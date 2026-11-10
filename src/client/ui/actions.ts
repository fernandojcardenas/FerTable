import type { Action, BaseState, CellValue, Field, SelectChoice } from "@/shared/types";
import { linkChangeActions } from "@/shared/activity";

/** Actions to set one cell, adding a new select option first when one was just created. */
export function cellActions(state: BaseState, rowId: string, field: Field, value: CellValue, newChoice?: SelectChoice): Action[] {
  if (field.type === "link") return linkActions(state, rowId, field, value);
  const actions: Action[] = [];
  if (newChoice) {
    const current = state.fields[field.id]?.options.choices ?? [];
    actions.push({ type: "field.update", fieldId: field.id, options: { choices: [...current, newChoice] } });
  }
  actions.push({ type: "row.update", rowId, cells: { [field.id]: value } });
  return actions;
}

/**
 * A link cell is saved as "link these, unlink those" rather than the whole list,
 * so links someone else adds to the same cell at the same moment aren't lost.
 */
function linkActions(state: BaseState, rowId: string, field: Field, value: CellValue): Action[] {
  return linkChangeActions(state, rowId, field.id, Array.isArray(value) ? (value as string[]) : []);
}
