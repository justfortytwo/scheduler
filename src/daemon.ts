import { Cron } from 'croner';
import PQueue from 'p-queue';
import {
  openDb,
  runMigrations,
  claimDue,
  complete,
  fail,
  requeueStale,
  FakeEmbedder,
  OllamaEmbedder,
  store,
  query,
  reembed,
  listActive,
  enqueue,
  setRecurrence,
  countPendingApprovals,
  type Embedder,
} from '@justfortytwo/memory';
import { createRunner } from '@justfortytwo/runner';
import { tick, type TickDeps } from './tick.js';
import { heartbeatPath, writeHeartbeat } from './heartbeat.js';
import { createJournalNotifier, createFanoutNotifier } from './notifier.js';
import { buildRegistry, RECURRING_DEFS } from './handlers/index.js';
import { seedRecurring } from './seed.js';
import type { Notifier, Registry } from './types.js';

/** Poll interval: how often `tick` is invoked to drain due jobs. */
export const POLL_MS = 30_000;

/**
 * Stale-running threshold: jobs stuck in 'running' for longer than this are
 * reset to 'pending' on boot (crash recovery).
 */
export const STALE_RUNNING_MS = 15 * 60_000; // 15 minutes

// ---------------------------------------------------------------------------
// recurrenceNext
// ---------------------------------------------------------------------------

/**
 * Returns the next ISO run time for a cron expression, given an ISO `now`.
 *
 * Called by `tick` OUTSIDE its per-job try/catch for recurrence calculation.
 * Built-in crons are validated at seed time (Phase 4), so a malformed
 * expression here is a programming error that surfaces correctly at seed time.
 * If `new Cron` throws on a malformed expression, that is acceptable — it is
 * the seed step's responsibility to validate cron strings before persisting them.
 */
export function recurrenceNext(cron: string, now: string): string {
  // timezone: 'UTC' ensures cron expressions are always interpreted in UTC,
  // matching the ISO-string run_at values stored in the jobs table.
  const next = new Cron(cron, { timezone: 'UTC' }).nextRun(new Date(now));
  if (!next) throw new Error(`recurrenceNext: no next run for cron '${cron}' after ${now}`);
  return next.toISOString();
}

// ---------------------------------------------------------------------------
// makePoll — overlap-guarded poll factory (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Returns a `{ poll, isRunning }` pair. `poll()` calls `tickFn()` at most once
 * at a time — a second concurrent call returns immediately without running
 * `tickFn` again. This prevents tick() pileup if a slow job causes a poll
 * interval to fire before the previous one completes.
 */
export function makePoll(tickFn: () => Promise<void>): {
  poll: () => Promise<void>;
  isRunning: () => boolean;
} {
  let running = false;

  const poll = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await tickFn();
    } finally {
      running = false;
    }
  };

  return { poll, isRunning: () => running };
}

// ---------------------------------------------------------------------------
// startDaemon options
// ---------------------------------------------------------------------------

export interface DaemonOptions {
  /** Absolute path to the SQLite database file. */
  dbPath: string;
  /**
   * Handler registry. Phase 4 supplies the real registry with job handlers.
   * Defaults to an empty registry so Phase 3 builds + runs standalone.
   */
  registry?: Registry;
  /**
   * Additional notifiers beyond the journal (e.g. Telegram). Phase 5 wires
   * these in. Defaults to [] so only the journal notifier is active.
   */
  extraNotifiers?: Notifier[];
}

// ---------------------------------------------------------------------------
// startDaemon
// ---------------------------------------------------------------------------

/**
 * Boot the scheduler daemon.
 *
 * 1. Opens the SQLite DB and runs pending migrations.
 * 2. Requeues any stale 'running' jobs (crash recovery).
 * 3. Builds the TickDeps: claimDue / complete / fail bound to the DB handle,
 *    recurrenceNext (croner), enqueueRun (PQueue concurrency-1),
 *    notify (fanout: journal + optional extras), and the injected registry.
 * 4. Starts a 30-second setInterval poll loop with an overlap guard.
 *
 * Journal write: each notification is stored via memory's generic `store` fn
 * with source='scheduler:wake'. The embedder is OllamaEmbedder when
 * EMBED_MODEL is set, else FakeEmbedder (same pattern as telegram/bridge.ts).
 *
 * CONCERN: using FakeEmbedder in production means scheduler-emitted journal
 * entries are not semantically searchable (fake vectors). This matches the
 * bridge's current pattern for channel events and is acceptable for Phase 3.
 * It should be revisited when a persistent embedder is always available (e.g.
 * Phase 4+ where EMBED_MODEL is part of the required env).
 *
 * @returns A dispose fn that clears the poll interval.
 */
