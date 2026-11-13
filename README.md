# @justfortytwo/scheduler

Durable job scheduler daemon for justfortytwo. Drains a `jobs` queue stored in `@justfortytwo/memory` and fires LLM turns only behind a cheap "is there work?" gate.

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
| `FORTYTWO_CLAUDE_ARGS` | no | Extra arguments for every `claude` run, as a JSON array of strings (e.g. `["--chrome"]`). Set by `fortytwo start -- <args>`. Applies to scheduled runs, not to the Oneiros worker. A malformed value stops the daemon at boot. |
| `FORTYTWO_TURN_TIMEOUT` | no | Per-turn timeout in seconds for a spawned `claude` run (default: `300`) |
| `TELEGRAM_BOT_TOKEN` | optional | Telegram bot token — enables push notifications to Telegram |
| `ALLOWED_CHAT_IDS` | optional | Comma-separated Telegram chat IDs; when set, notifications go to the **first** id. When unset, they go to every chat paired with `fortytwo pair` |
| `FORTYTWO_ROOT` | no | Project root: holds `.fortytwo/schedules.json`, `.claude/skills` and the Telegram bindings db (default: the working directory) |
| `CLAUDE_CONFIG_DIR` | no | Claude Code config dir, checked for user-level skills (default: `~/.claude`) |
| `TELEGRAM_BINDINGS_DB` | no | Bindings db path, relative to the root (default: `state/telegram-bindings.db`); must match the bridge |

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
