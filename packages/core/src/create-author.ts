import { type AuthorCache, type CacheKeyInput, decisionCacheKey } from "./cache.js";
import type { ContextDefinition, EntityDefinition, ResourceDefinition } from "./definitions.js";
import type { EntitlementContext, EntitlementsConfig } from "./entitlements.js";
import {
  AuthorizationDeniedError,
  DuplicateResourceTypeError,
  MissingParentResourceError,
  UnknownActionError,
  UnknownEntityTypeError,
  UnknownResourceTypeError,
} from "./errors.js";
import { memoryStore } from "./memory-store.js";
import type { AuthorModule } from "./module.js";
import {
  type AuthorPolicyContext,
  type AuthorRule,
  type DecisionHook,
  normalizePolicyResult,
  type Policy,
} from "./policy.js";
import type {
  AuthorStore,
  Decision,
  DeleteRelationInput,
  GetPermissionsInput,
  GetRelationsInput,
  GetRolesInput,
  HasPermissionInput,
  HasRelationInput,
  HasRoleInput,
  Mode,
  ParentRef,
  ParentResolver,
  PermissionGrant,
  PermissionGrantInput,
  PolicyEffect,
  RelationTuple,
  RelationTupleInput,
  ResourceInput,
  RevokePermissionInput,
  RevokeRoleInput,
  RoleGrant,
  RoleGrantInput,
  ScopeInput,
} from "./types.js";

type EntityMap = Record<string, EntityDefinition<unknown, string>>;
type ResourceMap = Record<string, ResourceDefinition<unknown, string, readonly string[]>>;
type EmptyResourceMap = Record<never, never>;
type AnyAuthorModule = AuthorModule<ResourceMap, unknown>;
type EntityValue<Entities> = Entities[keyof Entities] extends EntityDefinition<infer Entity, string> ? Entity : never;
type ResourceValue<Resources, Type extends keyof Resources> =
  Resources[Type] extends ResourceDefinition<infer Resource, string, readonly string[]> ? Resource : never;
type ResourceAction<Resources> =
  Resources[keyof Resources] extends ResourceDefinition<unknown, string, infer Actions> ? Actions[number] : string;
type SubjectValue<Entities, Type extends keyof Entities> =
  Entities[Type] extends EntityDefinition<infer Entity, string> ? Entity : never;
type SubjectUnion<Entities> = {
  [Type in keyof Entities & string]: { type: Type; id: string; data: SubjectValue<Entities, Type> };
}[keyof Entities & string];
type TypedResource<Resources, Type extends keyof Resources & string> = ResourceValue<Resources, Type> & {
  readonly authorType: Type;
};
type ResourceOn<Resources, CustomContext extends Record<string, unknown>> = {
  <Type extends keyof Resources & string>(
    resourceType: Type,
    resource: ResourceValue<Resources, Type>,
    context?: CustomContext,
  ): ResourceDecisionBuilder;
  <Type extends keyof Resources & string>(
    resource: TypedResource<Resources, Type>,
    context?: CustomContext,
  ): ResourceDecisionBuilder;
};
type PolicyContext<Entities, Resources, CustomContext extends Record<string, unknown>> = AuthorPolicyContext<
  EntityValue<Entities>,
  ResourceValue<Resources, keyof Resources>,
  CustomContext,
  SubjectUnion<Entities>
>;
type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
  value: infer Intersection,
) => void
  ? Intersection
  : never;
type ModuleResourceUnion<Modules extends readonly AnyAuthorModule[]> =
  Modules[number] extends AuthorModule<infer Resources, unknown> ? Resources : never;
type ResourcesFromModules<Modules extends readonly AnyAuthorModule[]> = [Modules[number]] extends [never]
  ? EmptyResourceMap
  : UnionToIntersection<ModuleResourceUnion<Modules>>;
type CombinedResources<Resources, Modules extends readonly AnyAuthorModule[]> = Resources &
  ResourcesFromModules<Modules>;
type CombinedPolicyContext<
  Entities,
  Resources,
  Modules extends readonly AnyAuthorModule[],
  CustomContext extends Record<string, unknown>,
> = PolicyContext<Entities, CombinedResources<Resources, Modules>, CustomContext>;
export type AuditMode = "all" | "explain" | "none";
type EvaluationOperation = "check" | "evaluate";
const wildcardScope = Symbol("author.wildcardScope");
type ScopeKey = string | typeof wildcardScope;
type IndexedPolicy<Ctx> = { readonly order: number; readonly policy: Policy<Ctx> };
type IndexedHook<Ctx> = { readonly order: number; readonly hook: DecisionHook<Ctx> };
type RuleBucket<Ctx> = {
  readonly denies: IndexedPolicy<Ctx>[];
  readonly allows: IndexedPolicy<Ctx>[];
  readonly afterDecision: IndexedHook<Ctx>[];
};
type RuleIndex<Ctx> = Map<ScopeKey, Map<ScopeKey, Map<ScopeKey, RuleBucket<Ctx>>>>;
type RuleSelection<Ctx> = {
  readonly policies: {
    readonly all: readonly Policy<Ctx>[];
    readonly denies: readonly Policy<Ctx>[];
    readonly allows: readonly Policy<Ctx>[];
  };
  readonly afterDecision: readonly DecisionHook<Ctx>[];
};

/** Configuration for `createAuthor`. */
export type CreateAuthorInput<
  Entities,
  Resources,
  CustomContext extends Record<string, unknown>,
  Modules extends readonly AnyAuthorModule[] = readonly AnyAuthorModule[],
