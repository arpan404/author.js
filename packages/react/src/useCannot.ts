import type { UseCanInput, UseCanResult } from "./types.js";
import { useCan } from "./useCan.js";

/** Runs an async `cannot` check by inverting `useCan`. */
export function useCannot(input: UseCanInput): UseCanResult {
  const result = useCan(input);
  if (result.error || (result.loading && result.decision === null)) return result;
  return { ...result, allowed: !result.allowed };
}
