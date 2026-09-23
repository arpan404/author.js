# Core

author.js answers one question:

```txt
Can this entity perform this action on this resource in this context?
```

```ts
await author.as("User", user).can("update").on("Project", project);
```

## Entities and resources

Entities are actors. Resources are the objects being protected.

```ts
import { defineEntity, defineResource } from "author-js";

export type User = {
  id: string;
  orgId: string;
  role: "admin" | "member";
  plan: "free" | "pro" | "enterprise";
};

export type Project = {
  id: string;
  orgId: string;
  ownerId: string;
  visibility: "public" | "private";
};

export const UserEntity = defineEntity<User>()({
  type: "User",
  id: (user) => user.id,
});

export const ProjectResource = defineResource<Project>()({
  type: "Project",
  id: (project) => project.id,
  actions: ["read", "create", "update", "delete"] as const,
  parents: {
    organization: {
      type: "Organization",
      id: (project) => project.orgId,
    },
  },
});
```

`type` and `id` are the stable references used in decisions, audit logs, roles, permissions, relationships, and cache keys.

## Policies

Policies are named rules. Return `true` to match, `false` to skip.

```ts
import { policy } from "author-js";

export const projectPolicies = [
  policy
    .for("User")
    .on("Project")
    .can(["read", "create", "update", "delete"])
    .allow("admins can do anything", ({ entity }) => entity.role === "admin"),

  policy
    .for("User")
    .on("Project")
    .can("update")
    .allow("owners can update projects", ({ entity, resource }) => entity.id === resource.data.ownerId),

  policy
    .for("User")
    .on("Project")
    .can("delete")
    .deny("members cannot delete projects", ({ entity }) => entity.role === "member"),
] as const;
```

Evaluation order:

1. The engine selects only rules relevant to the entity type, resource type, and action.
2. Boolean checks evaluate relevant deny rules first and stop at the first matching deny.
3. If no deny matches, boolean checks evaluate relevant allow rules and stop at the first matching allow.
4. `.explain()` runs every relevant decision policy so the decision includes all matching and skipped policies.
5. If no allow matches, the result is denied.

Unscoped policies are relevant to every check. In larger apps, scope policies so the engine can skip unrelated rules before running user code:

```ts
policy
  .for("User")
  .on("Project")
  .can("update")
  .allow("owners can update projects", ({ entity, resource }) => entity.id === resource.data.ownerId);

policy
  .for("User")
  .on("Project")
  .can("delete")
  .deny("members cannot delete projects", ({ entity }) => entity.role === "member");
```

Scopes are static applicability metadata. Keep dynamic checks such as ownership, tenant membership, roles, and subscription state inside the policy function.
The lower-level `allow(name, scope, check)` and `deny(name, scope, check)` helpers are still available when you want to build scopes yourself.
Detailed checker results can provide custom reasons, but an allow policy always produces an allow and a deny policy always produces a deny; return `skip(...)` or `false` when the policy does not apply.

## Typed request context

Use `defineContext` when policies need typed request context.

```ts
import { defineContext } from "author-js";

type AuthContext = {
  tenantId: string;
  projectCount?: number;
};

export const AuthContext = defineContext<AuthContext>();
```

Pass it to `createAuthor`:

```ts
createAuthor({
  context: AuthContext,
  entities,
  modules,
  policies: globalPolicies,
});
```

Now `ctx.context.tenantId` is typed as `string` in policies.

## Author instance

Keep definitions, plans, modules, and policies in separate files. Compose them once.

```ts
import { createAuthor, defineAuthorModule } from "author-js";
import { UserEntity, ProjectResource, InvoiceResource } from "./definitions";
import { entitlements } from "./plans";
import { organizationPolicies } from "./policies/organization";
import { projectPolicies } from "./policies/project";
import { billingPolicies } from "./policies/billing";

export const projectModule = defineAuthorModule({
  name: "projects",
  resources: { Project: ProjectResource },
  policies: projectPolicies,
});

export const billingModule = defineAuthorModule({
  name: "billing",
  resources: { Invoice: InvoiceResource },
  policies: billingPolicies,
});

export const author = createAuthor({
  entities: { User: UserEntity },
  modules: [projectModule, billingModule],
  entitlements,
  policies: organizationPolicies,
});
```

Suggested layout:

```txt
src/authorization/
  author.ts
  definitions.ts
  plans.ts
  modules/
    projects.ts
    billing.ts
  policies/
    organization.ts
```

## Author modules

Use modules to group resource definitions and policies by domain while still building one authorization engine. This keeps global denies and audit behavior centralized.

```ts
import { defineAuthorModule } from "author-js";

export const projectModule = defineAuthorModule({
  name: "projects",
  resources: { Project: ProjectResource },
  policies: projectPolicies,
});

export const billingModule = defineAuthorModule({
  name: "billing",
  resources: { Invoice: InvoiceResource },
  policies: billingPolicies,
});
```

Compose modules once:

```ts
export const author = createAuthor({
  entities: { User: UserEntity, ApiKey: ApiKeyEntity },
  modules: [projectModule, billingModule],
  policies: globalPolicies,
});
```

Module resources and policies are merged into one runtime index. If two modules register the same resource type, `createAuthor` throws `DuplicateResourceTypeError`.

For small apps, `createAuthor({ resources, policies })` is still valid. Modules are the preferred API when resources and policies are owned by different domains.

## Decision hooks

Use `afterDecision` hooks for side effects such as metrics, custom logs, tracing, or cache warming. Hooks are scoped like policies and run after a decision is produced. They cannot change the returned decision.

