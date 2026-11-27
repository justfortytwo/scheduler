# @justfortytwo/scheduler

Durable job scheduler daemon for justfortytwo. Owns the `jobs` queue (its schema and API), kept in the database opened by `@justfortytwo/memory`, and fires LLM turns only behind a cheap "is there work?" gate.

## Overview

- **Handler registry** — maps job kinds to handlers
- **`tick()`** — pure, fully injectable function: claim due jobs, gate check, enqueue run, notify, reschedule/complete, backoff on error
- **Daemon** (Phase 3) — croner + p-queue wiring around `tick()`

## Usage

```ts
import { createRegistry, tick } from '@justfortytwo/scheduler';

const registry = createRegistry([myHandler]);

await tick({
  claimDue,
  complete,
  fail,
  registry,
  recurrenceNext,
  enqueueRun,
  notify,
}, new Date().toISOString());
```

## Jobs queue

The scheduler owns the `jobs` table and the job API. Both used to live in
`@justfortytwo/memory`; import them from here:

```ts
import { openDb, runMigrations } from '@justfortytwo/memory';
import { runSchedulerMigrations, enqueue, existsPending, listActive } from '@justfortytwo/scheduler';

const h = openDb('fortytwo.db');
await runMigrations(h.k);          // memory's schema
await runSchedulerMigrations(h.k); // the jobs table (migration 004_jobs)
enqueue(h, { kind: 'reminder', run_at: new Date().toISOString(), payload: { text: 'hi' } });
```

Exports: `enqueue`, `claimDue`, `complete`, `fail`, `listActive`, `requeueStale`,
`existsPending`, `setRecurrence`, `cancel`, `MAX_ATTEMPTS`, `JobRow`, `NewJob`,
`CancelResult`, `SCHEDULER_MIGRATIONS`, `runSchedulerMigrations`.

`cancel(h, id, { kinds? })` sets a **pending** job to `cancelled`, a terminal
status nothing picks up again. A running or finished job is refused, and so is a
job whose kind is not in `kinds` when given; the check and the change are one
UPDATE, so a job the daemon claims at the same moment is reported as running.

Every process that opens the database and touches jobs runs both migration
lists: the daemon, the Telegram bridge and the installer. The migration keeps
its old name, `004_jobs`, in memory's `_migration_state` table under the same
lock, so an existing install skips it; on a fresh database it runs after
memory's migrations. `countPendingApprovals` stays in memory, which owns the
`approvals` table.

## Agent tools (MCP)

The package ships a second bin, `fortytwo-scheduler-mcp`: a stdio MCP server
that lets the assistant put jobs on this durable queue instead of a
session-local cron. `fortytwo init` registers it in `.mcp.json` as
`fortytwo-scheduler` (tools appear as `mcp__fortytwo-scheduler__*`):

```json
"fortytwo-scheduler": {
  "command": "npx",
  "args": ["-y", "-p", "@justfortytwo/scheduler", "fortytwo-scheduler-mcp"],
  "env": { "DB_PATH": "db/fortytwo.db" }
}
```

| Tool | What it does |
| --- | --- |
| `enqueue_job` | `{ kind, payload, run_at?, timezone?, recurrence? }`. Creates a job the daemon fires with no session open. |
| `list_jobs` | Active jobs: **pending and running** rows, soonest first. System jobs are listed without their payload; `cancellable` marks the ones `cancel_job` accepts. |
| `cancel_job` | `{ id }`. Cancels a pending reminder. |

Rules (`src/agent-jobs.ts`):

- **Kinds:** `reminder` only (`AGENT_JOB_KINDS`). `reply`, `notify_pending`,
  `reembed_memory`, Oneiros and the built-in recurring kinds are system-owned:
  the agent can neither create nor cancel them.
- **Payload:** exactly `{ "text": "..." }`, one line, 1 to 500 characters
  (`MAX_REMINDER_TEXT`). The text reaches a prompt as `Reminder: <text>`, so it is
  treated as untrusted: other keys, newlines and control characters are rejected.
- **`run_at`:** ISO-8601 with `Z` or an offset, or without one plus `timezone`
  (IANA). Stored as UTC `toISOString()`. Malformed values, impossible dates and
  times in the past are **rejected** (a past time is never fired immediately).
- **`recurrence`:** a cron checked with croner in the install time zone (the one
  the daemon reads crons in, UTC when none is saved), at most once an hour
  (`MIN_RECURRENCE_INTERVAL_MS`). Without `run_at` the first run is the cron's next one.
- **Cap:** at most 20 active reminders (`MAX_ACTIVE_AGENT_JOBS`), checked in the
  same write transaction as the insert.
