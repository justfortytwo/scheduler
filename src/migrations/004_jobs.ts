import type { Migration } from '@justfortytwo/memory';

type Knex = Parameters<Migration['up']>[0];

// The durable jobs queue. This migration used to ship in @justfortytwo/memory under
// the same name, so existing databases already record `004_jobs` in
// `_migration_state` and skip it. IF NOT EXISTS keeps it safe on a database that
// has the table without the state row. The DDL is the one memory's knex
// migration produced, so fresh and existing installs end up with the same table.
export async function up(k: Knex): Promise<void> {
  await k.raw(
    `CREATE TABLE IF NOT EXISTS \`jobs\` (\`id\` integer not null primary key autoincrement, \`kind\` text not null, \`payload\` text, \`run_at\` text not null, \`recurrence\` text, \`status\` text not null default 'pending', \`attempts\` integer not null default '0', \`last_error\` text, \`created_at\` text not null, \`updated_at\` text not null)`,
  );
  await k.raw('CREATE INDEX IF NOT EXISTS `idx_jobs_status_run_at` ON `jobs` (`status`, `run_at`)');
}

export async function down(k: Knex): Promise<void> {
  await k.raw('DROP TABLE IF EXISTS `jobs`');
}
