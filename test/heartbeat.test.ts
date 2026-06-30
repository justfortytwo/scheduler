import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, runMigrations, enqueue } from '@justfortytwo/memory';
import { heartbeatPath, writeHeartbeat } from '../src/heartbeat.js';
import { POLL_MS, startDaemon } from '../src/daemon.js';
import { createRegistry } from '../src/registry.js';

describe('heartbeatPath', () => {
  it('returns scheduler.heartbeat sibling of the DB file', () => {
    expect(heartbeatPath('db/fortytwo.db')).toBe('db/scheduler.heartbeat');
  });

  it('works with absolute paths', () => {
    expect(heartbeatPath('/var/data/fortytwo.db')).toBe('/var/data/scheduler.heartbeat');
  });
});

describe('writeHeartbeat', () => {
  it('creates a parseable { pid, ts } JSON file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-test-'));
    try {
      const path = join(dir, 'scheduler.heartbeat');
      const iso = new Date().toISOString();
      writeHeartbeat(path, 12345, iso);
      expect(existsSync(path)).toBe(true);
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      expect(parsed).toEqual({ pid: 12345, ts: iso });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates intermediate directories if missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-test-'));
    try {
      const path = join(dir, 'nested', 'deep', 'scheduler.heartbeat');
      const iso = new Date().toISOString();
      writeHeartbeat(path, 99, iso);
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT throw when the target path is invalid (write cannot succeed)', () => {
    // /dev/null/scheduler.heartbeat — /dev/null is a device file, not a dir;
    // mkdirSync will throw ENOTDIR. writeHeartbeat must swallow it.
    writeHeartbeat('/dev/null/scheduler.heartbeat', 42, new Date().toISOString());
    // reaching here without throw is the assertion
  });
});

// ---------------------------------------------------------------------------
// Regression: the heartbeat must refresh on EVERY poll, even while a long tick
// is still in flight (overlap guard skips tick, but NOT the heartbeat write).
// If the write were inside tickFn, a tick longer than the poll interval would
// starve the heartbeat and doctor would falsely report the daemon stale.
// ---------------------------------------------------------------------------
describe('startDaemon — heartbeat refreshes during a long in-flight tick', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes a fresher heartbeat on a later poll while the first tick is still running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-daemon-'));
    let dispose: (() => void) | undefined;
    try {
      const dbPath = join(dir, 'fortytwo.db');
      const hbPath = heartbeatPath(dbPath);

      // Seed a due job whose handler never resolves — the first tick stays
      // in-flight forever, so the overlap guard skips every subsequent poll.
      const h = openDb(dbPath);
      await runMigrations(h.k);
      enqueue(h, { kind: 'blocking_job', run_at: '2020-01-01T00:00:00.000Z' });

      const registry = createRegistry([
        { kind: 'blocking_job', run: () => new Promise<never>(() => { /* never resolves */ }) },
      ]);

      // Pin the system clock so heartbeat ts is deterministic and advanceable.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-30T00:00:00.000Z'));

      dispose = await startDaemon({ dbPath, registry });

      // First poll fires: heartbeat written, tick starts (and blocks).
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(existsSync(hbPath)).toBe(true);
      const first = JSON.parse(readFileSync(hbPath, 'utf-8')) as { pid: number; ts: string };

      // Advance another poll interval. The tick is still in flight (overlap
      // guard skips it), but the heartbeat write — now OUTSIDE the guard — must
      // still fire with a fresher timestamp.
      await vi.advanceTimersByTimeAsync(POLL_MS);
      const second = JSON.parse(readFileSync(hbPath, 'utf-8')) as { pid: number; ts: string };

      expect(new Date(second.ts).getTime()).toBeGreaterThan(new Date(first.ts).getTime());
      expect(second.pid).toBe(process.pid);
    } finally {
      dispose?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
