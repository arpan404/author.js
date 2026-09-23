import { describe, expect, test } from "bun:test";
import { allow, createAuthor, decisionCacheKey, defineEntity, defineResource, memoryCache } from "../index";
import { type RedisLike, redisCache } from "../packages/redis/src/index";

type User = { id: string };
type Project = { id: string; ownerId: string };

const UserEntity = defineEntity<User>()({ type: "User", id: (user) => user.id });
const ProjectResource = defineResource<Project>()({
  type: "Project",
  id: (project) => project.id,
  actions: ["read"] as const,
});

describe("cache", () => {
  test("decision cache key avoids simple concatenation collisions", async () => {
    const a = await decisionCacheKey({
      entityType: "A",
      entityId: "bc",
      action: "read",
      resourceType: "Project",
      resourceId: "1",
      mode: "backend",
      context: {},
      resource: {},
    });
    const b = await decisionCacheKey({
      entityType: "Ab",
      entityId: "c",
      action: "read",
      resourceType: "Project",
      resourceId: "1",
      mode: "backend",
      context: {},
      resource: {},
    });
    expect(a).not.toBe(b);
  });

  test("createAuthor caches and invalidates decisions", async () => {
    let calls = 0;
    const cache = memoryCache();
    const author = createAuthor({
      cache,
      entities: { User: UserEntity },
      resources: { Project: ProjectResource },
      policies: [
        allow("cached", () => {
          calls += 1;
          return true;
        }),
      ],
    });

    expect(await author.as("User", { id: "u1" }).can("read").on("Project", { id: "p1", ownerId: "u1" })).toBe(true);
    expect(await author.as("User", { id: "u1" }).can("read").on("Project", { id: "p1", ownerId: "u1" })).toBe(true);
    expect(calls).toBe(1);

    await author.invalidate();
    expect(await author.as("User", { id: "u1" }).can("read").on("Project", { id: "p1", ownerId: "u1" })).toBe(true);
    expect(calls).toBe(2);
  });

  test("createAuthor accepts a custom decision cache key resolver", async () => {
    let calls = 0;
    let keyCalls = 0;
    const cache = memoryCache();
    const author = createAuthor({
      cache,
      cacheKey: (input) => {
        keyCalls += 1;
        return `${input.entityType}:${input.entityId}:${input.action}:${input.resourceType}:${input.resourceId}`;
      },
      entities: { User: UserEntity },
      resources: { Project: ProjectResource },
      policies: [
        allow("cached by custom key", () => {
          calls += 1;
          return true;
        }),
      ],
    });

    expect(await author.as("User", { id: "u1" }).can("read").on("Project", { id: "p1", ownerId: "u1" })).toBe(true);
    expect(await author.as("User", { id: "u1" }).can("read").on("Project", { id: "p1", ownerId: "u1" })).toBe(true);
    expect(calls).toBe(1);
    expect(keyCalls).toBe(2);
  });

  test("redisCache stores and deletes decisions with prefix", async () => {
    const client = new FakeRedis();
    const cache = redisCache({ client, prefix: "app-auth" });
    const decision = {
      allowed: true,
      effect: "allow" as const,
      reason: "ok",
      action: "read",
      entity: { type: "User", id: "u1" },
      resource: { type: "Project", id: "p1" },
      matchedPolicies: [],
      skippedPolicies: [],
      metadata: { evaluatedAt: new Date(), mode: "backend" as const, durationMs: 0 },
    };

    await cache.set("key", decision, 1000);
    await expect(cache.get("key")).resolves.toMatchObject({ allowed: true, reason: "ok" });
    expect(client.keys()).toEqual(["app-auth:key"]);
    await cache.delete("key");
    await expect(cache.get("key")).resolves.toBeNull();
  });

  test("redisCache clear misses decisions written under the previous generation", async () => {
    const client = new FakeRedis();
    const cache = redisCache({ client, prefix: "app-auth" });
    const decision = {
      allowed: true,
      effect: "allow" as const,
      reason: "ok",
      action: "read",
      entity: { type: "User", id: "u1" },
      resource: { type: "Project", id: "p1" },
      matchedPolicies: [],
      skippedPolicies: [],
      metadata: { evaluatedAt: new Date(), mode: "backend" as const, durationMs: 0 },
    };

    await cache.set("key", decision, 1000);
    await cache.clear?.();
    await expect(cache.get("key")).resolves.toBeNull();
    await cache.set("key", decision, 1000);
    await expect(cache.get("key")).resolves.toMatchObject({ allowed: true, reason: "ok" });
  });
});

class FakeRedis implements RedisLike {
  private readonly data = new Map<string, string>();
  get(key: string) {
    return this.data.get(key) ?? null;
  }
  set(key: string, value: string) {
    this.data.set(key, value);
  }
  del(key: string) {
    this.data.delete(key);
  }
  keys() {
    return [...this.data.keys()];
  }
}
