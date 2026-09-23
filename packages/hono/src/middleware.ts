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
type HonoContextLike = { json(body: unknown, status?: number): Response | Promise<Response> };
type Next = () => Promise<void>;

/** Options for Hono authorization middleware. */
export type HonoRequireCanOptions<C> = {
  author: AuthorLike;
  entityType: string | ((context: C) => MaybePromise<string>);
  entity(context: C): MaybePromise<unknown>;
  action: string | ((context: C) => MaybePromise<string>);
  resourceType: string | ((context: C) => MaybePromise<string>);
  resource(context: C): MaybePromise<unknown>;
  context?: (context: C) => MaybePromise<Record<string, unknown>>;
};

/** Creates Hono-compatible middleware that returns a 403 JSON response when denied. */
export function requireCan<C extends HonoContextLike>(options: HonoRequireCanOptions<C>) {
  return async (context: C, next: Next): Promise<Response | undefined> => {
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
    if (!decision.allowed) return context.json({ error: "Forbidden", reason: decision.reason }, 403);
    await next();
  };
}

function value<C>(input: string | ((context: C) => MaybePromise<string>), context: C): MaybePromise<string> {
  return typeof input === "string" ? input : input(context);
}
