import type { CanProps } from "./types.js";
import { useCannot } from "./useCannot.js";

/** Renders children when the current entity cannot perform an action on a resource. */
export function Cannot(props: CanProps) {
  const result = useCannot(props);
  if (result.loading && result.decision === null) return null;
  return result.allowed ? props.children : (props.fallback ?? null);
}
