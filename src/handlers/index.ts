import { createRegistry } from '../registry.js';
import type { Handler, Registry } from '../types.js';
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
  /** Cron expression (croner format), read in the install's time zone (UTC unless one is set). */
  cron: string;
  /** Prompt sent to the runner when the job fires and hasWork is true. */
  trigger: string;
}

/**
 * A built-in recurring job the owner can switch on or off per install
 * (see `../schedules.ts`).
 */
export interface BuiltinSchedule extends RecurringDef {
  /** One line shown to the owner when `fortytwo init` asks which jobs to run. */
  description: string;
  /**
   * Set when the job's method lives in a Claude Code skill. `trigger` is used
   * when that skill is installed; `fallback` when it is not.
   */
  skill?: {
    /** Skill directory name, e.g. `daily-briefing`. */
    name: string;
    /** Self-contained prompt: states the task and its limits without the skill. */
    fallback: string;
  };
}

/**
 * Canonical set of built-in recurring jobs. Seeds are idempotent: the daemon
 * calls `seedRecurring` with the ENABLED ones on every boot and only inserts
 * or updates rows when the definition changes; disabled ones are retired.
 *
 * The skills named here ship as templates in `@justfortytwo/persona` and are
 * rendered into the workspace by the installer. The scheduler must not assume
 * they exist: a standalone daemon, or an install that predates them, gets the
 * `fallback` prompt instead.
 */
export const RECURRING_DEFS: BuiltinSchedule[] = [
  {
    kind: 'daily_briefing',
    cron: '57 7 * * *',
    description: 'Daily briefing: a morning rundown of what needs you today (07:57)',
    trigger: 'Run the daily-briefing skill and send me the rundown for today.',
    skill: {
      name: 'daily-briefing',
      fallback:
        'Daily briefing. No daily-briefing skill is installed in this workspace; if one is available to you anyway, use it instead of the steps below. ' +
        'Give me the rundown for today from sources you can actually read: pending approvals, reminders and open threads, what we discussed or decided in the last 24 hours, and today\'s calendar or inbox only if those tools are connected. ' +
        'Lead with what needs my decision. Leave out any section with nothing in it, and say so in one line if there is nothing at all. ' +
        'Keep it short enough to read on a phone. Read only: take no external action.',
    },
  },
  {
    kind: 'sweep',
    cron: '3 13,18 * * *',
    description: 'Open-thread sweep: a one-line status, only when approvals are pending (13:03 and 18:03)',
    trigger: 'Open-thread sweep: check pending approvals and threads awaiting a reply; give me a one-line status.',
  },
  {
    kind: 'learn_review',
    cron: '17 9 * * 0',
    description: 'Weekly learn-review: proposes rules and cleanups from the last 7 days (Sundays 09:17)',
    trigger: 'Run the learn-review skill for the last 7 days. Propose only: nothing is installed or approved.',
    skill: {
      name: 'learn-review',
      fallback:
        'Weekly learn-review. No learn-review skill is installed in this workspace; if one is available to you anyway, use it instead of the steps below. ' +
        'Review the last 7 days of our conversations and of stored memories for: corrections I had to repeat, preferences or rules I stated, recurring tasks worth turning into a skill, and duplicate or outdated memories. ' +
        'Propose only. If context/rules/PROPOSED.md exists, add each candidate rule there with the evidence it comes from. Never edit context/rules/APPROVED.md, and install or delete nothing. ' +
        'Finish with a short numbered list I can approve or reject by number. If nothing is worth proposing, say so in one line.',
    },
  },
];

/**
 * The prompt for one run of a built-in job: `trigger` when the job needs no
 * skill or its skill is installed, otherwise the self-contained `fallback`.
 */
export function triggerFor(def: BuiltinSchedule, hasSkill: (name: string) => boolean): string {
  if (!def.skill || hasSkill(def.skill.name)) return def.trigger;
  return def.skill.fallback;
}

// ---------------------------------------------------------------------------
// buildRegistry — assembles ALL handlers with injected deps
// ---------------------------------------------------------------------------

export interface RegistryDeps {
  oneiros?: Handler;
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
  /**
   * Whether a Claude Code skill is installed, asked on every run. Defaults to
   * "yes" so a caller that does not track skills gets the plain triggers.
   */
  hasSkill?: (name: string) => boolean;
}

export function buildRegistry(deps: RegistryDeps): Registry {
  const { runner, countPendingApprovals, recentCount, reembedOne } = deps;
  const hasSkill = deps.hasSkill ?? (() => true);
  const trigger = (kind: string) => (): string =>
    triggerFor(RECURRING_DEFS.find((d) => d.kind === kind)!, hasSkill);

  return createRegistry([
    ...(deps.oneiros ? [deps.oneiros] : []),
    // --- Recurring: ungated ---
    makeRecurringHandler({
      kind: 'daily_briefing',
      trigger: trigger('daily_briefing'),
      runner,
    }),

    // --- Recurring: gated on pending approvals > 0 ---
    makeRecurringHandler({
      kind: 'sweep',
      trigger: trigger('sweep'),
      runner,
      hasWork: async () => countPendingApprovals() > 0,
    }),

    // --- Recurring: gated on recent memories > 0 ---
    makeRecurringHandler({
      kind: 'learn_review',
      trigger: trigger('learn_review'),
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
