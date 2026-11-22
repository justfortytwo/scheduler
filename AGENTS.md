# AGENTS.md

Guidance for AI coding agents working in `@justfortytwo/scheduler`.

## Purpose

A long-running daemon (`fortytwo-scheduler`) that drains the durable `jobs` table. The scheduler
owns that table (migration `004_jobs`) and the job API; the SQLite file and its handle (`openDb`) come
from `@justfortytwo/memory`. It also ships `fortytwo-scheduler-mcp`, the agent's job tools, and polls
memory's approvals outbox so every staged approval is announced. It fires an LLM turn (via `@justfortytwo/runner`, which spawns the `claude` CLI)
only after a cheap `hasWork` gate says there is real work. Results go to the conversation log (`@justfortytwo/transcript`) and, if
configured, to Telegram. The design doc is `../docs/scheduler.md` (the sibling `docs` repo).

## Layout

```
src/
  index.ts          Public exports + bin entry (boots daemon only when run directly)
  jobs.ts           Job API: enqueue, claimDue, complete, fail, listActive, requeueStale, existsPending,
                    setRecurrence, cancel (pending rows only; refuses running and seeded kinds)
  migrate.ts        SCHEDULER_MIGRATIONS + runSchedulerMigrations() (memory's state table and lock)
  migrations/       004_jobs (same name memory used to ship; CREATE TABLE IF NOT EXISTS)
  agent-jobs.ts     Rules for agent-created jobs: reminder-only allowlist, run_at/cron checks, caps
  mcp.ts            fortytwo-scheduler-mcp bin: enqueue_job / list_jobs / cancel_job over stdio; no migrations
  approval-outbox.ts  drain(): notify approvals with notified_at NULL, then stamp them
  held.ts           Notice for a scheduled run stopped by the safety gate (tool_deferred)
  oneiros.ts        Oneiros job seeding/handler wiring
  conversation-log.ts  ConversationLog adapter over @justfortytwo/transcript (no-op when absent)
  types.ts          Job, RunCtx, RunResult, Handler, Notification, Notifier, Registry
  registry.ts       createRegistry(): kind -> Handler map; throws on duplicate kind
  tick.ts           tick(): pure, fully injected drain loop; backoffAt / RETRY_BACKOFF_MIN
  daemon.ts         startDaemon(): DB open + memory and scheduler migrations, stale requeue, seeding,
                    30s poll (due jobs + approval outbox), PQueue(1); recurrenceNext()
  seed.ts           seedRecurring(): idempotent upsert of recurring rows; retireRecurring(): completes rows of disabled kinds
  schedules.ts      .fortytwo/schedules.json: which built-in jobs are enabled (read/write/parse)
  skills.ts         skillDirs() / skillInstalled(): is a Claude Code skill present on disk
  notifier.ts       Journal notifier + fanout notifier (per-notifier errors swallowed)
  telegram-push.ts  Telegram push targets (ALLOWED_CHAT_IDS or paired chats) + push notifier; no telegram import
  heartbeat.ts      heartbeatPath() / writeHeartbeat() (best-effort, never throws)
  handlers/
    index.ts        RECURRING_DEFS (cron, trigger, description, optional skill + fallback), triggerFor(), buildRegistry()
    recurring.ts    makeRecurringHandler() with optional hasWork gate
    oneoff.ts       notify_pending (payload.ids, legacy payload.id), reply, reminder (payload.text) handlers
    reembed.ts      reembed_memory handler (no LLM, returns null = no notification); no producer since memory 2.0.0
test/               Vitest suites, one per module (*.test.ts)
```

`dist/` is build output (gitignored). There is no CI workflow and no lint/format script in this repo.

## Commands

From `package.json` (Node >= 20, npm, lockfile present):

- `npm ci` - install dependencies
- `npm run build` - `tsc -p tsconfig.json` -> `dist/`
- `npm test` - `vitest run`
- `npm run test:watch` - Vitest watch mode
- `npx vitest run test/tick.test.ts` - single test file
- `prepublishOnly` runs the build; the package publishes only `dist`, `README.md`, `LICENSE`.

