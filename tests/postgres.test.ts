import { describe, expect, test } from "bun:test";
import { type PostgresClient, postgresStore } from "../packages/postgres/src/index";

class FakePostgres implements PostgresClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  rows: readonly unknown[] = [];

  async query(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    return { rows: this.rows };
  }
}

describe("postgresStore", () => {
  test("maps roles and writes audit logs", async () => {
    const client = new FakePostgres();
    const store = postgresStore({ client });
    client.rows = [
      {
        id: "r1",
        entity_type: "User",
        entity_id: "u1",
        role: "admin",
        scope_type: "Org",
        scope_id: "o1",
        created_at: new Date("2024-01-01"),
      },
    ];

    await expect(store.getRoles({ entityType: "User", entityId: "u1" })).resolves.toEqual([
      {
        id: "r1",
        entityType: "User",
        entityId: "u1",
        role: "admin",
        scopeType: "Org",
        scopeId: "o1",
        createdAt: new Date("2024-01-01"),
      },
    ]);
    await store.writeAuditLog?.({
      id: "a1",
      entityType: "User",
      entityId: "u1",
      action: "read",
      resourceType: "Project",
      resourceId: "p1",
      allowed: true,
      reason: "ok",
      matchedPolicies: ["p"],
      createdAt: new Date("2024-01-01"),
    });

    expect(client.calls.some((call) => call.sql.includes("author_audit_logs"))).toBe(true);
  });

  test("supports direct role permission and relation checks", async () => {
    const client = new FakePostgres();
    const store = postgresStore({ client });
    if (!store.hasRole || !store.hasPermission || !store.hasRelation) {
      throw new Error("postgresStore should expose direct checks");
    }

    client.rows = [{ exists: 1 }];
    await expect(
      store.hasRole({ entityType: "User", entityId: "u1", role: "admin", scopeType: "Org", scopeId: "o1" }),
    ).resolves.toBe(true);
    expect(client.calls.at(-1)?.sql).toContain("LIMIT 1");

    client.rows = [{ has_deny: false, has_allow: true }];
    await expect(
      store.hasPermission({ entityType: "User", entityId: "u1", action: "read", resourceType: "Project" }),
    ).resolves.toBe(true);

    client.rows = [{ has_deny: true, has_allow: true }];
    await expect(
      store.hasPermission({ entityType: "User", entityId: "u1", action: "read", resourceType: "Project" }),
    ).resolves.toBe(false);

    client.rows = [];
    await expect(
      store.hasRelation({
        subjectType: "User",
        subjectId: "u1",
        relation: "owner",
        objectType: "Project",
        objectId: "p1",
      }),
    ).resolves.toBe(false);
  });
});
