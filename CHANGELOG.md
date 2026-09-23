# Changelog

## 0.3.0

- add `author.decide(...)` for a short-circuit decision with the matching policy and reason
- add `runDecision(...)` so adapters call `decide` when it exists and `evaluate` otherwise
- boolean checks, `.throw()`, framework middleware, Next `assertCan`, and React `useCan` use the short-circuit path
- `.explain()` and `author.evaluate(...)` still run every relevant policy and include skipped policies
- cache boolean checks and explanations separately so a short-circuit result is not reused as a full explanation
- make `decisionCacheKey(...)` synchronous
- stop waiting for audit writes on boolean checks; a failed audit write does not fail the check
- keep `.explain()` and `author.evaluate(...)` waiting for the audit write
- add Redis `clear()` by storing a new generation id instead of scanning keys
- add PostgreSQL lookup indexes and equality filters for role, permission, and relation checks
- resolve PostgreSQL `hasPermission` with one `BOOL_OR` query
- limit MongoDB existence checks to one document, and check deny and allow permissions separately
- index the memory store by actor and return `hasRole`, `hasPermission`, and `hasRelation` as booleans
- share in-flight React decisions inside one `AuthorProvider`
- keep the previous React result on screen while the same check refreshes
- remove the policy-scaling benchmark and the `tinybench` dependency

Existing databases need the new indexes in `author-js/postgres/schema.sql`. Permission changes should call `author.invalidate()` with no key. A raw `decisionCacheKey(...)` is not the stored cache key; boolean checks are stored as `check:` plus that value, and explanations as `explain:` plus that value.

## 0.2.0

- add `defineAuthorModule` for domain-level authorization modules
- add scoped policy metadata for entity, resource, and action preselection
- add fluent `policy.for(...).on(...).can(...).allow/deny` helpers for resource/action-specific rules
- add after-decision hooks for scoped metrics, custom logs, and side effects
- add wildcard-aware nested rule indexing with separate deny/allow fast paths
- add configurable audit mode with `all`, `explain`, and `none`
- add optional direct `hasRole`, `hasPermission`, and `hasRelation` store checks
- add `author.check(...)` for direct boolean checks
- add request-local memoization for repeated store and entitlement helper reads
- add custom decision cache key support
- add Tinybench policy-scaling benchmarks

## 0.1.0

Initial release:

- core authorization engine
- memory, PostgreSQL, and MongoDB stores
- React adapter
- Express, Hono, Fastify, Elysia, and Next.js helpers
- Redis decision cache
- permission management helpers for roles, permissions, and relations
- Docker-backed PostgreSQL, MongoDB, and Redis integration tests
- Husky quality gates with Biome formatting/linting
