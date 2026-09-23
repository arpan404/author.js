import { describe, expect, test } from "bun:test";
import type { AuthorPolicyContext } from "../index";
import { allow, createAuthor, defineEntity, defineResource, memoryCache, memoryStore } from "../index";

type User = { id: string };
type Project = { id: string };
type Ctx = AuthorPolicyContext<User, Project, Record<string, unknown>>;

const UserEntity = defineEntity<User>()({ type: "User", id: (user) => user.id });
const ProjectResource = defineResource<Project>()({
  type: "Project",
  id: (project) => project.id,
  actions: ["read"] as const,
});

describe("management API", () => {
  test("manages roles permissions and relations", async () => {
    const author = createAuthor({
      entities: { User: UserEntity },
      resources: { Project: ProjectResource },
      policies: [],
    });

    await author.roles.grant({ entityType: "User", entityId: "u1", role: "admin" });
    await expect(author.roles.list({ entityType: "User", entityId: "u1" })).resolves.toHaveLength(1);
    await author.roles.revoke({ entityType: "User", entityId: "u1", role: "admin" });
    await expect(author.roles.list({ entityType: "User", entityId: "u1" })).resolves.toHaveLength(0);

    await author.permissions.grant({
      entityType: "User",
      entityId: "u1",
      action: "read",
      resourceType: "Project",
      resourceId: "p1",
      effect: "allow",
    });
    await expect(author.permissions.list({ entityType: "User", entityId: "u1" })).resolves.toHaveLength(1);
    await author.permissions.revoke({
      entityType: "User",
      entityId: "u1",
      action: "read",
      resourceType: "Project",
      resourceId: "p1",
      effect: "allow",
    });
    await expect(author.permissions.list({ entityType: "User", entityId: "u1" })).resolves.toHaveLength(0);

    await author.relations.create({
      subjectType: "User",
      subjectId: "u1",
      relation: "viewer",
      objectType: "Project",
      objectId: "p1",
    });
    await expect(author.relations.list({ subjectType: "User", subjectId: "u1" })).resolves.toHaveLength(1);
    await author.relations.delete({
      subjectType: "User",
      subjectId: "u1",
      relation: "viewer",
      objectType: "Project",
      objectId: "p1",
    });
    await expect(author.relations.list({ subjectType: "User", subjectId: "u1" })).resolves.toHaveLength(0);
  });

  test("write helpers invalidate cache when supported", async () => {
    const cache = memoryCache();
    const store = memoryStore();
    let calls = 0;
    const author = createAuthor({
      cache,
      store,
      entities: { User: UserEntity },
      resources: { Project: ProjectResource },
      policies: [
        allow("role can read", async (ctx: Ctx) => {
          calls += 1;
          return ctx.roles.has("reader");
        }),
      ],
    });

    expect(await author.as("User", { id: "u1" }).can("read").on("Project", { id: "p1" })).toBe(false);
    expect(await author.as("User", { id: "u1" }).can("read").on("Project", { id: "p1" })).toBe(false);
    expect(calls).toBe(1);

    await author.roles.grant({ entityType: "User", entityId: "u1", role: "reader" });
    expect(await author.as("User", { id: "u1" }).can("read").on("Project", { id: "p1" })).toBe(true);
    expect(calls).toBe(2);
  });
});
