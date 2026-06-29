import type { Notification, Notifier } from './types.js';

/**
 * Creates a notifier that forwards every notification to the injected `write`
 * callback. The daemon supplies the real write that persists entries to the
 * memory journal. Using DI keeps the journalling logic testable without
 * opening a real database.
 */
export function createJournalNotifier(
  write: (n: Notification) => Promise<void>,
): Notifier {
  return {
    async notify(n: Notification): Promise<void> {
      await write(n);
    },
  };
}

/**
 * Creates a notifier that fans out to every notifier in the list. Each
 * notifier is wrapped in its own try/catch so a failing notifier (e.g. a
 * Telegram push) does NOT prevent the others (e.g. the journal write) from
 * running. The returned promise always resolves.
 */
export function createFanoutNotifier(notifiers: Notifier[]): Notifier {
  return {
    async notify(n: Notification): Promise<void> {
      for (const notifier of notifiers) {
        try {
          await notifier.notify(n);
        } catch {
          // Intentionally swallowed: one failing notifier must not block others.
        }
      }
    },
  };
}
