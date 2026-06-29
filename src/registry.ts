import type { Handler, Registry } from './types.js';

export function createRegistry(handlers: Handler[]): Registry {
  const map = new Map<string, Handler>();
  for (const handler of handlers) {
    if (map.has(handler.kind)) {
      throw new Error(`Duplicate handler kind: '${handler.kind}'`);
    }
    map.set(handler.kind, handler);
  }
  return {
    get(kind: string): Handler | undefined {
      return map.get(kind);
    },
  };
}
