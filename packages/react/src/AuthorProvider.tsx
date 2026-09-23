import { useMemo, useRef } from "react";
import { AuthorContext } from "./author-context.js";
import { createDecisionCache } from "./decision-cache.js";
import type { AuthorContextValue, AuthorProviderProps } from "./types.js";

const emptyContext: Record<string, unknown> = {};

/** Provides an author.js instance and default entity to authorization hooks and components. */
export function AuthorProvider({
  authorization,
  entityType,
  entity,
  mode = "frontend",
  context = emptyContext,
  children,
}: AuthorProviderProps) {
  const decisions = useRef(createDecisionCache());
  const authorizationRef = useRef(authorization);
  if (authorizationRef.current !== authorization) {
    authorizationRef.current = authorization;
    decisions.current.clear();
  }

  const value = useMemo<AuthorContextValue>(
    () => ({ authorization, entityType, entity, mode, context, decisions: decisions.current }),
    [authorization, entityType, entity, mode, context],
  );

  return <AuthorContext.Provider value={value}>{children}</AuthorContext.Provider>;
}