> = {
  entities: Entities;
  /** Root resource definitions. Prefer modules for larger applications. */
  resources?: Resources;
  context?: ContextDefinition<CustomContext>;
  /** Global policies that apply across modules. */
  policies?: readonly AuthorRule<CombinedPolicyContext<Entities, Resources, Modules, CustomContext>>[];
  /** Domain modules merged into this author instance. */
  modules?: Modules;
  store?: AuthorStore;
  mode?: Mode;
  /** Controls audit writes. `all` logs checks and explanations; `explain` logs only full decisions; `none` disables audit writes. */
  audit?: AuditMode;
  /** Optional decision cache. Include resource/context data in cache keys to avoid cross-request collisions. */
  cache?: AuthorCache;
  /** TTL for cached decisions. Defaults to 30 seconds when `cache` is provided. */
  cacheTtlMs?: number;
  /** Optional cache key resolver. Use this when the default stable SHA-256 decision key is too expensive. */
  cacheKey?: (input: CacheKeyInput) => string | Promise<string>;
  /** Optional plan, feature, and limit configuration exposed in policy context. */
  entitlements?: EntitlementsConfig<
    EntityValue<Entities>,
    ResourceValue<CombinedResources<Resources, Modules>, keyof CombinedResources<Resources, Modules>>,
    CustomContext
  >;
};

type EvaluateInput<CustomContext extends Record<string, unknown>> = {
  entityType: string;
  entity: unknown;
  action: string;
  resourceType: string;
  resource: unknown;
  context: CustomContext;
  mode: Mode;
};
type CacheVariant = "check" | "explain";

/** Author surface that can produce a decision. `decide` is the short-circuit path. */
export type AuthorizationRunner<Input = EvaluateInput<Record<string, unknown>>> = {
  evaluate(input: Input): Promise<Decision>;
  decide?(input: Input): Promise<Decision>;
};

/** Runs `decide` when the author implements it, otherwise the exhaustive `evaluate` path. */
export function runDecision<Input>(author: AuthorizationRunner<Input>, input: Input): Promise<Decision> {
  if (author.decide) return author.decide(input);
  return author.evaluate(input);
}

/** Fluent result returned by `.on(...)`. Await it for a boolean or call explicit methods. */
export type ResourceDecisionBuilder = PromiseLike<boolean> & {
  allowed(): Promise<boolean>;
  denied(): Promise<boolean>;
  explain(): Promise<Decision>;
  throw(): Promise<void>;
};

/** Authorization engine instance created by `createAuthor`. */
export type AuthorInstance<Entities, Resources, CustomContext extends Record<string, unknown>> = {
  as<Type extends keyof Entities & string>(
    entityType: Type,
    entity: SubjectValue<Entities, Type>,
  ): {
    can<Action extends ResourceAction<Resources>>(action: Action): { on: ResourceOn<Resources, CustomContext> };
    cannot<Action extends ResourceAction<Resources>>(action: Action): { on: ResourceOn<Resources, CustomContext> };
  };
  check(input: EvaluateInput<CustomContext>): Promise<boolean>;
  /** Short-circuit decision used by enforcement. Stops at the first matching deny or allow. */
  decide(input: EvaluateInput<CustomContext>): Promise<Decision>;
  evaluate(input: EvaluateInput<CustomContext>): Promise<Decision>;
  readonly store: AuthorStore;
  readonly cache: AuthorCache | undefined;
  readonly roles: {
    list(input: GetRolesInput): Promise<RoleGrant[]>;
    grant(input: RoleGrantInput): Promise<void>;
    revoke(input: RevokeRoleInput): Promise<void>;
  };
  readonly permissions: {
    list(input: GetPermissionsInput): Promise<PermissionGrant[]>;
    grant(input: PermissionGrantInput): Promise<void>;
    revoke(input: RevokePermissionInput): Promise<void>;
  };
  readonly relations: {
    list(input: GetRelationsInput): Promise<RelationTuple[]>;
    create(input: RelationTupleInput): Promise<void>;
    delete(input: DeleteRelationInput): Promise<void>;
  };
  invalidate(input?: { key?: string }): Promise<void>;
};

/**
 * Creates one authorization engine from entity definitions, optional root resources, domain modules, policies, and adapters.
 *
 * @example
 * const allowed = await author.as(user).can("update").on("Project", project).allowed();
 */
export function createAuthor<
  const Entities extends EntityMap,
  const Resources extends ResourceMap = EmptyResourceMap,
  const Modules extends readonly AnyAuthorModule[] = [],
  CustomContext extends Record<string, unknown> = Record<string, unknown>,
