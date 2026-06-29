import type { Job, Notification, Registry, RunCtx } from './types.js';

export interface TickDeps {
  claimDue(now: string): Job[];
  complete(id: number, opts: { reschedule?: string }): void;
  fail(id: number, error: string, opts?: { retryAt?: string }): void;
  registry: Registry;
  recurrenceNext(cron: string, now: string): string;
  enqueueRun(fn: () => Promise<void>): Promise<void>;
  notify(n: Notification): Promise<void>;
}

export const RETRY_BACKOFF_MIN = [1, 5, 30] as const;

export function backoffAt(now: string, attempts: number): string {
  const mins = RETRY_BACKOFF_MIN[Math.min(attempts, RETRY_BACKOFF_MIN.length - 1)]!;
  return new Date(Date.parse(now) + mins * 60_000).toISOString();
}

export async function tick(deps: TickDeps, now: string): Promise<void> {
  for (const job of deps.claimDue(now)) {
    const handler = deps.registry.get(job.kind);
    if (!handler) {
      deps.fail(job.id, `no handler for kind '${job.kind}'`);
      continue;
    }

    const reschedule = job.recurrence
      ? { reschedule: deps.recurrenceNext(job.recurrence, now) }
      : {};

    let ctx: RunCtx;
    try {
      ctx = { now, payload: job.payload ? JSON.parse(job.payload) : undefined };
      if (handler.hasWork && !(await handler.hasWork(ctx))) {
        deps.complete(job.id, reschedule);
        continue;
      }
    } catch (e: unknown) {
      deps.fail(
        job.id,
        e instanceof Error ? e.message : String(e),
        { retryAt: backoffAt(now, job.attempts) },
      );
      continue;
    }

    await deps.enqueueRun(async () => {
      try {
        const res = await handler.run(ctx);
        if (res && res.text) await deps.notify({ kind: job.kind, text: res.text });
        deps.complete(job.id, reschedule);
      } catch (e: unknown) {
        deps.fail(
          job.id,
          e instanceof Error ? e.message : String(e),
          { retryAt: backoffAt(now, job.attempts) },
        );
      }
    });
  }
}
