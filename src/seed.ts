import type { RecurringDef } from './handlers/index.js';

// Minimal injected store surface: only what seed needs (testable with a fake).
export interface SeedStore {
  listActive(): Array<{ id: number; kind: string; recurrence: string | null }>;
  enqueue(j: { kind: string; run_at: string; recurrence: string }): number;
  setRecurrence(id: number, recurrence: string, runAt: string): void;
}

/**
 * Seeds recurring job rows from the authoritative in-code definitions.
 *
 * For each def:
 * - If no active row with that kind + a recurrence exists → INSERT (first boot).
 * - If the existing row's cron differs from the def → UPDATE (cron changed in code).
 * - Otherwise → leave it alone (idempotent on subsequent boots).
 *
 * `recurrenceNext` is injected so seed is testable without croner.
 */
export function seedRecurring(
  store: SeedStore,
  defs: RecurringDef[],
  now: string,
  recurrenceNext: (cron: string, now: string) => string,
): void {
  const active = store.listActive();

  for (const def of defs) {
    const existing = active.find(
      (j) => j.kind === def.kind && j.recurrence != null,
    );

    if (!existing) {
      store.enqueue({
        kind: def.kind,
        run_at: recurrenceNext(def.cron, now),
        recurrence: def.cron,
      });
    } else if (existing.recurrence !== def.cron) {
      store.setRecurrence(existing.id, def.cron, recurrenceNext(def.cron, now));
    }
    // else: unchanged — leave the existing row as-is
  }
}

// Minimal injected store surface for realigning rows (testable with a fake).
export interface RealignStore {
  listActive(): Array<{ id: number; kind: string; recurrence: string | null; status: string; run_at: string; attempts: number }>;
  setRecurrence(id: number, recurrence: string, runAt: string): void;
}

/**
 * Moves the next run of built-in recurring jobs onto the schedule as it reads
 * NOW, so a changed time zone applies on the next boot instead of after one
 * more run at the old time.
 *
 * Only a row that is waiting for a future run is touched. A job that is
 * overdue still runs (catch-up after downtime), a running one is left to
 * finish, and one waiting out a retry backoff (attempts > 0) keeps its retry
 * time.
 *
 * @returns the ids that were moved.
 */
export function realignRecurring(
  store: RealignStore,
  defs: RecurringDef[],
  now: string,
  recurrenceNext: (cron: string, now: string) => string,
): number[] {
  const moved: number[] = [];
  for (const job of store.listActive()) {
    const def = defs.find((d) => d.kind === job.kind);
    if (!def || job.recurrence !== def.cron) continue;
    if (job.status !== 'pending' || job.attempts > 0 || job.run_at <= now) continue;
    const expected = recurrenceNext(def.cron, now);
    if (expected !== job.run_at) {
      store.setRecurrence(job.id, def.cron, expected);
      moved.push(job.id);
    }
  }
  return moved;
}

// Minimal injected store surface for retiring rows (testable with a fake).
export interface RetireStore {
  listActive(): Array<{ id: number; kind: string; recurrence: string | null }>;
  /** Marks the job done WITHOUT rescheduling it. */
  complete(id: number): void;
}

/**
 * Retires the active recurring rows of the given kinds, so a built-in job the
 * owner switched off stops firing. `seedRecurring` only ever inserts or
 * updates, so without this a disabled job's existing row would keep running.
 *
 * Only rows with a recurrence are touched: a one-off job that happens to share
 * a kind is left alone. Re-enabling the kind later makes `seedRecurring`
 * insert a fresh row on the next boot.
 *
 * @returns the ids that were retired.
 */
export function retireRecurring(store: RetireStore, kinds: string[]): number[] {
  const retired: number[] = [];
  for (const job of store.listActive()) {
    if (job.recurrence != null && kinds.includes(job.kind)) {
      store.complete(job.id);
      retired.push(job.id);
    }
  }
  return retired;
}
