export type { AuthorCache, CacheKeyInput } from "./cache.js";
export { decisionCacheKey, memoryCache } from "./cache.js";
export type {
  AuditMode,
  AuthorInstance,
  AuthorizationRunner,
  CreateAuthorInput,
  ResourceDecisionBuilder,
} from "./create-author.js";
export { createAuthor, runDecision } from "./create-author.js";
export type { ContextDefinition, EntityDefinition, ResourceDefinition, ResourceParent } from "./definitions.js";
export { defineContext, defineEntity, defineResource } from "./definitions.js";
export type { EntitlementContext, EntitlementsConfig } from "./entitlements.js";
export {
  AuthorError,
  AuthorizationDeniedError,
  DuplicateResourceTypeError,
  MissingParentResourceError,
  UnknownActionError,
  UnknownEntityTypeError,
  UnknownResourceTypeError,
} from "./errors.js";
export { memoryStore } from "./memory-store.js";
export type { AuthorModule } from "./module.js";
export { defineAuthorModule } from "./module.js";
export type {
  AuthorPolicyContext,
  AuthorRule,
  DecisionHook,
  Policy,
  PolicyChecker,
  PolicyResult,
  PolicyScope,
} from "./policy.js";
export { afterDecision, allow, deny, policy, skip } from "./policy.js";
export type * from "./types.js";
