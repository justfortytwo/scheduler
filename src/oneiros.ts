// Internal maintenance adapter: scheduler owns timing and runner invocation.
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner, type RunOptions, type RunResult } from '@justfortytwo/runner';
import { hasWork, refine, workerPrompt, type WorkerInput } from '@justfortytwo/persona';
import { memoryHead, memoryDelta, listActive, enqueue, setRecurrence, type DbHandles } from '@justfortytwo/memory';
import { seedRecurring } from './seed.js';
import type { Handler } from './types.js';
import type { RecurringDef } from './handlers/index.js';
export const ONEIROS_DEF: RecurringDef = { kind: 'persona.oneiros', cron: '17 3 * * *', trigger: '' };
export function seedOneiros(h: DbHandles, now: string, next: (cron: string, now: string) => string): void {
  // Existing seeder, serialized with the jobs DB write lock across installer/daemon.
  h.raw.transaction(() => seedRecurring({ listActive: () => listActive(h), enqueue: j => enqueue(h,j), setRecurrence: (id,rec,at) => setRecurrence(h,id,rec,at) }, [ONEIROS_DEF], now, next)).immediate();
}
export async function isolatedWorker(input: WorkerInput, run: (options: RunOptions) => Promise<RunResult> = createRunner().run): Promise<unknown> {
  const cwd = mkdtempSync(join(tmpdir(), 'fortytwo-oneiros-'));
  try {
    // Safe mode keeps authentication/provider selection while disabling customizations,
    // including hooks, CLAUDE.md and plugins. Unsupported flags fail closed.
    // Provider selectors, OAuth/API credentials and their config directory must
    // survive. Safe mode disables customization without discarding authentication.
    const env: NodeJS.ProcessEnv = { CLAUDECODE: undefined, CLAUDE_CODE_SESSION_ID: undefined };
    const result = await run({ cwd, env, timeoutMs: 120_000,
      args: ['--safe-mode', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--no-session-persistence', '--setting-sources', '', '--system-prompt', workerPrompt],
      prompt: JSON.stringify(input),
    });
    if (!result.ok) throw new Error('Oneiros worker failed');
    if (Buffer.byteLength(result.text) > 16_384) throw new Error('Oneiros response too large');
    return JSON.parse(result.text);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
export function oneirosEnabled(root: string): boolean { return existsSync(join(root, '.fortytwo/oneiros/checkpoint.json')); }
export function makeOneirosHandler(root: string, h: DbHandles, worker: typeof isolatedWorker = isolatedWorker): Handler {
  const memory = { head: () => memoryHead(h), delta: (cursor: ReturnType<typeof memoryHead>) => memoryDelta(h,cursor) };
  return { kind: ONEIROS_DEF.kind,
    hasWork: async () => hasWork(root,memory),
    run: async () => { await refine({root,memory,worker}); return null; },
  };
}
