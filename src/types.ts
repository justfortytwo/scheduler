// Structural job-row shape (kept local; memory's JobRow is structurally compatible — wired in Phase 3).
export interface Job {
  id: number;
  kind: string;
  payload: string | null;
  run_at: string;
  recurrence: string | null;
  status: string;
  attempts: number;
}

export interface RunCtx {
  now: string;
  payload: unknown;
}

export interface RunResult {
  ok: boolean;
  text: string;
}

export interface Handler {
  kind: string;
  hasWork?(ctx: RunCtx): Promise<boolean>;
  run(ctx: RunCtx): Promise<RunResult | null>;
}

export interface Notification {
  kind: string;
  text: string;
}

export interface Notifier {
  notify(n: Notification): Promise<void>;
}

export interface Registry {
  get(kind: string): Handler | undefined;
}
