import { Cron } from 'croner';
import type { DbHandles } from '@justfortytwo/memory';
import { cancel, enqueue, listActive, type CancelResult, type JobRow } from './jobs.js';
import { RECURRING_DEFS } from './handlers/index.js';
import { ONEIROS_DEF } from './oneiros.js';
import { isValidTimezone } from './schedules.js';

// The rules for jobs the AGENT creates through the scheduler MCP (./mcp.ts).
// Every other kind (reply, notify_pending, reembed_memory, the seeded recurring
// jobs, Oneiros) is system-owned: the agent can see it in list_jobs, but cannot
// create or cancel it. This is a static allowlist on purpose; the handler
// registry needs a runner and is built only inside the daemon.

/** Kinds the agent may enqueue and cancel. */
export const AGENT_JOB_KINDS: readonly string[] = ['reminder'];

/** Longest reminder text, in characters. */
export const MAX_REMINDER_TEXT = 500;

/** Most active (pending or running) agent jobs at once: each run is an LLM turn. */
export const MAX_ACTIVE_AGENT_JOBS = 20;

/** Shortest gap allowed between two runs of an agent-created recurring job. */
export const MIN_RECURRENCE_INTERVAL_MS = 60 * 60_000;

/** Consecutive runs inspected for the frequency cap. */
const RECURRENCE_SAMPLE = 48;

/** Kinds re-seeded on every daemon boot: cancelling them would not stick. */
const SEEDED_KINDS: readonly string[] = [...RECURRING_DEFS.map((d) => d.kind), ONEIROS_DEF.kind];

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/;

/** UTC offset of `tz` at instant `ms`, in milliseconds (local = utc + offset). */
function zoneOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const n = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const local = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return local - Math.floor(ms / 1000) * 1000;
}

/**
 * Normalise a run time to the UTC `toISOString()` form that `claimDue` compares
 * lexicographically. Accepted: ISO-8601 date and time (`YYYY-MM-DDTHH:MM`,
 * optional seconds and milliseconds) with `Z` or a `+HH:MM`/`-HH:MM` offset, or
 * without one when `timezone` (an IANA name) says which clock it is read on.
 * Impossible dates (Feb 30), a missing zone and times before `now` are rejected.
 */
export function normalizeRunAt(input: unknown, now: string, timezone?: unknown): Checked<string> {
  if (typeof input !== 'string') return { ok: false, error: 'run_at must be an ISO-8601 string' };
  const m = ISO_RE.exec(input.trim());
  if (!m) return { ok: false, error: `run_at "${input}" is not ISO-8601 (expected e.g. 2026-11-20T17:00:00+01:00)` };
  const [, y, mo, d, hh, mi, ss = '0', ms = '0', zone] = m;
  const fields = [Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss), Number(ms.padEnd(3, '0'))] as const;
  const wall = Date.UTC(...fields);
  const back = new Date(wall);
  if (back.getUTCFullYear() !== fields[0] || back.getUTCMonth() !== fields[1] || back.getUTCDate() !== fields[2]
    || back.getUTCHours() !== fields[3] || back.getUTCMinutes() !== fields[4] || back.getUTCSeconds() !== fields[5]) {
    return { ok: false, error: `run_at "${input}" is not a real date and time` };
  }
  let at: number;
  if (zone) {
    if (timezone !== undefined) return { ok: false, error: 'give either an offset in run_at or a timezone, not both' };
    if (zone === 'Z') at = wall;
    else {
      const sign = zone.startsWith('-') ? -1 : 1;
      const [oh, om] = zone.slice(1).split(':').map(Number) as [number, number];
      if (oh > 23 || om > 59) return { ok: false, error: `run_at "${input}" has an invalid offset` };
      at = wall - sign * (oh * 60 + om) * 60_000;
    }
  } else {
    if (timezone === undefined) {
      return { ok: false, error: 'run_at has no offset: add one (e.g. +01:00 or Z) or pass timezone (e.g. Europe/Rome)' };
    }
    if (!isValidTimezone(timezone)) return { ok: false, error: `unknown timezone "${String(timezone)}"` };
    // Two passes: the offset at the guessed instant can differ across a DST change.
    const first = wall - zoneOffsetMs(wall, timezone);
    at = wall - zoneOffsetMs(first, timezone);
  }
  const iso = new Date(at).toISOString();
  if (!/^\d{4}-/.test(iso)) return { ok: false, error: `run_at "${input}" is out of range` };
  if (iso < now) return { ok: false, error: `run_at ${iso} is in the past (now ${now}); past times are rejected, not fired` };
  return { ok: true, value: iso };
}

