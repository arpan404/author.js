import { describe, expect, test } from "bun:test";
import { ensureMongoIndexes, type MongoClientLike, mongodbStore } from "../packages/mongodb/src/index";

class FakeCollection {
  rows: readonly unknown[] = [];
  readonly inserts: unknown[] = [];
  readonly indexes: unknown[] = [];
  readonly finds: Array<Record<string, unknown>> = [];

  find(query: Record<string, unknown>) {
    this.finds.push(query);
    const matched = this.rows.filter((row) => {
      if (typeof row !== "object" || row === null) return false;
      const record = row as Record<string, unknown>;
      return Object.entries(query).every(([key, value]) => record[key] === value);
    });
    return {
      limit: (count: number) => ({
        limit: (next: number) => this.find(query).limit(next),
        toArray: async () => matched.slice(0, count),
      }),
      toArray: async () => matched,
    };
  }
  async insertOne(document: Record<string, unknown>) {
    this.inserts.push(document);
  }
  async deleteOne() {
    return {};
  }
  async createIndex(index: Record<string, unknown>, options?: Record<string, unknown>) {
    this.indexes.push({ index, options });
  }
}

class FakeMongo implements MongoClientLike {
  readonly collections = new Map<string, FakeCollection>();
  db() {
    return { collection: (name: string) => this.collection(name) };
  }
  collection(name: string) {
    const existing = this.collections.get(name);
    if (existing) return existing;
    const collection = new FakeCollection();
    this.collections.set(name, collection);
    return collection;
  }
}

describe("mongodbStore", () => {
  test("maps relations and creates indexes", async () => {
    const client = new FakeMongo();
    const relations = client.collection("author_relations");
    relations.rows = [
      {
        _id: "r1",
        subjectType: "User",
        subjectId: "u1",
        relation: "owner",
        objectType: "Project",
        objectId: "p1",
        createdAt: new Date("2024-01-01"),
      },
    ];
    const store = mongodbStore({ client, database: "app" });

    await expect(store.getRelations({ subjectId: "u1" })).resolves.toEqual([
      {
        id: "r1",
        subjectType: "User",
        subjectId: "u1",
        relation: "owner",
        objectType: "Project",
        objectId: "p1",
        createdAt: new Date("2024-01-01"),
      },
    ]);
    await ensureMongoIndexes({ client, database: "app" });

    expect(relations.indexes.length).toBe(3);
  });

  test("supports direct role permission and relation checks", async () => {
    const client = new FakeMongo();
    const store = mongodbStore({ client, database: "app" });
    if (!store.hasRole || !store.hasPermission || !store.hasRelation) {
      throw new Error("mongodbStore should expose direct checks");
    }

    const roles = client.collection("author_roles");
    roles.rows = [{ _id: "role_1", entityType: "User", entityId: "u1", role: "admin", createdAt: new Date() }];
    await expect(store.hasRole({ entityType: "User", entityId: "u1", role: "admin" })).resolves.toBe(true);
    expect(roles.finds.at(-1)).toEqual({ entityType: "User", entityId: "u1", role: "admin" });

    const permissions = client.collection("author_permissions");
    permissions.rows = [
      {
        _id: "permission_1",
        entityType: "User",
        entityId: "u1",
        action: "read",
        resourceType: "Project",
        effect: "allow",
      },
    ];
    await expect(
      store.hasPermission({ entityType: "User", entityId: "u1", action: "read", resourceType: "Project" }),
    ).resolves.toBe(true);
    permissions.rows = [
      {
        _id: "permission_1",
        entityType: "User",
        entityId: "u1",
        action: "read",
        resourceType: "Project",
        effect: "allow",
      },
      {
        _id: "permission_2",
        entityType: "User",
        entityId: "u1",
        action: "read",
        resourceType: "Project",
        effect: "deny",
      },
    ];
    await expect(
      store.hasPermission({ entityType: "User", entityId: "u1", action: "read", resourceType: "Project" }),
    ).resolves.toBe(false);

    const relations = client.collection("author_relations");
    relations.rows = [];
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
