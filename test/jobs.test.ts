import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, runMigrations, type DbHandles } from '@justfortytwo/memory';
import { runSchedulerMigrations } from '../src/migrate.js';
import { enqueue, claimDue, complete, fail, listActive, requeueStale, existsPending, setRecurrence, cancel } from '../src/jobs.js';

// Moved from @justfortytwo/memory (test/jobs.test.ts) with the job API (scheduler#2).

let dir: string, h: DbHandles;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ft-jobs-'));
  h = openDb(join(dir, 'm.db'));
  await runMigrations(h.k);
  await runSchedulerMigrations(h.k);
});
afterEach(async () => { await h.k.destroy(); h.raw.close(); rmSync(dir, { recursive: true, force: true }); });

describe('JobStore', () => {
  it('enqueue + claimDue returns due pending rows and flips them to running', () => {
    enqueue(h, { kind: 'reminder', run_at: '2020-01-01T00:00:00Z' });
    const future = enqueue(h, { kind: 'reminder', run_at: '2999-01-01T00:00:00Z' });
    const claimed = claimDue(h, '2026-06-29T00:00:00Z');
    expect(claimed.map((j) => j.kind)).toEqual(['reminder']);          // only the due one
    expect(claimed[0]!.status).toBe('running');
    expect(claimDue(h, '2026-06-29T00:00:00Z')).toEqual([]);            // already claimed → none
    expect(future).toBeGreaterThan(0);
  });

  it('complete with reschedule sets a recurring row back to pending at the new run_at', () => {
    const id = enqueue(h, { kind: 'sweep', run_at: '2020-01-01T00:00:00Z', recurrence: '0 13 * * *' });
    claimDue(h, '2026-06-29T00:00:00Z');
    complete(h, id, { reschedule: '2026-06-30T13:00:00Z' });
    const row = listActive(h).find((j) => j.id === id)!;
    expect(row.status).toBe('pending');
    expect(row.run_at).toBe('2026-06-30T13:00:00Z');
  });

  it('fail increments attempts; marks failed at the cap', () => {
    const id = enqueue(h, { kind: 'reminder', run_at: '2020-01-01T00:00:00Z' });
    claimDue(h, '2026-06-29T00:00:00Z');
    fail(h, id, 'boom', { retryAt: '2026-06-29T00:05:00Z' });          // attempt 1 → pending
    const after1 = claimDue(h, '2026-06-29T01:00:00Z')[0]!;
    expect(after1.attempts).toBe(1); expect(after1.status).toBe('running');
    fail(h, id, 'boom', {}); fail(h, id, 'boom', {});                  // reach cap (3) → failed
    expect(listActive(h).find((j) => j.id === id)).toBeUndefined();
  });

  it('requeueStale returns stale running rows to pending', () => {
    const id = enqueue(h, { kind: 'reminder', run_at: '2020-01-01T00:00:00Z' });
    claimDue(h, '2026-06-29T00:00:00Z');
    requeueStale(h, '2999-01-01T00:00:00Z');                           // threshold far future → everything stale
    expect(claimDue(h, '2026-06-29T02:00:00Z').map((j) => j.id)).toContain(id);
  });
});

describe('existsPending (exact json_extract match)', () => {
  it('matches the exact payload id and not a different one', () => {
    enqueue(h, { kind: 'reply', run_at: '2020-01-01T00:00:00Z', payload: { id: 5 } });
    expect(existsPending(h, 'reply', 5)).toBe(true);
    expect(existsPending(h, 'reply', 6)).toBe(false);
  });

  it('does NOT collide on substring ids (id 11 must not match a query for 1)', () => {
    enqueue(h, { kind: 'reply', run_at: '2020-01-01T00:00:00Z', payload: { id: 11 } });
    // Would FAIL under the old `payload LIKE '%"id":1%'` substring match.
    expect(existsPending(h, 'reply', 1)).toBe(false);
    expect(existsPending(h, 'reply', 11)).toBe(true);
  });

  it('scopes by kind and ignores terminal (done/failed) jobs', () => {
    const id = enqueue(h, { kind: 'reply', run_at: '2020-01-01T00:00:00Z', payload: { id: 7 } });
    expect(existsPending(h, 'other_kind', 7)).toBe(false); // wrong kind
    complete(h, id);                                       // → done (terminal)
    expect(existsPending(h, 'reply', 7)).toBe(false);
  });
});

describe('setRecurrence', () => {
  it('updates recurrence and run_at on an existing job', () => {
    const id = enqueue(h, { kind: 'sweep', run_at: '2026-06-30T13:03:00Z', recurrence: '3 13 * * *' });
    setRecurrence(h, id, '3 13,18 * * *', '2026-06-30T18:03:00Z');
    const row = listActive(h).find((j) => j.id === id)!;
    expect(row.recurrence).toBe('3 13,18 * * *');
    expect(row.run_at).toBe('2026-06-30T18:03:00Z');
  });

  it('updated_at is bumped after setRecurrence', () => {
    const before = new Date().toISOString();
    const id = enqueue(h, { kind: 'sweep', run_at: '2026-06-30T13:03:00Z', recurrence: '3 13 * * *' });
    setRecurrence(h, id, '3 13,18 * * *', '2026-06-30T18:03:00Z');
    const row = listActive(h).find((j) => j.id === id)!;
    expect(row.updated_at >= before).toBe(true);
  });
});

describe('cancel (scheduler#1)', () => {
  it('cancels a pending job: terminal, never claimed or requeued', () => {
    const id = enqueue(h, { kind: 'reminder', run_at: '2020-01-01T00:00:00Z' });
    expect(cancel(h, id)).toEqual({ ok: true });
    expect(listActive(h)).toEqual([]);
    requeueStale(h, '2999-01-01T00:00:00Z');
    expect(claimDue(h, '2999-01-01T00:00:00Z')).toEqual([]);
    expect(cancel(h, id)).toEqual({ ok: false, reason: 'not_active', status: 'cancelled', kind: 'reminder' });
  });

  it('refuses a running job and leaves it running', () => {
    const id = enqueue(h, { kind: 'reminder', run_at: '2020-01-01T00:00:00Z' });
    claimDue(h, '2026-06-29T00:00:00Z');
    expect(cancel(h, id)).toEqual({ ok: false, reason: 'running', status: 'running', kind: 'reminder' });
    expect(listActive(h)[0]!.status).toBe('running');
  });

  it('with kinds, refuses other kinds and reports unknown ids', () => {
    const id = enqueue(h, { kind: 'sweep', run_at: '2999-01-01T00:00:00Z', recurrence: '0 13 * * *' });
    expect(cancel(h, id, { kinds: ['reminder'] })).toEqual({ ok: false, reason: 'kind_not_allowed', status: 'pending', kind: 'sweep' });
    expect(listActive(h)[0]!.status).toBe('pending');
    expect(cancel(h, 424242)).toEqual({ ok: false, reason: 'not_found' });
  });
});
