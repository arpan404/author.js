# author.js

[![CI](https://github.com/arpan404/author-js/actions/workflows/ci.yml/badge.svg)](https://github.com/arpan404/author-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/author-js.svg)](https://www.npmjs.com/package/author-js)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Unified authorization layer for frontend and backend applications with scoped policies, RBAC, ABAC, ReBAC, and audit logging.

Write authorization as normal TypeScript policies, grouped into modules when your app grows:

```ts
const allowed = await author.as("User", user).can("update").on("Project", project);
```

Supports RBAC, ABAC, ReBAC, parent-resource checks, subscription features, limits, UI rendering, and backend enforcement.

## Install

```bash
bun add author-js
```

Add peer dependencies only for the adapters you use:

```bash
bun add pg react
```

## Quick start

```ts
import { createAuthor, defineAuthorModule, defineEntity, defineResource, policy } from "author-js";

type User = { id: string; role: "admin" | "member" };
type Project = { id: string; ownerId: string };

const UserEntity = defineEntity<User>()({
  type: "User",
  id: (user) => user.id,
});

const ProjectResource = defineResource<Project>()({
  type: "Project",
  id: (project) => project.id,
  actions: ["read", "update", "delete"] as const,
});

const projectModule = defineAuthorModule({
  name: "projects",
  resources: { Project: ProjectResource },
  policies: [
    policy
      .for("User")
      .on("Project")
      .can(["read", "update", "delete"])
      .allow("admins can do anything", ({ entity }) => entity.role === "admin"),
    policy
      .for("User")
      .on("Project")
      .can("update")
      .allow("owners can update projects", ({ entity, resource }) => entity.id === resource.data.ownerId),
  ],
});

export const author = createAuthor({
  entities: { User: UserEntity },
  modules: [projectModule],
});

await author.as("User", user).can("update").on("Project", project).throw();
```

Policy scopes are static applicability metadata. The engine uses them to select only policies relevant to the current entity type, resource type, and action.
Boolean checks, `.throw()`, and `author.decide(...)` evaluate deny rules first and stop at the first match. `.explain()` and `author.evaluate(...)` run every relevant policy and include skipped policies.

## Permission management

Use the built-in management helpers for admin screens and setup scripts. They wrap the configured store and invalidate the decision cache when possible.

```ts
await author.roles.grant({
  entityType: "User",
  entityId: "user_1",
  role: "admin",
  scopeType: "Organization",
  scopeId: "org_1",
});

await author.permissions.grant({
  entityType: "User",
  entityId: "user_1",
  action: "read",
  resourceType: "Project",
  resourceId: "project_1",
  effect: "allow",
});

await author.relations.create({
  subjectType: "User",
  subjectId: "user_1",
  relation: "owner",
  objectType: "Project",
  objectId: "project_1",
});
```

## Packages

| Import | Purpose |
| --- | --- |
| `author-js` | Core API |
| `author-js/postgres` | PostgreSQL store |
| `author-js/mongodb` | MongoDB store |
| `author-js/redis` | Redis decision cache |
| `author-js/react` | Provider, components, hooks |
| `author-js/express` | Express middleware |
| `author-js/hono` | Hono middleware |
| `author-js/fastify` | Fastify pre-handler |
| `author-js/elysia` | Elysia beforeHandle helper |
| `author-js/next` | Next.js entry |
| `author-js/next/server` | Server-side `assertCan` and `requireCan` |
| `author-js/next/client` | React components for client components |

## Documentation

Full docs: [docs/README.md](./docs/README.md)

| Guide | Topics |
| --- | --- |
| [Core](./docs/core.md) | Entities, resources, modules, scoped policies, plans, parent checks |
| [Permission management](./docs/management.md) | Grant, revoke, and list roles, permissions, and relations |
| [Adapters](./docs/adapters.md) | Memory, PostgreSQL, MongoDB, Redis caching |
| [React](./docs/react.md) | `AuthorProvider`, `Can`, `Cannot`, hooks |
| [Frameworks](./docs/frameworks.md) | Express, Hono, Fastify, Elysia, Next.js |
| [Testing](./docs/testing.md) | Local checks, hooks, Docker integration tests |

## Development

```bash
bun install
bun run check
```

## License

MIT © Arpan Bhandari
