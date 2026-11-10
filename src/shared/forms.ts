// Form view helpers shared by the form screen and tests.

import type { CellValue, Field, FormConfig } from "./types";

/** Which questions must be answered. Older forms had no setting: then only the primary field. */
export function requiredIds(form: FormConfig, primaryFieldId: string): string[] {
  return form.requiredFieldIds ?? [primaryFieldId];
}

/** The text shown for a question. */
export function questionLabel(form: FormConfig, field: Field): string {
  return form.labels?.[field.id]?.trim() || field.name;
}

/** Help text under a question, falling back to the field's own description. */
export function questionHelp(form: FormConfig, field: Field): string {
  return form.help?.[field.id]?.trim() || field.description || "";
}

export function isAnswered(v: CellValue | undefined): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Required questions on the form (in form order) that have no answer yet. */
export function missingAnswers(form: FormConfig, fields: Field[], values: Record<string, CellValue>, primaryFieldId: string): Field[] {
  const required = new Set(requiredIds(form, primaryFieldId));
  return fields.filter((f) => required.has(f.id) && !isAnswered(values[f.id]));
}
