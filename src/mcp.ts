#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { openDb, type DbHandles } from '@justfortytwo/memory';
import {
  AGENT_JOB_KINDS, MAX_ACTIVE_AGENT_JOBS, MAX_REMINDER_TEXT,
  cancelAgentJob, enqueueAgentJob, listAgentView, type Checked,
} from './agent-jobs.js';
import { readScheduleTimezone } from './schedules.js';

// `fortytwo-scheduler-mcp`: a small stdio MCP server that lets the agent put
// jobs on the scheduler's durable queue (scheduler#1). Claude Code spawns it
// next to the daemon; the two share the SQLite file through WAL and
// busy_timeout only. It runs NO migrations: the daemon and `fortytwo init` own
// the schema, and a DB without the jobs table is reported, not created.

/** Server name; tools appear to the agent as `mcp__fortytwo-scheduler__<tool>`. */
export const SCHEDULER_MCP_ID = 'fortytwo-scheduler';

const INSTRUCTIONS = [
  'Durable jobs run by the fortytwo scheduler daemon: they survive restarts and fire with no chat session open.',
  'Use enqueue_job for anything the owner wants at a later time ("remind me at 5pm"), instead of a session-local cron or timer.',
  `Allowed kinds: ${AGENT_JOB_KINDS.join(', ')}. A reminder runs one assistant turn with the prompt "Reminder: <text>" and sends the answer to the owner.`,
  'run_at is ISO-8601 with an offset (2026-11-20T17:00:00+01:00), or without one plus timezone (an IANA name). Past times are rejected.',
  'recurrence is a cron expression read in the install time zone, at most once an hour.',
  'list_jobs shows pending and running jobs; cancel_job cancels a pending reminder by id.',
].join('\n');

function toolDefinitions(): Tool[] {
  return [
    {
      name: 'enqueue_job',
      description:
        `Schedule a durable job. Only kind "reminder" is allowed; payload is { "text": "..." } (one line, at most ${MAX_REMINDER_TEXT} characters). ` +
        `Give run_at for a one-off; give recurrence (cron, at most hourly) for a repeating reminder, optionally with run_at for its first run. ` +
        `At most ${MAX_ACTIVE_AGENT_JOBS} reminders can be active at once.`,
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...AGENT_JOB_KINDS] },
          payload: {
            type: 'object',
            properties: { text: { type: 'string', maxLength: MAX_REMINDER_TEXT } },
            required: ['text'],
            additionalProperties: false,
          },
          run_at: { type: 'string', description: 'ISO-8601 date and time, with Z or an offset unless timezone is given.' },
          timezone: { type: 'string', description: 'IANA zone (e.g. Europe/Rome) for a run_at written without an offset.' },
          recurrence: { type: 'string', description: 'Cron expression, read in the install time zone; no more often than hourly.' },
        },
        required: ['kind', 'payload'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_jobs',
      description:
        'List active jobs: both pending and running rows, soonest first. Built-in and system jobs are included without their payload; ' +
        '`cancellable` marks the ones cancel_job accepts.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'cancel_job',
      description: 'Cancel a pending reminder by id. Running jobs, finished jobs and built-in or system jobs are refused.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'integer' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
  ];
}

export interface JobsServerOptions {
  /** Current time as ISO (UTC); defaults to the clock. */
  now?: () => string;
  /** Zone crons are read in; defaults to UTC. The bin passes the install's zone. */
  timezone?: () => string;
}

function hasJobsTable(h: DbHandles): boolean {
  return h.raw.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'`).get() !== undefined;
}

/**
 * Build the MCP server on an open DB without connecting a transport (the bin
 * uses stdio; tests use an in-memory transport). Validation failures come back
 * as tool errors (`isError: true`) with a message the agent can act on.
 */
export function createJobsServer(h: DbHandles, opts: JobsServerOptions = {}): Server {
  const now = opts.now ?? (() => new Date().toISOString());
  const timezone = opts.timezone ?? (() => 'UTC');
  const server = new Server(
    { name: SCHEDULER_MCP_ID, version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions() }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const a = args as Record<string, unknown>;
    let result: Checked<unknown>;
    if (!hasJobsTable(h)) {
      result = { ok: false, error: 'the jobs table does not exist yet: run `fortytwo init` or start the scheduler once' };
    } else if (name === 'enqueue_job') {
      let tz: string;
      try {
        tz = timezone();
      } catch (e: unknown) {
        return errorResult(`cannot read the install time zone: ${(e as Error)?.message ?? e}`);
      }
      result = enqueueAgentJob(h, a, { now: now(), timezone: tz });
    } else if (name === 'list_jobs') {
      result = { ok: true, value: { includes: ['pending', 'running'], jobs: listAgentView(h) } };
    } else if (name === 'cancel_job') {
      result = cancelAgentJob(h, a['id']);
      if (result.ok) result = { ok: true, value: { ...(result.value as object), status: 'cancelled' } };
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
    if (!result.ok) return errorResult(result.error);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result.value, null, 2) }] };
  });

  return server;
}

function errorResult(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Open the DB (no migrations) and serve over stdio. `DB_PATH` is required to
 * point at an existing file so a wrong path never creates a stray empty DB.
 * Crons are read in the zone saved in `<FORTYTWO_ROOT or cwd>/.fortytwo/schedules.json`,
 * read on each enqueue like the daemon reads it at boot.
 */
export async function startJobsServer(): Promise<void> {
  const raw = process.env['DB_PATH'];
  if (!raw) throw new Error('DB_PATH is not set');
  const dbPath = resolve(raw);
  if (!existsSync(dbPath)) throw new Error(`database ${dbPath} does not exist: run \`fortytwo init\` first`);
  const root = resolve(process.env['FORTYTWO_ROOT'] ?? process.cwd());
  const h = openDb(dbPath);
  const server = createJobsServer(h, { timezone: () => readScheduleTimezone(root) ?? 'UTC' });
  await server.connect(new StdioServerTransport());
}

function invokedAsBin(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsBin()) {
  startJobsServer().catch((err: unknown) => {
    process.stderr.write(`fortytwo-scheduler-mcp: ${(err as Error)?.stack ?? err}\n`);
    process.exit(1);
  });
}