Run the daemon after building: `DB_PATH=/abs/path/fortytwo.db node dist/index.js`
(or `npx fortytwo-scheduler`). The job tools: `DB_PATH=... node dist/mcp.js` (`fortytwo-scheduler-mcp`),
normally launched by Claude Code from the `fortytwo-scheduler` entry the installer writes in `.mcp.json`. See README for the env table: `DB_PATH`, `EMBED_MODEL`,
`OLLAMA_BASE_URL`, `CLAUDE_BIN`, `FORTYTWO_TURN_TIMEOUT`, `TELEGRAM_BOT_TOKEN`, `ALLOWED_CHAT_IDS`,
`FORTYTWO_ROOT`, `TELEGRAM_BINDINGS_DB`, `CLAUDE_CONFIG_DIR`.

## Code conventions

- ESM (`"type": "module"`), TypeScript strict with `noUncheckedIndexedAccess`, `NodeNext`
  resolution: relative imports must use the `.js` suffix (`./tick.js`).
- Two-space indent, single quotes, semicolons, trailing commas; kebab/lowercase filenames.
- Dependency injection everywhere: `tick`, `seedRecurring`, `buildRegistry`, and notifiers take their
  I/O as injected functions so tests use fakes rather than a real DB, Ollama, or `claude`.
- Timestamps are ISO-8601 strings; pass `now` in explicitly rather than reading the clock deep inside logic.
- Env vars are read with bracket access (`process.env['DB_PATH']`), only in `index.ts` / `daemon.ts` / `mcp.ts`.
- New public API must be re-exported from `src/index.ts` (grouped by "Phase N" comments).
- Commit messages: conventional style with scope, e.g. `feat(scheduler): ...`, `fix(scheduler): ...`.

## Architecture notes

- **tick flow** per claimed job: look up handler (missing -> `fail`, no retry) -> compute
  `reschedule` from `job.recurrence` (outside try/catch) -> parse payload + `hasWork` gate
  (false -> `complete` + reschedule, no LLM) -> `enqueueRun(run)` -> notify if `res.text` ->
  `complete`; on throw, `fail` with `retryAt = backoffAt(now, attempts)` (1, 5, 30 min).
- **Daemon**: `setInterval` every `POLL_MS` (30s). `makePoll` guards against overlapping ticks;
  `PQueue({ concurrency: 1 })` means at most one handler runs at a time.
- **Crash recovery**: on boot, jobs stuck in `running` longer than `STALE_RUNNING_MS` (15 min) are
  requeued via `requeueStale` (`src/jobs.ts`).
- **Recurring jobs are code-authoritative**: `RECURRING_DEFS` (`daily_briefing`, `sweep`,
  `learn_review`) are seeded on every boot; a changed cron updates the existing row. Crons are
  evaluated in **UTC** unless `.fortytwo/schedules.json` sets `timezone` (`recurrenceNext` uses croner
  with that zone; the MCP validates agent crons in the same zone through `readScheduleTimezone`).
- **The owner chooses which built-in jobs run**: `<root>/.fortytwo/schedules.json` (written by
  `fortytwo init` through `writeSchedules`) is read once at boot, before the DB is opened. Disabled
  kinds are retired (`retireRecurring` completes their active recurring row) and not seeded. Missing
  file or unlisted kind = enabled; an unparseable file makes `startDaemon` reject (never "all on").
  `root` is `DaemonOptions.root`, else `FORTYTWO_ROOT`, else cwd.
- **Skill-aware triggers**: `daily_briefing` and `learn_review` name a skill that ships in `persona`
  and is copied into `<root>/.claude/skills` by the installer. `triggerFor` picks `trigger` when
  `skillInstalled` finds `<name>/SKILL.md` (project or `CLAUDE_CONFIG_DIR`), else the def's
  self-contained `fallback`; it is evaluated on every run. Keep both prompts in step with the skill.
- Gates: `sweep` runs only if pending approvals > 0; `learn_review` only if memories in the last
  7 days > 0 (memory rows only; journal entries now live in the transcript, so it fires less often) (window computed per call, not at boot); `daily_briefing` is ungated.
