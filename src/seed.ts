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
