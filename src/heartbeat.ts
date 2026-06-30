import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Returns the heartbeat file path for a given dbPath.
 * Convention: sibling of the DB file, named `scheduler.heartbeat`.
 * Both the daemon (writer) and `fortytwo doctor` (reader) derive the path
 * from the same dbPath / DB_PATH env var using this function.
 */
export function heartbeatPath(dbPath: string): string {
  return join(dirname(dbPath), 'scheduler.heartbeat');
}

/**
 * Write a liveness heartbeat JSON file `{ pid, ts }` at `path`.
 * Best-effort: a write failure NEVER crashes the daemon — errors are swallowed.
 */
export function writeHeartbeat(path: string, pid: number, nowIso: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ pid, ts: nowIso }), 'utf-8');
  } catch {
    // Best-effort — never crash the daemon on a heartbeat write failure.
  }
}
