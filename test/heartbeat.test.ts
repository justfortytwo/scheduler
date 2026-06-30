import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heartbeatPath, writeHeartbeat } from '../src/heartbeat.js';

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
