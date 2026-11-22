import type { Handler, RunCtx, RunResult } from '../types.js';

export interface ReembedOneFn {
  (id: number): Promise<boolean>;
}

/**
 * `reembed_memory` — re-embeds a stored memory in-place after an
 * embedder/model change. Nothing enqueues it since memory 2.0.0 (`store()`
 * embeds in its own write); kept for jobs queued by older installs. Runs with
 * no LLM call (no notify — returns null).
 */
export function makeReembedHandler(reembedOne: ReembedOneFn): Handler {
  return {
    kind: 'reembed_memory',
    async run(ctx: RunCtx): Promise<RunResult | null> {
      const payload = ctx.payload as { id?: unknown };
      const id = typeof payload?.id === 'number' ? payload.id : undefined;
      if (id == null) return null; // malformed payload — skip silently
      await reembedOne(id);
      return null; // no notification: pure background maintenance
    },
  };
}
