#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Phase 2 re-exports — kept intact.
export type {
  Job,
  RunCtx,
  RunResult,
  Handler,
  Notification,
  Notifier,
  Registry,
} from './types.js';

export { createRegistry } from './registry.js';

export { tick, backoffAt, RETRY_BACKOFF_MIN } from './tick.js';
export type { TickDeps } from './tick.js';

// Phase 3 re-exports.
export { createJournalNotifier, createFanoutNotifier } from './notifier.js';
export { startDaemon, recurrenceNext, makePoll, POLL_MS, STALE_RUNNING_MS } from './daemon.js';
export type { DaemonOptions } from './daemon.js';

// ---------------------------------------------------------------------------
// Bin guard — boot the daemon ONLY when this file is the direct entrypoint.
// Mirrors telegram/src/bridge.ts `invokedAsBin()` exactly so importing this
// package as a library does not open a DB, run migrations, or start an interval.
// ---------------------------------------------------------------------------

function invokedAsBin(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsBin()) {
  const { startDaemon: boot } = await import('./daemon.js');
  const dbPath = process.env['DB_PATH'] ?? 'fortytwo.db';
  boot({ dbPath }).catch((err: unknown) => {
    process.stderr.write(`fortytwo-scheduler: ${(err as Error)?.stack ?? err}\n`);
    process.exit(1);
  });
}