>(
  input: CreateAuthorInput<Entities, Resources, CustomContext, Modules>,
): AuthorInstance<Entities, CombinedResources<Resources, Modules>, CustomContext> {
  type RuntimeResources = CombinedResources<Resources, Modules>;
  const store = input.store ?? memoryStore();
  const mode = input.mode ?? "backend";
  const auditMode = input.audit ?? "all";
  const cacheTtlMs = input.cacheTtlMs ?? 30_000;
  const resources = mergeResources(input.resources, input.modules);
  const rules = mergeRules(input.policies, input.modules);
  const resourceActionSets = buildResourceActionSets(resources);
  const ruleIndex = buildRuleIndex(rules);
  const selectionCache = new Map<
    string,
    RuleSelection<CombinedPolicyContext<Entities, Resources, Modules, CustomContext>>
  >();

  function prepareEvaluation(request: EvaluateInput<CustomContext>) {
    const startedAt = performance.now();
    const entityDefinition = input.entities[request.entityType];
    if (!entityDefinition) throw new UnknownEntityTypeError(request.entityType);

    const resourceDefinition = resources[request.resourceType];
    if (!resourceDefinition) throw new UnknownResourceTypeError(request.resourceType);
    if (!resourceActionSets.get(request.resourceType)?.has(request.action))
      throw new UnknownActionError(request.action, request.resourceType);

    return {
      startedAt,
      resourceDefinition,
      entityId: entityDefinition.id(request.entity),
      resourceId: resourceDefinition.id(request.resource),
      selection: selectRules(ruleIndex, request.entityType, request.resourceType, request.action, selectionCache),
    };
  }

  async function cacheKeyFor(
    request: EvaluateInput<CustomContext>,
    entityId: string,
    resourceId: string,
    variant: CacheVariant,
  ): Promise<string | null> {
    if (!input.cache) return null;

    const cacheInput = {
      entityType: request.entityType,
      entityId,
      action: request.action,
      resourceType: request.resourceType,
      resourceId,
      mode: request.mode,
      context: request.context,
      resource: request.resource,
    } satisfies CacheKeyInput;

    const base = input.cacheKey ? await input.cacheKey(cacheInput) : decisionCacheKey(cacheInput);
    return `${variant}:${base}`;
  }

  function createContext(
    request: EvaluateInput<CustomContext>,
    prepared: ReturnType<typeof prepareEvaluation>,
  ): PolicyContext<EntityMap, ResourceMap, CustomContext> {
    return buildContext({
      entity: request.entity,
      action: request.action,
      resourceType: request.resourceType,
      resourceId: prepared.resourceId,
      resource: request.resource,
      context: request.context,
      mode: request.mode,
      store,
      entityType: request.entityType,
      entityId: prepared.entityId,
      resourceDefinition: prepared.resourceDefinition,
      entitlements: input.entitlements,
    });
  }

  async function readCachedDecision(
    request: EvaluateInput<CustomContext>,
    prepared: ReturnType<typeof prepareEvaluation>,
    cacheKey: string | null,
  ): Promise<Decision | null> {
    if (!cacheKey) return null;
    const cached = await input.cache?.get(cacheKey);
    if (!cached) return null;
    if (prepared.selection.afterDecision.length > 0) {
      await runAfterDecisionHooks(prepared.selection.afterDecision, createContext(request, prepared), cached);
    }
    return cached;
  }

  async function evaluateFull(request: EvaluateInput<CustomContext>): Promise<Decision> {
    const prepared = prepareEvaluation(request);
    const cacheKey = await cacheKeyFor(request, prepared.entityId, prepared.resourceId, "explain");
    const cached = await readCachedDecision(request, prepared, cacheKey);
    if (cached) return cached;

    const ctx = createContext(request, prepared);
    const matchedAllows: Decision["matchedPolicies"] = [];
    const matchedDenies: Decision["matchedPolicies"] = [];
    const skippedPolicies: Decision["skippedPolicies"] = [];

    for (const policy of prepared.selection.policies.all) {
      const raw = policy.check(ctx);
      const resolved = raw === true || raw === false || !isThenable(raw) ? raw : await raw;
      if (resolved === false) {
        skippedPolicies.push({ name: policy.name });
        continue;
      }
      if (resolved === true) {
        const match = { name: policy.name, effect: policy.effect, reason: policy.name };
        if (policy.effect === "deny") matchedDenies.push(match);
        else matchedAllows.push(match);
        continue;
      }
      const result = normalizePolicyResult(policy, resolved);
      if (result.effect === "skip") {
        skippedPolicies.push(
          result.reason === undefined ? { name: policy.name } : { name: policy.name, reason: result.reason },
        );
      } else if (result.effect === "deny") {
        matchedDenies.push({ name: policy.name, effect: "deny", reason: result.reason });
      } else {
        matchedAllows.push({ name: policy.name, effect: "allow", reason: result.reason });
      }
    }

    const decision = makeDecision({
      action: request.action,
      entityType: request.entityType,
      entityId: prepared.entityId,
      resourceType: request.resourceType,
      resourceId: prepared.resourceId,
      matchedDenies,
      matchedAllows,
      skippedPolicies,
      mode: request.mode,
      durationMs: performance.now() - prepared.startedAt,
    });

    if (cacheKey) await input.cache?.set(cacheKey, decision, cacheTtlMs);
    await finishDecision({
      store,
      auditMode,
      operation: "evaluate",
      hooks: prepared.selection.afterDecision,
      ctx,
      decision,
    });
    return decision;
  }

  async function decideUncached(
    request: EvaluateInput<CustomContext>,
    prepared: ReturnType<typeof prepareEvaluation>,
  ): Promise<Decision> {
    const ctx = createContext(request, prepared);
    const deny = await firstMatchingPolicy(prepared.selection.policies.denies, ctx);
    const allow = deny ? null : await firstMatchingPolicy(prepared.selection.policies.allows, ctx);
    const decision = makeDecision({
      action: request.action,
      entityType: request.entityType,
      entityId: prepared.entityId,
      resourceType: request.resourceType,
      resourceId: prepared.resourceId,
      matchedDenies: deny ? [deny] : [],
      matchedAllows: allow ? [allow] : [],
      skippedPolicies: [],
      mode: request.mode,
      durationMs: performance.now() - prepared.startedAt,
    });
    await finishDecision({
      store,
      auditMode,
      operation: "check",
      hooks: prepared.selection.afterDecision,
      ctx,
      decision,
    });
    return decision;
  }

  async function decide(request: EvaluateInput<CustomContext>): Promise<Decision> {
    const prepared = prepareEvaluation(request);
    const cacheKey = await cacheKeyFor(request, prepared.entityId, prepared.resourceId, "check");
    const cached = await readCachedDecision(request, prepared, cacheKey);
    if (cached) return cached;

    const decision = await decideUncached(request, prepared);
    if (cacheKey) await input.cache?.set(cacheKey, decision, cacheTtlMs);
    return decision;
  }

  async function evaluate(request: EvaluateInput<CustomContext>): Promise<Decision> {
    return evaluateFull(request);
  }

  async function evaluateAllowed(request: EvaluateInput<CustomContext>): Promise<boolean> {
    return (await decide(request)).allowed;
  }

  return {
    store,
    cache: input.cache,
    roles: {
      list: (query) => store.getRoles(query),
      grant: async (role) => {
        await store.grantRole(role);
        await invalidateCache(input.cache);
      },
      revoke: async (role) => {
        await store.revokeRole(role);
        await invalidateCache(input.cache);
      },
    },
    permissions: {
      list: (query) => store.getPermissions(query),
      grant: async (permission) => {
        await store.grantPermission(permission);
        await invalidateCache(input.cache);
      },
      revoke: async (permission) => {
        await store.revokePermission(permission);
        await invalidateCache(input.cache);
      },
    },
    relations: {
      list: (query) => store.getRelations(query),
      create: async (relation) => {
        await store.createRelation(relation);
        await invalidateCache(input.cache);
      },
      delete: async (relation) => {
        await store.deleteRelation(relation);
        await invalidateCache(input.cache);
      },
    },
    async invalidate(request) {
      if (!input.cache) return;
      if (request?.key) await input.cache.delete(request.key);
      else await input.cache.clear?.();
    },
    evaluate,
    decide,
    check: evaluateAllowed,
    as(entityType, entity) {
      const chain = (negated: boolean) => (action: ResourceAction<RuntimeResources>) => ({
        on: ((
          first: string | TypedResource<RuntimeResources, keyof RuntimeResources & string>,
          second?: ResourceValue<RuntimeResources, keyof RuntimeResources> | CustomContext,
          third?: CustomContext,
        ) => {
          const parsed = parseResourceInput(first, second, third);
          const request = {
            entityType,
            entity,
            action,
            resourceType: parsed.resourceType,
            resource: parsed.resource,
            context: parsed.context,
            mode,
          };
          const explain = async () => {
            const decision = await evaluate(request);
            return negated ? invertDecision(decision) : decision;
          };
          const allowed = async () => {
            const result = await evaluateAllowed(request);
            return negated ? !result : result;
          };
          const enforce = async () => {
            const decision = await decide(request);
            const result = negated ? invertDecision(decision) : decision;
            if (!result.allowed) throw new AuthorizationDeniedError(result);
          };
          return decisionBuilder({ allowed, explain, enforce });
        }) as ResourceOn<RuntimeResources, CustomContext>,
      });
      return { can: chain(false), cannot: chain(true) };
    },
  };
}

