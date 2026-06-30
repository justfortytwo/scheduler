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
  FORTYTWO_ROOT=/path/to/fortytwo \
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
Environment=FORTYTWO_ROOT=/path/to/fortytwo
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
| `CLAUDE_BIN` | yes | Path to the `claude` CLI binary |
| `FORTYTWO_ROOT` | yes | Root directory of the fortytwo project |
| `TELEGRAM_BOT_TOKEN` | optional | Telegram bot token — enables push notifications to Telegram |
| `ALLOWED_CHAT_IDS` | optional | Comma-separated Telegram chat IDs to push notifications to |

### Liveness / `fortytwo doctor`

On boot and at the start of each 30-second poll cycle the daemon writes a heartbeat file at `$(dirname $DB_PATH)/scheduler.heartbeat` containing `{ "pid": <number>, "ts": "<ISO>" }`. `fortytwo doctor` reads this file and warns (non-fatal) if it is missing or older than 90 seconds.

## License

MIT © 2026 Enrico Deleo
