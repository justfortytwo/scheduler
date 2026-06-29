import { describe, it, expect, vi } from 'vitest';
import { tick, backoffAt, type TickDeps } from '../src/tick.js';
import { createRegistry } from '../src/registry.js';
import type { Job, Handler, Notification } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 1,
    kind: 'test',
    payload: null,
    run_at: '2026-06-29T13:00:00.000Z',
    recurrence: '*/5 * * * *',
    status: 'claimed',
    attempts: 0,
    ...overrides,
  };
}

function makeDeps(
  jobs: Job[],
  handler: Handler,
  overrides: Partial<TickDeps> = {},
): TickDeps & {
  completeCalls: Array<[number, { reschedule?: string }]>;
  failCalls: Array<[number, string, { retryAt?: string } | undefined]>;
  notifyCalls: Notification[];
} {
  const completeCalls: Array<[number, { reschedule?: string }]> = [];
  const failCalls: Array<[number, string, { retryAt?: string } | undefined]> = [];
  const notifyCalls: Notification[] = [];

  const deps: TickDeps = {
    claimDue: (_now: string) => jobs,
    complete: (id, opts) => completeCalls.push([id, opts]),
    fail: (id, error, opts) => failCalls.push([id, error, opts]),
    registry: createRegistry([handler]),
    recurrenceNext: (_cron: string, _now: string) => '2026-06-29T13:05:00.000Z',
    enqueueRun: (fn) => fn(),
    notify: async (n) => { notifyCalls.push(n); },
    ...overrides,
  };

  return Object.assign(deps, { completeCalls, failCalls, notifyCalls });
}

// ---------------------------------------------------------------------------
// backoffAt unit tests
// ---------------------------------------------------------------------------

