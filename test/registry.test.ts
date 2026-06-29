import { describe, it, expect } from 'vitest';
import { createRegistry } from '../src/registry.js';
import type { Handler, RunCtx, RunResult } from '../src/types.js';

const noop: Handler = {
  kind: 'a',
  async run(_ctx: RunCtx): Promise<RunResult | null> {
    return null;
  },
};

describe('createRegistry', () => {
  it('returns a handler that was registered', () => {
    const registry = createRegistry([noop]);
    expect(registry.get('a')).toBe(noop);
  });

  it('returns undefined for an unregistered kind', () => {
    const registry = createRegistry([noop]);
    expect(registry.get('missing')).toBeUndefined();
  });

  it('throws when two handlers share the same kind', () => {
    const duplicate: Handler = {
      kind: 'a',
      async run(_ctx: RunCtx): Promise<RunResult | null> {
        return null;
      },
    };
    expect(() => createRegistry([noop, duplicate])).toThrow();
  });
});