async function invalidateCache(cache: AuthorCache | undefined): Promise<void> {
  await cache?.clear?.();
}

function emptyContext<CustomContext extends Record<string, unknown>>(): CustomContext {
  return {} as CustomContext;
}

function decisionBuilder(input: {
  allowed: () => Promise<boolean>;
  explain: () => Promise<Decision>;
  enforce: () => Promise<void>;
}): ResourceDecisionBuilder {
  return {
    then: (onFulfilled, onRejected) => input.allowed().then(onFulfilled, onRejected),
    allowed: input.allowed,
    denied: async () => !(await input.allowed()),
    explain: input.explain,
    throw: input.enforce,
  };
}

function parseResourceInput<Resources, CustomContext extends Record<string, unknown>>(
  first: string | TypedResource<Resources, keyof Resources & string>,
  second: ResourceValue<Resources, keyof Resources> | CustomContext | undefined,
  third: CustomContext | undefined,
): { resourceType: string; resource: unknown; context: CustomContext } {
  if (typeof first === "string") {
    return { resourceType: first, resource: second, context: third ?? emptyContext<CustomContext>() };
  }
  return {
    resourceType: first.authorType,
    resource: first,
    context: isContext(second) ? second : emptyContext<CustomContext>(),
  };
}

function isContext<CustomContext extends Record<string, unknown>>(value: unknown): value is CustomContext {
  return typeof value === "object" && value !== null && !("authorType" in value);
}

function makeDecision(input: {
  action: string;
  entityType: string;
  entityId: string;
  resourceType: string;
  resourceId: string;
  matchedDenies: Decision["matchedPolicies"];
  matchedAllows: Decision["matchedPolicies"];
  skippedPolicies: Decision["skippedPolicies"];
  mode: Mode;
  durationMs: number;
}): Decision {
  const deny = input.matchedDenies[0];
  const allow = input.matchedAllows[0];
  const effect: PolicyEffect = deny ? "deny" : allow ? "allow" : "deny";
  return {
    allowed: effect === "allow",
    effect,
    reason: deny?.reason ?? allow?.reason ?? "No matching allow policy",
    action: input.action,
    entity: { type: input.entityType, id: input.entityId },
    resource: { type: input.resourceType, id: input.resourceId },
    matchedPolicies: [...input.matchedDenies, ...input.matchedAllows],
    skippedPolicies: input.skippedPolicies,
    metadata: { evaluatedAt: new Date(), mode: input.mode, durationMs: input.durationMs },
  };
}

function invertDecision(decision: Decision): Decision {
  return {
    ...decision,
    allowed: !decision.allowed,
    effect: decision.allowed ? "deny" : "allow",
    reason: decision.allowed ? `Cannot check failed: ${decision.reason}` : `Cannot check passed: ${decision.reason}`,
  };
}

