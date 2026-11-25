import type { PaseoApi } from "@getpaseo/client";

/**
 * Keeps the PaseoApi captured from an RPC or hook context, for work that runs outside a request.
 * The first instance is kept; a later context carrying a different object replaces it. Subscribers
 * hear the first object and every replacement, never the same object twice. There is no replay: a
 * listener that subscribes after the first `set` hears only later replacements (index.server.ts
 * compensates with its early reconcile of an already captured context).
 */
export function createPaseoHolder(log?: (m: string) => void): {
  set(p: PaseoApi): void;
  get(): PaseoApi | null;
  subscribe(listener: (p: PaseoApi) => void): () => void;
} {
  let current: PaseoApi | null = null;
  const listeners = new Set<(p: PaseoApi) => void>();
  return {
    set(p) {
      if (current === p) return;
      if (current !== null) log?.("paseo context replaced");
      current = p;
      for (const listener of [...listeners]) {
        try {
          listener(p);
        } catch {
          log?.("paseo context listener failed");
        }
      }
    },
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
