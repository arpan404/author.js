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
type ReplyLike = { code(status: number): { send(body: unknown): unknown } };

/** Options for Fastify authorization pre-handlers. */
export type FastifyRequireCanOptions<Req> = {
  author: AuthorLike;
  entityType: string | ((request: Req) => MaybePromise<string>);
  entity(request: Req): MaybePromise<unknown>;
  action: string | ((request: Req) => MaybePromise<string>);
  resourceType: string | ((request: Req) => MaybePromise<string>);
  resource(request: Req): MaybePromise<unknown>;
  context?: (request: Req) => MaybePromise<Record<string, unknown>>;
};

/** Creates a Fastify-compatible pre-handler that sends 403 when denied. */
export function requireCan<Req, Reply extends ReplyLike = ReplyLike>(options: FastifyRequireCanOptions<Req>) {
  return async (request: Req, reply: Reply): Promise<void> => {
    const [entityType, entity, action, resourceType, resource, context] = await Promise.all([
      value(options.entityType, request),
      options.entity(request),
      value(options.action, request),
      value(options.resourceType, request),
      options.resource(request),
      options.context?.(request) ?? {},
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
    if (!decision.allowed) reply.code(403).send({ error: "Forbidden", reason: decision.reason });
  };
}

function value<Req>(input: string | ((request: Req) => MaybePromise<string>), request: Req): MaybePromise<string> {
  return typeof input === "string" ? input : input(request);
}
