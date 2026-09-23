import { createHash } from "node:crypto";
import type { Decision, Mode } from "./types.js";

/** Adapter interface for decision caching. Values are serialized by the adapter. */
export interface AuthorCache {
  get(key: string): Promise<Decision | null>;
  set(key: string, value: Decision, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear?(): Promise<void>;
}

export type CacheKeyInput = {
  namespace?: string;
  entityType: string;
  entityId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  mode: Mode;
  context: Record<string, unknown>;
  resource: unknown;
};

/** Builds a namespaced cache key from length-delimited stable JSON to avoid collisions. */
export function decisionCacheKey(input: CacheKeyInput): string {
  const namespace = input.namespace ?? "author-js:v1";
  const parts = [
    input.entityType,
    input.entityId,
    input.action,
    input.resourceType,
    input.resourceId,
    input.mode,
    stableStringify(input.context),
    stableStringify(input.resource),
  ];
  const body = parts.map((part) => `${part.length}:${part}`).join("|");
  const digest = createHash("sha256").update(body).digest("hex");
  return `${namespace}:decision:${digest}`;
}

/** In-memory cache for tests and small local apps. */
export function memoryCache(): AuthorCache {
  const entries = new Map<string, { value: Decision; expiresAt: number | null }>();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlMs) {
      entries.set(key, { value, expiresAt: ttlMs === undefined ? null : Date.now() + ttlMs });
    },
    async delete(key) {
      entries.delete(key);
    },
    async clear() {
      entries.clear();
    },
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
