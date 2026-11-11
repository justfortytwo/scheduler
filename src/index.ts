#!/usr/bin/env node
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindingsDbPath, createTelegramPushNotifier, pushTargets } from './telegram-push.js';
import type { BoundChat } from './telegram-push.js';

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

// Phase 7 re-exports.
export { bindingChatIds, bindingsDbPath, createTelegramPushNotifier, pushTargets } from './telegram-push.js';
export type { BoundChat } from './telegram-push.js';

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

  // Optional Telegram push: when TELEGRAM_BOT_TOKEN is set, wire a Telegram
  // notifier so the daemon pushes notifications to Telegram in addition to the
  // journal write. Without the token, only the journal notifier is active.
  //
  // Target chats (see ./telegram-push.ts): the first id of ALLOWED_CHAT_IDS
  // (comma-separated, same format as the bridge) when it is set; otherwise the
  // chats paired via `fortytwo pair`, read from the bridge's bindings db on
  // every notification. The bindings db is opened only in that second case.
  const extraNotifiers = await (async () => {
    const token = process.env['TELEGRAM_BOT_TOKEN'];
    if (!token) return [];
    try {
      // Lazy import so scheduler can run without @justfortytwo/telegram installed.
      const { Telegram, parseAllowed, SqliteBindingStore } = await import('@justfortytwo/telegram');
      const allowed = parseAllowed(process.env['ALLOWED_CHAT_IDS']);
      let listBindings: () => BoundChat[] = () => [];
      if (allowed.size === 0) {
        const root = resolve(process.env['FORTYTWO_ROOT'] ?? process.cwd());
        const path = bindingsDbPath(root, process.env['TELEGRAM_BINDINGS_DB']);
        // Same as the bridge: the db may not exist yet on a fresh install.
        mkdirSync(dirname(path), { recursive: true });
        const store = new SqliteBindingStore(path);
        listBindings = () => store.list('telegram');
      }
      const tg = new Telegram(token, allowed);
      return [createTelegramPushNotifier({
        targets: pushTargets({ staticChatIds: [...allowed], listBindings }),
        send: (id, text) => tg.sendMessage(id, text).then(() => undefined),
        onError: (chatId, err) => {
          const where = chatId === null ? 'resolving target chats' : `chat ${chatId}`;
          process.stderr.write(`fortytwo-scheduler: Telegram push failed (${where}): ${(err as Error)?.message ?? err}\n`);
        },
      })];
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

export { ONEIROS_DEF, seedOneiros, makeOneirosHandler } from './oneiros.js';
export { loadTranscriptSource } from './oneiros.js';
export { loadConversationLog, noopConversationLog } from './conversation-log.js';
export type { ConversationEvent, ConversationLog } from './conversation-log.js';
export { makeJournalWrite } from './daemon.js';