describe('backoffAt', () => {
  it('attempts=0 → +1 minute', () => {
    expect(backoffAt('2026-06-29T13:00:00.000Z', 0)).toBe('2026-06-29T13:01:00.000Z');
  });

  it('attempts=1 → +5 minutes', () => {
    expect(backoffAt('2026-06-29T13:00:00.000Z', 1)).toBe('2026-06-29T13:05:00.000Z');
  });

  it('attempts=2 → +30 minutes', () => {
    expect(backoffAt('2026-06-29T13:00:00.000Z', 2)).toBe('2026-06-29T13:30:00.000Z');
  });

  it('attempts=5 → +30 minutes (clamped)', () => {
    expect(backoffAt('2026-06-29T13:00:00.000Z', 5)).toBe('2026-06-29T13:30:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// tick() tests
// ---------------------------------------------------------------------------

describe('tick()', () => {
  const NOW = '2026-06-29T13:00:00.000Z';
  const NEXT = '2026-06-29T13:05:00.000Z';

  it('gate false → skip: complete with reschedule, run never called, notify never called', async () => {
    const runSpy = vi.fn().mockResolvedValue({ ok: true, text: 'hello' });
    const handler: Handler = {
      kind: 'test',
      hasWork: async () => false,
      run: runSpy,
    };
    const job = makeJob({ recurrence: '*/5 * * * *' });
    const deps = makeDeps([job], handler);

    await tick(deps, NOW);

    expect(runSpy).not.toHaveBeenCalled();
    expect(deps.notifyCalls).toHaveLength(0);
    expect(deps.completeCalls).toHaveLength(1);
    expect(deps.completeCalls[0]).toEqual([job.id, { reschedule: NEXT }]);
    expect(deps.failCalls).toHaveLength(0);
  });

  it('gate true → run+notify+reschedule', async () => {
    const handler: Handler = {
      kind: 'test',
      hasWork: async () => true,
      run: async () => ({ ok: true, text: 'done' }),
    };
    const job = makeJob({ recurrence: '*/5 * * * *' });
    const deps = makeDeps([job], handler);

    await tick(deps, NOW);

    expect(deps.notifyCalls).toHaveLength(1);
    expect(deps.notifyCalls[0]).toEqual({ kind: 'test', text: 'done' });
    expect(deps.completeCalls).toHaveLength(1);
    expect(deps.completeCalls[0]).toEqual([job.id, { reschedule: NEXT }]);
    expect(deps.failCalls).toHaveLength(0);
  });

  it('one-off success → complete without reschedule key', async () => {
    const handler: Handler = {
      kind: 'test',
      run: async () => ({ ok: true, text: 'one-off done' }),
    };
    const job = makeJob({ recurrence: null });
    const deps = makeDeps([job], handler);

    await tick(deps, NOW);

    expect(deps.completeCalls).toHaveLength(1);
    expect(deps.completeCalls[0]).toEqual([job.id, {}]);
    expect(deps.failCalls).toHaveLength(0);
  });

  it('run throws → fail with backoff retryAt, complete NOT called', async () => {
    const handler: Handler = {
      kind: 'test',
      run: async () => { throw new Error('boom'); },
    };
    const job = makeJob({ attempts: 0 });
    const deps = makeDeps([job], handler);

    await tick(deps, NOW);

    expect(deps.failCalls).toHaveLength(1);
    expect(deps.failCalls[0]![0]).toBe(job.id);
    expect(deps.failCalls[0]![1]).toContain('boom');
    expect(deps.failCalls[0]![2]).toEqual({ retryAt: backoffAt(NOW, 0) });
    expect(deps.completeCalls).toHaveLength(0);
  });

  it('no handler → fail with /no handler/, loop continues', async () => {
    const handler: Handler = {
      kind: 'other',
      run: async () => null,
    };
    const job = makeJob({ kind: 'unknown' });
    const deps = makeDeps([job], handler);

    await tick(deps, NOW);

    expect(deps.failCalls).toHaveLength(1);
    expect(deps.failCalls[0]![1]).toMatch(/no handler/);
    expect(deps.completeCalls).toHaveLength(0);
  });

  it('gateless handler always runs', async () => {
    const runSpy = vi.fn().mockResolvedValue({ ok: true, text: '' });
    const handler: Handler = {
      kind: 'test',
      // no hasWork
      run: runSpy,
    };
    const job = makeJob({ recurrence: null });
    const deps = makeDeps([job], handler);

    await tick(deps, NOW);

    expect(runSpy).toHaveBeenCalledOnce();
    expect(deps.completeCalls).toHaveLength(1);
  });

  it('malformed payload on job 1 → fail just job 1, job 2 still runs+completes', async () => {
    const runSpy = vi.fn().mockResolvedValue({ ok: true, text: '' });
    const handlerBad: Handler = { kind: 'bad', run: vi.fn().mockResolvedValue(null) };
    const handlerGood: Handler = { kind: 'good', run: runSpy };

    const job1 = makeJob({ id: 1, kind: 'bad', payload: '{bad json', attempts: 2 });
    const job2 = makeJob({ id: 2, kind: 'good', recurrence: null });

    const deps = makeDeps([job1, job2], handlerBad, {
      registry: createRegistry([handlerBad, handlerGood]),
    });

    await tick(deps, NOW);

    // job 1 failed (with backoff) before its handler ran
    expect(handlerBad.run).not.toHaveBeenCalled();
    expect(deps.failCalls).toHaveLength(1);
    expect(deps.failCalls[0]![0]).toBe(job1.id);
    expect(deps.failCalls[0]![2]).toEqual({ retryAt: backoffAt(NOW, job1.attempts) });

    // job 2 was NOT dropped — the batch continued
    expect(runSpy).toHaveBeenCalledOnce();
    expect(deps.completeCalls).toHaveLength(1);
    expect(deps.completeCalls[0]).toEqual([job2.id, {}]);
  });

  it('no handler on job 1 → fail just job 1, job 2 still runs+completes', async () => {
    const runSpy = vi.fn().mockResolvedValue({ ok: true, text: '' });
    const handlerGood: Handler = { kind: 'known', run: runSpy };

    const job1 = makeJob({ id: 1, kind: 'unknown' });
    const job2 = makeJob({ id: 2, kind: 'known', recurrence: null });

    const deps = makeDeps([job1, job2], handlerGood);

    await tick(deps, NOW);

    expect(deps.failCalls).toHaveLength(1);
    expect(deps.failCalls[0]![0]).toBe(job1.id);
    expect(deps.failCalls[0]![1]).toMatch(/no handler/);

    // job 2 was NOT dropped — the loop continued
    expect(runSpy).toHaveBeenCalledOnce();
    expect(deps.completeCalls).toHaveLength(1);
    expect(deps.completeCalls[0]).toEqual([job2.id, {}]);
  });
});
