import { describe, expect, test } from "bun:test";
import type { AuthorPolicyContext } from "../index";
import {
  AuthorizationDeniedError,
  allow,
  createAuthor,
  defineEntity,
  defineResource,
  deny,
  memoryStore,
} from "../index";

type User = { id: string; role: "admin" | "member" };
type Project = { id: string; ownerId: string; orgId?: string };
type Ctx = AuthorPolicyContext<User, Project, Record<string, unknown>>;

const UserEntity = defineEntity<User>()({ type: "User", id: (user) => user.id });
const ProjectResource = defineResource<Project>()({
  type: "Project",
  id: (project) => project.id,
  actions: ["read", "update", "delete"] as const,
  parents: { organization: { type: "Organization", id: (project) => project.orgId ?? "org_1" } },
});

function testAuthor(store = memoryStore()) {
  return createAuthor({
    store,
    entities: { User: UserEntity },
    resources: { Project: ProjectResource },
    policies: [
      allow("admin can do anything", ({ entity }) => entity.role === "admin"),
      allow("owner can update project", ({ entity, resource, action }) => {
        if (resource.type !== "Project") return false;
        return action === "update" && entity.id === resource.data.ownerId;
      }),
      deny("members cannot delete", ({ entity, action }) => entity.role === "member" && action === "delete"),
      allow("role can read", async (ctx: Ctx) => ctx.action === "read" && (await ctx.roles.has("reader"))),
      allow(
        "relation can update",
        async (ctx: Ctx) =>
          ctx.action === "update" &&
          (await ctx.relations.has({
            subjectType: "User",
            subjectId: ctx.entity.id,
            relation: "editor",
            objectType: "Project",
            objectId: ctx.resource.id,
          })),
      ),
      allow(
        "entity relation can update",
        async (ctx: Ctx) => ctx.action === "update" && (await ctx.entityHasRelation("owner")),
      ),
      allow(
        "permission can delete",
        async (ctx: Ctx) =>
          ctx.action === "delete" && (await ctx.permissions.has("delete", { type: "Project", id: ctx.resource.id })),
      ),
      allow(
        "parent org role can read",
        async (ctx: Ctx) => ctx.action === "read" && (await ctx.parents.hasRole("org-reader", "organization")),
      ),
      allow(
        "parent permission can read",
        async (ctx: Ctx) => ctx.action === "read" && (await ctx.parents.hasPermission("read", "organization")),
      ),
      allow(
        "parent relation can read",
        async (ctx: Ctx) => ctx.action === "read" && (await ctx.parents.hasRelation("member", "organization")),
      ),
    ],
  });
}

const member = { id: "user_1", role: "member" } satisfies User;
const admin = { id: "admin_1", role: "admin" } satisfies User;
const project = { id: "project_1", ownerId: "user_1", orgId: "org_1" } satisfies Project;
const typedProject = { authorType: "Project", id: "project_1", ownerId: "user_1", orgId: "org_1" } satisfies Project & {
  authorType: "Project";
};

