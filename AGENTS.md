# AGENTS.md

Guidance for AI coding agents working in `@justfortytwo/scheduler`.

## Purpose

A long-running daemon (`fortytwo-scheduler`) that drains the durable `jobs` table stored in
`@justfortytwo/memory`. It fires an LLM turn (via `@justfortytwo/runner`, which spawns the `claude` CLI)
only after a cheap `hasWork` gate says there is real work. Results go to the memory journal and, if
configured, to Telegram. The design doc is `../docs/scheduler.md` (the sibling `docs` repo).

## Layout

```
src/
  index.ts          Public exports + bin entry (boots daemon only when run directly)
  types.ts          Job, RunCtx, RunResult, Handler, Notification, Notifier, Registry
  registry.ts       createRegistry(): kind -> Handler map; throws on duplicate kind
  tick.ts           tick(): pure, fully injected drain loop; backoffAt / RETRY_BACKOFF_MIN
  daemon.ts         startDaemon(): DB open + migrations, stale requeue, seeding, 30s poll, PQueue(1)
  seed.ts           seedRecurring(): idempotent upsert of recurring rows from RECURRING_DEFS
  notifier.ts       Journal notifier + fanout notifier (per-notifier errors swallowed)
  heartbeat.ts      heartbeatPath() / writeHeartbeat() (best-effort, never throws)
  handlers/
    index.ts        RECURRING_DEFS (cron + trigger prompt) and buildRegistry()
    recurring.ts    makeRecurringHandler() with optional hasWork gate
    oneoff.ts       notify_pending, reply, reminder handlers (payload.text / payload.id)
    reembed.ts      reembed_memory handler (no LLM, returns null = no notification)
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
(or `npx fortytwo-scheduler`). See README for the env table: `DB_PATH`, `EMBED_MODEL`,
`OLLAMA_BASE_URL`, `CLAUDE_BIN`, `FORTYTWO_TURN_TIMEOUT`, `TELEGRAM_BOT_TOKEN`, `ALLOWED_CHAT_IDS`.

## Code conventions

- ESM (`"type": "module"`), TypeScript strict with `noUncheckedIndexedAccess`, `NodeNext`
  resolution: relative imports must use the `.js` suffix (`./tick.js`).
- Two-space indent, single quotes, semicolons, trailing commas; kebab/lowercase filenames.
- Dependency injection everywhere: `tick`, `seedRecurring`, `buildRegistry`, and notifiers take their
  I/O as injected functions so tests use fakes rather than a real DB, Ollama, or `claude`.
- Timestamps are ISO-8601 strings; pass `now` in explicitly rather than reading the clock deep inside logic.
- Env vars are read with bracket access (`process.env['DB_PATH']`), only in `index.ts` / `daemon.ts`.
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
  requeued via memory's `requeueStale`.
- **Recurring jobs are code-authoritative**: `RECURRING_DEFS` (`daily_briefing`, `sweep`,
  `learn_review`) are seeded on every boot; a changed cron updates the existing row. Crons are
  evaluated in **UTC** (`recurrenceNext` uses croner with `timezone: 'UTC'`).
- Gates: `sweep` runs only if pending approvals > 0; `learn_review` only if memories in the last
  7 days > 0 (window computed per call, not at boot); `daily_briefing` is ungated.
- **Notifications**: journal notifier writes via memory `store()` with `source: 'scheduler:wake'`;
  extra notifiers are fanned out and their failures are swallowed so the journal write always happens.
- **Heartbeat**: `$(dirname DB_PATH)/scheduler.heartbeat` with `{ pid, ts }`, written on boot and on
  every interval *outside* the overlap guard so long `claude` turns do not make it go stale.

## Gotchas

- `src/index.ts` is both the library entry and the bin. The daemon boots only when
  `invokedAsBin()` is true (realpath of argv[1] equals the module), so importing never opens a DB.
  Keep the `#!/usr/bin/env node` shebang and the top-level `await` inside that guard.
- `@justfortytwo/telegram` is an **optional peer** and is imported lazily; the scheduler must keep
  working without it installed. Only the first id in `ALLOWED_CHAT_IDS` is used as the push target.
- Without `EMBED_MODEL`, a `FakeEmbedder` is used, so scheduler journal entries are not semantically
  searchable.
- `recurrenceNext` throws on a cron with no next run, and `tick` calls it outside the per-job
  try/catch; validate crons in `RECURRING_DEFS` before adding them.
- `reembed_memory` jobs are enqueued by memory's `store()`; the handler silently skips malformed payloads.
- `Job` in `types.ts` is a local structural type kept compatible with memory's `JobRow`; keep them in sync.
- `CLAUDE.md`, `.wolf/`, `.codegraph/`, `.claude/` are local tooling (OpenWolf/CodeGraph), not tracked.

## Sibling repos (`../`)

- `memory` - SQLite DB, migrations, `jobs` table and job functions (`claimDue`, `complete`, `fail`,
  `enqueue`, `setRecurrence`, `requeueStale`, `listActive`), journal `store`/`query`, embedders.
- `runner` - `createRunner()` which spawns the `claude` CLI for one turn.
- `telegram` - `telegramNotifier` (structural, does not import this package); the bridge enqueues
  jobs for this daemon and no longer runs proactive wakes itself.
- `installer` - depends on this package; `fortytwo doctor` reads the heartbeat file
  (warns if missing or older than 90s); `init` tells users to run `fortytwo-scheduler` under a restart loop.
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