```ts
import { policy } from "author-js";

export const projectPolicies = [
  policy.for("User").on("Project").can("read").allow("members can read projects", async (ctx) => {
    return ctx.parents.hasRole("member", "organization");
  }),

  policy
    .for("User")
    .on("Project")
    .can("read")
    .afterDecision("record project read", async (ctx, decision) => {
      await metrics.count("auth.project.read", {
        allowed: decision.allowed,
        mode: ctx.mode,
      });
    }),
];
```

For global hooks, use `afterDecision(name, run)` directly or omit one or more builder scopes.

## Audit mode

Stores with `writeAuditLog` receive audit entries by default for both boolean checks and explanations. Boolean checks start the write and return without waiting for it. `.explain()` and `author.evaluate(...)` wait for the audit write before resolving. Tune this per author instance:

```ts
createAuthor({
  entities,
  modules,
  audit: "explain",
});
```

Modes:

- `all`: write audit logs for `.allowed()`, awaited checks, `author.check(...)`, `author.decide(...)`, and `.explain()`. Boolean checks do not wait for the write, and a rejected write does not fail the check.
- `explain`: write audit logs only for full decisions from `.explain()` and `author.evaluate(...)`
- `none`: disable automatic audit writes

## Check API

Boolean result:

```ts
const allowed = await author.as("User", user).can("update").on("Project", project);
```

Direct boolean check:

```ts
const allowed = await author.check({
  entityType: "User",
  entity: user,
  action: "update",
  resourceType: "Project",
  resource: project,
  context: {},
  mode: "backend",
});
```

Short-circuit decision, including the matching policy and reason:

```ts
const decision = await author.decide({
  entityType: "User",
  entity: user,
  action: "update",
  resourceType: "Project",
  resource: project,
  context: {},
  mode: "backend",
});
```

`decision.skippedPolicies` is empty here. Later allow policies are not run after a matching deny.

Detailed decision:

```ts
const decision = await author
  .as("User", user)
  .can("update")
  .on("Project", project)
  .explain();
```

Enforcement:

```ts
await author.as("User", user).can("delete").on("Project", project).throw();
```

`.throw()` raises `AuthorizationDeniedError` when denied. It uses the short-circuit decision, so a denied check includes the matching deny without running later allow policies.

## Context

Pass request-specific data that policies need but resources do not contain: IP address, tenant ID, usage counts, feature flags.

```ts
await author.as("User", user).can("create").on("Project", project, {
  ip: request.ip,
  projectCount: await countProjects(user.id),
});
```

```ts
allow("trusted IP can read reports", ({ action, context }) => {
  return action === "read" && context.ip === "127.0.0.1";
});
```

## Plans, features, and limits

Centralize billing capabilities in one file.

```ts
export const plans = {
  free: {
    features: ["projects.read"],
    limits: { projects: 3, seats: 1 },
  },
  pro: {
    features: ["projects.read", "projects.create", "members.invite"],
    limits: { projects: 100, seats: 10 },
  },
  enterprise: {
    features: ["projects.read", "projects.create", "members.invite", "audit.read"],
    limits: { projects: 10_000, seats: 500 },
  },
} as const;

export type PlanName = keyof typeof plans;

export const entitlements = {
  plan: ({ entity }: { entity: { plan: PlanName } }) => entity.plan,
  features: Object.fromEntries(
    Object.entries(plans).map(([name, plan]) => [name, plan.features]),
  ),
  limits: Object.fromEntries(
    Object.entries(plans).map(([name, plan]) => [name, plan.limits]),
  ),
};
```

Use entitlement helpers in policies:

```ts
allow("plan can create projects", async (ctx) => {
  if (ctx.action !== "create") return false;
  if (!(await ctx.features.has("projects.create"))) return false;

  const used = Number(ctx.context["projectCount"] ?? 0);
  return ctx.limits.within("projects", { used });
});
```

Pass usage through context or query it inside the policy.

```ts
await ctx.subscription.plan();
await ctx.features.has("projects.create");
await ctx.features.list();
await ctx.limits.get("projects");
await ctx.limits.within("projects", { used: 2 });
await ctx.limits.remaining("projects", { used: 2 });
```

## Parent resources

Parent permissions are not inherited automatically. Write explicit rules.

```ts
allow("organization admins can update projects", async (ctx) => {
  if (ctx.resource.type !== "Project") return false;
  if (ctx.action !== "update") return false;

  return ctx.parents.hasRole("admin", "organization");
});
```

```ts
await ctx.parents.get("organization");
await ctx.parents.getRequired("organization");
await ctx.parents.list();
await ctx.parents.hasRole("admin", "organization");
await ctx.parents.hasPermission("read", "organization");
await ctx.parents.hasRelation("member", "organization");
```

Use `getRequired` when a missing parent is a programming error. Use `get` when the parent is optional.

## Permission management

For settings pages and setup scripts, use the management helpers:

```ts
await author.roles.grant({ entityType: "User", entityId: "u1", role: "admin" });
await author.permissions.revoke({ entityType: "User", entityId: "u1", action: "read", resourceType: "Project", resourceId: "p1", effect: "allow" });
await author.relations.delete({ subjectType: "User", subjectId: "u1", relation: "owner", objectType: "Project", objectId: "p1" });
```

See [Permission management](./management.md) for the full grant/revoke/list API and settings-page examples.

## Decisions

`.explain()` returns the full decision:

```ts
type Decision = {
  allowed: boolean;
  effect: "allow" | "deny";
  reason: string;
  matchedPolicies: Array<{ name: string; effect: "allow" | "deny"; reason: string }>;
  skippedPolicies: Array<{ name: string; reason?: string }>;
};
```

Use decisions in tests, audit screens, support tooling, and logs.
