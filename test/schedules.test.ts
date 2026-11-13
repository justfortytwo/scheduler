import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SCHEDULES_PATH,
  isScheduleEnabled,
  isValidTimezone,
  parseSchedules,
  readScheduleTimezone,
  readSchedules,
  writeScheduleTimezone,
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

describe('time zone', () => {
  it('is undefined (UTC) when the file or the field is missing', () => {
    expect(readScheduleTimezone(root)).toBeUndefined();
    writeSchedules(root, { sweep: false });
    expect(readScheduleTimezone(root)).toBeUndefined();
  });

  it('is saved beside the on/off choice, and each write keeps the other', () => {
    writeSchedules(root, { sweep: false });
    writeScheduleTimezone(root, 'Europe/Rome');
    expect(readScheduleTimezone(root)).toBe('Europe/Rome');
    expect(readSchedules(root)).toEqual({ sweep: false });

    writeSchedules(root, { sweep: true, daily_briefing: false });
    expect(readScheduleTimezone(root)).toBe('Europe/Rome');
    expect(JSON.parse(readFileSync(join(root, SCHEDULES_PATH), 'utf8'))).toEqual({
      version: 1, timezone: 'Europe/Rome',
      schedules: { sweep: { enabled: true }, daily_briefing: { enabled: false } },
    });

    writeScheduleTimezone(root, undefined);
    expect(readScheduleTimezone(root)).toBeUndefined();
    expect(readSchedules(root)).toEqual({ sweep: true, daily_briefing: false });
  });

  it('can be saved before any choice exists', () => {
    writeScheduleTimezone(root, 'America/New_York');
    expect(readSchedules(root)).toEqual({});
    expect(readScheduleTimezone(root)).toBe('America/New_York');
  });

  it('accepts IANA names and UTC, nothing else', () => {
    for (const ok of ['UTC', 'Europe/Rome', 'America/Argentina/Buenos_Aires']) expect(isValidTimezone(ok), ok).toBe(true);
    for (const bad of ['', '  ', 'Rome', 'Europe/Nowhere', 7, null, undefined]) expect(isValidTimezone(bad), String(bad)).toBe(false);
    expect(() => writeScheduleTimezone(root, 'Rome')).toThrow(/not a time zone/);
  });

  it('refuses a file whose time zone cannot be used, instead of falling back to UTC', () => {
    writeRaw('{"version":1,"timezone":"Rome","schedules":{}}');
    expect(() => readScheduleTimezone(root)).toThrow(/timezone must be an IANA name/);
    expect(() => readSchedules(root)).toThrow(/timezone must be an IANA name/);
  });
});
