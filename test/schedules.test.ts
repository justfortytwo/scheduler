import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SCHEDULES_PATH,
  isScheduleEnabled,
  parseSchedules,
  readSchedules,
  writeSchedules,
} from '../src/schedules.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'scheduler-schedules-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function writeRaw(text: string): void {
  mkdirSync(join(root, '.fortytwo'), { recursive: true });
  writeFileSync(join(root, SCHEDULES_PATH), text, 'utf8');
}

describe('isScheduleEnabled', () => {
  it('treats a kind that is not listed as enabled', () => {
    expect(isScheduleEnabled({}, 'daily_briefing')).toBe(true);
  });

  it('follows the explicit choice', () => {
    expect(isScheduleEnabled({ daily_briefing: false }, 'daily_briefing')).toBe(false);
    expect(isScheduleEnabled({ daily_briefing: true }, 'daily_briefing')).toBe(true);
  });
});

describe('readSchedules', () => {
  it('returns {} when the file is missing, so installs without it keep every job', () => {
    expect(readSchedules(root)).toEqual({});
  });

  it('reads the per-kind choice', () => {
    writeRaw(JSON.stringify({ version: 1, schedules: { daily_briefing: { enabled: false }, sweep: { enabled: true } } }));
    expect(readSchedules(root)).toEqual({ daily_briefing: false, sweep: true });
  });

  it('round-trips what writeSchedules wrote', () => {
    writeSchedules(root, { daily_briefing: false, learn_review: true });
    expect(readSchedules(root)).toEqual({ daily_briefing: false, learn_review: true });
    expect(JSON.parse(readFileSync(join(root, SCHEDULES_PATH), 'utf8'))).toEqual({
      version: 1,
      schedules: { daily_briefing: { enabled: false }, learn_review: { enabled: true } },
    });
  });

  it('throws instead of enabling everything when the file is not valid JSON', () => {
    writeRaw('{ nope');
    expect(() => readSchedules(root)).toThrow(/schedules\.json: not valid JSON/);
  });
});

describe('parseSchedules', () => {
  it('rejects a file without a schedules object', () => {
    expect(() => parseSchedules('{"version":1}')).toThrow(/"schedules" object/);
    expect(() => parseSchedules('[]')).toThrow(/"schedules" object/);
  });

  it('rejects an entry whose enabled is not a boolean, naming the kind', () => {
    expect(() => parseSchedules('{"schedules":{"sweep":{"enabled":"no"}}}')).toThrow(/schedules\.sweep\.enabled/);
    expect(() => parseSchedules('{"schedules":{"sweep":false}}')).toThrow(/schedules\.sweep\.enabled/);
  });

  it('keeps kinds it does not know (the daemon ignores them)', () => {
    expect(parseSchedules('{"schedules":{"future_job":{"enabled":false}}}')).toEqual({ future_job: false });
  });
});
