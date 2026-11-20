import type { DbHandles } from '@justfortytwo/memory';

// The durable jobs queue on memory's DB handle. The scheduler owns the table
// (`004_jobs`, see ./migrate.ts) and this API; producers in other packages
// (telegram's reply queue, installer's Oneiros seeding) import it from here.

export interface NewJob {
  kind: string;
  run_at: string;
  payload?: unknown;
  recurrence?: string | null;
}

export interface JobRow {
  id: number;
  kind: string;
  payload: string | null;
  run_at: string;
  recurrence: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export const MAX_ATTEMPTS = 3;

export function enqueue(h: DbHandles, j: NewJob): number {
  const ts = new Date().toISOString();
  const row = h.raw.prepare(
    `INSERT INTO jobs (kind, payload, run_at, recurrence, status, attempts, created_at, updated_at)
     VALUES (?,?,?,?, 'pending', 0, ?, ?) RETURNING id`,
  ).get(j.kind, j.payload != null ? JSON.stringify(j.payload) : null, j.run_at, j.recurrence ?? null, ts, ts) as { id: number };
  return row.id;
}

export function claimDue(h: DbHandles, now: string): JobRow[] {
  return h.raw.prepare(
    `UPDATE jobs SET status='running', updated_at=? WHERE status='pending' AND run_at <= ? RETURNING *`,
  ).all(now, now) as JobRow[];
}

export function complete(h: DbHandles, id: number, opts: { reschedule?: string } = {}): void {
  const ts = new Date().toISOString();
  if (opts.reschedule) {
    h.raw.prepare(
      `UPDATE jobs SET status='pending', run_at=?, attempts=0, last_error=NULL, updated_at=? WHERE id=?`,
    ).run(opts.reschedule, ts, id);
  } else {
    h.raw.prepare(`UPDATE jobs SET status='done', updated_at=? WHERE id=?`).run(ts, id);
  }
}

export function fail(h: DbHandles, id: number, error: string, opts: { retryAt?: string } = {}): void {
  const ts = new Date().toISOString();
  const row = h.raw.prepare(`SELECT attempts FROM jobs WHERE id=?`).get(id) as { attempts: number } | undefined;
  const attempts = (row?.attempts ?? 0) + 1;
  if (attempts >= MAX_ATTEMPTS) {
    h.raw.prepare(
      `UPDATE jobs SET status='failed', attempts=?, last_error=?, updated_at=? WHERE id=?`,
    ).run(attempts, error, ts, id);
  } else {
    h.raw.prepare(
      `UPDATE jobs SET status='pending', attempts=?, last_error=?, run_at=?, updated_at=? WHERE id=?`,
    ).run(attempts, error, opts.retryAt ?? ts, ts, id);
  }
}

/** All active (non-terminal) jobs — status in ('pending','running'). */
export function listActive(h: DbHandles): JobRow[] {
  return h.raw.prepare(`SELECT * FROM jobs WHERE status IN ('pending','running')`).all() as JobRow[];
}

export function requeueStale(h: DbHandles, olderThan: string): void {
  const ts = new Date().toISOString();
  h.raw.prepare(
    `UPDATE jobs SET status='pending', updated_at=? WHERE status='running' AND updated_at < ?`,
  ).run(ts, olderThan);
}

/**
 * Returns true if a pending or running job of the given `kind` exists whose
 * payload `$.id` equals `idValue`. Used to deduplicate producer enqueues (e.g.
 * `reembed_memory` for a specific memory id). Uses `json_extract` (SQLite
 * >= 3.38) for an exact match — a substring LIKE would spuriously collide
 * (id 1 vs 11/100).
 */
export function existsPending(h: DbHandles, kind: string, idValue: number): boolean {
  const row = h.raw.prepare(
    `SELECT 1 FROM jobs WHERE kind=? AND status IN ('pending','running')
       AND json_extract(payload, '$.id') = ? LIMIT 1`,
  ).get(kind, idValue) as { 1: number } | undefined;
  return row !== undefined;
}

/**
 * Updates the recurrence expression and next run_at for a recurring job.
 * Called by seedRecurring when the in-code cron definition changes.
 */
export function setRecurrence(h: DbHandles, id: number, recurrence: string, runAt: string): void {
  const ts = new Date().toISOString();
  h.raw.prepare(
    `UPDATE jobs SET recurrence=?, run_at=?, updated_at=? WHERE id=?`,
  ).run(recurrence, runAt, ts, id);
}

/** Why `cancel` left a job alone; `status`/`kind` describe the row when one exists. */
export type CancelResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'running' | 'not_active' | 'kind_not_allowed'; status: string; kind: string };

/**
 * Cancel a pending job: its status becomes `cancelled`, a terminal state that
 * `claimDue`, `listActive` and `requeueStale` never pick up again.
 *
 * Only `pending` rows are cancelled. A `running` job is refused (its turn is
 * already under way and `complete`/`fail` would overwrite the status), and so
 * is a finished one. With `kinds`, a job of any other kind is refused too; the
 * kind check and the status change are one UPDATE, so a job the daemon claims
 * at the same moment is reported as running, never cancelled.
 */
export function cancel(h: DbHandles, id: number, opts: { kinds?: readonly string[] } = {}): CancelResult {
  const ts = new Date().toISOString();
  const kinds = opts.kinds;
  const kindClause = kinds ? ` AND kind IN (${kinds.map(() => '?').join(',') || 'NULL'})` : '';
  const changed = h.raw.prepare(
    `UPDATE jobs SET status='cancelled', updated_at=? WHERE id=? AND status='pending'${kindClause}`,
  ).run(ts, id, ...(kinds ?? [])).changes;
  if (changed > 0) return { ok: true };
  const row = h.raw.prepare(`SELECT status, kind FROM jobs WHERE id=?`).get(id) as
    { status: string; kind: string } | undefined;
  if (!row) return { ok: false, reason: 'not_found' };
  if (kinds && !kinds.includes(row.kind)) return { ok: false, reason: 'kind_not_allowed', ...row };
  if (row.status === 'running') return { ok: false, reason: 'running', ...row };
  return { ok: false, reason: 'not_active', ...row };
}
