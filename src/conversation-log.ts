// Scheduler's own port for writing the conversation. Structural on purpose:
// no @justfortytwo/transcript (or memory) types are imported. The
// implementation is loaded dynamically and degrades to a no-op.

export interface ConversationEvent {
  channel: string;
  direction: 'inbound' | 'outbound' | 'internal';
  actor: string;
  kind: string;
  content: string;
  threadId?: string | null;
  meta?: Record<string, unknown>;
}

export interface ConversationLog {
  append(event: ConversationEvent): Promise<unknown>;
}

export const noopConversationLog: ConversationLog = { append: async () => undefined };

type TranscriptModule = {
  prepareTranscript: (h: unknown) => Promise<unknown> | unknown;
  createTranscript: (h: unknown, embedder: unknown) => ConversationLog;
};

/**
 * Load the optional @justfortytwo/transcript peer. Any failure (not installed,
 * prepare/create throws) is logged and yields the no-op log.
 */
export async function loadConversationLog(
  h: unknown,
  embedder: unknown,
  importer: (name: string) => Promise<unknown> = (n) => import(n),
): Promise<ConversationLog> {
  try {
    const mod = (await importer('@justfortytwo/transcript')) as TranscriptModule;
    await mod.prepareTranscript(h);
    return mod.createTranscript(h, embedder);
  } catch (e: unknown) {
    console.error(`[scheduler] transcript unavailable (${(e as Error)?.message ?? e}) — journal entries will NOT be recorded.`);
    return noopConversationLog;
  }
}
