import { describe, it, expect } from 'vitest';
import { DEFAULT_TURN_TIMEOUT_S, failOnNoResult, turnTimeoutFromEnv } from '../src/turn-timeout.js';

describe('turnTimeoutFromEnv', () => {
  it('defaults to 300 s when unset or empty', () => {
    expect(DEFAULT_TURN_TIMEOUT_S).toBe(300);
    expect(turnTimeoutFromEnv({})).toBe(300_000);
    expect(turnTimeoutFromEnv({ FORTYTWO_TURN_TIMEOUT: '  ' })).toBe(300_000);
  });
  it('reads whole seconds', () => {
    expect(turnTimeoutFromEnv({ FORTYTWO_TURN_TIMEOUT: '45' })).toBe(45_000);
    expect(turnTimeoutFromEnv({ FORTYTWO_TURN_TIMEOUT: ' 600 ' })).toBe(600_000);
  });
  it.each(['0', '-5', '1.5', '5m', 'abc', '2147484'])('rejects %j at boot', (v) => {
    expect(() => turnTimeoutFromEnv({ FORTYTWO_TURN_TIMEOUT: v })).toThrow(/FORTYTWO_TURN_TIMEOUT/);
  });
});

describe('failOnNoResult', () => {
  const clock = (...ts: number[]) => () => ts.shift()!;

  it('passes a run with a result through, including an error result', async () => {
    const ok = { ok: true, text: 'hi', raw: { result: 'hi' } };
    await expect(failOnNoResult(async () => ok, 1000)('p')).resolves.toBe(ok);
    const err = { ok: false, text: '', raw: { is_error: true } };
    await expect(failOnNoResult(async () => err, 1000)('p')).resolves.toBe(err);
  });
  it('throws a timeout error when the runner stopped the turn at the limit', async () => {
    const run = failOnNoResult(async () => ({ ok: false, text: '', raw: null }), 300_000, clock(0, 300_050));
    await expect(run('p')).rejects.toThrow('claude turn stopped after 300 s (FORTYTWO_TURN_TIMEOUT)');
  });
  it('throws when a turn ends early without a result', async () => {
    const run = failOnNoResult(async () => ({ ok: false, text: 'garbage', raw: null }), 300_000, clock(0, 20));
    await expect(run('p')).rejects.toThrow('claude turn ended without a result');
  });
});
