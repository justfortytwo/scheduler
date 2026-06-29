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

## License

MIT © 2026 Enrico Deleo
