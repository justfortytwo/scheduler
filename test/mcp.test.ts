import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb, runMigrations, type DbHandles } from '@justfortytwo/memory';
import { runSchedulerMigrations } from '../src/migrate.js';
import { claimDue, complete, enqueue, fail, listActive } from '../src/jobs.js';
import { MAX_ACTIVE_AGENT_JOBS } from '../src/agent-jobs.js';
import { createJobsServer } from '../src/mcp.js';
import { createRegistry } from '../src/registry.js';
import { makeReminderHandler } from '../src/handlers/oneoff.js';
import { tick } from '../src/tick.js';
import { recurrenceNext } from '../src/daemon.js';
import type { Notification } from '../src/types.js';

const NOW = '2026-11-20T12:00:00.000Z';

let dir: string;
let h: DbHandles;
let client: Client;

async function connect(db: DbHandles): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'test-client', version: '0.0.0' });
  await createJobsServer(db, { now: () => NOW, timezone: () => 'Europe/Rome' }).connect(serverSide);
  await c.connect(clientSide);
  return c;
}

type CallResult = { isError?: boolean; content: Array<{ type: string; text: string }> };
async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  return (await client.callTool({ name, arguments: args })) as CallResult;
}
function json(r: CallResult): any {
  expect(r.isError, r.content[0]?.text).toBeFalsy();
  return JSON.parse(r.content[0]!.text);
}
function reminder(text: string, run_at = '2026-11-20T17:00:00+01:00'): Record<string, unknown> {
  return { kind: 'reminder', payload: { text }, run_at };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ft-mcp-'));
  h = openDb(join(dir, 'm.db'));
  await runMigrations(h.k);
  await runSchedulerMigrations(h.k);
  client = await connect(h);
});
afterEach(async () => {
  await client.close();
  await h.k.destroy(); h.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('scheduler MCP — tool surface', () => {
  it('lists enqueue_job, list_jobs and cancel_job and sends usage instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['cancel_job', 'enqueue_job', 'list_jobs']);
    expect(client.getInstructions()).toMatch(/reminder/);
  });
});

describe('enqueue_job', () => {
  it('stores a one-off reminder in jobs with a normalised UTC run_at', async () => {
    const out = json(await call('enqueue_job', reminder('buy milk')));
    expect(out).toMatchObject({ kind: 'reminder', run_at: '2026-11-20T16:00:00.000Z', recurrence: null });
    const row = listActive(h).find((j) => j.id === out.id)!;
    expect(row).toMatchObject({ kind: 'reminder', status: 'pending', run_at: '2026-11-20T16:00:00.000Z' });
    expect(JSON.parse(row.payload!)).toEqual({ text: 'buy milk' });
  });

  it('accepts an hourly-or-slower recurrence and takes its first run in the install zone', async () => {
    const out = json(await call('enqueue_job', { kind: 'reminder', payload: { text: 'stand up' }, recurrence: '0 9 * * 1' }));
    expect(out).toMatchObject({ run_at: '2026-11-23T08:00:00.000Z', recurrence: '0 9 * * 1' });
  });

  it.each([
    ['a kind that is not allowed', { kind: 'reply', payload: { text: 'x' }, run_at: '2026-11-20T17:00:00Z' }, /cannot be created/],
    ['a seeded kind', { kind: 'daily_briefing', payload: { text: 'x' }, run_at: '2026-11-20T17:00:00Z' }, /built-in job/],
    ['a malformed run_at', reminder('x', 'tomorrow at five'), /not ISO-8601/],
    ['a past run_at', reminder('x', '2026-11-20T11:00:00Z'), /in the past/],
    ['a run_at without offset or timezone', reminder('x', '2026-11-20T17:00:00'), /no offset/],
    ['an empty text', reminder('  '), /non-empty/],
    ['an over-long text', reminder('x'.repeat(501)), /longer than 500/],
    ['an over-frequent cron', { kind: 'reminder', payload: { text: 'x' }, recurrence: '*/5 * * * *' }, /once an hour/],
    ['no time at all', { kind: 'reminder', payload: { text: 'x' } }, /run_at is required/],
  ])('rejects %s', async (_label, args, message) => {
    const r = await call('enqueue_job', args);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(message);
    expect(listActive(h)).toEqual([]);
  });

  it('caps the number of active agent jobs', async () => {
    for (let i = 0; i < MAX_ACTIVE_AGENT_JOBS; i++) json(await call('enqueue_job', reminder(`r${i}`)));
    const r = await call('enqueue_job', reminder('one too many'));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/limit/);
    // System jobs do not count against the cap.
    expect(listActive(h)).toHaveLength(MAX_ACTIVE_AGENT_JOBS);
  });

  it('reports a DB without the jobs table instead of creating it', async () => {
    const bare = openDb(join(dir, 'bare.db'));
    await runMigrations(bare.k);
    const c = await connect(bare);
    const r = (await c.callTool({ name: 'enqueue_job', arguments: reminder('x') })) as CallResult;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/jobs table does not exist/);
    expect(bare.raw.prepare(`SELECT 1 FROM sqlite_master WHERE name='jobs'`).get()).toBeUndefined();
    await c.close(); await bare.k.destroy(); bare.raw.close();
  });
});

