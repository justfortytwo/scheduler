import { describe, it, expect, vi } from 'vitest';
import { seedRecurring, type SeedStore } from '../src/seed.js';
import { RECURRING_DEFS } from '../src/handlers/index.js';

const NOW = '2026-06-30T09:00:00.000Z';

// Fake recurrenceNext: just appends the cron as a comment to make it testable.
function fakeNext(cron: string, _now: string): string {
  return `2026-06-30T10:00:00.000Z|${cron}`;
}

function makeStore(initial: Array<{ id: number; kind: string; recurrence: string | null }> = []): SeedStore & {
  rows: typeof initial;
  enqueueArgs: Array<{ kind: string; run_at: string; recurrence: string }>;
  setRecurrenceArgs: Array<{ id: number; recurrence: string; runAt: string }>;
} {
  let nextId = 100;
  const rows = [...initial];
  const enqueueArgs: Array<{ kind: string; run_at: string; recurrence: string }> = [];
  const setRecurrenceArgs: Array<{ id: number; recurrence: string; runAt: string }> = [];

  return {
    rows,
    enqueueArgs,
    setRecurrenceArgs,
    listActive: () => rows,
    enqueue(j) {
      const id = nextId++;
      rows.push({ id, kind: j.kind, recurrence: j.recurrence });
      enqueueArgs.push(j);
      return id;
    },
    setRecurrence(id, recurrence, runAt) {
      const row = rows.find((r) => r.id === id);
      if (row) row.recurrence = recurrence;
      setRecurrenceArgs.push({ id, recurrence, runAt });
    },
  };
}

describe('seedRecurring', () => {
  it('inserts one row per RECURRING_DEF on first boot (empty store)', () => {
    const store = makeStore();
    seedRecurring(store, RECURRING_DEFS, NOW, fakeNext);
    expect(store.enqueueArgs).toHaveLength(RECURRING_DEFS.length);
    for (const def of RECURRING_DEFS) {
      expect(store.enqueueArgs.some((a) => a.kind === def.kind && a.recurrence === def.cron)).toBe(true);
    }
  });

  it('is idempotent: seeding twice does not create duplicate rows', () => {
    const store = makeStore();
    seedRecurring(store, RECURRING_DEFS, NOW, fakeNext);
    seedRecurring(store, RECURRING_DEFS, NOW, fakeNext);
    // Only RECURRING_DEFS.length inserts — the second pass finds existing rows.
    expect(store.enqueueArgs).toHaveLength(RECURRING_DEFS.length);
    expect(store.setRecurrenceArgs).toHaveLength(0);
  });

  it('calls setRecurrence (not enqueue) when cron expression changed in code', () => {
    const store = makeStore([
      { id: 1, kind: 'sweep', recurrence: '0 12 * * *' }, // old cron
    ]);
    const newDef = [{ kind: 'sweep', cron: '3 13,18 * * *', trigger: 'sweep' }];
    seedRecurring(store, newDef, NOW, fakeNext);
    expect(store.enqueueArgs).toHaveLength(0);
    expect(store.setRecurrenceArgs).toHaveLength(1);
    expect(store.setRecurrenceArgs[0]!.id).toBe(1);
    expect(store.setRecurrenceArgs[0]!.recurrence).toBe('3 13,18 * * *');
  });

  it('leaves an existing row unchanged when cron matches', () => {
    const existingCron = RECURRING_DEFS[0]!.cron;
    const store = makeStore([{ id: 5, kind: RECURRING_DEFS[0]!.kind, recurrence: existingCron }]);
    seedRecurring(store, [RECURRING_DEFS[0]!], NOW, fakeNext);
    expect(store.enqueueArgs).toHaveLength(0);
    expect(store.setRecurrenceArgs).toHaveLength(0);
  });

  it('does not treat a one-off row (recurrence=null) as the recurring row', () => {
    // A one-off job with the same kind but recurrence=null should not block seeding.
    const store = makeStore([{ id: 9, kind: 'sweep', recurrence: null }]);
    const newDef = [{ kind: 'sweep', cron: '3 13,18 * * *', trigger: 'sweep' }];
    seedRecurring(store, newDef, NOW, fakeNext);
    expect(store.enqueueArgs).toHaveLength(1);
    expect(store.enqueueArgs[0]!.recurrence).toBe('3 13,18 * * *');
  });
});
