import { describe, expect, test } from "bun:test";
import type { AuthorPolicyContext } from "../index";
import { allow, createAuthor, defineEntity, defineResource } from "../index";

type User = { id: string; plan: "free" | "pro" };
type Project = { id: string; ownerId: string };
type Ctx = AuthorPolicyContext<User, Project, Record<string, unknown>>;

const UserEntity = defineEntity<User>()({ type: "User", id: (user) => user.id });
const ProjectResource = defineResource<Project>()({
  type: "Project",
  id: (project) => project.id,
  actions: ["create", "read"] as const,
});
const project = { id: "p1", ownerId: "u1" } satisfies Project;

describe("entitlements", () => {
  test("checks features by async plan resolver", async () => {
    const author = createAuthor({
      entities: { User: UserEntity },
      resources: { Project: ProjectResource },
      entitlements: {
        plan: async ({ entity }) => entity.plan,
        features: { free: ["projects.read"], pro: ["projects.read", "projects.create"] },
      },
      policies: [
        allow(
          "feature allows create",
          async (ctx: Ctx) => ctx.action === "create" && (await ctx.features.has("projects.create")),
        ),
      ],
    });

    await expect(
      author.as("User", { id: "u1", plan: "free" }).can("create").on("Project", project).allowed(),
    ).resolves.toBe(false);
    await expect(
      author.as("User", { id: "u2", plan: "pro" }).can("create").on("Project", project).allowed(),
    ).resolves.toBe(true);
  });

  test("checks limits and remaining quota", async () => {
    const author = createAuthor({
      entities: { User: UserEntity },
      resources: { Project: ProjectResource },
      entitlements: {
        plan: ({ entity }) => entity.plan,
        limits: { free: { projects: 1 }, pro: { projects: 10 } },
      },
      policies: [
        allow("within project limit", async (ctx: Ctx) => {
          const used = Number(ctx.context.used ?? 0);
          const remaining = await ctx.limits.remaining("projects", { used });
          return remaining !== 0 && (await ctx.limits.within("projects", { used }));
        }),
      ],
    });

    await expect(
      author.as("User", { id: "u1", plan: "free" }).can("create").on("Project", project, { used: 0 }).allowed(),
    ).resolves.toBe(true);
    await expect(
      author.as("User", { id: "u1", plan: "free" }).can("create").on("Project", project, { used: 1 }).allowed(),
    ).resolves.toBe(false);
  });
});