- **Cancel:** pending reminders only; running jobs and built-in or system jobs are refused.

The server runs no migrations. It opens `DB_PATH` (which must exist) with
memory's `openDb` and shares the file with the daemon through WAL and
`busy_timeout`; until the `jobs` table exists every tool returns an error.
Env: `DB_PATH` (required), `FORTYTWO_ROOT` (where `.fortytwo/schedules.json`
is read for the time zone; default: the working directory).

**Safety gate:** with the gate on, the shipped capability manifest names each
tool. `list_jobs` and `enqueue_job` get the `internal` tier: they only write the
local database, within the caps above, and every scheduled turn later runs under
the gate like any other. `cancel_job` gets `irreversible`, so cancelling waits
for the owner's approval. A tool added later is held (unknown tools are
`external`) until the manifest names it. A manifest written before these entries
existed holds every call until you add
`"mcp__fortytwo-scheduler__list_jobs" = "internal"` and
`"mcp__fortytwo-scheduler__enqueue_job" = "internal"`.

## Run

The scheduler daemon is a long-running process — run it under a restart loop.

### tmux (development / quick start)

```sh
while true; do
  DB_PATH=/path/to/fortytwo.db \
  EMBED_MODEL=qwen3-embedding:0.6b \
  OLLAMA_BASE_URL=http://localhost:11434 \
  CLAUDE_BIN=$(which claude) \
  FORTYTWO_TURN_TIMEOUT=300 \
  npx fortytwo-scheduler
  echo "scheduler exited ($?); restarting in 3 s …"
  sleep 3
done
```

### systemd (production)

Create `/etc/systemd/system/fortytwo-scheduler.service`:

```ini
[Unit]
Description=fortytwo scheduler daemon
After=network.target

[Service]
Type=simple
Restart=always
RestartSec=3s
Environment=DB_PATH=/path/to/fortytwo/db/fortytwo.db
Environment=EMBED_MODEL=qwen3-embedding:0.6b
Environment=OLLAMA_BASE_URL=http://localhost:11434
Environment=CLAUDE_BIN=/usr/local/bin/claude
Environment=FORTYTWO_TURN_TIMEOUT=300
ExecStart=npx fortytwo-scheduler

[Install]
WantedBy=multi-user.target
```

Then: `systemctl enable --now fortytwo-scheduler`

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_PATH` | yes | Absolute path to `fortytwo.db` |
| `EMBED_MODEL` | recommended | Ollama model name for semantic embeddings (falls back to FakeEmbedder) |
| `OLLAMA_BASE_URL` | no | Ollama API base URL (default: `http://localhost:11434`) |
| `CLAUDE_BIN` | no | Path to the `claude` CLI binary the runner spawns (default: `claude` on `PATH`) |
| `FORTYTWO_CLAUDE_ARGS` | no | Extra arguments for every `claude` run, as a JSON array of strings (e.g. `["--chrome"]`). Set by `fortytwo start -- <args>`. Applies to scheduled runs, not to the Oneiros worker. A malformed value stops the daemon at boot. When Telegram push is on, the daemon also passes scheduled runs an output note through `--append-system-prompt` that asks for compact lists instead of Markdown tables. If the operator sets `--append-system-prompt`, the daemon keeps that value and adds the note after it. |
| `FORTYTWO_TURN_TIMEOUT` | no | Per-turn time limit in seconds for a scheduled `claude` run (default: `300`). The runner stops a turn that passes it, and the job fails into the normal retry (1 min, then 5 min). A one-off then becomes `failed`; a recurring job skips that slot and runs again at its next one. A value that is not a whole number of seconds from 1 to 2147483 stops the daemon at boot. The Oneiros worker keeps its own 120 s limit. |
| `TELEGRAM_BOT_TOKEN` | optional | Telegram bot token — enables push notifications to Telegram |
| `ALLOWED_CHAT_IDS` | optional | Comma-separated Telegram chat IDs; when set, notifications go to the **first** id. When unset, they go to every chat paired with `fortytwo pair` |
| `FORTYTWO_ROOT` | no | Project root: holds `.fortytwo/schedules.json`, `.claude/skills` and the Telegram bindings db (default: the working directory) |
| `CLAUDE_CONFIG_DIR` | no | Claude Code config dir, checked for user-level skills (default: `~/.claude`) |
| `TELEGRAM_BINDINGS_DB` | no | Bindings db path, relative to the root (default: `state/telegram-bindings.db`); must match the bridge |

### Approval notifications

