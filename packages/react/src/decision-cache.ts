import type { Decision } from "../../core/src/index.js";

/** In-memory decision cache shared by hooks under one `AuthorProvider`. */
export type DecisionCache = {
  get(key: string): Decision | undefined;
  load(key: string, create: () => Promise<Decision>): Promise<Decision>;
  clear(): void;
};

/** Creates a decision cache that collapses duplicate in-flight checks. */
export function createDecisionCache(): DecisionCache {
  const decisions = new Map<string, Decision>();
  const pending = new Map<string, Promise<Decision>>();
  return {
    get(key) {
      return decisions.get(key);
    },
    load(key, create) {
      const cached = decisions.get(key);
      if (cached) return Promise.resolve(cached);
      const existing = pending.get(key);
      if (existing) return existing;
      const promise = create().then(
        (decision) => {
          decisions.set(key, decision);
          pending.delete(key);
          return decision;
        },
        (error: unknown) => {
          pending.delete(key);
          throw error;
        },
      );
      pending.set(key, promise);
      return promise;
    },
    clear() {
      decisions.clear();
      pending.clear();
    },
  };
}
