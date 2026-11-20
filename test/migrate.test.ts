import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb, runMigrations, type DbHandles } from '@justfortytwo/memory';
import { SCHEDULER_MIGRATIONS, runSchedulerMigrations } from '../src/migrate.js';
import { enqueue, listActive } from '../src/jobs.js';

// The DDL memory's knex migration `004_jobs` produced before the move (memory <= 1.0.1).
const LEGACY_JOBS_DDL = [
  "create table `jobs` (`id` integer not null primary key autoincrement, `kind` text not null, `payload` text, `run_at` text not null, `recurrence` text, `status` text not null default 'pending', `attempts` integer not null default '0', `last_error` text, `created_at` text not null, `updated_at` text not null)",
  'create index `idx_jobs_status_run_at` on `jobs` (`status`, `run_at`)',
];

const viteNode = resolve('node_modules/.bin/vite-node');
const child = resolve('test/fixtures/migrate-child.ts');
function spawnChild(dbPath: string): { proc: ChildProcess; ready: Promise<void>; done: Promise<{ code: number | null; stderr: string }> } {
  const proc = spawn(viteNode, [child, dbPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const ready = new Promise<void>((res, rej) => {
    proc.stdout!.on('data', (d) => { stdout += String(d); if (stdout.includes('ready\n')) res(); });
    proc.once('exit', () => rej(new Error(`child exited before ready: ${stderr}`)));
  });
  proc.stderr!.on('data', (d) => (stderr += String(d)));
  const done = new Promise<{ code: number | null; stderr: string }>((res) => proc.once('exit', (code) => res({ code, stderr })));
  return { proc, ready, done };
}

const dirs: string[] = [];
const handles: DbHandles[] = [];
function open(): DbHandles {
  const dir = mkdtempSync(join(tmpdir(), 'ft-sched-mig-'));
  dirs.push(dir);
  const h = openDb(join(dir, 'fortytwo.db'));
  handles.push(h);
  return h;
}
afterEach(async () => {
  for (const h of handles.splice(0)) { await h.k.destroy(); h.raw.close(); }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const stateNames = (h: DbHandles): string[] =>
  (h.raw.prepare('SELECT name FROM _migration_state ORDER BY rowid').all() as Array<{ name: string }>).map((r) => r.name);
const shape = (h: DbHandles): unknown => ({
  columns: h.raw.prepare("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info('jobs')").all(),
  indexes: h.raw.prepare("SELECT name FROM pragma_index_list('jobs') WHERE origin = 'c'").all(),
});

describe('scheduler migrations', () => {
  it('keeps the migration name 004_jobs', () => {
    expect(SCHEDULER_MIGRATIONS.map((m) => m.name)).toEqual(['004_jobs']);
  });

  it('creates jobs on a fresh DB after memory, recording 004_jobs once in the shared state table', async () => {
    const h = open();
    await runMigrations(h.k);
    expect(h.raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'jobs'").get()).toBeUndefined();
    await runSchedulerMigrations(h.k);
    await runSchedulerMigrations(h.k); // idempotent
    await runMigrations(h.k);          // memory's list does not touch it either
    expect(stateNames(h)).toEqual(['001_init', '002_fts', '003_approvals', '005_memory_identity', '006_approvals_notified_at', '004_jobs']);
    expect(enqueue(h, { kind: 'reminder', run_at: '2020-01-01T00:00:00Z' })).toBeGreaterThan(0);
  });

  it('creates the same table shape memory used to create', async () => {
    const fresh = open();
    await runMigrations(fresh.k);
    await runSchedulerMigrations(fresh.k);
    const legacy = open();
    for (const sql of LEGACY_JOBS_DDL) legacy.raw.exec(sql);
    expect(shape(fresh)).toEqual(shape(legacy));
  });

  it('skips an install that already recorded 004_jobs (from memory) and keeps its jobs', async () => {
    const h = open();
    await runMigrations(h.k);
    for (const sql of LEGACY_JOBS_DDL) h.raw.exec(sql);
    h.raw.prepare("INSERT INTO _migration_state (name) VALUES ('004_jobs')").run();
    const id = enqueue(h, { kind: 'reminder', run_at: '2020-01-01T00:00:00Z' });
    const before = h.raw.prepare('SELECT name, applied_at FROM _migration_state ORDER BY rowid').all();

    await runSchedulerMigrations(h.k);

    expect(h.raw.prepare('SELECT name, applied_at FROM _migration_state ORDER BY rowid').all()).toEqual(before);
    expect(listActive(h).map((j) => j.id)).toEqual([id]);
  });

  it('tolerates a jobs table with no state row (CREATE TABLE IF NOT EXISTS) and records it', async () => {
    const h = open();
    await runMigrations(h.k);
    for (const sql of LEGACY_JOBS_DDL) h.raw.exec(sql);
    const id = enqueue(h, { kind: 'reminder', run_at: '2020-01-01T00:00:00Z' });

    await runSchedulerMigrations(h.k);

    expect(stateNames(h)).toContain('004_jobs');
    expect(listActive(h).map((j) => j.id)).toEqual([id]);
  });

  it('lets independent processes migrate one absent DB concurrently under the shared lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ft-sched-race-'));
    dirs.push(dir);
    const dbPath = join(dir, 'fortytwo.db');
    const kids = Array.from({ length: 4 }, () => spawnChild(dbPath));
    await Promise.all(kids.map((c) => c.ready));
    for (const c of kids) c.proc.stdin!.write('go\n');
    for (const r of await Promise.all(kids.map((c) => c.done))) expect(r, r.stderr).toMatchObject({ code: 0 });

    const h = openDb(dbPath);
    handles.push(h);
    expect(stateNames(h).filter((n) => n === '004_jobs')).toHaveLength(1);
    expect(listActive(h)).toEqual([]);
  }, 60_000);
});
