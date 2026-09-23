# Adapters

This page covers persistence and caching adapters. For application-level grant/revoke APIs, see [Permission management](./management.md).

author.js separates authorization logic from persistence and caching.

| Adapter | Role |
| --- | --- |
| **Store** | Roles, permissions, relations, audit logs |
| **Cache** | Short-lived evaluated decisions |

Install only what your app needs.

## Local integration environment

Run real PostgreSQL, MongoDB, and Redis services with Docker:

```bash
docker compose up -d
bun run test:integration
```

Defaults:

```txt
POSTGRES_URL=postgres://author:author@localhost:54329/author_js
MONGODB_URL=mongodb://localhost:27029
REDIS_URL=redis://localhost:63799
```

The same integration test runs in GitHub Actions.

## Stores

### Memory

For tests and local development.

```ts
import { memoryStore } from "author-js";

const store = memoryStore();

await store.grantRole({
  entityType: "User",
  entityId: "user_1",
  role: "admin",
  scopeType: "Organization",
  scopeId: "org_1",
});
```

Data is process-local and does not survive restarts.

### PostgreSQL

```ts
import { postgresStore } from "author-js/postgres";

const store = postgresStore({
  connectionString: process.env.DATABASE_URL,
});
```

Pass an existing pg-compatible client:

```ts
const store = postgresStore({ client });
```

Schema file: `author-js/postgres/schema.sql`

Existing databases should apply the lookup indexes from that file: `author_roles_lookup_idx` and `author_permissions_lookup_idx`.

Tables:

- `author_roles`
- `author_permissions`
- `author_relations`
- `author_audit_logs`

Requires `pg`. Not suitable for edge runtimes.

### MongoDB

```ts
import { ensureMongoIndexes, mongodbStore } from "author-js/mongodb";

const store = mongodbStore({
  client,
  database: "my_app",
});

await ensureMongoIndexes({ client, database: "my_app" });
```

Run `ensureMongoIndexes` during setup or migrations.

Collections:

- `author_roles`
- `author_permissions`
- `author_relations`
- `author_audit_logs`

### Direct helper checks

Stores must implement list methods such as `getRoles`, `getPermissions`, and `getRelations`. For better hot-path performance, stores can also implement direct existence checks:

```ts
const store = {
  async getRoles(input) {
    // list roles for management screens and fallback policy helpers
  },
  async hasRole(input) {
    // return true when this entity has input.role in the optional scope
  },
  async hasPermission(input) {
    // return true when an allow grant exists and no matching deny grant exists
  },
  async hasRelation(input) {
    // return true when at least one relation tuple matches the query
  },
};
```

Policy helpers use these methods when present:

```ts
await ctx.roles.has("admin", { type: "Organization", id: "org_1" });
await ctx.permissions.has("read", { type: "Project", id: "project_1" });
await ctx.relations.has({ subjectType: "User", subjectId: "user_1", relation: "owner" });
await ctx.parents.hasRole("admin", "organization");
```

The memory, PostgreSQL, and MongoDB stores include direct checks. The memory store returns those booleans directly. `await` still works.

## Audit logs

Stores that implement `writeAuditLog` receive a log entry after each decision. Each entry records the outcome, matched policies, and actor.

For high-volume apps, use `audit: "explain"` or `audit: "none"` in `createAuthor`, or use a custom store that queues or samples writes. With `audit: "all"`, boolean checks still record the decision, but they do not wait for the store write to finish.

## Decision cache

Optional. Useful when the same check runs repeatedly in a short window.

```ts
import { createAuthor, memoryCache } from "author-js";

const author = createAuthor({
  cache: memoryCache(),
  cacheTtlMs: 30_000,
  entities,
  modules,
  policies: globalPolicies,
});
```

By default, cache keys are generated from the entity, action, resource, mode, context, and resource data using a synchronous SHA-256 digest. Boolean checks and `.explain()` use different key suffixes so a short-circuit result is not reused as a full explanation. For apps with their own stable resource versioning, provide a custom key resolver:

```ts
const author = createAuthor({
  cache,
  cacheKey: ({ entityType, entityId, action, resourceType, resourceId }) =>
    `${entityType}:${entityId}:${action}:${resourceType}:${resourceId}`,
  entities,
  modules,
});
```

### Redis

```ts
import { redisCache } from "author-js/redis";

const cache = redisCache({
  client: Bun.redis,
  prefix: "my-app-auth",
});

const author = createAuthor({
  cache,
  cacheTtlMs: 30_000,
  entities,
  modules,
  policies: globalPolicies,
});
```

Accepts any client with `get`, `set`, and `del`. `clear()` stores a new generation id, so later reads miss keys written before the invalidation without scanning Redis.

### Invalidation

Clear the entire cache:

```ts
await author.invalidate();
```

`decisionCacheKey(...)` returns a string. The engine stores that value with a prefix: `check:` for boolean checks and `decide`, `explain:` for `.explain()` and `author.evaluate(...)`. A custom `cacheKey` gets the same prefix. Delete both entries when dropping one check:

```ts
import { decisionCacheKey } from "author-js";

const base = decisionCacheKey({
  entityType: "User",
  entityId: "user_1",
  action: "read",
  resourceType: "Project",
  resourceId: "project_1",
  mode: "backend",
  context: {},
  resource: project,
});

await cache.delete(`check:${base}`);
await cache.delete(`explain:${base}`);
```

Role, permission, and relation changes made through `author.roles`, `author.permissions`, and `author.relations` clear the whole cache. Prefer `author.invalidate()` after any other permission change.
