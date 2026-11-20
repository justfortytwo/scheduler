// approval-outbox.ts — tell the owner about staged approvals.
//
// Memory does not queue a job when the safety gate stages an approval: the
// `approvals` row is the outbox, with `notified_at` NULL until someone has told
// the owner. The daemon calls `drain` on every poll (POLL_MS, ~30s): it lists the
// un-notified pending approvals, runs the `notify_pending` handler for them,
// delivers its text, and only then stamps `notified_at`. So every staged approval
// is notified at least once, including one staged while a notification is
// already running (it is still NULL and is picked up by the next poll).
//
// Latency is up to one poll period plus any job run ahead of it in the queue.
// The `sweep` gate cannot do this job: it is cron-only (twice a day).

import { backoffAt } from './tick.js';
import type { Handler, Notification } from './types.js';

export interface ApprovalOutboxDeps {
  /** Pending approvals with `notified_at IS NULL` (memory's `listUnnotifiedApprovals`). */
  listUnnotified(): Array<{ id: string }>;
  /** Stamps `notified_at` on these ids (memory's `markApprovalsNotified`). */
  markNotified(ids: string[], at: string): void;
  /** The `notify_pending` handler; receives `payload: { ids }`. */
  handler: Handler;
  /** Same concurrency-1 queue as `tick`, so a notification never runs beside a job. */
  enqueueRun(fn: () => Promise<void>): Promise<void>;
  notify(n: Notification): Promise<void>;
  /** Called when a drain fails; the approvals stay un-notified for a later poll. */
  onError?(e: unknown): void;
}

export interface ApprovalOutbox {
  /** One pass. Returns how many approvals were stamped as notified. */
  drain(now: string): Promise<number>;
}

/**
 * A failed pass (the run threw, produced no text, or delivery threw) leaves the approvals un-notified and waits
 * `backoffAt` (1, 5, then 30 minutes) before trying again, so a broken runner
 * does not start a `claude` turn on every poll.
 */
export function createApprovalOutbox(deps: ApprovalOutboxDeps): ApprovalOutbox {
  let failures = 0;
  let retryAt: string | null = null;

  return {
    async drain(now: string): Promise<number> {
      if (retryAt !== null && now < retryAt) return 0;
      let stamped = 0;
      const failed = (e: unknown): void => {
        retryAt = backoffAt(now, failures);
        failures++;
        deps.onError?.(e);
      };
      try {
        const ids = deps.listUnnotified().map((a) => a.id);
        if (ids.length === 0) return 0;
        await deps.enqueueRun(async () => {
          try {
            const res = await deps.handler.run({ now, payload: { ids } });
            // Nothing to send (e.g. the runner timed out: ok:false, text:'') means
            // the owner was not told: stamp nothing, retry after the backoff.
            if (!res || !res.text) throw new Error('notify_pending produced no text to send');
            await deps.notify({ kind: deps.handler.kind, text: res.text });
            deps.markNotified(ids, now);
            stamped = ids.length;
            failures = 0;
            retryAt = null;
          } catch (e: unknown) {
            failed(e);
          }
        });
      } catch (e: unknown) {
        failed(e);
      }
      return stamped;
    },
  };
}
