import { AuthorizationDeniedError, type Decision, runDecision } from "../../core/src/index.js";

type MaybePromise<T> = T | Promise<T>;
type DecisionInput = {
  entityType: string;
  entity: unknown;
  action: string;
  resourceType: string;
  resource: unknown;
  context: Record<string, unknown>;
  mode: "backend";
};
type AuthorLike = {
  evaluate(input: DecisionInput): Promise<Decision>;
  decide?(input: DecisionInput): Promise<Decision>;
};

/** Input for server-side Next.js authorization assertions. */
export type AssertCanInput = {
  author: AuthorLike;
  entityType: string;
  entity: unknown;
  action: string;
  resourceType: string;
  resource: unknown;
  context?: Record<string, unknown>;
};

/** Options for building reusable Next.js server authorization checks. */
export type NextRequireCanOptions<Req> = {
  author: AuthorLike;
  entityType: string | ((request: Req) => MaybePromise<string>);
  entity(request: Req): MaybePromise<unknown>;
  action: string | ((request: Req) => MaybePromise<string>);
  resourceType: string | ((request: Req) => MaybePromise<string>);
  resource(request: Req): MaybePromise<unknown>;
  context?: (request: Req) => MaybePromise<Record<string, unknown>>;
};

/** Evaluates a backend check and throws `AuthorizationDeniedError` when denied. */
export async function assertCan(input: AssertCanInput): Promise<Decision> {
  const decision = await runDecision(input.author, {
    entityType: input.entityType,
    entity: input.entity,
    action: input.action,
    resourceType: input.resourceType,
    resource: input.resource,
    context: input.context ?? {},
    mode: "backend",
  });
  if (!decision.allowed) throw new AuthorizationDeniedError(decision);
  return decision;
}

/** Creates a reusable request-to-decision helper for Next.js route handlers and server actions. */
export function requireCan<Req>(options: NextRequireCanOptions<Req>) {
  return async (request: Req): Promise<Decision> => {
    const [entityType, entity, action, resourceType, resource, context] = await Promise.all([
      value(options.entityType, request),
      options.entity(request),
      value(options.action, request),
      value(options.resourceType, request),
      options.resource(request),
      options.context?.(request) ?? {},
    ]);
    return assertCan({ author: options.author, entityType, entity, action, resourceType, resource, context });
  };
}

function value<Req>(input: string | ((request: Req) => MaybePromise<string>), request: Req): MaybePromise<string> {
  return typeof input === "string" ? input : input(request);
}
