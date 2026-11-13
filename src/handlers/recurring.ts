import type { Handler, RunCtx, RunResult } from '../types.js';

export interface RunnerFn {
  /** `raw` is the parsed `claude -p` result, when the caller has it (see ../held.ts). */
  (prompt: string): Promise<{ ok: boolean; text: string; raw?: unknown }>;
}

/**
 * Factory for recurring LLM-backed handlers. Optionally gated by a `hasWork`
 * predicate — if the gate returns false the tick skips the run (job is
 * rescheduled without consuming LLM quota).
 */
export function makeRecurringHandler(opts: {
  kind: string;
  /**
   * Prompt for the run. A function is evaluated on every run, so the prompt can
   * follow the install's current state (e.g. a skill added after boot).
   */
  trigger: string | (() => string);
  runner: RunnerFn;
  hasWork?: () => Promise<boolean>;
}): Handler {
  return {
    kind: opts.kind,
    async hasWork(_ctx: RunCtx): Promise<boolean> {
      if (!opts.hasWork) return true;
      return opts.hasWork();
    },
    async run(_ctx: RunCtx): Promise<RunResult | null> {
      const r = await opts.runner(typeof opts.trigger === 'function' ? opts.trigger() : opts.trigger);
      return { ok: r.ok, text: r.text };
    },
  };
}
