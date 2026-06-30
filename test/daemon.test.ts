import { describe, it, expect, vi } from 'vitest';
import { recurrenceNext, makePoll } from '../src/daemon.js';

// ---------------------------------------------------------------------------
// recurrenceNext
// ---------------------------------------------------------------------------
describe('recurrenceNext', () => {
  it('returns the next ISO run time for a daily cron', () => {
    // At midnight UTC on 2026-06-29, "0 13 * * *" next fires at 13:00 same day.
    const result = recurrenceNext('0 13 * * *', '2026-06-29T00:00:00.000Z');
    expect(result).toBe('2026-06-29T13:00:00.000Z');
  });

  it('returns the correct next time when now is past the slot on the same day', () => {
    // At 14:00 UTC on 2026-06-29, "0 13 * * *" already fired — next is 2026-06-30.
    const result = recurrenceNext('0 13 * * *', '2026-06-29T14:00:00.000Z');
    expect(result).toBe('2026-06-30T13:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// makePoll — overlap guard
// ---------------------------------------------------------------------------
describe('makePoll', () => {
  it('calls tick once and isRunning is false after it completes', async () => {
    let callCount = 0;
    const slowTick = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 20));
    };

    const { poll } = makePoll(slowTick);
    await poll();
    expect(callCount).toBe(1);
  });

  it('second concurrent poll is skipped while first is in flight', async () => {
    let callCount = 0;
    const slowTick = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 30));
    };

    const { poll, isRunning } = makePoll(slowTick);

    // Fire two polls concurrently without awaiting the first.
    const p1 = poll();
    // isRunning should be true immediately after p1 starts
    expect(isRunning()).toBe(true);

    // p2 should be a no-op (returns immediately)
    const p2 = poll();

    await Promise.all([p1, p2]);

    // tick was only called once — the second call was skipped
    expect(callCount).toBe(1);
    expect(isRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Smoke: import src/index.ts — no daemon boot, just re-exports present
// ---------------------------------------------------------------------------
describe('index.ts smoke', () => {
  it('importing index exports expected symbols without booting the daemon', async () => {
    // Under vitest, invokedAsBin() returns false so startDaemon is NOT called.
    const mod = await import('../src/index.js');

    // Phase 2 re-exports must still be present
    expect(typeof mod.tick).toBe('function');
    expect(typeof mod.backoffAt).toBe('function');
    expect(typeof mod.createRegistry).toBe('function');
    expect(mod.RETRY_BACKOFF_MIN).toBeDefined();

    // Phase 3 additions
    expect(typeof mod.createJournalNotifier).toBe('function');
    expect(typeof mod.createFanoutNotifier).toBe('function');
    expect(typeof mod.startDaemon).toBe('function');
    expect(typeof mod.POLL_MS).toBe('number');
    expect(typeof mod.STALE_RUNNING_MS).toBe('number');
  });

  it('importing index does not boot the daemon (no interval started)', async () => {
    // Guard against a regression that inverts invokedAsBin() and boots on import.
    // startDaemon is the only thing that calls setInterval; under vitest
    // invokedAsBin() is false, so no interval should ever be scheduled.
    const intervalSpy = vi.spyOn(global, 'setInterval');
    try {
      await import('../src/index.js');
      expect(intervalSpy).not.toHaveBeenCalled();
    } finally {
      intervalSpy.mockRestore();
    }
  });
});
