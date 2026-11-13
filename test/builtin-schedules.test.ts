import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, runMigrations, listActive } from '@justfortytwo/memory';
import { RECURRING_DEFS, buildRegistry, triggerFor } from '../src/handlers/index.js';
import { startDaemon } from '../src/daemon.js';
import { createRegistry } from '../src/registry.js';
import { writeSchedules, writeScheduleTimezone, SCHEDULES_PATH } from '../src/schedules.js';

const def = (kind: string) => RECURRING_DEFS.find((d) => d.kind === kind)!;
const ctx = { now: '2026-06-30T09:00:00.000Z', payload: undefined };

describe('RECURRING_DEFS', () => {
  it('describes every built-in job for the init prompt', () => {
    for (const d of RECURRING_DEFS) expect(d.description.length, d.kind).toBeGreaterThan(10);
  });

  it('gives every skill-backed job a fallback that works without the skill', () => {
    const backed = RECURRING_DEFS.filter((d) => d.skill);
    expect(backed.map((d) => d.kind)).toEqual(['daily_briefing', 'learn_review']);
    for (const d of backed) {
      expect(d.skill!.fallback, d.kind).toContain(`No ${d.skill!.name} skill is installed`);
      expect(d.trigger, d.kind).toContain(`${d.skill!.name} skill`);
    }
  });

  it('keeps learn-review propose-only in both prompts', () => {
    const d = def('learn_review');
    expect(d.trigger).toMatch(/Propose only/);
    expect(d.skill!.fallback).toMatch(/Never edit context\/rules\/APPROVED\.md/);
  });
});

describe('triggerFor', () => {
  it('uses the trigger when the skill is installed', () => {
    expect(triggerFor(def('learn_review'), () => true)).toBe(def('learn_review').trigger);
  });

  it('uses the self-contained fallback when the skill is missing', () => {
    const hasSkill = vi.fn(() => false);
    expect(triggerFor(def('learn_review'), hasSkill)).toBe(def('learn_review').skill!.fallback);
    expect(hasSkill).toHaveBeenCalledWith('learn-review');
  });

  it('never asks about skills for a job that needs none', () => {
    const hasSkill = vi.fn(() => false);
    expect(triggerFor(def('sweep'), hasSkill)).toBe(def('sweep').trigger);
    expect(hasSkill).not.toHaveBeenCalled();
  });
});

describe('buildRegistry — skill-aware prompts', () => {
  function registry(hasSkill?: (name: string) => boolean) {
    const runner = vi.fn(async (_prompt: string) => ({ ok: true, text: 'done' }));
    const reg = buildRegistry({
      runner,
      hasSkill,
      countPendingApprovals: () => 1,
      recentCount: async () => 1,
      reembedOne: async () => true,
    });
    return { reg, runner };
  }

  it('sends the fallback when the skill is missing', async () => {
    const { reg, runner } = registry(() => false);
    await reg.get('daily_briefing')!.run(ctx);
    expect(runner).toHaveBeenCalledWith(def('daily_briefing').skill!.fallback);
  });

  it('checks on every run, so a skill installed after boot is picked up', async () => {
    let installed = false;
    const { reg, runner } = registry(() => installed);
    await reg.get('daily_briefing')!.run(ctx);
    installed = true;
    await reg.get('daily_briefing')!.run(ctx);
    expect(runner.mock.calls.map((c) => c[0])).toEqual([
      def('daily_briefing').skill!.fallback,
      def('daily_briefing').trigger,
    ]);
  });

  it('sends the plain trigger when the caller does not track skills', async () => {
    const { reg, runner } = registry();
    await reg.get('learn_review')!.run(ctx);
    expect(runner).toHaveBeenCalledWith(def('learn_review').trigger);
  });
});

describe('startDaemon — .fortytwo/schedules.json', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'scheduler-builtin-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const emptyRegistry = createRegistry([]);
  async function recurringKinds(dbPath: string): Promise<string[]> {
    const h = openDb(dbPath);
    try {
      await runMigrations(h.k);
      return listActive(h).filter((j) => j.recurrence != null).map((j) => j.kind).sort();
    } finally {
      await h.k.destroy();
      h.raw.close();
    }
  }

  it('moves the waiting runs when the time zone changes between boots', async () => {
    const dbPath = join(root, 'tz.db');
    const briefingRunAt = async (): Promise<string> => {
      const h = openDb(dbPath);
      try { return listActive(h).find((j) => j.kind === 'daily_briefing')!.run_at; }
      finally { await h.k.destroy(); h.raw.close(); }
    };
    (await startDaemon({ dbPath, root, registry: emptyRegistry }))();
    const utc = await briefingRunAt();
    expect(utc).toMatch(/T07:57:00\.000Z$/);

    writeScheduleTimezone(root, 'Asia/Tokyo'); // UTC+9, no daylight saving
    (await startDaemon({ dbPath, root, registry: emptyRegistry }))();
    expect(await briefingRunAt()).toMatch(/T22:57:00\.000Z$/); // 07:57 in Tokyo

    (await startDaemon({ dbPath, root, registry: emptyRegistry }))(); // idempotent
    expect(await briefingRunAt()).toMatch(/T22:57:00\.000Z$/);
  });

  it('seeds every built-in job when the file is missing', async () => {
    const dbPath = join(root, 'a.db');
    (await startDaemon({ dbPath, root, registry: emptyRegistry }))();
    expect(await recurringKinds(dbPath)).toEqual(['daily_briefing', 'learn_review', 'sweep']);
  });

  it('does not seed a job the owner switched off', async () => {
    const dbPath = join(root, 'b.db');
    writeSchedules(root, { daily_briefing: false });
    (await startDaemon({ dbPath, root, registry: emptyRegistry }))();
    expect(await recurringKinds(dbPath)).toEqual(['learn_review', 'sweep']);
  });

  it('retires the existing row when a job is switched off, and seeds it again when switched back on', async () => {
    const dbPath = join(root, 'c.db');
    (await startDaemon({ dbPath, root, registry: emptyRegistry }))();
    expect(await recurringKinds(dbPath)).toContain('learn_review');

    writeSchedules(root, { learn_review: false });
    (await startDaemon({ dbPath, root, registry: emptyRegistry }))();
    expect(await recurringKinds(dbPath)).toEqual(['daily_briefing', 'sweep']);

    writeSchedules(root, { learn_review: true });
    (await startDaemon({ dbPath, root, registry: emptyRegistry }))();
    expect(await recurringKinds(dbPath)).toEqual(['daily_briefing', 'learn_review', 'sweep']);
  });

  it('refuses to boot on an unreadable file instead of running everything', async () => {
    const dbPath = join(root, 'd.db');
    mkdirSync(join(root, '.fortytwo'), { recursive: true });
    writeFileSync(join(root, SCHEDULES_PATH), '{ nope', 'utf8');
    await expect(startDaemon({ dbPath, root, registry: emptyRegistry })).rejects.toThrow(/schedules\.json/);
  });
});
