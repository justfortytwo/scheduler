import type { Handler, RunCtx, RunResult } from '../types.js';

export interface RunnerFn {
  (prompt: string): Promise<{ ok: boolean; text: string }>;
}

/**
 * Factory for recurring LLM-backed handlers. Optionally gated by a `hasWork`
 * predicate — if the gate returns false the tick skips the run (job is
 * rescheduled without consuming LLM quota).
 */
export function makeRecurringHandler(opts: {
  kind: string;
  trigger: string;
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
      const r = await opts.runner(opts.trigger);
      return { ok: r.ok, text: r.text };
    },
  };
}