- **Notifications**: journal notifier appends to the `ConversationLog` (`src/conversation-log.ts`, channel `scheduler`, notification kind in `kind`;
  `source: 'scheduler:wake'` is no longer used) fire-and-forget, failures logged to stderr; with no `@justfortytwo/transcript`
  it is a no-op. Extra notifiers are fanned out and their failures are swallowed.
  Oneiros also reads the transcript via `loadTranscriptSource` (20-row pages, row `meta` passed
  through; undefined when not installed, reported on stderr). An initialised transcript stream with
  no source makes the Oneiros job fail closed in persona.
- **Jobs schema**: `runSchedulerMigrations` records `004_jobs` in memory's `_migration_state` under the
  same lock, so installs that got the table from memory 1.x skip it. Every process that opens the DB
  runs it: the daemon, the telegram bridge, and the installer (`init`, Oneiros seeding).
- **Approval outbox**: memory stages approvals with `notified_at` NULL and queues nothing. Each poll,
  inside the overlap guard and through the same PQueue, `drain` notifies the un-notified ones and only
  then stamps them; a failed or empty run stamps nothing and backs off (1, 5, 30 min).
- **Agent job tools** (`mcp.ts` + `agent-jobs.ts`): kind `reminder` only, text capped at 500 chars,
  recurrence no more often than hourly, at most 20 active agent jobs (counted in the insert's write
  transaction). Cancel is a single UPDATE on pending rows. The shipped gate manifest names each tool:
  `list_jobs`/`enqueue_job` internal, `cancel_job` irreversible.
- **Heartbeat**: `$(dirname DB_PATH)/scheduler.heartbeat` with `{ pid, ts }`, written on boot and on
  every interval *outside* the overlap guard so long `claude` turns do not make it go stale.

## Gotchas

- `src/index.ts` is both the library entry and the bin. The daemon boots only when
  `invokedAsBin()` is true (realpath of argv[1] equals the module), so importing never opens a DB.
  Keep the `#!/usr/bin/env node` shebang and the top-level `await` inside that guard.
- `@justfortytwo/telegram` is an **optional peer** and is imported lazily; the scheduler must keep
  working without it installed. Push targets: the first id in `ALLOWED_CHAT_IDS` when set; otherwise
  every paired private chat, read from the bridge's bindings db (`bindingsDbPath`) on each notification,
  so pairing/unbinding needs no restart. The bindings db is opened only when `ALLOWED_CHAT_IDS` is empty.
  Push failures are logged to stderr per chat.
- Without `EMBED_MODEL`, a `FakeEmbedder` is used, so scheduler journal entries are not semantically
  searchable.
- `recurrenceNext` throws on a cron with no next run, and `tick` calls it outside the per-job
  try/catch; validate crons in `RECURRING_DEFS` before adding them.
- Nothing enqueues `reembed_memory` since memory 2.0.0 (`store()` embeds in its own write); the handler
  stays for jobs queued by older installs and silently skips malformed payloads.
- `Job` in `types.ts` is a local structural type kept compatible with `JobRow` in `src/jobs.ts`; keep them in sync.
- `CLAUDE.md`, `.wolf/`, `.codegraph/`, `.claude/` are local tooling (OpenWolf/CodeGraph), not tracked.

## Sibling repos (`../`)

- `memory` - SQLite handle (`openDb`, WAL, busy_timeout), memory migrations (`applyMigrations`), the
  approvals table and its outbox accessors (`listUnnotifiedApprovals`, `markApprovalsNotified`),
  memory `store`/`query`, embedders. It no longer owns or produces jobs.
- `transcript` - the conversation log (`createTranscript`) and Oneiros transcript source
  (`transcriptHead`/`transcriptDelta`).
- `runner` - `createRunner()` which spawns the `claude` CLI for one turn.
- `telegram` - `telegramNotifier` (structural, does not import this package); the bridge enqueues
  reply jobs for this daemon through this package's job API (imported lazily) and no longer runs
  proactive wakes itself.