When the safety gate stages an approval, memory queues no job: the approval row
waits with `notified_at` unset. On every poll (`POLL_MS`, 30 s) the daemon runs
`notify_pending` for those approvals, sends the result like any notification,
and then stamps `notified_at`. Each staged approval is notified at least once,
including one staged while a notification is already running. The delay is up
to one poll period, plus any job running ahead of it. A failed run stamps
nothing and is retried after 1, 5, then 30 minutes. Requires memory with
migration `006_approvals_notified_at`.

### Built-in schedules

Three recurring jobs are built in. Each can be switched on or off per install.

| kind | when | runs only if | skill |
|------|------|--------------|-------|
| `daily_briefing` | 07:57 daily | always | `daily-briefing` |
| `sweep` | 13:03 and 18:03 daily | approvals are pending | none |
| `learn_review` | Sundays 09:17 | memories were stored in the last 7 days | `learn-review` |

**Choosing which run.** `fortytwo init` asks about each one (or takes
`--schedules all|none|<kind,kind>`) and writes `<FORTYTWO_ROOT>/.fortytwo/schedules.json`:

```json
{ "version": 1, "schedules": { "daily_briefing": { "enabled": false } } }
```

The daemon reads the file once at boot: a job that is off is not seeded and its
existing row is retired; switching it back on seeds it again. A kind that is not
listed is on, and so is every kind when the file is missing. A file that cannot
be parsed stops the daemon with an error instead of running everything. Restart
the daemon after changing the file. On an existing install, change the choice with
`fortytwo schedules` (it touches only this file).

**Time zone.** The times above are UTC unless the file names a zone:

```json
{ "version": 1, "timezone": "Europe/Rome", "schedules": {} }
```

With `timezone` set (an IANA name), 07:57 is 07:57 on that clock all year,
across daylight saving. The Oneiros job (03:17) follows it too. `fortytwo init`
writes the owner's zone on a new install; on an existing one set it with
`fortytwo schedules --timezone <name>`. At boot, a waiting run that no longer
matches the schedule is moved to the next correct time; an overdue run and a
retry keep theirs. A value that is not a usable zone stops the daemon with an
error instead of falling back to UTC.

**Skills.** The two skills ship in `@justfortytwo/persona` and the installer
copies them into `<FORTYTWO_ROOT>/.claude/skills/`. On every run the job checks
for `<name>/SKILL.md` there and in `$CLAUDE_CONFIG_DIR/skills` (default
`~/.claude/skills`). With the skill it sends a short "run the skill" prompt;
without it, a self-contained prompt that states the task and its limits, so a
standalone daemon still produces a sensible result.

**With the safety gate on.** A scheduled run has nobody waiting to approve a
held action. When the gate (`@justfortytwo/gate`) holds a tool call, the run
ends there and is not resumed. The job then reports that instead of a result:
which job stopped and the exact action that was held (a Bash command is shown
as written). It stops at the same point on the next run until that action is
allowed in the gate's policy (`.claude/policy/capabilities.toml`, or
`rules/bash-allowlist.jsonl` for Bash commands). Oneiros runs in its own
locked-down worker and does not send this notice.

### Liveness / `fortytwo doctor`

On boot and on every 30-second poll tick — even while a previous tick is still in flight — the daemon writes a heartbeat file at `$(dirname $DB_PATH)/scheduler.heartbeat` containing `{ "pid": <number>, "ts": "<ISO>" }`. The write is outside the poll's overlap guard so a long-running turn never starves it. `fortytwo doctor` reads this file and warns (non-fatal) if it is missing or older than 90 seconds.

## License

MIT © 2026 Enrico Deleo

## Oneiros maintenance

`persona.oneiros` runs daily at `17 3 * * *` (UTC, or the install's time zone when one is set), with null payload and the existing
durable retry/claim mechanism. Installer seeds it after initializing persona's
checkpoint; daemon boot reconciles the same job when the checkpoint exists.
The cheap gate checks the memory head and, when the optional `@justfortytwo/transcript`
peer is installed, the transcript head. Persona validates and applies additions;
scheduler runs the private prompt through runner in an isolated temporary cwd.
No tools, MCP, skills or session persistence are enabled, and maintenance emits
no notification into memory. Authentication/provider configuration is preserved.
Requires a Claude CLI with `--safe-mode`; unsupported flags fail closed.
Stop the runtime before upgrading packages and start it again afterwards.

## Journal

Each job notification is appended to the conversation log (`channel: 'scheduler'`, the
notification kind in `kind`) when the optional `@justfortytwo/transcript` peer is
installed; otherwise it is a no-op. It is no longer stored as a memory row
(`source: 'scheduler:wake'` is retired), so the `learn_review` gate, which counts memory
rows only, fires less often.
