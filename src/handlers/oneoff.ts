import type { Handler, RunCtx, RunResult } from '../types.js';
import type { RunnerFn } from './recurring.js';

/** Payload shape expected by one-off handlers that carry text. */
interface TextPayload {
  text?: string;
  id?: number;
}

function textPayload(ctx: RunCtx): TextPayload {
  if (ctx.payload && typeof ctx.payload === 'object') {
    return ctx.payload as TextPayload;
  }
  return {};
}

/**
 * `notify_pending` — fires when a tool-call approval is staged and awaiting
 * the owner's decision. Summarises the pending approval(s) via LLM.
 */
export function makeNotifyPendingHandler(runner: RunnerFn): Handler {
  return {
    kind: 'notify_pending',
    async run(ctx: RunCtx): Promise<RunResult | null> {
      const { id } = textPayload(ctx);
      const idClause = id != null ? ` (approval id: ${id})` : '';
      const r = await runner(
        `A tool call is awaiting your approval${idClause}. Summarize the pending approval(s) and ask me to approve or deny.`,
      );
      return { ok: r.ok, text: r.text };
    },
  };
}

/**
 * `reply` — fires when an inbound message needs a reply. Prompt is constructed
 * from `ctx.payload.text`.
 */
export function makeReplyHandler(runner: RunnerFn): Handler {
  return {
    kind: 'reply',
    async run(ctx: RunCtx): Promise<RunResult | null> {
      const { text = '' } = textPayload(ctx);
      const r = await runner(`Handle this pending message: ${text}`);
      return { ok: r.ok, text: r.text };
    },
  };
}

/**
 * `reminder` — fires at a scheduled reminder time. Prompt is constructed from
 * `ctx.payload.text`.
 */
export function makeReminderHandler(runner: RunnerFn): Handler {
  return {
    kind: 'reminder',
    async run(ctx: RunCtx): Promise<RunResult | null> {
      const { text = '' } = textPayload(ctx);
      const r = await runner(`Reminder: ${text}`);
      return { ok: r.ok, text: r.text };
    },
  };
}
