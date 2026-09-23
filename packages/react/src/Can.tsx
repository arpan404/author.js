import type { CanProps } from "./types.js";
import { useCan } from "./useCan.js";

/** Renders children when the current entity can perform an action on a resource. */
export function Can(props: CanProps) {
  const result = useCan(props);
  if (result.loading && result.decision === null) return null;
  return result.allowed ? props.children : (props.fallback ?? null);
}
