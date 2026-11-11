// Brings saved bases up to date with field types this version still has.

import type { BaseState, Field } from "./types";

/** Field types that were removed, and the type their fields become. Values are kept. */
const REMOVED_TYPES: Record<string, Field["type"]> = { ai: "longText" };

/** Turn fields of a removed type into their replacement, in place. Returns the same state. */
export function upgradeState(state: BaseState): BaseState {
  for (const f of Object.values(state.fields)) {
    const to = REMOVED_TYPES[f.type as string];
    if (!to) continue;
    f.type = to;
    delete (f.options as Record<string, unknown>).prompt;
  }
  for (const r of Object.values(state.rows)) delete (r as { aiErrors?: unknown }).aiErrors;
  return state;
}
