import type {
  AuthorStore,
  Decision,
  Mode,
  ParentResolver,
  PermissionGrant,
  PolicyEffect,
  RelationTuple,
  ResourceInput,
  RoleGrant,
  ScopeInput,
} from "./types.js";

/** Result returned by a policy checker after normalization. */
export type PolicyResult =
  | { effect: "allow"; reason: string }
  | { effect: "deny"; reason: string }
  | { effect: "skip"; reason?: string };

/** Query shape for listing or testing relationship tuples. Omitted fields act as wildcards. */
export type RelationQuery = Partial<RelationTuple>;

/** Data available inside every policy checker. */
export type SubjectContext<Type extends string, Data> = { type: Type; id: string; data: Data };

export type AuthorPolicyContext<
  Entity,
  Resource,
  CustomContext extends Record<string, unknown>,
  Subject = SubjectContext<string, Entity>,
> = {
  /** Current actor reference with type, ID, and data. Use this for multi-entity apps. */
  subject: Subject;
  /** Current actor data. For multi-entity apps prefer `subject.data` after checking `subject.type`. */
  entity: Entity;
  /** Current actor type. */
  entityType: string;
  /** Current actor ID. */
  entityId: string;
  /** Action being checked, for example `read`, `update`, or `delete`. */
  action: string;
  /** Resource reference and original resource data. */
  resource: { type: string; id: string; data: Resource };
  /** Caller-provided request context such as IP address, tenant, or flags. */
  context: CustomContext;
  /** Evaluation mode. Frontend mode is only for UX; enforce security on the backend. */
  mode: Mode;
  /** Store adapter backing roles, permissions, relations, and audit logs. */
  store: AuthorStore;
  /** Parent resource resolver for nested authorization checks. */
  parents: ParentResolver;
  /** Subscription helpers for plan-aware authorization. */
  subscription: {
    /** Returns the current plan, or null when no subscription applies. */
    plan(): string | null | Promise<string | null>;
  };
  /** Feature flag helpers resolved from the current plan. */
  features: {
    /** Returns true when the current plan includes the feature. */
    has(feature: string): boolean | Promise<boolean>;
    /** Lists all features enabled for the current plan. */
    list(): readonly string[] | Promise<readonly string[]>;
  };
  /** Numeric limit helpers resolved from the current plan. */
  limits: {
    /** Returns the configured limit, or null when unlimited/unconfigured. */
    get(name: string): number | null | Promise<number | null>;
    /** Returns true when `used` is below the configured limit. Null limit means allowed. */
    within(name: string, input: { used: number }): boolean | Promise<boolean>;
    /** Returns remaining units, or null when unlimited/unconfigured. */
    remaining(name: string, input: { used: number }): number | null | Promise<number | null>;
  };
  /** Relationship-based authorization helpers. */
  relations: {
    /** Returns true when at least one relation tuple matches the query. */
    has(input: RelationQuery): boolean | Promise<boolean>;
    /** Lists relation tuples matching the query. */
    list(input: RelationQuery): RelationTuple[] | Promise<RelationTuple[]>;
  };
  /** Convenience check for `entity --relation--> current resource`. */
  entityHasRelation(relation: string): boolean | Promise<boolean>;
  /** Role-based authorization helpers scoped to the current entity. */
  roles: {
    /** Returns true when the current entity has the role, optionally within a scope. */
    has(role: string, scope?: ScopeInput): boolean | Promise<boolean>;
    /** Lists roles for the current entity, optionally within a scope. */
    list(scope?: ScopeInput): RoleGrant[] | Promise<RoleGrant[]>;
  };
  /** Direct permission grant helpers scoped to the current entity. */
  permissions: {
    /** Returns true when an allow grant exists and no deny grant matches. */
    has(action: string, resource?: ResourceInput): boolean | Promise<boolean>;
    /** Lists permission grants for the current entity, optionally for a resource. */
    list(resource?: ResourceInput): PermissionGrant[] | Promise<PermissionGrant[]>;
  };
};

/** A policy function. Return `true` to match, `false` to skip, or a detailed `PolicyResult`. */
export type PolicyChecker<Ctx> = {
  bivarianceHack(ctx: Ctx): boolean | PolicyResult | Promise<boolean | PolicyResult>;
}["bivarianceHack"];

/** Static policy applicability used to preselect relevant policies before running checks. */
export type PolicyScope = {
  /** Actor/entity types this policy can apply to. Omit to allow every entity type. */
  entityTypes?: readonly string[];
  /** Resource types this policy can apply to. Omit to allow every resource type. */
  resourceTypes?: readonly string[];
  /** Actions this policy can apply to. Omit to allow every action on matching resources. */
  actions?: readonly string[];
};

/** Named allow/deny rule evaluated by the authorization engine. */
export type Policy<Ctx> = {
  phase: "decision";
  name: string;
  effect: PolicyEffect;
  check: PolicyChecker<Ctx>;
  scope?: PolicyScope;
};

/** Side-effect hook that runs after a decision is produced. It cannot change the decision. */
export type DecisionHook<Ctx> = {
  phase: "afterDecision";
  name: string;
  run(ctx: Ctx, decision: Decision): void | Promise<void>;
  scope?: PolicyScope;
};

