# React

Render UI based on authorization decisions. Pair with server-side enforcement for mutations and protected data.

## Provider

```tsx
import { AuthorProvider } from "author-js/react";

<AuthorProvider authorization={author} entityType="User" entity={user}>
  <App />
</AuthorProvider>
```

| Prop | Description |
| --- | --- |
| `authorization` | author.js instance |
| `entity` | Default actor for child checks |
| `mode` | Defaults to `frontend` |
| `context` | Default context for child checks |
| `children` | React children |

Set shared context once at the provider:

```tsx
<AuthorProvider authorization={author} entityType="User" entity={user} context={{ tenantId }}>
  <App />
</AuthorProvider>
```

## Can

Render children when allowed.

```tsx
import { Can } from "author-js/react";

<Can do="update" on="Project" resource={project}>
  <EditButton />
</Can>
```

With a fallback:

```tsx
<Can
  do="update"
  on="Project"
  resource={project}
  fallback={<DisabledEditButton />}
>
  <EditButton />
</Can>
```

The first check renders `null` while loading. After a decision exists, `Can` keeps showing that result while the same check refreshes. `decision` is the short-circuit result: one matching policy and a reason, with no skipped policies.

## Cannot

Render children when denied.

```tsx
import { Cannot } from "author-js/react";

<Cannot do="delete" on="Project" resource={project}>
  <p>You cannot delete this project.</p>
</Cannot>
```

## Hooks

### useCan

For custom loading, error, or layout behavior.

```tsx
import { useCan } from "author-js/react";

function EditProjectButton({ project }: { project: Project }) {
  const permission = useCan({
    do: "update",
    on: "Project",
    resource: project,
  });

  if (permission.loading) return null;
  if (permission.error) return <span>Could not check permissions</span>;
  if (!permission.allowed) return null;

  return <EditButton />;
}
```

### useCannot

Inverted `useCan`. When `allowed` is `true`, the actor is denied the action.

```tsx
import { useCannot } from "author-js/react";

const { allowed: isDenied, loading } = useCannot({
  do: "delete",
  on: "Project",
  resource: project,
});

if (isDenied) return <p>You cannot delete this project.</p>;
```

### useAuthor

Read provider context directly.

```tsx
import { useAuthor } from "author-js/react";

const { authorization, entity, mode, context } = useAuthor();
```

Hook return shape:

```ts
type UseCanResult = {
  allowed: boolean;
  loading: boolean;
  error: Error | null;
  decision: Decision | null;
};
```

## Entity override

Use `i` to check a different actor than the provider default.

```tsx
<Can i={serviceAccount} do="read" on="Project" resource={project}>
  <span>Service account can read this project</span>
</Can>
```

## Context

Component context merges with provider context. Component keys override provider keys.

```tsx
<Can
  do="read"
  on="Report"
  resource={report}
  context={{ tenantId, rollout: "beta" }}
>
  <ReportPreview />
</Can>
```

## Next.js client components

Import from `author-js/next/client` in client components:

```tsx
import { AuthorProvider, Can } from "author-js/next/client";
```