function buildContext<CustomContext extends Record<string, unknown>>(input: {
  entity: unknown;
  entityType: string;
  entityId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  resource: unknown;
  context: CustomContext;
  mode: Mode;
  store: AuthorStore;
  resourceDefinition: ResourceDefinition<unknown, string, readonly string[]>;
  entitlements: EntitlementsConfig<unknown, unknown, CustomContext> | undefined;
}): PolicyContext<EntityMap, ResourceMap, CustomContext> {
  let memoizedStore: AuthorStore | undefined;
  const store = () => (memoizedStore ??= memoizeStoreReads(input.store));
  let parentsValue: ParentResolver | undefined;
  let planLoader: (() => string | null | Promise<string | null>) | undefined;
  const loadPlan = () => {
    planLoader ??= once(() => resolvePlan(input.entitlements, entitlementContext(input)));
    return planLoader();
  };
  let featureLoader: (() => readonly string[] | Promise<readonly string[]>) | undefined;
  const loadFeatures = () => {
    featureLoader ??= once(() => {
      const plan = loadPlan();
      if (isThenable(plan)) return plan.then((name) => cachedFeatures(input.entitlements, name).list);
      return cachedFeatures(input.entitlements, plan).list;
    });
    return featureLoader();
  };
  let limitCache: Map<string, number | null | Promise<number | null>> | undefined;
  const getLimitByName = (name: string) => {
    limitCache ??= new Map();
    return memoizeValue(limitCache, name, () => {
      const plan = loadPlan();
      if (isThenable(plan)) return plan.then((resolved) => limitForPlan(input.entitlements, resolved, name));
      return limitForPlan(input.entitlements, plan, name);
    });
  };
  let rolesValue: PolicyContext<EntityMap, ResourceMap, CustomContext>["roles"] | undefined;
  let permissionsValue: PolicyContext<EntityMap, ResourceMap, CustomContext>["permissions"] | undefined;
  let relationsValue: PolicyContext<EntityMap, ResourceMap, CustomContext>["relations"] | undefined;
  let subscriptionValue: PolicyContext<EntityMap, ResourceMap, CustomContext>["subscription"] | undefined;
  let featuresValue: PolicyContext<EntityMap, ResourceMap, CustomContext>["features"] | undefined;
  let limitsValue: PolicyContext<EntityMap, ResourceMap, CustomContext>["limits"] | undefined;

  return {
    subject: { type: input.entityType, id: input.entityId, data: input.entity },
    entity: input.entity,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    resource: { type: input.resourceType, id: input.resourceId, data: input.resource },
    context: input.context,
    mode: input.mode,
    get store() {
      return store();
    },
    get parents() {
      parentsValue ??= createParentResolver({
        definition: input.resourceDefinition,
        resource: input.resource,
        store: store(),
        entityType: input.entityType,
        entityId: input.entityId,
      });
      return parentsValue;
    },
    get subscription() {
      subscriptionValue ??= { plan: loadPlan };
      return subscriptionValue;
    },
    get features() {
      featuresValue ??= {
        has: (feature) => {
          const plan = loadPlan();
          if (isThenable(plan)) return plan.then((name) => cachedFeatures(input.entitlements, name).flags.has(feature));
          return cachedFeatures(input.entitlements, plan).flags.has(feature);
        },
        list: loadFeatures,
      };
      return featuresValue;
    },
    get limits() {
      limitsValue ??= {
        get: getLimitByName,
        within: (name, value) => {
          const limit = getLimitByName(name);
          if (isThenable(limit)) return limit.then((resolved) => resolved === null || value.used < resolved);
          return limit === null || value.used < limit;
        },
        remaining: (name, value) => {
          const limit = getLimitByName(name);
          if (isThenable(limit))
            return limit.then((resolved) => (resolved === null ? null : Math.max(0, resolved - value.used)));
          return limit === null ? null : Math.max(0, limit - value.used);
        },
      };
      return limitsValue;
    },
    get relations() {
      relationsValue ??= {
        has: (query) => {
          const reads = store();
          if (reads.hasRelation) return reads.hasRelation(query);
          return reads.getRelations(query).then((relations) => relations.length > 0);
        },
        list: (query) => store().getRelations(query),
      };
      return relationsValue;
    },
    entityHasRelation: (relation) => {
      const query = {
        subjectType: input.entityType,
        subjectId: input.entityId,
        relation,
        objectType: input.resourceType,
        objectId: input.resourceId,
      };
      const reads = store();
      if (reads.hasRelation) return reads.hasRelation(query);
      return reads.getRelations(query).then((relations) => relations.length > 0);
    },
    get roles() {
      rolesValue ??= {
        has: (role, scope) => {
          const query = roleQuery(input.entityType, input.entityId, scope);
          const reads = store();
          if (reads.hasRole) return reads.hasRole({ ...query, role });
          return reads.getRoles(query).then((roles) => roles.some((grant) => grant.role === role));
        },
        list: (scope) => store().getRoles(roleQuery(input.entityType, input.entityId, scope)),
      };
      return rolesValue;
    },
    get permissions() {
      permissionsValue ??= {
        has: (action, resource) => {
          const query = permissionQuery(input.entityType, input.entityId, resource);
          const reads = store();
          if (reads.hasPermission) return reads.hasPermission({ ...query, action });
          return reads.getPermissions(query).then((permissions) => {
            const deny = permissions.some((grant) => grant.action === action && grant.effect === "deny");
            const allow = permissions.some((grant) => grant.action === action && grant.effect === "allow");
            return !deny && allow;
          });
        },
        list: (resource) => store().getPermissions(permissionQuery(input.entityType, input.entityId, resource)),
      };
      return permissionsValue;
    },
  };
}

