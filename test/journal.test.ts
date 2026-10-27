import { describe, it, expect, vi } from 'vitest';
import { makeJournalWrite } from '../src/daemon.js';
import { createJournalNotifier, createFanoutNotifier } from '../src/notifier.js';
import type { Notifier } from '../src/types.js';

describe('makeJournalWrite', () => {
  it('appends exactly one scheduler event with the notification kind', async () => {
    const append = vi.fn(async () => 1);
    await makeJournalWrite({ append })({ kind: 'daily_briefing', text: 'hello' });
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith({
      channel: 'scheduler', direction: 'outbound', actor: 'assistant', kind: 'daily_briefing', content: 'hello',
    });
  });

  it('contains a rejecting log and still fans out to extra notifiers', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const extra: Notifier = { notify: vi.fn(async () => undefined) };
    const write = makeJournalWrite({ append: async () => { throw new Error('nope'); } });
    const fanout = createFanoutNotifier([createJournalNotifier(write), extra]);
    await fanout.notify({ kind: 'k', text: 't' });
    await new Promise(r => setImmediate(r));
    expect(extra.notify).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('contains a synchronously throwing log', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const write = makeJournalWrite({ append: () => { throw new Error('sync'); } });
    await expect(write({ kind: 'k', text: 't' })).resolves.toBeUndefined();
    err.mockRestore();
  });
});