/**
 * Check a cron expression with the daemon's library and time zone, and the
 * frequency cap. Returns the first run after `now` (what the daemon would use).
 */
export function checkRecurrence(cron: unknown, now: string, timezone: string): Checked<string> {
  if (typeof cron !== 'string' || cron.trim() === '') return { ok: false, error: 'recurrence must be a cron expression' };
  let runs: Date[];
  try {
    runs = new Cron(cron, { timezone }).nextRuns(RECURRENCE_SAMPLE, new Date(now));
  } catch (e: unknown) {
    return { ok: false, error: `recurrence "${cron}" is not a valid cron expression: ${(e as Error)?.message ?? e}` };
  }
  const first = runs[0];
  if (!first) return { ok: false, error: `recurrence "${cron}" never runs after ${now}` };
  for (let i = 1; i < runs.length; i++) {
    if (runs[i]!.getTime() - runs[i - 1]!.getTime() < MIN_RECURRENCE_INTERVAL_MS) {
      return { ok: false, error: `recurrence "${cron}" runs more often than once an hour; each run is an LLM turn` };
    }
  }
  return { ok: true, value: first.toISOString() };
}

/** Check a reminder payload: exactly `{ text }`, a non-empty single line of at most MAX_REMINDER_TEXT characters. */
export function checkReminderPayload(payload: unknown): Checked<{ text: string }> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'payload must be an object: { "text": "..." }' };
  }
  const extra = Object.keys(payload).filter((k) => k !== 'text');
  if (extra.length > 0) return { ok: false, error: `payload accepts only "text" (unexpected: ${extra.join(', ')})` };
  const text = (payload as { text?: unknown }).text;
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'payload.text must be a non-empty string' };
  if ([...text].length > MAX_REMINDER_TEXT) return { ok: false, error: `payload.text is longer than ${MAX_REMINDER_TEXT} characters` };
  // The text is put into a prompt later; control characters (newlines included)
  // could make it read as more than one reminder line.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, error: 'payload.text must be one line without control characters' };
  return { ok: true, value: { text } };
}

function kindRefusal(kind: string, verb: 'created' | 'cancelled'): string {
  const why = SEEDED_KINDS.includes(kind) ? ' (a built-in job, re-seeded on every boot)' : ' (system-owned)';
  return `kind "${kind}" cannot be ${verb} by the agent${AGENT_JOB_KINDS.includes(kind) ? '' : why}; allowed: ${AGENT_JOB_KINDS.join(', ')}`;
}

export interface EnqueueArgs {
  kind?: unknown;
  payload?: unknown;
  run_at?: unknown;
  timezone?: unknown;
  recurrence?: unknown;
}

export interface AgentJobContext {
  /** Current time, ISO (UTC). */
  now: string;
  /** Zone crons are read in: the install's (`readScheduleTimezone`), else UTC, as in the daemon. */
  timezone: string;
}

export interface EnqueuedJob {
  id: number;
  kind: string;
  run_at: string;
  recurrence: string | null;
}

/**
 * Validate and enqueue an agent job. `run_at` is required unless `recurrence`
 * is given (then the first run is the cron's next one). The active-job cap and
 * the insert share one write transaction, so two MCP processes cannot both
 * pass the count and exceed it.
 */
