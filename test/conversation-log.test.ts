import { describe, it, expect, vi } from 'vitest';
import { loadConversationLog, noopConversationLog } from '../src/conversation-log.js';

describe('loadConversationLog', () => {
  it('prepares and creates the transcript from the dynamic import', async () => {
    const log = { append: vi.fn(async () => 1) };
    const prepareTranscript = vi.fn();
    const createTranscript = vi.fn(() => log);
    const importer = vi.fn(async () => ({ prepareTranscript, createTranscript }));
    const h = {}; const embedder = {};
    await expect(loadConversationLog(h, embedder, importer)).resolves.toBe(log);
    expect(importer).toHaveBeenCalledWith('@justfortytwo/transcript');
    expect(prepareTranscript).toHaveBeenCalledWith(h);
    expect(createTranscript).toHaveBeenCalledWith(h, embedder);
  });

  it('falls back to the no-op log when the import fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = await loadConversationLog({}, {}, async () => { throw new Error('missing'); });
    expect(log).toBe(noopConversationLog);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('falls back to the no-op log when prepare throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = await loadConversationLog({}, {}, async () => ({
      prepareTranscript: () => { throw new Error('boom'); },
      createTranscript: () => ({ append: async () => 1 }),
    }));
    expect(log).toBe(noopConversationLog);
    err.mockRestore();
  });
});