- `installer` - depends on this package; `fortytwo doctor` reads the heartbeat file
  (warns if missing or older than 90s); `init` tells users to run `fortytwo-scheduler` under a restart loop.
  It runs `runSchedulerMigrations`, writes the `fortytwo-scheduler` entry in `.mcp.json`, and ships the
  gate tiers for the job tools.
- `docs` - `docs/scheduler.md` holds the full design rationale.

## fortytwo project context

This repository is part of **fortytwo**, a local-first personal-assistant spine built around existing agent runtimes and tool ecosystems.

The umbrella project is **fortytwo**. It is not intended to replace Claude Code, Codex, MCP servers, plugins, skills, or other agent runtimes. The project provides the durable personal-assistant infrastructure around them: memory, lifecycle, scheduling, channels, optional policy enforcement, and related supporting components.

Claude Code is currently the primary/reference runtime, but the architecture should avoid unnecessary coupling to a specific model provider. In particular, components should remain usable when Claude Code itself is configured against alternative compatible model providers.

The main bootstrap and lifecycle entry point is the **installer** repository (`justfortytwo/installer`).

### Canonical project locations

- Website: `forty-two.it`
- GitHub organization: `github.com/justfortytwo`
- Architecture/design documentation: `justfortytwo/docs`

### Repositories

The fortytwo project is intentionally split into small, focused repositories.

- **`justfortytwo/installer`**
  Main installer and lifecycle CLI (`create-fortytwo` / `fortytwo`). This is the primary bootstrap entry point for assembling a fortytwo installation.

- **`justfortytwo/runner`**
  Thin Claude Code process/session runtime. Owns process lifecycle and stream transport, including one-shot runs and persistent interactive sessions. It must not become an agent framework.

- **`justfortytwo/memory`**
  Durable semantic-memory MCP server backed by local storage and retrieval infrastructure.

- **`justfortytwo/scheduler`**
  Durable scheduling and proactive job execution. Owns *when* work should happen, not how the agent reasons about or performs that work.

- **`justfortytwo/telegram`**
  Telegram transport/channel adapter. Owns Telegram identity, pairing, message transport, attachment handling, and mapping chats to live agent sessions. It should delegate agent process lifecycle to `runner`.

- **`justfortytwo/persona`**
  Persona and context templates rendered by the installer into an individual fortytwo installation.

- **`justfortytwo/gate`**
  Optional external safety/policy enforcement layer for tool execution and approvals. Keep this separate from the agent runtime's own reasoning and permissions.

- **`justfortytwo/salience`**
  Optional model-driven salience extraction used to enrich durable memory.

- **`justfortytwo/marketplace`**
  Claude Code plugin marketplace and umbrella plugin used as a distribution surface for fortytwo components.

- **`justfortytwo/docs`**
  Cross-repository architecture, design, contracts, and project documentation.

- **`justfortytwo/website`**
  Public website for the project, served as `forty-two.it`.

- **`justfortytwo/.github`**
  GitHub organization metadata and shared organization-level project information.

### Cross-repository architecture

When changing one repository, treat the sibling repositories as parts of the same system.

The intended high-level ownership is:

```text
channels / scheduler
        |
        v
      runner
        |
        v
   agent runtime
  (Claude Code today)
        |
        +---- MCPs / plugins / skills / tools
        |
        +---- fortytwo memory

optional surrounding components:
- gate
- salience

bootstrap / distribution / documentation:
- installer
- persona
- marketplace
- docs
- website
```

A useful rule when deciding where code belongs:

> fortytwo should add continuity and infrastructure around an existing agent, not reimplement capabilities already owned by the agent runtime or its MCP/plugin ecosystem.

Examples:

- agent reasoning, planning, subagents, tools, MCP orchestration, and plugins belong to the agent runtime;
- Claude process/session lifecycle belongs to `runner`;
- durable memory belongs to `memory`;
- durable time and scheduled execution belong to `scheduler`;
- Telegram transport and Telegram identity belong to `telegram`;
- installation and lifecycle management belong to `installer`;
- browser automation should normally come from an existing MCP/plugin rather than a fortytwo-specific browser implementation.

Before introducing a new abstraction, check the relevant sibling repositories and the agent runtime's existing capabilities to avoid duplicating functionality elsewhere in the fortytwo stack.
