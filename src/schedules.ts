import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Per-install choice of which BUILT-IN recurring jobs run.
 *
 * `fortytwo init` asks the owner and writes the answer to
 * `<root>/.fortytwo/schedules.json`; the daemon reads it once at boot:
 *
 *   { "version": 1, "schedules": { "daily_briefing": { "enabled": false } } }
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

/** Parses the file's text. Throws with the reason when it is not a valid schedules file. */
export function parseSchedules(raw: string): SchedulesConfig {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${SCHEDULES_PATH}: not valid JSON (${(e as Error).message})`);
  }
  const schedules = isRecord(data) ? data['schedules'] : undefined;
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

/** Writes the install's choice in the format `readSchedules` expects. */
export function writeSchedules(root: string, config: SchedulesConfig): void {
  const path = join(root, SCHEDULES_PATH);
  const schedules = Object.fromEntries(
    Object.entries(config).map(([kind, enabled]) => [kind, { enabled }]),
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, schedules }, null, 2)}\n`, 'utf8');
}

/** A built-in job runs unless the owner explicitly switched it off. */
export function isScheduleEnabled(config: SchedulesConfig, kind: string): boolean {
  return config[kind] !== false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
