import type { AuthorCache, Decision } from "../../core/src/index.js";

export type RedisLike = {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string, options?: { ex?: number; px?: number }): Promise<unknown> | unknown;
  del(key: string): Promise<unknown> | unknown;
};

export type RedisCacheInput = {
  client: RedisLike;
  prefix?: string;
};

const generationRefreshMs = 1_000;

/** Creates an AuthorCache backed by Redis or Bun.redis-compatible clients. */
export function redisCache(input: RedisCacheInput): AuthorCache {
  const prefix = input.prefix ?? "author-js:v1";
  const generationKey = `${prefix}:generation`;
  let generation = "";
  let generationLoadedAt = 0;

  async function currentGeneration(): Promise<string> {
    if (Date.now() - generationLoadedAt < generationRefreshMs) return generation;
    const stored = await input.client.get(generationKey);
    generation = typeof stored === "string" ? stored : "";
    generationLoadedAt = Date.now();
    return generation;
  }

  async function storageKey(key: string): Promise<string> {
    const base = key.startsWith(`${prefix}:`) ? key : `${prefix}:${key}`;
    const current = await currentGeneration();
    return current ? `${base}:g:${current}` : base;
  }

  return {
    async get(key) {
      const raw = await input.client.get(await storageKey(key));
      return typeof raw === "string" ? readDecision(raw) : null;
    },
    async set(key, value, ttlMs) {
      const options = ttlMs === undefined ? undefined : { px: ttlMs };
      await input.client.set(await storageKey(key), JSON.stringify(value), options);
    },
    async delete(key) {
      await input.client.del(await storageKey(key));
    },
    async clear() {
      generation = crypto.randomUUID();
      generationLoadedAt = Date.now();
      await input.client.set(generationKey, generation);
    },
  };
}

function readDecision(raw: string): Decision | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isDecision(value) ? value : null;
  } catch {
    return null;
  }
}

function isDecision(value: unknown): value is Decision {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.allowed === "boolean" &&
    (record.effect === "allow" || record.effect === "deny") &&
    typeof record.reason === "string"
  );
}
