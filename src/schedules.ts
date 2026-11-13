import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Per-install choice of which BUILT-IN recurring jobs run.
 *
 * `fortytwo init` asks the owner and writes the answer to
 * `<root>/.fortytwo/schedules.json`; the daemon reads it once at boot:
 *
 *   { "version": 1, "timezone": "Europe/Rome",
 *     "schedules": { "daily_briefing": { "enabled": false } } }
 *
 * `timezone` (optional, an IANA name) is the zone the built-in times are read
 * in: with it, "07:57" is 07:57 on the owner's clock all year. Without it the
 * times are UTC, as they were before this field existed.
 *
 * A kind that is not listed is ENABLED, and so is every kind when the file is
 * missing: installs that predate this file keep running all built-in jobs.
 * Kinds the scheduler does not know are ignored. A file that exists but cannot
 * be understood is an error, never "everything on": running a job the owner
 * switched off is worse than refusing to start with a clear message.
 */
export const SCHEDULES_PATH = '.fortytwo/schedules.json';

/** kind -> enabled. Absent kinds are enabled (see `isScheduleEnabled`). */
export type SchedulesConfig = Record<string, boolean>;

/** True for a time zone name this runtime can compute with (IANA names and "UTC"). */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseFile(raw: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${SCHEDULES_PATH}: not valid JSON (${(e as Error).message})`);
  }
  if (!isRecord(data)) throw new Error(`${SCHEDULES_PATH}: expected an object with a "schedules" object`);
  return data;
}

/**
 * The time zone saved in the file's text, or undefined when none is set.
 * Throws when the value is not a usable zone: guessing UTC would silently move
 * every built-in job.
 */
export function parseScheduleTimezone(raw: string): string | undefined {
  const tz = parseFile(raw)['timezone'];
  if (tz === undefined || tz === null) return undefined;
  if (!isValidTimezone(tz)) {
    throw new Error(`${SCHEDULES_PATH}: timezone must be an IANA name such as "Europe/Rome", got ${JSON.stringify(tz)}`);
  }
  return tz;
}

/** Parses the file's text. Throws with the reason when it is not a valid schedules file. */
export function parseSchedules(raw: string): SchedulesConfig {
  const data = parseFile(raw);
  parseScheduleTimezone(raw);
  const schedules = data['schedules'];
  if (!isRecord(schedules)) {
    throw new Error(`${SCHEDULES_PATH}: expected an object with a "schedules" object`);
  }
  const config: SchedulesConfig = {};
  for (const [kind, entry] of Object.entries(schedules)) {
    const enabled = isRecord(entry) ? entry['enabled'] : undefined;
    if (typeof enabled !== 'boolean') {
      throw new Error(`${SCHEDULES_PATH}: schedules.${kind}.enabled must be true or false`);
    }
    config[kind] = enabled;
  }
  return config;
}

/** Reads the install's choice. A missing file is `{}` (every built-in job enabled). */
export function readSchedules(root: string): SchedulesConfig {
  const path = join(root, SCHEDULES_PATH);
  if (!existsSync(path)) return {};
  return parseSchedules(readFileSync(path, 'utf8'));
}

/** The install's time zone for built-in schedules; undefined (UTC) when the file or the field is missing. */
export function readScheduleTimezone(root: string): string | undefined {
  const path = join(root, SCHEDULES_PATH);
  if (!existsSync(path)) return undefined;
  return parseScheduleTimezone(readFileSync(path, 'utf8'));
}

/** What a rewrite must carry over from the current file; nothing when it is missing or unreadable. */
function savedParts(root: string): { timezone?: string; schedules: Record<string, unknown> } {
  try {
    const data = parseFile(readFileSync(join(root, SCHEDULES_PATH), 'utf8'));
    return {
      ...(isValidTimezone(data['timezone']) ? { timezone: data['timezone'] } : {}),
      schedules: isRecord(data['schedules']) ? data['schedules'] : {},
    };
  } catch {
    return { schedules: {} };
  }
}

function writeFile(root: string, timezone: string | undefined, schedules: Record<string, unknown>): void {
  const path = join(root, SCHEDULES_PATH);
  mkdirSync(dirname(path), { recursive: true });
  const body = { version: 1, ...(timezone ? { timezone } : {}), schedules };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

/** Writes the install's choice in the format `readSchedules` expects; a saved time zone is kept. */
export function writeSchedules(root: string, config: SchedulesConfig): void {
  const schedules = Object.fromEntries(
    Object.entries(config).map(([kind, enabled]) => [kind, { enabled }]),
  );
  writeFile(root, savedParts(root).timezone, schedules);
}

/**
 * Saves the time zone built-in schedules are read in (undefined goes back to
 * UTC); the on/off choice is kept. Throws on a name that is not a time zone.
 */
export function writeScheduleTimezone(root: string, timezone: string | undefined): void {
  if (timezone !== undefined && !isValidTimezone(timezone)) {
    throw new Error(`not a time zone: ${JSON.stringify(timezone)} (use an IANA name such as "Europe/Rome")`);
  }
  writeFile(root, timezone, savedParts(root).schedules);
}

/** A built-in job runs unless the owner explicitly switched it off. */
export function isScheduleEnabled(config: SchedulesConfig, kind: string): boolean {
  return config[kind] !== false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
