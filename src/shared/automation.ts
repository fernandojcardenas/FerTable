// Turns an automation's steps into concrete changes and emails for one record.
// The server uses it to run automations; the editor uses it to preview a test run.

import type { Action, Automation, BaseState, CellValue, Field, Row } from "./types";
import { CellError, Computer } from "./compute";
import { makeChoice } from "./fieldTypes";
import { matchesFilters } from "./query";
import { newId } from "./ids";

export const MAX_EMAIL_RECIPIENTS = 10;
export const EMAIL_LIMITS = { to: 1000, subject: 300, body: 20000 } as const;

export type PlannedEmail = { to: string[]; subject: string; text: string };

/** What one step will do, in words, for the test panel. */
export type StepPreview =
  | { kind: "update" | "create"; tableName: string; cells: { field: string; value: string }[] }
  | { kind: "email"; to: string[]; invalid: string[]; subject: string; text: string };

export type StepPlan = {
  /** Record changes, applied as one transaction. */
  actions: Action[];
  /** New select options the changes need, applied first. */
  fieldUpdates: Action[];
  emails: PlannedEmail[];
  preview: StepPreview[];
  /** Problems that stop the run, such as an email step with no valid address. */
  problems: string[];
};

const EMAIL_RE = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$/;

/** Split a resolved "to" line into addresses, keeping the ones that don't look valid apart. */
export function parseRecipients(text: string): { valid: string[]; invalid: string[] } {
  const parts = text.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    const addr = p.toLowerCase();
    if (EMAIL_RE.test(addr) && addr.length <= 254) {
      if (!valid.includes(addr)) valid.push(addr);
    } else invalid.push(p);
  }
  return { valid, invalid };
}

/** Does the trigger's condition hold for this record right now? (Only "matches conditions" has one.) */
export function triggerMatches(state: BaseState, auto: Automation, row: Row): boolean {
  if (auto.trigger.type !== "recordMatches") return true;
  return matchesFilters(new Computer(state), row, auto.trigger.filters);
}

/** Fill in step templates from the trigger record. Doesn't change anything. */
export function planSteps(state: BaseState, auto: Automation, trigger: Row, now = new Date()): StepPlan {
  const c = new Computer(state, now);
  const actions: Action[] = [];
  const emails: PlannedEmail[] = [];
  const preview: StepPreview[] = [];
  const problems: string[] = [];
  const newChoices = new Map<string, Field>();

  /** A template with {fldId} placeholders replaced by the trigger record's values, as text. */
  const fill = (template: string) =>
    template.replace(/\{(fld[A-Za-z0-9]{14})\}/g, (_, id: string) => {
      const f = state.fields[id];
      if (!f || f.tableId !== trigger.tableId) return "";
      const v = c.value(trigger, f);
      return v instanceof CellError ? "" : c.display(trigger, f);
    });

  const resolve = (field: Field, template: string): CellValue => {
    // A template that is exactly one link field copies the linked records.
    const only = /^\{(fld[A-Za-z0-9]{14})\}$/.exec(template.trim());
    if (only && field.type === "link") {
      const src = state.fields[only[1]];
      if (src?.type === "link" && src.options.linkedTableId === field.options.linkedTableId) return trigger.cells[src.id] ?? null;
    }
    const text = fill(template);
    if (field.type === "singleSelect" || field.type === "multiSelect") {
      const working = newChoices.get(field.id) ?? structuredClone(field);
      const names = field.type === "multiSelect" ? text.split(",") : [text];
      const ids: string[] = [];
      for (const raw of names) {
        const name = raw.trim();
        if (!name) continue;
        let ch = working.options.choices?.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (!ch) {
          ch = makeChoice(name, working.options.choices?.length ?? 0);
          working.options.choices = [...(working.options.choices ?? []), ch];
          newChoices.set(field.id, working);
        }
        ids.push(ch.id);
      }
      return field.type === "singleSelect" ? ids[0] ?? null : ids;
    }
    if (field.type === "link") {
      const target = state.tables[field.options.linkedTableId ?? ""];
      if (!target) return null;
      const names = text.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      return target.rowOrder.filter((id) => names.includes(c.primaryName(id).toLowerCase()));
    }
    return text === "" ? null : text;
  };

  auto.steps.forEach((step, i) => {
    if (step.type === "sendEmail") {
      const { valid, invalid } = parseRecipients(fill(step.to));
      const subject = fill(step.subject).replace(/[\r\n\t]+/g, " ").trim() || `${auto.name}`;
      const text = fill(step.body);
      preview.push({ kind: "email", to: valid, invalid, subject, text });
      if (valid.length === 0) problems.push(`Step ${i + 1}: no valid email address to send to`);
      else if (valid.length > MAX_EMAIL_RECIPIENTS) problems.push(`Step ${i + 1}: more than ${MAX_EMAIL_RECIPIENTS} recipients`);
      else emails.push({ to: valid, subject, text });
      return;
    }
    const tableId = step.type === "createRecord" ? step.tableId : trigger.tableId;
    const cells: Record<string, CellValue> = {};
    const shown: { field: string; value: string }[] = [];
    for (const [fieldId, template] of Object.entries(step.values)) {
      const f = state.fields[fieldId];
      if (!f || f.tableId !== tableId) continue;
      const v = resolve(f, template);
      cells[fieldId] = v;
      shown.push({ field: f.name, value: displayPlanned(state, c, f, v, newChoices.get(f.id)) });
    }
    preview.push({ kind: step.type === "updateRecord" ? "update" : "create", tableName: state.tables[tableId]?.name ?? "?", cells: shown });
    if (step.type === "updateRecord") actions.push({ type: "row.update", rowId: trigger.id, cells });
    else actions.push({ type: "row.create", rowId: newId("rec"), tableId, cells });
  });
  const fieldUpdates: Action[] = [...newChoices.values()].map((f) => ({ type: "field.update", fieldId: f.id, options: { choices: f.options.choices } }));
  return { actions, fieldUpdates, emails, preview, problems };
}

/** How a value a step will write reads on screen (select ids → names, link ids → record names). */
function displayPlanned(state: BaseState, c: Computer, field: Field, v: CellValue, withNewChoices?: Field): string {
  if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) return "(empty)";
  if (field.type === "singleSelect" || field.type === "multiSelect") {
    const choices = (withNewChoices ?? field).options.choices ?? [];
    const ids = Array.isArray(v) ? (v as string[]) : [v as string];
    return ids.map((id) => choices.find((ch) => ch.id === id)?.name ?? "?").join(", ");
  }
  if (field.type === "link") return (v as string[]).filter((id) => state.rows[id]).map((id) => c.primaryName(id)).join(", ");
  return String(v);
}