export async function startDaemon(opts: DaemonOptions): Promise<() => void> {
  const h = openDb(opts.dbPath);
  await runMigrations(h.k);

  // Crash recovery: reset jobs stuck in 'running' for > 15 minutes.
  const staleThreshold = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  requeueStale(h, staleThreshold);

  // Embedder: real Ollama when EMBED_MODEL is present, deterministic fake otherwise.
  const embedder: Embedder = process.env['EMBED_MODEL']
    ? new OllamaEmbedder(process.env['EMBED_MODEL'], process.env['OLLAMA_BASE_URL'])
    : new FakeEmbedder();

  // Journal notifier: persists each Notification as a memory entry.
  const journalWrite = async (n: { kind: string; text: string }): Promise<void> => {
    await store(h, embedder, {
      content: `[scheduler:${n.kind}] ${n.text}`,
      source: 'scheduler:wake',
      observed: 'internal',
      tags: ['scheduler', n.kind],
    });
  };

  const journalNotifier = createJournalNotifier(journalWrite);
  const allNotifiers: Notifier[] = [journalNotifier, ...(opts.extraNotifiers ?? [])];
  const fanout = createFanoutNotifier(allNotifiers);

  // Build the real handler registry (or accept the injected one for tests).
  const registry: Registry = opts.registry ?? (() => {
    const runner = createRunner();
    const reembedOne = (id: number): Promise<boolean> => reembed(h, embedder, id);
    return buildRegistry({
      runner,
      countPendingApprovals: () => countPendingApprovals(h),
      // Compute the 7-day lookback per call so a long-running daemon's window
      // does not drift forward from the boot-time instant.
      recentCount: async () =>
        (await query(h, { since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() })).length,
      reembedOne,
    });
  })();

  // Seed recurring job rows from the in-code definitions (idempotent on every boot).
  seedRecurring(
    {
      listActive: () => listActive(h),
      enqueue: (j) => enqueue(h, j),
      setRecurrence: (id, rec, at) => setRecurrence(h, id, rec, at),
    },
    RECURRING_DEFS,
    new Date().toISOString(),
    recurrenceNext,
  );

  // Write liveness heartbeat on boot.
  const hbPath = heartbeatPath(opts.dbPath);
  writeHeartbeat(hbPath, process.pid, new Date().toISOString());

  // Concurrency-1 PQueue: at most one handler run at a time.
  const queue = new PQueue({ concurrency: 1 });

  const deps: TickDeps = {
    claimDue: (now) => claimDue(h, now),
    complete: (id, rescheduleOpts) => complete(h, id, rescheduleOpts),
    fail: (id, error, retryOpts) => fail(h, id, error, retryOpts),
    recurrenceNext,
    enqueueRun: (fn) => queue.add(fn) as Promise<void>,
    notify: (notification) => fanout.notify(notification),
    registry,
  };

  const { poll } = makePoll(async () => {
    await tick(deps, new Date().toISOString());
  });

  // Refresh the heartbeat on EVERY poll tick — outside the overlap guard — so a
  // long-running `tick` (e.g. a multi-minute `claude` turn) does not starve the
  // heartbeat. If the write were inside `tickFn`, a tick exceeding the poll
  // interval would make every subsequent poll hit `if (running) return` and skip
  // the refresh, and `fortytwo doctor` would falsely report the daemon stale.
  const interval = setInterval(() => {
    writeHeartbeat(hbPath, process.pid, new Date().toISOString());
    void poll();
  }, POLL_MS);

  // Return dispose function so callers (tests, signal handlers) can clean up.
  return () => clearInterval(interval);
}
