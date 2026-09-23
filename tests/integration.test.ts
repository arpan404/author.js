import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MongoClient } from "mongodb";
import { Pool } from "pg";
import { createClient, type RedisClientType } from "redis";
import type { Decision } from "../index";
import { ensureMongoIndexes, mongodbStore } from "../packages/mongodb/src/index";
import { postgresStore } from "../packages/postgres/src/index";
import { redisCache } from "../packages/redis/src/index";

const run = process.env.RUN_INTEGRATION === "1";
const integration = run ? describe : describe.skip;

const pgUrl = process.env.POSTGRES_URL ?? "postgres://author:author@localhost:54329/author_js";
const mongoUrl = process.env.MONGODB_URL ?? "mongodb://localhost:27029";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:63799";

let pg: Pool;
let mongo: MongoClient;
let redis: RedisClientType;

integration("real adapter integrations", () => {
  beforeAll(async () => {
    pg = new Pool({ connectionString: pgUrl });
    mongo = await createMongoClient(mongoUrl);
    redis = createClient({ url: redisUrl });

    await Promise.all([mongo.connect(), redis.connect()]);
    await setupPostgres(pg);
    await mongo.db("author_js_test").dropDatabase();
  });

  afterAll(async () => {
    await Promise.allSettled([pg?.end(), mongo?.close(), redis?.quit()]);
  });

  test("postgres store grants lists revokes and audits", async () => {
    const store = postgresStore({ client: pg });

    await store.grantRole({
      entityType: "User",
      entityId: "u1",
      role: "admin",
      scopeType: "Organization",
      scopeId: "o1",
    });
    await expect(
      store.getRoles({ entityType: "User", entityId: "u1", scopeType: "Organization", scopeId: "o1" }),
    ).resolves.toHaveLength(1);
    await store.revokeRole({
      entityType: "User",
      entityId: "u1",
      role: "admin",
      scopeType: "Organization",
      scopeId: "o1",
    });
    await expect(store.getRoles({ entityType: "User", entityId: "u1" })).resolves.toHaveLength(0);

    await store.createRelation({
      subjectType: "User",
      subjectId: "u1",
      relation: "owner",
      objectType: "Project",
      objectId: "p1",
    });
    await expect(store.getRelations({ subjectType: "User", subjectId: "u1" })).resolves.toHaveLength(1);
    await store.deleteRelation({
      subjectType: "User",
      subjectId: "u1",
      relation: "owner",
      objectType: "Project",
      objectId: "p1",
    });
    await expect(store.getRelations({ subjectType: "User", subjectId: "u1" })).resolves.toHaveLength(0);

    await store.writeAuditLog?.({
      id: crypto.randomUUID(),
      entityType: "User",
      entityId: "u1",
      action: "read",
      resourceType: "Project",
      resourceId: "p1",
      allowed: true,
      reason: "ok",
      matchedPolicies: ["p"],
      createdAt: new Date(),
    });
    const count = await pg.query("SELECT COUNT(*)::int AS count FROM author_audit_logs");
    expect(count.rows[0]?.count).toBe(1);
  });

  test("mongodb store grants lists revokes and creates indexes", async () => {
    const input = { client: mongo, database: "author_js_test" };
    const store = mongodbStore(input);
    await ensureMongoIndexes(input);

    await store.grantPermission({
      entityType: "User",
      entityId: "u1",
      action: "read",
      resourceType: "Project",
      resourceId: "p1",
      effect: "allow",
    });
    await expect(
      store.getPermissions({ entityType: "User", entityId: "u1", resourceType: "Project", resourceId: "p1" }),
    ).resolves.toHaveLength(1);
    await store.revokePermission({
      entityType: "User",
      entityId: "u1",
      action: "read",
      resourceType: "Project",
      resourceId: "p1",
      effect: "allow",
    });
    await expect(store.getPermissions({ entityType: "User", entityId: "u1" })).resolves.toHaveLength(0);

    const indexes = await mongo.db("author_js_test").collection("author_relations").indexes();
    expect(indexes.some((index) => index.name?.includes("subjectType"))).toBe(true);
  });

  test("redis cache stores gets and deletes decisions", async () => {
    const cache = redisCache({ client: redisClient(redis), prefix: "author-js-integration" });
    const decision = decisionFixture();

    await cache.set("decision-key", decision, 5_000);
    await expect(cache.get("decision-key")).resolves.toMatchObject({ allowed: true, reason: "ok" });
    await cache.delete("decision-key");
    await expect(cache.get("decision-key")).resolves.toBeNull();

    await cache.set("ttl-key", decision, 20);
    await expect(cache.get("ttl-key")).resolves.toMatchObject({ allowed: true });
    await Bun.sleep(40);
    await expect(cache.get("ttl-key")).resolves.toBeNull();
  });
});

async function createMongoClient(url: string): Promise<MongoClient> {
  patchBunV8SnapshotProbe();
  const { MongoClient } = await import("mongodb");
  return new MongoClient(url);
}

let bunV8SnapshotProbePatched = false;

function patchBunV8SnapshotProbe(): void {
  if (bunV8SnapshotProbePatched) return;
  bunV8SnapshotProbePatched = true;

  const getBuiltinModule = Reflect.get(process, "getBuiltinModule");
  if (typeof getBuiltinModule !== "function") return;

  const patchedGetBuiltinModule = (name: string): unknown => {
    const module: unknown = Reflect.apply(getBuiltinModule, process, [name]);
    if (name !== "v8" || !isRecord(module)) return module;

    const startupSnapshot = isRecord(module.startupSnapshot) ? module.startupSnapshot : {};
    return {
      ...module,
      startupSnapshot: {
        ...startupSnapshot,
        isBuildingSnapshot: () => false,
      },
    };
  };

  Reflect.set(process, "getBuiltinModule", patchedGetBuiltinModule);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function setupPostgres(pool: Pool): Promise<void> {
  await pool.query(`
    DROP TABLE IF EXISTS author_audit_logs, author_relations, author_permissions, author_roles;
    CREATE TABLE author_roles (id UUID PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, role TEXT NOT NULL, scope_type TEXT, scope_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE author_permissions (id UUID PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE author_relations (id UUID PRIMARY KEY, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, relation TEXT NOT NULL, object_type TEXT NOT NULL, object_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE UNIQUE INDEX author_relations_unique_idx ON author_relations (subject_type, subject_id, relation, object_type, object_id);
    CREATE TABLE author_audit_logs (id UUID PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, allowed BOOLEAN NOT NULL, reason TEXT NOT NULL, matched_policies JSONB NOT NULL DEFAULT '[]'::jsonb, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  `);
}

function redisClient(client: RedisClientType) {
  return {
    get: (key: string) => client.get(key),
    set: (key: string, value: string, options?: { px?: number }) =>
      options?.px === undefined ? client.set(key, value) : client.set(key, value, { PX: options.px }),
    del: (key: string) => client.del(key),
  };
}

function decisionFixture(): Decision {
  return {
    allowed: true,
    effect: "allow",
    reason: "ok",
    action: "read",
    entity: { type: "User", id: "u1" },
    resource: { type: "Project", id: "p1" },
    matchedPolicies: [],
    skippedPolicies: [],
    metadata: { evaluatedAt: new Date(), mode: "backend", durationMs: 1 },
  };
}
