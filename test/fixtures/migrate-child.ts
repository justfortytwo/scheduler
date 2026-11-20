// Child process for test/migrate.test.ts: opens argv[2] in its own OS process,
// prints `ready`, waits for a line on stdin (the parent's start barrier), then
// runs memory's migrations and the scheduler's, like every process that opens
// the DB. Exits 0, or prints the error and exits 1.
import { openDb, runMigrations } from '@justfortytwo/memory';
import { runSchedulerMigrations } from '../../src/migrate.js';

const dbPath = process.argv[2]!;
process.stdout.write('ready\n');
process.stdin.once('data', async () => {
  try {
    const h = openDb(dbPath);
    await runMigrations(h.k);
    await runSchedulerMigrations(h.k);
    await h.k.destroy();
    h.raw.close();
    process.exit(0);
  } catch (e) {
    process.stderr.write(`${(e as Error).stack} code=${(e as { code?: string }).code}\n`);
    process.exit(1);
  }
});
