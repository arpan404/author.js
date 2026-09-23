import { useEffect, useMemo, useState } from "react";
import { type Decision, runDecision } from "../../core/src/index.js";
import { useOptionalAuthor } from "./author-context.js";
import type { UseCanInput, UseCanResult } from "./types.js";

const missingProvider = new Error("AuthorProvider is required");
const missingEntity = new Error("Author entity is required");

/** Runs an async `can` check and returns loading, error, boolean, and decision state. */
export function useCan(input: UseCanInput): UseCanResult {
  const author = useOptionalAuthor();
  const entityType = input.iType ?? author?.entityType;
  const entity = input.i ?? author?.entity;
  const resourceKey = useMemo(() => stableKey(input.resource), [input.resource]);
  const contextKey = useMemo(
    () => stableKey({ ...(author?.context ?? {}), ...(input.context ?? {}) }),
    [author?.context, input.context],
  );
  const entityKey = useMemo(() => stableKey(entity), [entity]);
  const decisionKey = `${entityType ?? ""}\0${entityKey}\0${input.do}\0${input.on}\0${resourceKey}\0${contextKey}`;
  const cached = author?.decisions.get(decisionKey);
  const [state, setState] = useState<UseCanResult>(() =>
    cached ? fromDecision(cached) : { allowed: false, loading: true, error: null, decision: null },
  );

  useEffect(() => {
    let active = true;
    if (author === null) {
      setState({ allowed: false, loading: false, error: missingProvider, decision: null });
      return () => {
        active = false;
      };
    }
    if (entityType === undefined || entity === undefined) {
      setState({ allowed: false, loading: false, error: missingEntity, decision: null });
      return () => {
        active = false;
      };
    }

    const hit = author.decisions.get(decisionKey);
    if (hit) {
      setState(fromDecision(hit));
      return () => {
        active = false;
      };
    }

    setState((previous) => {
      if (previous.loading && previous.error === null) return previous;
      return {
        allowed: previous.allowed,
        loading: true,
        error: null,
        decision: previous.decision,
      };
    });

    const mergedContext = { ...(author.context ?? {}), ...(input.context ?? {}) };
    author.decisions
      .load(decisionKey, () =>
        runDecision(author.authorization, {
          entityType,
          entity,
          action: input.do,
          resourceType: input.on,
          resource: input.resource,
          context: mergedContext,
          mode: author.mode,
        }),
      )
      .then((decision) => {
        if (active) setState(fromDecision(decision));
      })
      .catch((error: unknown) => {
        if (active) setState({ allowed: false, loading: false, error: toError(error), decision: null });
      });

    return () => {
      active = false;
    };
  }, [author, entityType, entity, entityKey, input.do, input.on, resourceKey, contextKey, decisionKey]);

  return state;
}

function stableKey(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return String(value);
  }
}

function fromDecision(decision: Decision): UseCanResult {
  return { allowed: decision.allowed, loading: false, error: null, decision };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
