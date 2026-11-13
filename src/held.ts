// held.ts — make a scheduled run that was stopped for an approval visible.
//
// With a PreToolUse hook that defers a tool call (the optional safety gate),
// headless Claude Code ends the run there: the result carries
// `stop_reason: "tool_deferred"`, the held call in `deferred_tool_use`, and no
// reply text. A scheduled run has nobody waiting to approve and is not resumed,
// so without this the job would complete in silence. The owner gets a notice
// naming the held action instead.

import type { RunnerFn } from './handlers/recurring.js';

export interface HeldCall {
  /** Tool name, e.g. `Bash`. */
  name: string;
  /** The call's input, readable: the command for Bash, otherwise compact JSON. */
  detail: string;
}

/** Longest input shown in a notice; longer ones are cut and marked. */
const MAX_DETAIL = 600;

/** The held tool call in a `claude -p --output-format json` result, or null. */
export function heldCall(raw: unknown): HeldCall | null {
  if (!raw || typeof raw !== 'object') return null;
  const result = raw as { stop_reason?: unknown; deferred_tool_use?: unknown };
  if (result.stop_reason !== 'tool_deferred') return null;
  const call = (result.deferred_tool_use ?? {}) as { name?: unknown; input?: unknown };
  const name = typeof call.name === 'string' && call.name ? call.name : 'a tool';
  const input = call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>) : {};
  let detail = typeof input['command'] === 'string' ? input['command'] : JSON.stringify(input);
  if (detail === '{}') detail = '';
  if (detail.length > MAX_DETAIL) detail = `${detail.slice(0, MAX_DETAIL)}… (cut)`;
  return { name, detail };
}

/** `daily_briefing` -> `Daily briefing`. */
function label(kind: string): string {
  const words = kind.replace(/[._]/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Scheduled job';
}

/** What the owner is told when a scheduled run stopped for an approval. */
export function heldNotice(kind: string, held: HeldCall, partial = ''): string {
  const lines = [
    `${label(kind)} stopped before finishing: an action is waiting for approval.`,
    '',
    held.detail ? `${held.name}: ${held.detail}` : held.name,
    '',
    'A scheduled run cannot wait for an approval, so it ended here and will stop at the same point next time.',
    'To let it run, allow this action in the gate\'s policy (.claude/policy/capabilities.toml, or rules/bash-allowlist.jsonl for Bash commands).',
  ];
  if (partial.trim()) lines.push('', 'Output before it stopped:', partial.trim());
  return lines.join('\n');
}

/** A runner for one job kind whose reply becomes the notice when the run was held. */
export function reportingHeld(kind: string, runner: RunnerFn): RunnerFn {
  return async (prompt) => {
    const r = await runner(prompt);
    const held = heldCall(r.raw);
    return held ? { ...r, text: heldNotice(kind, held, r.text) } : r;
  };
}
