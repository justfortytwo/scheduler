import { createRegistry } from '../registry.js';
import type { Registry } from '../types.js';
import type { RunnerFn } from './recurring.js';
import type { ReembedOneFn } from './reembed.js';
import { makeRecurringHandler } from './recurring.js';
import { makeNotifyPendingHandler, makeReplyHandler, makeReminderHandler } from './oneoff.js';
import { makeReembedHandler } from './reembed.js';

// ---------------------------------------------------------------------------
// Recurring job definitions (code-authoritative cron schedule + trigger text)
// ---------------------------------------------------------------------------

export interface RecurringDef {
  kind: string;
  /** UTC cron expression (croner format). */
  cron: string;
  /** Prompt sent to the runner when the job fires and hasWork is true. */
  trigger: string;
}

/**
 * Canonical set of recurring jobs. Seeds are idempotent: the daemon calls
 * `seedRecurring(store, RECURRING_DEFS, ...)` on every boot and only inserts
 * or updates rows when the definition changes.
 */
export const RECURRING_DEFS: RecurringDef[] = [
  {
    kind: 'daily_briefing',
    cron: '57 7 * * *',
    trigger: 'Run the daily-briefing skill and send me the rundown for today.',
  },
  {
    kind: 'sweep',
    cron: '3 13,18 * * *',
    trigger: 'Open-thread sweep: check pending approvals and threads awaiting a reply; give me a one-line status.',
  },
  {
    kind: 'learn_review',
    cron: '17 9 * * 0',
    trigger: 'Run the learn-review skill: scan the recent Journal for patterns worth promoting. Propose-only — nothing installed.',
  },
];

// ---------------------------------------------------------------------------
// buildRegistry — assembles ALL handlers with injected deps
// ---------------------------------------------------------------------------

export interface RegistryDeps {
  /** Bound `createRunner()` return value. */
  runner: RunnerFn;
  /** Returns the count of pending approvals (injected so tests can fake it). */
  countPendingApprovals: () => number;
  /**
   * Returns the count of memories written in the last 7 days
   * (injected so tests can fake it).
   */
  recentCount: () => Promise<number>;
  /** Re-embeds one memory by id in-place (no LLM). */
  reembedOne: ReembedOneFn;
}

export function buildRegistry(deps: RegistryDeps): Registry {
  const { runner, countPendingApprovals, recentCount, reembedOne } = deps;

  return createRegistry([
    // --- Recurring: ungated ---
    makeRecurringHandler({
      kind: 'daily_briefing',
      trigger: RECURRING_DEFS.find((d) => d.kind === 'daily_briefing')!.trigger,
      runner,
    }),

    // --- Recurring: gated on pending approvals > 0 ---
    makeRecurringHandler({
      kind: 'sweep',
      trigger: RECURRING_DEFS.find((d) => d.kind === 'sweep')!.trigger,
      runner,
      hasWork: async () => countPendingApprovals() > 0,
    }),

    // --- Recurring: gated on recent memories > 0 ---
    makeRecurringHandler({
      kind: 'learn_review',
      trigger: RECURRING_DEFS.find((d) => d.kind === 'learn_review')!.trigger,
      runner,
      hasWork: async () => (await recentCount()) > 0,
    }),

    // --- One-off: no gate ---
    makeNotifyPendingHandler(runner),
    makeReplyHandler(runner),
    makeReminderHandler(runner),

    // --- Maintenance: no LLM, no notification ---
    makeReembedHandler(reembedOne),
  ]);
}

export { makeRecurringHandler } from './recurring.js';
export { makeNotifyPendingHandler, makeReplyHandler, makeReminderHandler } from './oneoff.js';
export { makeReembedHandler } from './reembed.js';
