import { describe, it, expect, vi } from 'vitest';
import { createJournalNotifier, createFanoutNotifier } from '../src/notifier.js';
import type { Notification, Notifier } from '../src/types.js';

const n: Notification = { kind: 'test', text: 'hello' };

describe('createJournalNotifier', () => {
  it('calls the injected write fn exactly once with the notification', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const notifier = createJournalNotifier(write);
    await notifier.notify(n);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(n);
  });
});

describe('createFanoutNotifier', () => {
  it('calls all notifiers with the notification', async () => {
    const a = vi.fn().mockResolvedValue(undefined);
    const b = vi.fn().mockResolvedValue(undefined);
    const notifierA: Notifier = { notify: a };
    const notifierB: Notifier = { notify: b };

    const fanout = createFanoutNotifier([notifierA, notifierB]);
    await fanout.notify(n);

    expect(a).toHaveBeenCalledOnce();
    expect(a).toHaveBeenCalledWith(n);
    expect(b).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledWith(n);
  });

  it('if notifier a throws, notifier b is still called and fanout resolves', async () => {
    const a = vi.fn().mockRejectedValue(new Error('telegram down'));
    const b = vi.fn().mockResolvedValue(undefined);
    const notifierA: Notifier = { notify: a };
    const notifierB: Notifier = { notify: b };

    const fanout = createFanoutNotifier([notifierA, notifierB]);

    // fanout must NOT reject even if a throws
    await expect(fanout.notify(n)).resolves.toBeUndefined();
    expect(b).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledWith(n);
  });

  it('empty notifiers array — resolves without error', async () => {
    const fanout = createFanoutNotifier([]);
    await expect(fanout.notify(n)).resolves.toBeUndefined();
  });
});