function entitlementContext<CustomContext extends Record<string, unknown>>(input: {
  entity: unknown;
  action: string;
  resourceType: string;
  resourceId: string;
  resource: unknown;
  context: CustomContext;
  mode: Mode;
}): EntitlementContext<unknown, unknown, CustomContext> {
  return {
    entity: input.entity,
    action: input.action,
    resource: { type: input.resourceType, id: input.resourceId, data: input.resource },
    context: input.context,
    mode: input.mode,
  };
}

function resolvePlan<CustomContext extends Record<string, unknown>>(
  entitlements: EntitlementsConfig<unknown, unknown, CustomContext> | undefined,
  ctx: EntitlementContext<unknown, unknown, CustomContext>,
): string | null | Promise<string | null> {
  if (!entitlements) return null;
  return typeof entitlements.plan === "function" ? entitlements.plan(ctx) : entitlements.plan;
}

function roleQuery(entityType: string, entityId: string, scope: ScopeInput | undefined): GetRolesInput {
  return scope ? { entityType, entityId, scopeType: scope.type, scopeId: scope.id } : { entityType, entityId };
}

function permissionQuery(
  entityType: string,
  entityId: string,
  resource: ResourceInput | undefined,
): GetPermissionsInput {
  if (!resource) return { entityType, entityId };
  return resource.id === undefined
    ? { entityType, entityId, resourceType: resource.type }
    : { entityType, entityId, resourceType: resource.type, resourceId: resource.id };
}

function createParentResolver(input: {
  definition: ResourceDefinition<unknown, string, readonly string[]>;
  resource: unknown;
  store: AuthorStore;
  entityType: string;
  entityId: string;
}): ParentResolver {
  const parents = input.definition.parents ?? {};
  const resolve = (name: string): ParentRef | null => {
    const parent = parents[name];
    return parent ? { type: parent.type, id: parent.id(input.resource) } : null;
  };
  const required = (name: string): ParentRef => {
    const parent = resolve(name);
    if (!parent) throw new MissingParentResourceError(name);
    return parent;
  };
  return {
    get(name) {
      return resolve(name);
    },
    getRequired(name) {
      return required(name);
    },
    list() {
      return Object.entries(parents).map(([name, parent]) => ({
        name,
        type: parent.type,
        id: parent.id(input.resource),
      }));
    },
    hasRole(role, parentName) {
      const parent = required(parentName);
      const query = roleQuery(input.entityType, input.entityId, parent);
      if (input.store.hasRole) return input.store.hasRole({ ...query, role });
      return input.store.getRoles(query).then((roles) => roles.some((grant) => grant.role === role));
    },
    hasPermission(action, parentName) {
      const parent = required(parentName);
      const query = permissionQuery(input.entityType, input.entityId, parent);
      if (input.store.hasPermission) return input.store.hasPermission({ ...query, action });
      return input.store
        .getPermissions(query)
        .then(
          (permissions) =>
            !permissions.some((grant) => grant.action === action && grant.effect === "deny") &&
            permissions.some((grant) => grant.action === action && grant.effect === "allow"),
        );
    },
    hasRelation(relation, parentName) {
      const parent = required(parentName);
      const query = {
        subjectType: input.entityType,
        subjectId: input.entityId,
        relation,
        objectType: parent.type,
        objectId: parent.id,
      };
      if (input.store.hasRelation) return input.store.hasRelation(query);
      return input.store.getRelations(query).then((relations) => relations.length > 0);
    },
  };
}

function buildResourceActionSets(resources: ResourceMap): ReadonlyMap<string, ReadonlySet<string>> {
  const actionSets = new Map<string, ReadonlySet<string>>();
  for (const [resourceType, resource] of Object.entries(resources)) {
    actionSets.set(resourceType, new Set(resource.actions));
  }
  return actionSets;
}

function mergeResources(
  rootResources: ResourceMap | undefined,
  modules: readonly AnyAuthorModule[] | undefined,
): ResourceMap {
  const resources: ResourceMap = {};
  const sources = new Map<string, string>();
  addResources(resources, sources, "root", rootResources);

  for (const [index, module] of (modules ?? []).entries()) {
    addResources(resources, sources, module.name ?? `module:${index}`, module.resources);
  }

  return resources;
}

function addResources(
  target: ResourceMap,
  sources: Map<string, string>,
  source: string,
  resources: ResourceMap | undefined,
): void {
  if (!resources) return;

  for (const [resourceType, resource] of Object.entries(resources)) {
    const existingSource = sources.get(resourceType);
    if (existingSource) throw new DuplicateResourceTypeError(resourceType, [existingSource, source]);

    target[resourceType] = resource;
    sources.set(resourceType, source);
  }
}

function mergeRules(
  rootRules: readonly AuthorRule<unknown>[] | undefined,
  modules: readonly AnyAuthorModule[] | undefined,
): readonly AuthorRule<unknown>[] {
  return [...(rootRules ?? []), ...(modules ?? []).flatMap((module) => module.policies)];
}

function buildRuleIndex<Ctx>(rules: readonly AuthorRule<Ctx>[]): RuleIndex<Ctx> {
  const index: RuleIndex<Ctx> = new Map();
  for (const [order, rule] of rules.entries()) {
    addRuleToIndex(index, rule, order);
  }
  return index;
}