/** One rule accepted by `createAuthor` and author modules. */
export type AuthorRule<Ctx> = Policy<Ctx> | DecisionHook<Ctx>;

/** Runs after a decision is produced. Use for metrics, custom logs, and other side effects. */
export function afterDecision<Ctx>(name: string, run: DecisionHook<Ctx>["run"]): DecisionHook<Ctx>;
export function afterDecision<Ctx>(name: string, scope: PolicyScope, run: DecisionHook<Ctx>["run"]): DecisionHook<Ctx>;
export function afterDecision<Ctx>(
  name: string,
  scopeOrRun: PolicyScope | DecisionHook<Ctx>["run"],
  run?: DecisionHook<Ctx>["run"],
): DecisionHook<Ctx> {
  if (typeof scopeOrRun === "function") return { phase: "afterDecision", name, run: scopeOrRun };
  if (run) return { phase: "afterDecision", name, scope: scopeOrRun, run };
  throw new TypeError("Decision hook runner is required");
}

/** Creates an allow policy. A `true` checker result becomes an allow decision reasoned by `name`. */
export function allow<Ctx>(name: string, check: PolicyChecker<Ctx>): Policy<Ctx>;
export function allow<Ctx>(name: string, scope: PolicyScope, check: PolicyChecker<Ctx>): Policy<Ctx>;
export function allow<Ctx>(
  name: string,
  scopeOrCheck: PolicyScope | PolicyChecker<Ctx>,
  check?: PolicyChecker<Ctx>,
): Policy<Ctx> {
  return createPolicy(name, "allow", parsePolicyInput(scopeOrCheck, check));
}

/** Creates a deny policy. Deny policies override all allow policies. */
export function deny<Ctx>(name: string, check: PolicyChecker<Ctx>): Policy<Ctx>;
export function deny<Ctx>(name: string, scope: PolicyScope, check: PolicyChecker<Ctx>): Policy<Ctx>;
export function deny<Ctx>(
  name: string,
  scopeOrCheck: PolicyScope | PolicyChecker<Ctx>,
  check?: PolicyChecker<Ctx>,
): Policy<Ctx> {
  return createPolicy(name, "deny", parsePolicyInput(scopeOrCheck, check));
}

/** Explicitly skips a policy with an optional explanation for `Decision.skippedPolicies`. */
export function skip(reason?: string): PolicyResult {
  return reason === undefined ? { effect: "skip" } : { effect: "skip", reason };
}

/** Converts boolean policy returns into structured policy results. */
export function normalizePolicyResult<Ctx>(policy: Policy<Ctx>, result: boolean | PolicyResult): PolicyResult {
  if (typeof result === "boolean") {
    return result ? { effect: policy.effect, reason: policy.name } : { effect: "skip" };
  }
  if (result.effect === "skip") return result;
  return { effect: policy.effect, reason: result.reason };
}

/** Fluent scoped policy builder. Prefer this in larger apps to avoid unscoped policies. */
export const policy = scopedPolicyBuilder({});

type ParsedPolicyInput<Ctx> = { check: PolicyChecker<Ctx>; scope?: PolicyScope };

function parsePolicyInput<Ctx>(
  scopeOrCheck: PolicyScope | PolicyChecker<Ctx>,
  check: PolicyChecker<Ctx> | undefined,
): ParsedPolicyInput<Ctx> {
  if (typeof scopeOrCheck === "function") return { check: scopeOrCheck };
  if (check) return { check, scope: scopeOrCheck };
  throw new TypeError("Policy check is required");
}

function createPolicy<Ctx>(name: string, effect: PolicyEffect, input: ParsedPolicyInput<Ctx>): Policy<Ctx> {
  if (input.scope) return { phase: "decision", name, effect, check: input.check, scope: input.scope };
  return { phase: "decision", name, effect, check: input.check };
}

type ScopeInputValue = string | readonly string[];
type ScopedPolicyBuilder = {
  for(entityTypes: ScopeInputValue): ScopedPolicyBuilder;
  on(resourceTypes: ScopeInputValue): ScopedPolicyBuilder;
  can(actions: ScopeInputValue): ScopedPolicyBuilder;
  allow<Ctx>(name: string, check: PolicyChecker<Ctx>): Policy<Ctx>;
  deny<Ctx>(name: string, check: PolicyChecker<Ctx>): Policy<Ctx>;
  afterDecision<Ctx>(name: string, run: DecisionHook<Ctx>["run"]): DecisionHook<Ctx>;
};

function scopedPolicyBuilder(scope: PolicyScope): ScopedPolicyBuilder {
  return {
    for: (entityTypes) => scopedPolicyBuilder({ ...scope, entityTypes: values(entityTypes) }),
    on: (resourceTypes) => scopedPolicyBuilder({ ...scope, resourceTypes: values(resourceTypes) }),
    can: (actions) => scopedPolicyBuilder({ ...scope, actions: values(actions) }),
    allow: (name, check) => allow(name, scope, check),
    deny: (name, check) => deny(name, scope, check),
    afterDecision: (name, run) => afterDecision(name, scope, run),
  };
}

function values(input: ScopeInputValue): readonly string[] {
  return typeof input === "string" ? [input] : input;
}
