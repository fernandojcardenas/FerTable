import type { BaseState, CellValue, View } from "@/shared/types";
import { isReadOnly } from "@/shared/fieldTypes";

/**
 * Values for a new record so it still shows in a filtered view
 * (e.g. a view filtered to Status = Done creates records with Status = Done).
 */
export function prefillFromFilters(state: BaseState, view: View): Record<string, CellValue> {
  const out: Record<string, CellValue> = {};
  const f = view.config.filters;
  if (!f || f.conjunction !== "and") return out;
  for (const cond of f.conditions) {
    const field = state.fields[cond.fieldId];
    if (!field || isReadOnly(field) || cond.value === null || cond.value === undefined || cond.value === "") continue;
    if (["is", "contains"].includes(cond.operator) && ["text", "longText", "email", "url", "phone"].includes(field.type)) out[field.id] = String(cond.value);
    else if (cond.operator === "is" && field.type === "singleSelect") out[field.id] = Array.isArray(cond.value) ? String(cond.value[0]) : String(cond.value);
    else if (cond.operator === "eq" && field.type === "number") out[field.id] = Number(cond.value);
    else if (["hasAny", "hasAll"].includes(cond.operator) && field.type === "multiSelect") out[field.id] = (cond.value as string[]).slice(0, cond.operator === "hasAny" ? 1 : undefined);
    else if (cond.operator === "is" && field.type === "date") out[field.id] = String(cond.value);
  }
  for (const cond of f.conditions) {
    const field = state.fields[cond.fieldId];
    if (field?.type === "checkbox" && cond.operator === "checked") out[field.id] = true;
  }
  return out;
}
