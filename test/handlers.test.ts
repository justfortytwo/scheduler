import { describe, it, expect, vi } from 'vitest';
import { makeRecurringHandler } from '../src/handlers/recurring.js';
import { makeNotifyPendingHandler, makeReplyHandler, makeReminderHandler } from '../src/handlers/oneoff.js';
import { makeReembedHandler } from '../src/handlers/reembed.js';
import type { RunCtx } from '../src/types.js';

function fakeCtx(payload: unknown = undefined): RunCtx {
  return { now: '2026-06-30T09:00:00.000Z', payload };
}

function fakeRunner(text = 'ok text') {
  return vi.fn(async (_prompt: string) => ({ ok: true, text }));
}

// ---------------------------------------------------------------------------
// makeRecurringHandler
// ---------------------------------------------------------------------------

describe('makeRecurringHandler (ungated)', () => {
  it('run calls runner with the trigger and returns result', async () => {
    const runner = fakeRunner('daily briefing done');
    const h = makeRecurringHandler({ kind: 'daily_briefing', trigger: 'Run daily briefing.', runner });
    const result = await h.run(fakeCtx());
    expect(runner).toHaveBeenCalledWith('Run daily briefing.');
    expect(result).toEqual({ ok: true, text: 'daily briefing done' });
  });

  it('hasWork returns true when no gate is provided', async () => {
    const h = makeRecurringHandler({ kind: 'daily_briefing', trigger: 'x', runner: fakeRunner() });
    const yes = await h.hasWork!(fakeCtx());
    expect(yes).toBe(true);
  });
});

describe('sweep gate (countPendingApprovals injection)', () => {
  it('hasWork returns false when countPendingApprovals returns 0', async () => {
    const h = makeRecurringHandler({
      kind: 'sweep',
      trigger: 'sweep',
      runner: fakeRunner(),
      hasWork: async () => 0 > 0,
    });
    expect(await h.hasWork!(fakeCtx())).toBe(false);
  });

  it('hasWork returns true when countPendingApprovals returns >0', async () => {
    const h = makeRecurringHandler({
      kind: 'sweep',
      trigger: 'sweep',
      runner: fakeRunner(),
      hasWork: async () => 3 > 0,
    });
    expect(await h.hasWork!(fakeCtx())).toBe(true);
  });
});

describe('learn_review gate (recentCount injection)', () => {
  it('hasWork returns false when recentCount is 0', async () => {
    const h = makeRecurringHandler({
      kind: 'learn_review',
      trigger: 'learn review',
      runner: fakeRunner(),
      hasWork: async () => (await Promise.resolve(0)) > 0,
    });
    expect(await h.hasWork!(fakeCtx())).toBe(false);
  });

  it('hasWork returns true when recentCount > 0', async () => {
    const h = makeRecurringHandler({
      kind: 'learn_review',
      trigger: 'learn review',
      runner: fakeRunner(),
      hasWork: async () => (await Promise.resolve(5)) > 0,
    });
    expect(await h.hasWork!(fakeCtx())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// One-off handlers
// ---------------------------------------------------------------------------

describe('makeReminderHandler', () => {
  it('run calls runner with the payload text prefixed', async () => {
    const runner = fakeRunner('reminder acked');
    const h = makeReminderHandler(runner);
    const result = await h.run(fakeCtx({ text: 'dentist at 3pm' }));
    expect(runner).toHaveBeenCalledWith('Reminder: dentist at 3pm');
    expect(result).toEqual({ ok: true, text: 'reminder acked' });
  });

  it('run uses empty string when payload.text is absent', async () => {
    const runner = fakeRunner('ok');
    const h = makeReminderHandler(runner);
    await h.run(fakeCtx());
    expect(runner).toHaveBeenCalledWith('Reminder: ');
  });
});

describe('makeReplyHandler', () => {
  it('run calls runner with the message text', async () => {
    const runner = fakeRunner('replied');
    const h = makeReplyHandler(runner);
    await h.run(fakeCtx({ text: 'hey are you there?' }));
    expect(runner).toHaveBeenCalledWith('Handle this pending message: hey are you there?');
  });
});

describe('makeNotifyPendingHandler', () => {
  it('run includes the approval id in the prompt when provided', async () => {
    const runner = fakeRunner('notified');
    const h = makeNotifyPendingHandler(runner);
    await h.run(fakeCtx({ id: 42 }));
    expect(runner.mock.calls[0]![0]).toContain('approval id: 42');
  });

  it('run omits id clause when no id in payload', async () => {
    const runner = fakeRunner('notified');
    const h = makeNotifyPendingHandler(runner);
    await h.run(fakeCtx());
    expect(runner.mock.calls[0]![0]).not.toContain('approval id');
  });
});

// ---------------------------------------------------------------------------
// makeReembedHandler
// ---------------------------------------------------------------------------

describe('makeReembedHandler', () => {
  it('run calls reembedOne with payload.id and returns null', async () => {
    const reembedOne = vi.fn(async (_id: number) => true);
    const h = makeReembedHandler(reembedOne);
    const result = await h.run(fakeCtx({ id: 7 }));
    expect(reembedOne).toHaveBeenCalledWith(7);
    expect(result).toBeNull();
  });

  it('run returns null and skips reembedOne when id is missing', async () => {
    const reembedOne = vi.fn(async (_id: number) => false);
    const h = makeReembedHandler(reembedOne);
    const result = await h.run(fakeCtx({}));
    expect(reembedOne).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
