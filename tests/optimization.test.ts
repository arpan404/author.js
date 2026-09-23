import { describe, expect, test } from "bun:test";
import type { AuthorPolicyContext, AuthorStore } from "../index";
import {
  AuthorizationDeniedError,
  allow,
  createAuthor,
  DuplicateResourceTypeError,
  defineAuthorModule,
  defineEntity,
  defineResource,
  deny,
  memoryCache,
  memoryStore,
  policy,
} from "../index";

type User = { id: string };
type ApiKey = { id: string };
type Project = { id: string };
type Report = { id: string };
type Entity = User | ApiKey;
type Resource = Project | Report;
type Ctx = AuthorPolicyContext<Entity, Resource, Record<string, unknown>>;

const UserEntity = defineEntity<User>()({ type: "User", id: (user) => user.id });
const ApiKeyEntity = defineEntity<ApiKey>()({ type: "ApiKey", id: (apiKey) => apiKey.id });

const ProjectResource = defineResource<Project>()({
  type: "Project",
  id: (project) => project.id,
  actions: ["read", "delete"] as const,
});

const ReportResource = defineResource<Report>()({
  type: "Report",
  id: (report) => report.id,
  actions: ["read"] as const,
});

describe("engine optimization", () => {
  test("author modules compose resources and policies into one runtime", async () => {
    const projectModule = defineAuthorModule({
      name: "projects",
      resources: { Project: ProjectResource },
      policies: [
        allow<Ctx>(
          "project read",
          { entityTypes: ["User"], resourceTypes: ["Project"], actions: ["read"] },
          () => true,
        ),
      ],
    });
    const reportModule = defineAuthorModule({
      name: "reports",
      resources: { Report: ReportResource },
      policies: [
        allow<Ctx>("report read", { entityTypes: ["User"], resourceTypes: ["Report"], actions: ["read"] }, () => true),
      ],
    });

    const author = createAuthor({
      entities: { User: UserEntity },
      modules: [projectModule, reportModule],
      policies: [
        deny<Ctx>(
          "global report deny",
          { entityTypes: ["User"], resourceTypes: ["Report"], actions: ["read"] },
          () => true,
        ),
      ],
    });

    await expect(author.as("User", { id: "u1" }).can("read").on("Project", { id: "p1" }).allowed()).resolves.toBe(true);

    const reportDecision = await author.as("User", { id: "u1" }).can("read").on("Report", { id: "r1" }).explain();

    expect(reportDecision.allowed).toBe(false);
    expect(reportDecision.matchedPolicies.map((policy) => policy.name)).toEqual(["global report deny", "report read"]);
  });

  test("author modules reject duplicate resource registrations", () => {
    const firstProjectModule = defineAuthorModule({
      name: "projects-a",
      resources: { Project: ProjectResource },
      policies: [],
    });
    const secondProjectModule = defineAuthorModule({
      name: "projects-b",
      resources: { Project: ProjectResource },
      policies: [],
    });

    expect(() =>
      createAuthor({
        entities: { User: UserEntity },
        modules: [firstProjectModule, secondProjectModule],
        policies: [],
      }),
    ).toThrow(DuplicateResourceTypeError);
  });

  test("scoped policies only run for matching entity resource and action", async () => {
    let globalCalls = 0;
    let apiKeyCalls = 0;
    let userProjectCalls = 0;
    let userReportCalls = 0;
    let userDeleteCalls = 0;

    const author = createAuthor({
      entities: { User: UserEntity, ApiKey: ApiKeyEntity },
      resources: { Project: ProjectResource, Report: ReportResource },
      policies: [
        allow<Ctx>("global fallback", () => {
          globalCalls += 1;
          return false;
        }),
        allow<Ctx>(
          "api key project read",
          { entityTypes: ["ApiKey"], resourceTypes: ["Project"], actions: ["read"] },
          () => {
            apiKeyCalls += 1;
            return true;
          },
        ),
        allow<Ctx>(
          "user project read",
          { entityTypes: ["User"], resourceTypes: ["Project"], actions: ["read"] },
          () => {
            userProjectCalls += 1;
            return true;
          },
        ),
        allow<Ctx>("user report read", { entityTypes: ["User"], resourceTypes: ["Report"], actions: ["read"] }, () => {
          userReportCalls += 1;
          return true;
        }),
        deny<Ctx>(
          "user project delete",
          { entityTypes: ["User"], resourceTypes: ["Project"], actions: ["delete"] },
          () => {
            userDeleteCalls += 1;
            return true;
          },
        ),
      ],
    });

    await expect(author.as("User", { id: "u1" }).can("read").on("Project", { id: "p1" }).allowed()).resolves.toBe(true);

    expect(globalCalls).toBe(1);
    expect(userProjectCalls).toBe(1);
    expect(apiKeyCalls).toBe(0);
    expect(userReportCalls).toBe(0);
    expect(userDeleteCalls).toBe(0);

    const decision = await author.evaluate({
      entityType: "User",
      entity: { id: "u1" },
      action: "read",
      resourceType: "Project",
      resource: { id: "p1" },
      context: {},
      mode: "backend",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.matchedPolicies.map((policy) => policy.name)).toEqual(["user project read"]);
    expect(decision.skippedPolicies.map((policy) => policy.name)).toEqual(["global fallback"]);
    expect(globalCalls).toBe(2);
    expect(userProjectCalls).toBe(2);
    expect(apiKeyCalls).toBe(0);
    expect(userReportCalls).toBe(0);
    expect(userDeleteCalls).toBe(0);
  });

  test("fluent scoped policy builder creates resource and action specific rules", async () => {
    let unrelatedCalls = 0;
    const author = createAuthor({
      entities: { User: UserEntity },
      resources: { Project: ProjectResource, Report: ReportResource },
      policies: [
        policy
          .for("User")
          .on("Project")
          .can("read")
          .allow<Ctx>("users can read projects", ({ resource }) => resource.type === "Project"),
        policy
          .for("User")
          .on("Report")
          .can("read")
          .allow<Ctx>("users can read reports", () => {
            unrelatedCalls += 1;
            return true;
          }),
      ],
    });

    await expect(author.as("User", { id: "u1" }).can("read").on("Project", { id: "p1" }).allowed()).resolves.toBe(true);
    expect(unrelatedCalls).toBe(0);
  });

  test("afterDecision hooks run after selected decisions without changing the outcome", async () => {
    const seen: Array<{ allowed: boolean; reason: string; action: string }> = [];
    const author = createAuthor({
      entities: { User: UserEntity },
      resources: { Project: ProjectResource },
      policies: [
        policy
          .for("User")
          .on("Project")
          .can("read")
          .allow<Ctx>("project read", () => true),
        policy
          .for("User")
          .on("Project")
          .can("read")
          .afterDecision<Ctx>("record read decision", (_ctx, decision) => {
            seen.push({ allowed: decision.allowed, reason: decision.reason, action: decision.action });
          }),
      ],
    });

    const allowed = await author.as("User", { id: "u1" }).can("read").on("Project", { id: "p1" }).allowed();

    expect(allowed).toBe(true);
    expect(seen).toEqual([{ allowed: true, reason: "project read", action: "read" }]);
  });

  test("audit mode can disable logs or keep them only for explanations", async () => {
    const noAuditStore = memoryStore();
    const noAuditAuthor = createAuthor({
      store: noAuditStore,
      audit: "none",
      entities: { User: UserEntity },
      resources: { Project: ProjectResource },
      policies: [
        policy
          .for("User")
          .on("Project")
          .can("read")
          .allow<Ctx>("project read", () => true),
      ],
    });

    await noAuditAuthor.as("User", { id: "u1" }).can("read").on("Project", { id: "p1" }).allowed();
    await noAuditAuthor.as("User", { id: "u1" }).can("read").on("Project", { id: "p1" }).explain();

    expect(noAuditStore.auditLogs).toHaveLength(0);

    const explainOnlyStore = memoryStore();
    const explainOnlyAuthor = createAuthor({
      store: explainOnlyStore,
      audit: "explain",
      entities: { User: UserEntity },
      resources: { Project: ProjectResource },
      policies: [
        policy
          .for("User")
          .on("Project")
          .can("read")
          .allow<Ctx>("project read", () => true),
      ],
    });

    await explainOnlyAuthor.as("User", { id: "u1" }).can("read").on("Project", { id: "p1" }).allowed();
    expect(explainOnlyStore.auditLogs).toHaveLength(0);

    await explainOnlyAuthor.as("User", { id: "u1" }).can("read").on("Project", { id: "p1" }).explain();
    expect(explainOnlyStore.auditLogs).toHaveLength(1);
  });

  test("boolean checks can stop at a matching deny while explain remains exhaustive", async () => {
    let earlyAllowCalls = 0;

    const author = createAuthor({
      entities: { User: UserEntity },
      resources: { Project: ProjectResource },
      policies: [
        allow<Ctx>("early allow", { entityTypes: ["User"], resourceTypes: ["Project"], actions: ["delete"] }, () => {
          earlyAllowCalls += 1;
          return true;
        }),
        deny<Ctx>(
          "deny delete",
          { entityTypes: ["User"], resourceTypes: ["Project"], actions: ["delete"] },
          () => true,
        ),
      ],
    });

    await expect(author.as("User", { id: "u1" }).can("delete").on("Project", { id: "p1" }).allowed()).resolves.toBe(
      false,
    );
    expect(earlyAllowCalls).toBe(0);

    const decision = await author.as("User", { id: "u1" }).can("delete").on("Project", { id: "p1" }).explain();

    expect(decision.allowed).toBe(false);
    expect(decision.matchedPolicies.map((policy) => policy.name)).toEqual(["deny delete", "early allow"]);
    expect(earlyAllowCalls).toBe(1);
  });

  test("direct store helper checks are memoized within one evaluation", async () => {
    const baseStore = memoryStore();
    let roleChecks = 0;
    const store: AuthorStore = {
      ...baseStore,
      getRoles: async () => {
        throw new Error("ctx.roles.has should use direct hasRole");
      },
      hasRole: (input) => {
        roleChecks += 1;
        return baseStore.hasRole(input);
      },
    };
    await store.grantRole({ entityType: "User", entityId: "u1", role: "reader" });

    const author = createAuthor({
      store,
      entities: { User: UserEntity },
      resources: { Project: ProjectResource },
      policies: [
        allow<Ctx>("reader one", { entityTypes: ["User"], resourceTypes: ["Project"], actions: ["read"] }, (ctx) =>
          ctx.roles.has("reader"),
        ),
        allow<Ctx>("reader two", { entityTypes: ["User"], resourceTypes: ["Project"], actions: ["read"] }, (ctx) =>
          ctx.roles.has("reader"),
        ),
      ],
    });

    const decision = await author.as("User", { id: "u1" }).can("read").on("Project", { id: "p1" }).explain();

    expect(decision.allowed).toBe(true);
    expect(decision.matchedPolicies.map((policy) => policy.name)).toEqual(["reader one", "reader two"]);
    expect(roleChecks).toBe(1);
  });

  test("throw stops at the first matching deny", async () => {
    let laterAllowCalls = 0;
    const author = createAuthor({
      audit: "none",
      entities: { User: UserEntity },
      resources: { Project: ProjectResource },
      policies: [
        deny<Ctx>(
          "deny delete",
          { entityTypes: ["User"], resourceTypes: ["Project"], actions: ["delete"] },
          () => true,
        ),
        allow<Ctx>("later allow", { entityTypes: ["User"], resourceTypes: ["Project"], actions: ["delete"] }, () => {
          laterAllowCalls += 1;
          return true;
        }),
      ],
    });

    await expect(
      author.as("User", { id: "u1" }).can("delete").on("Project", { id: "p1" }).throw(),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(laterAllowCalls).toBe(0);
  });

  test("cached checks stay short-circuit while explain stays exhaustive", async () => {
    let laterAllowCalls = 0;
    const author = createAuthor({
      cache: memoryCache(),
      audit: "none",
      entities: { User: UserEntity },
      resources: { Project: ProjectResource },
      policies: [
        allow<Ctx>("first allow", { entityTypes: ["User"], resourceTypes: ["Project"], actions: ["read"] }, () => true),
        allow<Ctx>("later allow", { entityTypes: ["User"], resourceTypes: ["Project"], actions: ["read"] }, () => {
          laterAllowCalls += 1;
          return true;
        }),
      ],
    });

    await author.as("User", { id: "u1" }).can("read").on("Project", { id: "p1" }).allowed();
    await author.as("User", { id: "u1" }).can("read").on("Project", { id: "p1" }).allowed();
    expect(laterAllowCalls).toBe(0);

    const decision = await author.as("User", { id: "u1" }).can("read").on("Project", { id: "p1" }).explain();
    expect(decision.matchedPolicies.map((policy) => policy.name)).toEqual(["first allow", "later allow"]);
    expect(laterAllowCalls).toBe(1);
  });

  test("boolean checks return before a slow audit write finishes", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const store = memoryStore();
    const slowStore: AuthorStore = {
      ...store,
      writeAuditLog: async (entry) => {
        started = true;
        await gate;
        await store.writeAuditLog?.(entry);
      },
    };
    const author = createAuthor({
      store: slowStore,
      entities: { User: UserEntity },
      resources: { Project: ProjectResource },
      policies: [allow<Ctx>("project read", () => true)],
    });

    const result = await Promise.race([
      author
        .as("User", { id: "u1" })
        .can("read")
        .on("Project", { id: "p1" })
        .allowed()
        .then(() => "done"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ]);

    expect(started).toBe(true);
    expect(result).toBe("done");
    release();
  });
});