describe("core", () => {
  test("first demo allows owner update", async () => {
    await expect(testAuthor().as("User", member).can("update").on("Project", project).allowed()).resolves.toBe(true);
    await expect(testAuthor().as("User", member).can("update").on(typedProject).allowed()).resolves.toBe(true);
    expect(await testAuthor().as("User", member).can("update").on(typedProject)).toBe(true);
  });

  test("denies when no policy matches", async () => {
    await expect(testAuthor().as("User", member).can("read").on("Project", project).allowed()).resolves.toBe(false);
  });

  test("deny overrides allow", async () => {
    await expect(testAuthor().as("User", admin).can("delete").on("Project", project).allowed()).resolves.toBe(true);
    await expect(testAuthor().as("User", member).can("delete").on("Project", project).allowed()).resolves.toBe(false);
  });

  test("explain and throw", async () => {
    const decision = await testAuthor().as("User", member).can("update").on("Project", project).explain();
    expect(decision.allowed).toBe(true);
    expect(decision.matchedPolicies.map((policy) => policy.name)).toContain("owner can update project");
    await expect(testAuthor().as("User", member).can("read").on("Project", project).throw()).rejects.toBeInstanceOf(
      AuthorizationDeniedError,
    );
  });

  test("memory roles relations permissions and parents", async () => {
    const store = memoryStore();
    const author = testAuthor(store);
    await store.grantRole({ entityType: "User", entityId: member.id, role: "reader" });
    await store.createRelation({
      subjectType: "User",
      subjectId: "other",
      relation: "editor",
      objectType: "Project",
      objectId: project.id,
    });
    await store.createRelation({
      subjectType: "User",
      subjectId: "owner",
      relation: "owner",
      objectType: "Project",
      objectId: project.id,
    });
    await store.grantPermission({
      entityType: "User",
      entityId: member.id,
      action: "delete",
      resourceType: "Project",
      resourceId: project.id,
      effect: "allow",
    });
    await store.grantRole({
      entityType: "User",
      entityId: member.id,
      role: "org-reader",
      scopeType: "Organization",
      scopeId: "org_1",
    });
    await store.grantPermission({
      entityType: "User",
      entityId: member.id,
      action: "read",
      resourceType: "Organization",
      resourceId: "org_1",
      effect: "allow",
    });
    await store.createRelation({
      subjectType: "User",
      subjectId: member.id,
      relation: "member",
      objectType: "Organization",
      objectId: "org_1",
    });

    await expect(author.as("User", member).can("read").on("Project", project).allowed()).resolves.toBe(true);
    await expect(author.as("User", member).can("delete").on("Project", project).allowed()).resolves.toBe(false);
    await expect(
      author
        .as("User", { id: "other", role: "member" })
        .can("update")
        .on("Project", { ...project, ownerId: "nope" })
        .allowed(),
    ).resolves.toBe(true);
    await expect(
      author
        .as("User", { id: "owner", role: "member" })
        .can("update")
        .on("Project", { ...project, ownerId: "nope" })
        .allowed(),
    ).resolves.toBe(true);
  });

  test("parent permission deny overrides parent allow", async () => {
    const store = memoryStore();
    const author = createAuthor({
      store,
      entities: { User: UserEntity },
      resources: { Project: ProjectResource },
      policies: [
        allow("parent permission can read", async (ctx: Ctx) => ctx.parents.hasPermission("read", "organization")),
      ],
    });
    await store.grantPermission({
      entityType: "User",
      entityId: member.id,
      action: "read",
      resourceType: "Organization",
      resourceId: "org_1",
      effect: "allow",
    });
    await store.grantPermission({
      entityType: "User",
      entityId: member.id,
      action: "read",
      resourceType: "Organization",
      resourceId: "org_1",
      effect: "deny",
    });

    await expect(author.as("User", member).can("read").on("Project", project).allowed()).resolves.toBe(false);
  });

  test("parent getRequired throws for missing parent", async () => {
    const author = createAuthor({
      entities: { User: UserEntity },
      resources: { Project: ProjectResource },
      policies: [
        allow("missing parent throws", async (ctx: Ctx) => {
          await ctx.parents.getRequired("workspace");
          return true;
        }),
      ],
    });

    await expect(author.as("User", member).can("read").on("Project", project).explain()).rejects.toThrow(
      "Missing parent resource: workspace",
    );
  });

  test("list helpers expose store grants and parent refs", async () => {
    const store = memoryStore();
    const author = createAuthor({
      store,
      entities: { User: UserEntity },
      resources: { Project: ProjectResource },
      policies: [
        allow("lists are available", async (ctx: Ctx) => {
          const roles = await ctx.roles.list();
          const relations = await ctx.relations.list({ subjectId: ctx.entity.id });
          const permissions = await ctx.permissions.list({ type: ctx.resource.type, id: ctx.resource.id });
          const parents = await ctx.parents.list();
          return roles.length === 1 && relations.length === 1 && permissions.length === 1 && parents[0]?.id === "org_1";
        }),
      ],
    });
    await store.grantRole({ entityType: "User", entityId: member.id, role: "reader" });
    await store.createRelation({
      subjectType: "User",
      subjectId: member.id,
      relation: "viewer",
      objectType: "Project",
      objectId: project.id,
    });
    await store.grantPermission({
      entityType: "User",
      entityId: member.id,
      action: "read",
      resourceType: "Project",
      resourceId: project.id,
      effect: "allow",
    });

    await expect(author.as("User", member).can("read").on("Project", project).allowed()).resolves.toBe(true);
  });
});