function addRuleToIndex<Ctx>(index: RuleIndex<Ctx>, rule: AuthorRule<Ctx>, order: number): void {
  for (const entityType of scopeKeys(rule.scope?.entityTypes)) {
    for (const resourceType of scopeKeys(rule.scope?.resourceTypes)) {
      for (const action of scopeKeys(rule.scope?.actions)) {
        const bucket = bucketFor(index, entityType, resourceType, action);
        if (rule.phase === "decision") {
          if (rule.effect === "deny") bucket.denies.push({ order, policy: rule });
          else bucket.allows.push({ order, policy: rule });
        } else bucket.afterDecision.push({ order, hook: rule });
      }
    }
  }
}

function selectRules<Ctx>(
  index: RuleIndex<Ctx>,
  entityType: string,
  resourceType: string,
  action: string,
  cache: Map<string, RuleSelection<Ctx>>,
): RuleSelection<Ctx> {
  const cacheKey = `${entityType.length}:${entityType}\0${resourceType.length}:${resourceType}\0${action.length}:${action}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const indexedDenies: IndexedPolicy<Ctx>[] = [];
  const indexedAllows: IndexedPolicy<Ctx>[] = [];
  const indexedHooks: IndexedHook<Ctx>[] = [];

  for (const entityKey of requestScopeKeys(entityType)) {
    const resources = index.get(entityKey);
    if (!resources) continue;
    for (const resourceKey of requestScopeKeys(resourceType)) {
      const actions = resources.get(resourceKey);
      if (!actions) continue;
      for (const actionKey of requestScopeKeys(action)) {
        const bucket = actions.get(actionKey);
        if (!bucket) continue;
        indexedDenies.push(...bucket.denies);
        indexedAllows.push(...bucket.allows);
        indexedHooks.push(...bucket.afterDecision);
      }
    }
  }

  const all = uniqueSortedPolicies([...indexedDenies, ...indexedAllows]);
  const selection = {
    policies: {
      all,
      denies: all.filter((policy) => policy.effect === "deny"),
      allows: all.filter((policy) => policy.effect === "allow"),
    },
    afterDecision: uniqueSortedHooks(indexedHooks),
  };
  cache.set(cacheKey, selection);
  return selection;
}

function bucketFor<Ctx>(
  index: RuleIndex<Ctx>,
  entityType: ScopeKey,
  resourceType: ScopeKey,
  action: ScopeKey,
): RuleBucket<Ctx> {
  const resources = getOrCreate(index, entityType, () => new Map<ScopeKey, Map<ScopeKey, RuleBucket<Ctx>>>());
  const actions = getOrCreate(resources, resourceType, () => new Map<ScopeKey, RuleBucket<Ctx>>());
  return getOrCreate(actions, action, () => ({ denies: [], allows: [], afterDecision: [] }));
}

function getOrCreate<Key, Value>(map: Map<Key, Value>, key: Key, create: () => Value): Value {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const value = create();
  map.set(key, value);
  return value;
}

function scopeKeys(scopedValues: readonly string[] | undefined): readonly ScopeKey[] {
  return scopedValues === undefined ? [wildcardScope] : scopedValues;
}

function requestScopeKeys(value: string): readonly ScopeKey[] {
  return [value, wildcardScope];
}

async function firstMatchingPolicy<Ctx>(
  policies: readonly Policy<Ctx>[],
  ctx: Ctx,
): Promise<Decision["matchedPolicies"][number] | null> {
  for (const policy of policies) {
    const raw = policy.check(ctx);
    if (raw === false) continue;
    if (raw === true) return { name: policy.name, effect: policy.effect, reason: policy.name };
    const resolved = isThenable(raw) ? await raw : raw;
    if (resolved === false) continue;
    if (resolved === true) return { name: policy.name, effect: policy.effect, reason: policy.name };
    const result = normalizePolicyResult(policy, resolved);
    if (result.effect === "skip") continue;
    return { name: policy.name, effect: result.effect, reason: result.reason };
  }
  return null;
}

function isThenable<Value>(value: Value | PromiseLike<Value>): value is PromiseLike<Value> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function uniqueSortedPolicies<Ctx>(indexedPolicies: readonly IndexedPolicy<Ctx>[]): readonly Policy<Ctx>[] {
  const seen = new Set<number>();
  const unique: IndexedPolicy<Ctx>[] = [];
  for (const indexedPolicy of indexedPolicies) {
    if (seen.has(indexedPolicy.order)) continue;
    seen.add(indexedPolicy.order);
    unique.push(indexedPolicy);
  }
  unique.sort((left, right) => left.order - right.order);
  return unique.map((indexedPolicy) => indexedPolicy.policy);
}

function uniqueSortedHooks<Ctx>(indexedHooks: readonly IndexedHook<Ctx>[]): readonly DecisionHook<Ctx>[] {
  const seen = new Set<number>();
  const unique: IndexedHook<Ctx>[] = [];
  for (const indexedHook of indexedHooks) {
    if (seen.has(indexedHook.order)) continue;
    seen.add(indexedHook.order);
    unique.push(indexedHook);
  }
  unique.sort((left, right) => left.order - right.order);
  return unique.map((indexedHook) => indexedHook.hook);
}

async function writeDecisionAuditLog(store: AuthorStore, decision: Decision): Promise<void> {
  await store.writeAuditLog?.({
    id: crypto.randomUUID(),
    entityType: decision.entity.type,
    entityId: decision.entity.id,
    action: decision.action,
    resourceType: decision.resource.type,
    resourceId: decision.resource.id,
    allowed: decision.allowed,
    reason: decision.reason,
    matchedPolicies: decision.matchedPolicies.map((policy) => policy.name),
    createdAt: new Date(),
  });
}

async function finishDecision(input: {
  store: AuthorStore;
  auditMode: AuditMode;
  operation: EvaluationOperation;
  hooks: readonly DecisionHook<unknown>[];
  ctx: unknown;
  decision: Decision;
}): Promise<void> {
  if (shouldAudit(input.auditMode, input.operation)) {
    const audit = writeDecisionAuditLog(input.store, input.decision);
    if (input.operation === "check") void audit.catch(() => undefined);
    else await audit;
  }
  if (input.hooks.length > 0) await runAfterDecisionHooks(input.hooks, input.ctx, input.decision);
}

function shouldAudit(auditMode: AuditMode, operation: EvaluationOperation): boolean {
  return auditMode === "all" || (auditMode === "explain" && operation === "evaluate");
}

async function runAfterDecisionHooks<Ctx>(
  hooks: readonly DecisionHook<Ctx>[],
  ctx: Ctx,
  decision: Decision,
): Promise<void> {
  for (const hook of hooks) {
    await hook.run(ctx, decision);
  }
}

function memoizeStoreReads(store: AuthorStore): AuthorStore {
  const roles = new Map<string, Promise<RoleGrant[]>>();
  const roleChecks = new Map<string, boolean | Promise<boolean>>();
  const permissions = new Map<string, Promise<PermissionGrant[]>>();
  const permissionChecks = new Map<string, boolean | Promise<boolean>>();
  const relations = new Map<string, Promise<RelationTuple[]>>();
  const relationChecks = new Map<string, boolean | Promise<boolean>>();
  const reads: AuthorStore = {
    getRoles: (input: GetRolesInput) => memoizeValue(roles, queryKey(roleFields, input), () => store.getRoles(input)),
    getPermissions: (input: GetPermissionsInput) =>
      memoizeValue(permissions, queryKey(permissionFields, input), () => store.getPermissions(input)),
    getRelations: (input: GetRelationsInput) =>
      memoizeValue(relations, queryKey(relationFields, input), () => store.getRelations(input)),
    grantRole: (input: RoleGrantInput) => store.grantRole(input),
    revokeRole: (input: RevokeRoleInput) => store.revokeRole(input),
    grantPermission: (input: PermissionGrantInput) => store.grantPermission(input),
    revokePermission: (input: RevokePermissionInput) => store.revokePermission(input),
    createRelation: (input: RelationTupleInput) => store.createRelation(input),
    deleteRelation: (input: DeleteRelationInput) => store.deleteRelation(input),
  };

  const hasRole = store.hasRole?.bind(store);
  if (hasRole) {
    reads.hasRole = (input: HasRoleInput) =>
      memoizeValue(roleChecks, queryKey(roleFields, input), () => hasRole(input));
  }

  const hasPermission = store.hasPermission?.bind(store);
  if (hasPermission) {
    reads.hasPermission = (input: HasPermissionInput) =>
      memoizeValue(permissionChecks, queryKey(permissionFields, input), () => hasPermission(input));
  }

  const hasRelation = store.hasRelation?.bind(store);
  if (hasRelation) {
    reads.hasRelation = (input: HasRelationInput) =>
      memoizeValue(relationChecks, queryKey(relationFields, input), () => hasRelation(input));
  }

  const writeAuditLog = store.writeAuditLog?.bind(store);
  if (writeAuditLog) reads.writeAuditLog = (entry) => writeAuditLog(entry);
  return reads;
}

function memoizeValue<Value>(cache: Map<string, Value>, key: string, create: () => Value): Value {
  if (cache.has(key)) return cache.get(key) as Value;
  const value = create();
  cache.set(key, value);
  return value;
}

function once<Value>(load: () => Value): () => Value {
  let loaded = false;
  let value: Value | undefined;
  return () => {
    if (!loaded) {
      value = load();
      loaded = true;
    }
    return value as Value;
  };
}

const roleFields = ["entityType", "entityId", "role", "scopeType", "scopeId"] as const;
const permissionFields = ["entityType", "entityId", "action", "resourceType", "resourceId"] as const;
const relationFields = ["subjectType", "subjectId", "relation", "objectType", "objectId"] as const;

function queryKey(fields: readonly string[], input: object): string {
  const record = input as Record<string, unknown>;
  let key = "";
  for (const field of fields) {
    const value = record[field];
    const text = value === undefined ? "" : String(value);
    key += `${text.length}:${text}|`;
  }
  return key;
}

const emptyFeatureList: readonly string[] = [];
const emptyFeatureFlags: ReadonlySet<string> = new Set();
const emptyFeatures = { list: emptyFeatureList, flags: emptyFeatureFlags };
const featureCache = new WeakMap<object, Map<string, { list: readonly string[]; flags: ReadonlySet<string> }>>();

function cachedFeatures(
  entitlements: EntitlementsConfig<unknown, unknown, Record<string, unknown>> | undefined,
  plan: string | null,
): { list: readonly string[]; flags: ReadonlySet<string> } {
  if (!plan || !entitlements) return emptyFeatures;
  let plans = featureCache.get(entitlements);
  if (!plans) {
    plans = new Map();
    featureCache.set(entitlements, plans);
  }
  const hit = plans.get(plan);
  if (hit) return hit;
  const list = [...(entitlements.features?.[plan] ?? [])];
  const value = { list, flags: new Set(list) };
  plans.set(plan, value);
  return value;
}

function limitForPlan<CustomContext extends Record<string, unknown>>(
  entitlements: EntitlementsConfig<unknown, unknown, CustomContext> | undefined,
  plan: string | null,
  name: string,
): number | null {
  if (!plan) return null;
  return entitlements?.limits?.[plan]?.[name] ?? null;
}
