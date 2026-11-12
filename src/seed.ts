import type { RecurringDef } from './handlers/index.js';

// Minimal injected store surface: only what seed needs (testable with a fake).
export interface SeedStore {
  listActive(): Array<{ id: number; kind: string; recurrence: string | null }>;
  enqueue(j: { kind: string; run_at: string; recurrence: string }): number;
  setRecurrence(id: number, recurrence: string, runAt: string): void;
}

/**
 * Seeds recurring job rows from the authoritative in-code definitions.
 *
 * For each def:
 * - If no active row with that kind + a recurrence exists → INSERT (first boot).
 * - If the existing row's cron differs from the def → UPDATE (cron changed in code).
 * - Otherwise → leave it alone (idempotent on subsequent boots).
 *
 * `recurrenceNext` is injected so seed is testable without croner.
 */
export function seedRecurring(
  store: SeedStore,
  defs: RecurringDef[],
  now: string,
  recurrenceNext: (cron: string, now: string) => string,
): void {
  const active = store.listActive();

  for (const def of defs) {
    const existing = active.find(
      (j) => j.kind === def.kind && j.recurrence != null,
    );

    if (!existing) {
      store.enqueue({
        kind: def.kind,
        run_at: recurrenceNext(def.cron, now),
        recurrence: def.cron,
      });
    } else if (existing.recurrence !== def.cron) {
      store.setRecurrence(existing.id, def.cron, recurrenceNext(def.cron, now));
    }
    // else: unchanged — leave the existing row as-is
  }
}

// Minimal injected store surface for retiring rows (testable with a fake).
export interface RetireStore {
  listActive(): Array<{ id: number; kind: string; recurrence: string | null }>;
  /** Marks the job done WITHOUT rescheduling it. */
  complete(id: number): void;
}

/**
 * Retires the active recurring rows of the given kinds, so a built-in job the
 * owner switched off stops firing. `seedRecurring` only ever inserts or
 * updates, so without this a disabled job's existing row would keep running.
 *
 * Only rows with a recurrence are touched: a one-off job that happens to share
 * a kind is left alone. Re-enabling the kind later makes `seedRecurring`
 * insert a fresh row on the next boot.
 *
 * @returns the ids that were retired.
 */
export function retireRecurring(store: RetireStore, kinds: string[]): number[] {
  const retired: number[] = [];
  for (const job of store.listActive()) {
    if (job.recurrence != null && kinds.includes(job.kind)) {
      store.complete(job.id);
      retired.push(job.id);
    }
  }
  return retired;
}
