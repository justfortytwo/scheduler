import { applyMigrations, type Migration } from '@justfortytwo/memory';
import * as m004 from './migrations/004_jobs.js';

/**
 * Migrations owned by the scheduler. They share memory's `_migration_state`
 * table and write lock (`applyMigrations`), so names must stay unique across
 * both lists: `004_jobs` keeps the name it had when memory shipped it.
 */
export const SCHEDULER_MIGRATIONS: Migration[] = [
  { name: '004_jobs', up: m004.up, down: m004.down },
];

/**
 * Apply the scheduler's migrations (the `jobs` table) to a DB opened with
 * memory's `openDb`. Run it after memory's `runMigrations`: every process that
 * opens the DB and touches jobs (daemon, telegram bridge, installer) calls both.
 * The jobs table does not reference memory's tables, so the order between
 * `004_jobs` and memory's `005`/`006` does not matter; on a fresh DB the state
 * rows land as memory's first, then `004_jobs`.
 */
export async function runSchedulerMigrations(k: Parameters<Migration['up']>[0]): Promise<void> {
  await applyMigrations(k, SCHEDULER_MIGRATIONS);
}
