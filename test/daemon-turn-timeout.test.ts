/**
 * startDaemon wiring for FORTYTWO_TURN_TIMEOUT: the real registry builds its
 * runner with the limit, and an invalid value stops the daemon at boot.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ createRunner: vi.fn() }));
vi.mock('@justfortytwo/runner', async (importOriginal) => {
  const real = await importOriginal<typeof import('@justfortytwo/runner')>();
  return { ...real, createRunner: mocks.createRunner };
});

import { startDaemon } from '../src/daemon.js';

let dir: string;
let dispose: (() => void | Promise<void>) | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-turn-timeout-'));
  mocks.createRunner.mockReset();
  mocks.createRunner.mockReturnValue({ run: vi.fn(), createSession: vi.fn() });
});
afterEach(async () => {
  await dispose?.(); dispose = undefined;
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('startDaemon: FORTYTWO_TURN_TIMEOUT', () => {
  it('passes the default 300 s limit to the scheduled runner', async () => {
    vi.stubEnv('FORTYTWO_TURN_TIMEOUT', '');
    dispose = await startDaemon({ dbPath: join(dir, 'a.db'), root: dir });
    expect(mocks.createRunner).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 300_000 }));
  });

  it('passes a configured limit', async () => {
    vi.stubEnv('FORTYTWO_TURN_TIMEOUT', '90');
    dispose = await startDaemon({ dbPath: join(dir, 'b.db'), root: dir });
    expect(mocks.createRunner).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 90_000 }));
  });

  it('rejects at boot on an invalid value', async () => {
    vi.stubEnv('FORTYTWO_TURN_TIMEOUT', '5m');
    await expect(startDaemon({ dbPath: join(dir, 'c.db'), root: dir })).rejects.toThrow(/FORTYTWO_TURN_TIMEOUT/);
  });
});
