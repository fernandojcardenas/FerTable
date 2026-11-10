// Public form links: what someone without an account sees, and how their answers
// are checked before they become a record. The server never trusts the page.

import type { BaseState, CellValue, Field, FieldType, FormConfig, SelectChoice, View } from "./types";
import { coerceValue, isComputed } from "./fieldTypes";
import { isAnswered, questionHelp, questionLabel, requiredIds } from "./forms";

/** Question types a public form can ask. Links would show other records; attachments would allow anonymous uploads. */
export const PUBLIC_TYPES = new Set<FieldType>(["text", "longText", "number", "checkbox", "singleSelect", "multiSelect", "date", "email", "url", "phone"]);

export const PUBLIC_TOKEN_RE = /^[A-Za-z0-9_-]{24,64}$/;
export const MAX_ANSWER_LENGTH = 10_000;

export type PublicQuestion = {
  fieldId: string;
  label: string;
  help: string;
  type: FieldType;
  required: boolean;
  choices?: Pick<SelectChoice, "id" | "name" | "color">[];
  includeTime?: boolean;
};

export type PublicFormDefinition = {
  title: string;
  description: string;
  submitLabel: string;
  thankYou: string;
  questions: PublicQuestion[];
};

/** The form's questions that can be asked publicly, in form order. */
export function publicFields(state: BaseState, form: FormConfig): Field[] {
  return form.fieldIds.map((id) => state.fields[id]).filter((f): f is Field => Boolean(f) && !isComputed(f.type) && PUBLIC_TYPES.has(f.type));
}

/** Everything the public page needs, and nothing else (no records, no other fields, no member names). */
export function publicFormDefinition(state: BaseState, view: View): PublicFormDefinition | null {
  const form = view.config.form;
  const table = state.tables[view.tableId];
  if (!form || !table || view.type !== "form") return null;
  const required = new Set(requiredIds(form, table.primaryFieldId));
  return {
    title: form.title || table.name,
    description: form.description,
    submitLabel: form.submitLabel || "Submit",
    thankYou: form.thankYou?.trim() || "Your response was sent.",
    questions: publicFields(state, form).map((f) => ({
      fieldId: f.id,
      label: questionLabel(form, f),
      help: questionHelp(form, f),
      type: f.type,
      required: required.has(f.id),
      ...(f.type === "singleSelect" || f.type === "multiSelect" ? { choices: (f.options.choices ?? []).map(({ id, name, color }) => ({ id, name, color })) } : {}),
      ...(f.type === "date" ? { includeTime: Boolean(f.options.includeTime) } : {}),
    })),
  };
}

/**
 * Turn submitted answers into cells for a new record. Unknown fields are ignored,
 * select answers must be existing options, and required questions must be answered.
 */
export function checkSubmission(state: BaseState, view: View, answers: unknown): { cells: Record<string, CellValue>; errors: string[] } {
  const form = view.config.form;
  const table = state.tables[view.tableId];
  if (!form || !table) return { cells: {}, errors: ["This form is no longer available"] };
  const input = answers && typeof answers === "object" && !Array.isArray(answers) ? (answers as Record<string, unknown>) : {};
  const required = new Set(requiredIds(form, table.primaryFieldId));
  const cells: Record<string, CellValue> = {};
  const errors: string[] = [];
  for (const f of publicFields(state, form)) {
    const label = questionLabel(form, f);
    const raw = input[f.id];
    let value: CellValue = null;
    if (raw !== undefined && raw !== null && raw !== "") {
      if (typeof raw === "string" && raw.length > MAX_ANSWER_LENGTH) { errors.push(`“${label}” is too long`); continue; }
      if (f.type === "singleSelect" || f.type === "multiSelect") {
        const ids = new Set((f.options.choices ?? []).map((c) => c.id));
        const picked = Array.isArray(raw) ? raw : [raw];
        if (!picked.every((x) => typeof x === "string" && ids.has(x))) { errors.push(`Pick one of the options for “${label}”`); continue; }
        value = f.type === "singleSelect" ? (picked[0] as string) : [...new Set(picked as string[])];
      } else if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
        try {
          value = coerceValue(f, raw);
        } catch {
          errors.push(`“${label}” doesn't look right`);
          continue;
        }
      } else {
        errors.push(`“${label}” doesn't look right`);
        continue;
      }
    }
    if (required.has(f.id) && !isAnswered(value)) { errors.push(`“${label}” is required`); continue; }
    if (isAnswered(value)) cells[f.id] = value;
  }
  return { cells, errors };
}
