import { describe, it, expect, vi } from 'vitest';
import { resolve } from 'node:path';
import {
  bindingChatIds,
  bindingsDbPath,
  createTelegramPushNotifier,
  pushTargets,
} from '../src/telegram-push.js';
import type { Notification } from '../src/types.js';

const n: Notification = { kind: 'daily_briefing', text: 'good morning' };

describe('bindingChatIds', () => {
  it('returns the bound private chat ids as numbers', () => {
    expect(bindingChatIds([{ channelUserId: '111' }, { channelUserId: '222' }])).toEqual([111, 222]);
  });

  it('drops group/channel ids (negative) and non-numeric ids', () => {
    expect(
      bindingChatIds([{ channelUserId: '-100123' }, { channelUserId: 'abc' }, { channelUserId: '' }, { channelUserId: '7' }]),
    ).toEqual([7]);
  });
});

describe('pushTargets', () => {
  it('uses only the first ALLOWED_CHAT_IDS id when the static allowlist is set', () => {
    const listBindings = vi.fn(() => [{ channelUserId: '999' }]);
    const targets = pushTargets({ staticChatIds: [111, 222], listBindings });
    expect(targets()).toEqual([111]);
    expect(listBindings).not.toHaveBeenCalled();
  });

  it('falls back to the bound chats when the static allowlist is empty', () => {
    const targets = pushTargets({ staticChatIds: [], listBindings: () => [{ channelUserId: '555' }] });
    expect(targets()).toEqual([555]);
  });

  it('re-reads the bindings on every call, so a chat paired after boot is picked up', () => {
    const bindings: Array<{ channelUserId: string }> = [];
    const targets = pushTargets({ staticChatIds: [], listBindings: () => bindings });
    expect(targets()).toEqual([]);
    bindings.push({ channelUserId: '555' });
    expect(targets()).toEqual([555]);
  });
});

describe('createTelegramPushNotifier', () => {
  it('sends the notification text to every target', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const notifier = createTelegramPushNotifier({ targets: () => [1, 2], send, onError: vi.fn() });
    await notifier.notify(n);
    expect(send.mock.calls).toEqual([[1, 'good morning'], [2, 'good morning']]);
  });

  it('sends nothing when there are no targets', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const notifier = createTelegramPushNotifier({ targets: () => [], send, onError: vi.fn() });
    await notifier.notify(n);
    expect(send).not.toHaveBeenCalled();
  });

  it('reports a failing chat and still delivers to the others', async () => {
    const boom = new Error('403 Forbidden');
    const send = vi.fn(async (chatId: number) => { if (chatId === 1) throw boom; });
    const onError = vi.fn();
    const notifier = createTelegramPushNotifier({ targets: () => [1, 2], send, onError });
    await expect(notifier.notify(n)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(1, boom);
  });

  it('reports a failure to resolve the targets instead of throwing', async () => {
    const boom = new Error('db locked');
    const onError = vi.fn();
    const send = vi.fn();
    const notifier = createTelegramPushNotifier({ targets: () => { throw boom; }, send, onError });
    await expect(notifier.notify(n)).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(null, boom);
  });
});

describe('bindingsDbPath', () => {
  it('defaults to <root>/state/telegram-bindings.db', () => {
    expect(bindingsDbPath('/srv/fortytwo', undefined)).toBe(resolve('/srv/fortytwo', 'state', 'telegram-bindings.db'));
  });

  it('resolves TELEGRAM_BINDINGS_DB against the root', () => {
    expect(bindingsDbPath('/srv/fortytwo', 'data/b.db')).toBe(resolve('/srv/fortytwo', 'data/b.db'));
  });
});

// Contract check against the real store from the optional telegram peer: the
// scheduler reads what `fortytwo pair` / the bridge write, through a second handle.
describe('pushTargets over the real telegram bindings db', () => {
  it('sees a chat bound by another process after the scheduler opened the db', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { SqliteBindingStore } = await import('@justfortytwo/telegram');

    const dir = mkdtempSync(join(tmpdir(), 'scheduler-telegram-push-'));
    try {
      const path = bindingsDbPath(dir, 'bindings.db');
      const schedulerSide = new SqliteBindingStore(path);
      const targets = pushTargets({ staticChatIds: [], listBindings: () => schedulerSide.list('telegram') });
      expect(targets()).toEqual([]);

      const bridgeSide = new SqliteBindingStore(path);
      bridgeSide.put({ channelType: 'telegram', channelUserId: '4242', owner: 'owner', boundAt: '2026-01-01T00:00:00.000Z' });
      expect(targets()).toEqual([4242]);

      bridgeSide.remove('telegram', '4242');
      expect(targets()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
