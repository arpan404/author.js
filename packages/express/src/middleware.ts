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

type ResponseLike = {
  status(code: number): { json(body: unknown): unknown };
};

type Next = (error?: unknown) => void;

/** Options for Express-style authorization middleware. */
export type RequireCanOptions<Req> = {
  author: AuthorLike;
  entityType: string | ((req: Req) => MaybePromise<string>);
  entity(req: Req): MaybePromise<unknown>;
  action: string | ((req: Req) => MaybePromise<string>);
  resourceType: string | ((req: Req) => MaybePromise<string>);
  resource(req: Req): MaybePromise<unknown>;
  context?: (req: Req) => MaybePromise<Record<string, unknown>>;
};

/** Creates Express-compatible middleware that returns 403 when authorization is denied. */
export function requireCan<Req, Res extends ResponseLike = ResponseLike>(options: RequireCanOptions<Req>) {
  return async (req: Req, res: Res, next: Next): Promise<void> => {
    try {
      const [entityType, entity, action, resourceType, resource, context] = await Promise.all([
        value(options.entityType, req),
        options.entity(req),
        value(options.action, req),
        value(options.resourceType, req),
        options.resource(req),
        options.context?.(req) ?? {},
      ]);
      const decision = await runDecision(options.author, {
        entityType,
        entity,
        action,
        resourceType,
        resource,
        context,
        mode: "backend",
      });
      if (decision.allowed) next();
      else res.status(403).json({ error: "Forbidden", reason: decision.reason });
    } catch (error) {
      next(error);
    }
  };
}

function value<Req>(input: string | ((req: Req) => MaybePromise<string>), req: Req): MaybePromise<string> {
  return typeof input === "string" ? input : input(req);
}