export function enqueueAgentJob(h: DbHandles, args: EnqueueArgs, ctx: AgentJobContext): Checked<EnqueuedJob> {
  const kind = args.kind;
  if (typeof kind !== 'string' || !AGENT_JOB_KINDS.includes(kind)) {
    return { ok: false, error: typeof kind === 'string' ? kindRefusal(kind, 'created') : 'kind must be a string' };
  }
  const payload = checkReminderPayload(args.payload);
  if (!payload.ok) return payload;

  let recurrence: string | null = null;
  let runAt: string | undefined;
  if (args.recurrence !== undefined && args.recurrence !== null) {
    const rec = checkRecurrence(args.recurrence, ctx.now, ctx.timezone);
    if (!rec.ok) return rec;
    recurrence = (args.recurrence as string).trim();
    runAt = rec.value;
  }
  if (args.run_at !== undefined && args.run_at !== null) {
    const at = normalizeRunAt(args.run_at, ctx.now, args.timezone ?? undefined);
    if (!at.ok) return at;
    runAt = at.value;
  } else if (args.timezone !== undefined && args.timezone !== null) {
    return { ok: false, error: 'timezone applies to run_at; recurrence is read in the install time zone' };
  }
  if (runAt === undefined) return { ok: false, error: 'run_at is required (or give a recurrence)' };
  const job = { kind, run_at: runAt, recurrence };

  return h.raw.transaction((): Checked<EnqueuedJob> => {
    const active = listActive(h).filter((j) => AGENT_JOB_KINDS.includes(j.kind)).length;
    if (active >= MAX_ACTIVE_AGENT_JOBS) {
      return { ok: false, error: `${active} agent jobs are already active (limit ${MAX_ACTIVE_AGENT_JOBS}); cancel one first` };
    }
    const id = enqueue(h, { ...job, payload: payload.value });
    return { ok: true, value: { id, ...job } };
  }).immediate();
}

export interface ListedJob {
  id: number;
  kind: string;
  status: string;
  run_at: string;
  recurrence: string | null;
  /** The reminder text; payloads of system-owned kinds are not shown. */
  text?: string;
  /** True when cancel_job would accept it (an agent kind, still pending). */
  cancellable: boolean;
}

/** Active jobs (pending AND running), soonest first. */
export function listAgentView(h: DbHandles): ListedJob[] {
  return listActive(h)
    .slice()
    .sort((a, b) => (a.run_at < b.run_at ? -1 : a.run_at > b.run_at ? 1 : a.id - b.id))
    .map((j: JobRow) => {
      const agent = AGENT_JOB_KINDS.includes(j.kind);
      const out: ListedJob = {
        id: j.id, kind: j.kind, status: j.status, run_at: j.run_at, recurrence: j.recurrence,
        cancellable: agent && j.status === 'pending',
      };
      if (agent && j.payload) {
        try {
          const text = (JSON.parse(j.payload) as { text?: unknown }).text;
          if (typeof text === 'string') out.text = text;
        } catch { /* malformed payload: listed without text */ }
      }
      return out;
    });
}

/** Cancel a pending agent job; running, finished and system-owned jobs are refused. */
export function cancelAgentJob(h: DbHandles, id: unknown): Checked<{ id: number }> {
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return { ok: false, error: 'id must be a positive integer' };
  const r: CancelResult = cancel(h, id, { kinds: AGENT_JOB_KINDS });
  if (r.ok) return { ok: true, value: { id } };
  switch (r.reason) {
    case 'not_found': return { ok: false, error: `no job with id ${id}` };
    case 'kind_not_allowed': return { ok: false, error: kindRefusal(r.kind, 'cancelled') };
    case 'running': return { ok: false, error: `job ${id} is running now and cannot be cancelled` };
    default: return { ok: false, error: `job ${id} is already ${r.status}` };
  }
}
