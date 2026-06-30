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

// Phase 4 re-exports.
export { RECURRING_DEFS, buildRegistry } from './handlers/index.js';
export type { RecurringDef, RegistryDeps } from './handlers/index.js';
export { seedRecurring } from './seed.js';
export type { SeedStore } from './seed.js';

// Phase 6 re-exports.
export { heartbeatPath, writeHeartbeat } from './heartbeat.js';

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

  // Optional Telegram push: when TELEGRAM_BOT_TOKEN + ALLOWED_CHAT_IDS are
  // set, construct a Telegram sender and wire it as an extra notifier so the
  // scheduler daemon can push notifications to Telegram in addition to the
  // journal write.
  //
  // FLAG: ALLOWED_CHAT_IDS is expected to be a comma-separated list of chat
  // ids (same format as the bridge); we use the first id as the target chat.
  // If neither env var is set, extraNotifiers defaults to [] and only the
  // journal notifier is active.
  const extraNotifiers = await (async () => {
    const token = process.env['TELEGRAM_BOT_TOKEN'];
    const chatIdsRaw = process.env['ALLOWED_CHAT_IDS'];
    if (!token || !chatIdsRaw) return [];
    try {
      // Lazy import so scheduler can run without @justfortytwo/telegram installed.
      const { Telegram, parseAllowed, telegramNotifier } = await import('@justfortytwo/telegram');
      const chatIds = parseAllowed(chatIdsRaw);
      if (chatIds.size === 0) return [];
      const chatId = [...chatIds][0]!;
      const tg = new Telegram(token, chatIds);
      return [telegramNotifier({ chatId, send: (id, text) => tg.sendMessage(id, text).then(() => undefined) })];
    } catch (e: unknown) {
      process.stderr.write(`fortytwo-scheduler: Telegram notifier wiring failed: ${(e as Error)?.message ?? e} — journal-only\n`);
      return [];
    }
  })();

  boot({ dbPath, extraNotifiers }).catch((err: unknown) => {
    process.stderr.write(`fortytwo-scheduler: ${(err as Error)?.stack ?? err}\n`);
    process.exit(1);
  });
}
