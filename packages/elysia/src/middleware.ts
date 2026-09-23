import { type Decision, runDecision } from "../../core/src/index.js";

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
type ElysiaContextLike = { set?: { status?: number } };

/** Options for Elysia `beforeHandle` authorization checks. */
export type ElysiaRequireCanOptions<C> = {
  author: AuthorLike;
  entityType: string | ((context: C) => MaybePromise<string>);
  entity(context: C): MaybePromise<unknown>;
  action: string | ((context: C) => MaybePromise<string>);
  resourceType: string | ((context: C) => MaybePromise<string>);
  resource(context: C): MaybePromise<unknown>;
  context?: (context: C) => MaybePromise<Record<string, unknown>>;
};

/** Creates an Elysia-compatible `beforeHandle` hook that returns 403 JSON when denied. */
export function requireCan<C extends ElysiaContextLike>(options: ElysiaRequireCanOptions<C>) {
  return async (context: C): Promise<{ error: "Forbidden"; reason: string } | undefined> => {
    const [entityType, entity, action, resourceType, resource, customContext] = await Promise.all([
      value(options.entityType, context),
      options.entity(context),
      value(options.action, context),
      value(options.resourceType, context),
      options.resource(context),
      options.context?.(context) ?? {},
    ]);
    const decision = await runDecision(options.author, {
      entityType,
      entity,
      action,
      resourceType,
      resource,
      context: customContext,
      mode: "backend",
    });
    if (decision.allowed) return;
    if (context.set) context.set.status = 403;
    return { error: "Forbidden", reason: decision.reason };
  };
}

function value<C>(input: string | ((context: C) => MaybePromise<string>), context: C): MaybePromise<string> {
  return typeof input === "string" ? input : input(context);
}
