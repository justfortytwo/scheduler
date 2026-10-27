// Internal maintenance adapter: scheduler owns timing and runner invocation.
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner, type RunOptions, type RunResult } from '@justfortytwo/runner';
import { hasWork, refine, workerPrompt, type WorkerInput, type TranscriptSource, type TranscriptEvidenceRow } from '@justfortytwo/persona';
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
export function makeOneirosHandler(root: string, h: DbHandles, worker: typeof isolatedWorker = isolatedWorker, transcript?: TranscriptSource): Handler {
  const memory = { head: () => memoryHead(h), delta: (cursor: ReturnType<typeof memoryHead>) => memoryDelta(h,cursor) };
  return { kind: ONEIROS_DEF.kind,
    hasWork: async () => hasWork(root,memory,transcript),
    run: async () => { await refine({root,memory,transcript,worker}); return null; },
  };
}

type TranscriptModule = {
  transcriptHead: (h: unknown) => ReturnType<TranscriptSource['head']>;
  transcriptDelta: (h: unknown, cursor: Parameters<TranscriptSource['delta']>[0], limit?: number) => { cursor: ReturnType<TranscriptSource['head']>; entries: Array<TranscriptEvidenceRow & Record<string, unknown>> };
};

/** Transcript rows per Oneiros round; smaller than the package default to keep the worker input within budget. */
export const TRANSCRIPT_PAGE_LIMIT = 20;

/**
 * Adapt the optional @justfortytwo/transcript peer into a TranscriptSource.
 * Any failure (not installed, missing exports) yields undefined and is reported
 * on stderr. Persona then refuses to run if a transcript stream was initialised,
 * so a missing source is never silently skipped.
 */
export async function loadTranscriptSource(
  h: unknown,
  importer: (name: string) => Promise<unknown> = (n) => import(n),
): Promise<TranscriptSource | undefined> {
  let mod: TranscriptModule;
  try {
    mod = (await importer('@justfortytwo/transcript')) as TranscriptModule;
  } catch (e: unknown) {
    process.stderr.write(`fortytwo-scheduler: transcript source unavailable (import @justfortytwo/transcript failed): ${(e as Error)?.message ?? e}\n`);
    return undefined;
  }
  if (typeof mod?.transcriptHead !== 'function' || typeof mod?.transcriptDelta !== 'function') {
    process.stderr.write('fortytwo-scheduler: transcript source unavailable (@justfortytwo/transcript lacks transcriptHead/transcriptDelta)\n');
    return undefined;
  }
  return {
    head: () => mod.transcriptHead(h),
    delta: (cursor) => {
      const d = mod.transcriptDelta(h, cursor, TRANSCRIPT_PAGE_LIMIT);
      // Explicit mapping: exactly the fields persona reads, including the row meta.
      return { cursor: d.cursor, entries: d.entries.map((r) => ({
        id: r.id, channel: r.channel, direction: r.direction, actor: r.actor, kind: r.kind,
        content: r.content, thread_id: r.thread_id, meta: r.meta,
      })) };
    },
  };
}