describe('list_jobs', () => {
  it('returns pending and running jobs; system payloads are not shown', async () => {
    const mine = json(await call('enqueue_job', reminder('call mum'))).id as number;
    enqueue(h, { kind: 'reply', run_at: '2020-01-01T00:00:00Z', payload: { text: 'secret inbound text' } });
    claimDue(h, '2020-01-02T00:00:00Z'); // the reply is now running
    const out = json(await call('list_jobs'));
    expect(out.includes).toEqual(['pending', 'running']);
    expect(out.jobs).toEqual([
      { id: expect.any(Number), kind: 'reply', status: 'running', run_at: '2020-01-01T00:00:00Z', recurrence: null, cancellable: false },
      { id: mine, kind: 'reminder', status: 'pending', run_at: '2026-11-20T16:00:00.000Z', recurrence: null, text: 'call mum', cancellable: true },
    ]);
    expect(JSON.stringify(out)).not.toContain('secret inbound text');
  });
});

describe('cancel_job', () => {
  it('cancels a pending reminder, which then never fires', async () => {
    const id = json(await call('enqueue_job', reminder('x'))).id as number;
    expect(json(await call('cancel_job', { id }))).toEqual({ id, status: 'cancelled' });
    expect(listActive(h)).toEqual([]);
    expect(claimDue(h, '2999-01-01T00:00:00Z')).toEqual([]);
    const again = await call('cancel_job', { id });
    expect(again.isError).toBe(true);
    expect(again.content[0]!.text).toMatch(/already cancelled/);
  });

  it('refuses a running reminder', async () => {
    const id = enqueue(h, { kind: 'reminder', run_at: '2020-01-01T00:00:00Z', payload: { text: 'x' } });
    claimDue(h, '2020-01-02T00:00:00Z');
    const r = await call('cancel_job', { id });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/running/);
    expect(listActive(h).find((j) => j.id === id)!.status).toBe('running');
  });

  it('refuses seeded and system jobs, and unknown ids', async () => {
    const seeded = enqueue(h, { kind: 'sweep', run_at: '2999-01-01T00:00:00Z', recurrence: '3 13,18 * * *' });
    const system = enqueue(h, { kind: 'reply', run_at: '2999-01-01T00:00:00Z', payload: { text: 'x' } });
    const r1 = await call('cancel_job', { id: seeded });
    expect(r1.isError).toBe(true);
    expect(r1.content[0]!.text).toMatch(/built-in job, re-seeded/);
    const r2 = await call('cancel_job', { id: system });
    expect(r2.content[0]!.text).toMatch(/system-owned/);
    expect(listActive(h).map((j) => j.status)).toEqual(['pending', 'pending']);
    expect((await call('cancel_job', { id: 9999 })).content[0]!.text).toMatch(/no job with id 9999/);
    expect((await call('cancel_job', { id: 'x' })).isError).toBe(true);
  });
});

describe('a reminder made through the tool fires via the daemon tick', () => {
  it('is claimed when due, runs the reminder turn, notifies and completes', async () => {
    const id = json(await call('enqueue_job', reminder('buy milk'))).id as number;
    const prompts: string[] = [];
    const sent: Notification[] = [];
    const deps = {
      claimDue: (now: string) => claimDue(h, now),
      complete: (jid: number, o: { reschedule?: string }) => complete(h, jid, o),
      fail: (jid: number, e: string, o?: { retryAt?: string }) => fail(h, jid, e, o),
      registry: createRegistry([makeReminderHandler(async (p) => { prompts.push(p); return { ok: true, text: 'Time to buy milk.' }; })]),
      recurrenceNext: (cron: string, now: string) => recurrenceNext(cron, now),
      enqueueRun: (fn: () => Promise<void>) => fn(),
      notify: async (n: Notification) => { sent.push(n); },
    };
    await tick(deps, '2026-11-20T15:59:00.000Z'); // not due yet
    expect(prompts).toEqual([]);
    await tick(deps, '2026-11-20T16:00:30.000Z');
    expect(prompts).toEqual(['Reminder: buy milk']);
    expect(sent).toEqual([{ kind: 'reminder', text: 'Time to buy milk.' }]);
    expect(h.raw.prepare('SELECT status FROM jobs WHERE id=?').get(id)).toEqual({ status: 'done' });
  });
});
