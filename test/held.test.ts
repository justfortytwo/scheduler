import { describe, expect, it, vi } from 'vitest';
import { heldCall, heldNotice, reportingHeld } from '../src/held.js';
import { buildRegistry } from '../src/handlers/index.js';

const deferred = (name: string, input: unknown) => ({
  type: 'result', result: '', stop_reason: 'tool_deferred', deferred_tool_use: { id: 'toolu_1', name, input },
});

describe('heldCall', () => {
  it('is null for a normal result and for no result', () => {
    expect(heldCall({ result: 'hi', stop_reason: 'end_turn' })).toBeNull();
    expect(heldCall(null)).toBeNull();
    expect(heldCall(undefined)).toBeNull();
  });

  it('shows the command of a held Bash call', () => {
    expect(heldCall(deferred('Bash', { command: 'cd x; cat a', description: 'd' })))
      .toEqual({ name: 'Bash', detail: 'cd x; cat a' });
  });

  it('shows other inputs as JSON and cuts long ones', () => {
    expect(heldCall(deferred('mcp__mail__send', { to: 'a@b' }))).toEqual({ name: 'mcp__mail__send', detail: '{"to":"a@b"}' });
    const long = heldCall(deferred('Bash', { command: 'x'.repeat(2000) }))!;
    expect(long.detail.length).toBeLessThan(700);
    expect(long.detail.endsWith('… (cut)')).toBe(true);
  });

  it('copes with a deferral that carries no call details', () => {
    expect(heldCall({ stop_reason: 'tool_deferred' })).toEqual({ name: 'a tool', detail: '' });
  });
});

describe('heldNotice', () => {
  it('names the job and the held action', () => {
    const text = heldNotice('daily_briefing', { name: 'Bash', detail: 'cd x; cat a' });
    expect(text).toContain('Daily briefing stopped before finishing');
    expect(text).toContain('Bash: cd x; cat a');
    expect(text).not.toContain('Output before it stopped');
  });

  it('keeps output produced before the stop', () => {
    expect(heldNotice('reminder', { name: 'Bash', detail: '' }, ' partial ')).toContain('Output before it stopped:\npartial');
  });
});

describe('reportingHeld', () => {
  it('passes a normal reply through unchanged', async () => {
    const r = await reportingHeld('sweep', async () => ({ ok: true, text: 'all clear', raw: { result: 'all clear' } }))('p');
    expect(r.text).toBe('all clear');
  });

  it('passes through a runner that exposes no raw result', async () => {
    const r = await reportingHeld('sweep', async () => ({ ok: true, text: '' }))('p');
    expect(r.text).toBe('');
  });

  it('turns a held run into a notice', async () => {
    const r = await reportingHeld('sweep', async () => ({ ok: true, text: '', raw: deferred('Bash', { command: 'ls; pwd' }) }))('p');
    expect(r.text).toContain('Sweep stopped before finishing');
    expect(r.text).toContain('Bash: ls; pwd');
  });
});

describe('buildRegistry with a held run', () => {
  it('a built-in job returns the notice as its text', async () => {
    const runner = vi.fn(async () => ({ ok: true, text: '', raw: deferred('Bash', { command: 'cd c; cat P.md' }) }));
    const registry = buildRegistry({
      runner, countPendingApprovals: () => 0, recentCount: async () => 0, reembedOne: async () => true,
    });
    const res = await registry.get('daily_briefing')!.run({ now: '2026-01-01T00:00:00.000Z', payload: undefined });
    expect(res?.text).toContain('Daily briefing stopped before finishing');
    expect(res?.text).toContain('Bash: cd c; cat P.md');
  });
});
