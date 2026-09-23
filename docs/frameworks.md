# Frameworks

Framework adapters enforce authorization at the route boundary.

Each adapter:

1. Resolves the entity from the request
2. Loads the resource from your database
3. Runs `author.decide(...)` when the author provides it, otherwise `author.evaluate(...)`
4. Returns 403 when denied. The JSON `reason` is the matching policy name. The response does not include skipped policies.

Authorize against the loaded resource, not route params alone. The loaded resource carries ownership, tenant, visibility, parent IDs, and other attributes policies depend on.

## Express

```ts
import { requireCan } from "author-js/express";

app.patch(
  "/projects/:id",
  requireCan({
    author,
    entityType: "User",
    entity: (req) => req.user,
    action: "update",
    resourceType: "Project",
    resource: (req) => db.project.findUniqueOrThrow({ where: { id: req.params.id } }),
    context: (req) => ({ ip: req.ip }),
  }),
  async (req, res) => {
    res.json({ ok: true });
  },
);
```

Denied response:

```json
{ "error": "Forbidden", "reason": "..." }
```

## Hono

```ts
import { requireCan } from "author-js/hono";

app.patch(
  "/projects/:id",
  requireCan({
    author,
    entityType: "User",
    entity: (c) => c.get("user"),
    action: "update",
    resourceType: "Project",
    resource: (c) => loadProject(c.req.param("id")),
  }),
  (c) => c.json({ ok: true }),
);
```

## Fastify

```ts
import { requireCan } from "author-js/fastify";

fastify.patch(
  "/projects/:id",
  {
    preHandler: requireCan({
      author,
      entityType: "User",
      entity: (request) => request.user,
      action: "update",
      resourceType: "Project",
      resource: (request) => loadProject(request.params.id),
    }),
  },
  async () => ({ ok: true }),
);
```

## Elysia

```ts
import { Elysia } from "elysia";
import { requireCan } from "author-js/elysia";

new Elysia().patch(
  "/projects/:id",
  () => ({ ok: true }),
  {
    beforeHandle: requireCan({
      author,
      entityType: "User",
      entity: (ctx) => ctx.user,
      action: "update",
      resourceType: "Project",
      resource: (ctx) => loadProject(ctx.params.id),
    }),
  },
);
```

When denied, sets `ctx.set.status = 403` and returns:

```json
{ "error": "Forbidden", "reason": "..." }
```

## Next.js

### assertCan

For route handlers, server actions, and server components.

```ts
import { assertCan } from "author-js/next/server";

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const user = await getCurrentUser();
  const project = await loadProject(params.id);

  await assertCan({
    author,
    entityType: "User",
    entity: user,
    action: "update",
    resourceType: "Project",
    resource: project,
  });

  await updateProject(project.id, await request.json());
  return Response.json({ ok: true });
}
```

Throws `AuthorizationDeniedError` when denied. Map it to a 403 in your error handler.

### requireCan

Reusable check function for route handlers and server actions.

```ts
import { requireCan } from "author-js/next/server";

const canUpdateProject = requireCan({
  author,
  entity: async () => getCurrentUser(),
  action: "update",
  resourceType: "Project",
  resource: async (request) => loadProject(getProjectId(request)),
});

export async function PATCH(request: Request) {
  await canUpdateProject(request);
  // ...
}
```

## Context

Pass values policies need but resources do not contain.

```ts
requireCan({
  author,
  entityType: "User",
  entity: (req) => req.user,
  action: "create",
  resourceType: "Project",
  resource: (req) => req.organization,
  context: async (req) => ({
    projectCount: await countProjects(req.user.id),
    ip: req.ip,
  }),
});
```

`action` and `resourceType` accept a string or a function when they vary per request.
