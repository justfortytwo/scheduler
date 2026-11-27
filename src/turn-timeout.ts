// Time limit for scheduled `claude` turns (FORTYTWO_TURN_TIMEOUT, in seconds).
//
// The queue runs one turn at a time, so a turn that never ends would hold every
// job behind it until the daemon restarts. The runner stops a turn that passes
// the limit and returns no result; `failOnNoResult` turns that into a thrown
// error so the job goes through the normal retry and backoff.

import type { RunnerFn } from './handlers/recurring.js';

export const TURN_TIMEOUT_ENV = 'FORTYTWO_TURN_TIMEOUT';
export const DEFAULT_TURN_TIMEOUT_S = 300;
/** Largest delay `setTimeout` accepts, in whole seconds. */
const MAX_TURN_TIMEOUT_S = Math.floor(2_147_483_647 / 1000);

/**
 * The turn limit in milliseconds. Unset or empty means the default (300 s).
 * Anything other than a whole number of seconds from 1 to 2147483 throws, so a
 * typo stops the daemon at boot instead of silently removing the limit.
 */
export function turnTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[TURN_TIMEOUT_ENV]?.trim();
  if (!raw) return DEFAULT_TURN_TIMEOUT_S * 1000;
  const seconds = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_TURN_TIMEOUT_S) {
    throw new Error(`${TURN_TIMEOUT_ENV} must be a whole number of seconds from 1 to ${MAX_TURN_TIMEOUT_S}, got ${JSON.stringify(raw)}`);
  }
  return seconds * 1000;
}

/**
 * Throws when a run produced no Claude result at all: the runner stopped it at
 * the time limit, or its output was not a result. Without this the job would be
 * completed as if it had run. A run with a result, including an error result,
 * passes through unchanged.
 */
export function failOnNoResult(runner: RunnerFn, timeoutMs: number, now: () => number = Date.now): RunnerFn {
  return async (prompt) => {
    const started = now();
    const r = await runner(prompt);
    if (r.ok || r.raw != null) return r;
    if (now() - started >= timeoutMs) {
      throw new Error(`claude turn stopped after ${Math.round(timeoutMs / 1000)} s (${TURN_TIMEOUT_ENV})`);
    }
    throw new Error('claude turn ended without a result');
  };
}
