import { resolve } from 'node:path';
import type { Notification, Notifier } from './types.js';

/**
 * Telegram push for scheduler notifications: decides WHICH chats receive a
 * notification and delivers it. Transport and the binding store stay in
 * `@justfortytwo/telegram`; everything here takes them as injected functions,
 * so this module never imports that optional peer.
 *
 * Target policy:
 * - `ALLOWED_CHAT_IDS` set   -> its first id (the original, explicit behaviour).
 * - `ALLOWED_CHAT_IDS` empty -> every chat paired with `fortytwo pair` /
 *   `/login <code>`, read again for each notification so pairing or unbinding
 *   takes effect without restarting the daemon.
 */

/** The only binding field this module needs (structural, mirrors telegram's `Binding`). */
export interface BoundChat {
  channelUserId: string;
}

/**
 * Chat ids of the bound PRIVATE chats. Group/channel ids are negative and are
 * never an owner chat (same rule as telegram's `isAuthorized`), so they are
 * dropped along with anything that is not a positive integer.
 */
export function bindingChatIds(bindings: BoundChat[]): number[] {
  return bindings
    .map((b) => (/^\d+$/.test(b.channelUserId) ? Number(b.channelUserId) : NaN))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

/** Builds the per-notification target resolver described in the module header. */
export function pushTargets(opts: {
  /** Parsed `ALLOWED_CHAT_IDS`, in the order written. May be empty. */
  staticChatIds: number[];
  /** Reads the current Telegram bindings. Only called when `staticChatIds` is empty. */
  listBindings: () => BoundChat[];
}): () => number[] {
  const first = opts.staticChatIds[0];
  if (first !== undefined) return () => [first];
  return () => bindingChatIds(opts.listBindings());
}

/**
 * Notifier that pushes each notification to every current target. It never
 * throws: a chat that fails is reported through `onError` and the remaining
 * chats are still tried. `chatId` is null when resolving the targets failed.
 */
export function createTelegramPushNotifier(opts: {
  targets: () => number[];
  send: (chatId: number, text: string) => Promise<void>;
  onError: (chatId: number | null, err: unknown) => void;
}): Notifier {
  return {
    async notify(n: Notification): Promise<void> {
      let chatIds: number[];
      try {
        chatIds = opts.targets();
      } catch (err) {
        opts.onError(null, err);
        return;
      }
      for (const chatId of chatIds) {
        try {
          await opts.send(chatId, n.text);
        } catch (err) {
          opts.onError(chatId, err);
        }
      }
    },
  };
}

/**
 * Path of the Telegram bindings db. MUST match the bridge and `fortytwo pair`
 * (`<root>/state/telegram-bindings.db`, overridable via `TELEGRAM_BINDINGS_DB`
 * resolved against the root), or the scheduler would read a db nobody writes.
 */
export function bindingsDbPath(root: string, custom: string | undefined): string {
  return custom ? resolve(root, custom) : resolve(root, 'state', 'telegram-bindings.db');
}
