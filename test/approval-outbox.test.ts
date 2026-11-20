import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, runMigrations, listActive, GateApprovalStore, listUnnotifiedApprovals } from '@justfortytwo/memory';
import { createApprovalOutbox, type ApprovalOutboxDeps } from '../src/approval-outbox.js';
import { POLL_MS, startDaemon } from '../src/daemon.js';
import { createRegistry } from '../src/registry.js';
import type { Handler, Notifier, RunCtx } from '../src/types.js';

const NOW = '2026-11-20T10:00:00.000Z';

function fakeDeps(rows: string[], handler: Handler): ApprovalOutboxDeps & { notified: string[]; stamped: string[][] } {
  const notified: string[] = [];
  const stamped: string[][] = [];
  return {
    notified,
    stamped,
    listUnnotified: () => rows.filter((id) => !stamped.flat().includes(id)).map((id) => ({ id })),
    markNotified: (ids) => { stamped.push(ids); },
    handler,
    enqueueRun: (fn) => fn(),
    notify: async (n) => { notified.push(n.text); },
  };
}

describe('createApprovalOutbox', () => {
  it('does nothing (no run) when no approval is waiting', async () => {
    const run = vi.fn(async () => ({ ok: true, text: 'x' }));
    const deps = fakeDeps([], { kind: 'notify_pending', run });
    expect(await createApprovalOutbox(deps).drain(NOW)).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs the handler with the ids, notifies, then stamps them', async () => {
    const run = vi.fn(async (_ctx: RunCtx) => ({ ok: true, text: 'approve?' }));
    const deps = fakeDeps(['pa_1', 'pa_2'], { kind: 'notify_pending', run });
    expect(await createApprovalOutbox(deps).drain(NOW)).toBe(2);
    expect(run.mock.calls[0]![0].payload).toEqual({ ids: ['pa_1', 'pa_2'] });
    expect(deps.notified).toEqual(['approve?']);
    expect(deps.stamped).toEqual([['pa_1', 'pa_2']]);
  });

  it('a later drain does not re-notify stamped approvals', async () => {
    const run = vi.fn(async () => ({ ok: true, text: 'approve?' }));
    const deps = fakeDeps(['pa_1'], { kind: 'notify_pending', run });
    const outbox = createApprovalOutbox(deps);
    await outbox.drain(NOW);
    await outbox.drain('2026-11-20T10:00:30.000Z');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a failed run stamps nothing and retries after the backoff', async () => {
    let calls = 0;
    const run = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('runner down');
      return { ok: true, text: 'approve?' };
    });
    const onError = vi.fn();
    const deps = { ...fakeDeps(['pa_1'], { kind: 'notify_pending', run }), onError };
    const outbox = createApprovalOutbox(deps);
    expect(await outbox.drain(NOW)).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(deps.stamped).toEqual([]);
    expect(await outbox.drain('2026-11-20T10:00:30.000Z')).toBe(0); // inside the 1-minute backoff
    expect(run).toHaveBeenCalledTimes(1);
    expect(await outbox.drain('2026-11-20T10:01:00.000Z')).toBe(1);
    expect(deps.stamped).toEqual([['pa_1']]);
  });

  it('a run with no text to send (e.g. runner timeout) stamps nothing and retries', async () => {
    let calls = 0;
    const run = vi.fn(async () => (++calls === 1 ? { ok: false, text: '' } : { ok: true, text: 'approve?' }));
    const onError = vi.fn();
    const deps = { ...fakeDeps(['pa_1'], { kind: 'notify_pending', run }), onError };
    const outbox = createApprovalOutbox(deps);
    expect(await outbox.drain(NOW)).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(deps.notified).toEqual([]);
    expect(deps.stamped).toEqual([]);
    expect(await outbox.drain('2026-11-20T10:01:00.000Z')).toBe(1);
    expect(deps.notified).toEqual(['approve?']);
  });

  it('a failed delivery stamps nothing', async () => {
    const run = vi.fn(async () => ({ ok: true, text: 'approve?' }));
    const onError = vi.fn();
    const deps = {
      ...fakeDeps(['pa_1'], { kind: 'notify_pending', run }),
      notify: async () => { throw new Error('telegram down'); },
      onError,
    };
    expect(await createApprovalOutbox(deps).drain(NOW)).toBe(0);
    expect(deps.stamped).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a failing list call is reported, not thrown', async () => {
    const onError = vi.fn();
    const outbox = createApprovalOutbox({
      listUnnotified: () => { throw new Error('db locked'); },
      markNotified: vi.fn(),
      handler: { kind: 'notify_pending', run: vi.fn() },
      enqueueRun: (fn) => fn(),
      notify: vi.fn(),
      onError,
    });
    await expect(outbox.drain(NOW)).resolves.toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Daemon + real DB: memory queues no job; the poll notifies every staged
// approval at least once, including one staged while a notification runs.
// ---------------------------------------------------------------------------
describe('startDaemon — approval outbox', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('notifies an approval staged while a notify run is in progress on the next poll', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scheduler-outbox-'));
    let dispose: (() => void) | undefined;
    try {
      const dbPath = join(dir, 'fortytwo.db');
      const h = openDb(dbPath);
      await runMigrations(h.k);
      const approvals = new GateApprovalStore(h);
      const first = await approvals.addPending({ tool: 'bash', target: 'ls', payload: {}, tier: 'ask', tool_use_id: 'tu_1' });
      expect(listActive(h)).toEqual([]); // memory produced no job

      let release!: () => void;
      let late = '';
      const seen: string[][] = [];
      const notifyPending: Handler = {
        kind: 'notify_pending',
        async run(ctx) {
          const ids = (ctx.payload as { ids: string[] }).ids;
          seen.push(ids);
          if (seen.length === 1) {
            // A second approval is staged while this notification is running.
            late = await approvals.addPending({ tool: 'bash', target: 'pwd', payload: {}, tier: 'ask', tool_use_id: 'tu_2' });
            await new Promise<void>((r) => { release = r; });
          }
          return { ok: true, text: `pending: ${ids.join(',')}` };
        },
      };
      const sent: string[] = [];
      const extra: Notifier = { notify: async (n) => { sent.push(n.text); } };

      vi.useFakeTimers();
      dispose = await startDaemon({ dbPath, root: dir, registry: createRegistry([notifyPending]), extraNotifiers: [extra] });

      await vi.advanceTimersByTimeAsync(POLL_MS); // poll 1: notify run starts, stays in flight
      expect(seen).toEqual([[first]]);
      await vi.advanceTimersByTimeAsync(POLL_MS); // overlap guard: poll skipped
      expect(seen).toHaveLength(1);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toEqual([`pending: ${first}`]);
      expect(listUnnotifiedApprovals(h).map((a) => a.id)).toEqual([late]);

      await vi.advanceTimersByTimeAsync(POLL_MS); // next poll picks up the late one
      expect(seen).toEqual([[first], [late]]);
      expect(sent).toEqual([`pending: ${first}`, `pending: ${late}`]);
      expect(listUnnotifiedApprovals(h)).toEqual([]);

      await vi.advanceTimersByTimeAsync(POLL_MS); // nothing left: no re-notification
      expect(seen).toHaveLength(2);
      await h.k.destroy();
    } finally {
      dispose?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
