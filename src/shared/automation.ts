// Automation steps: filling templates from records and turning steps into changes.
// The server runs steps one at a time (src/server/engine.ts); the editor previews a
// dry run with planSteps, using the same helpers so the preview matches the real run.

import type { Action, Automation, AutomationStep, BaseState, CellValue, Field, Row } from "./types";
import { CellError, Computer } from "./compute";
import { makeChoice } from "./fieldTypes";
import { matchesFilters } from "./query";
import { newId } from "./ids";

export const MAX_EMAIL_RECIPIENTS = 10;
export const EMAIL_LIMITS = { to: 1000, subject: 300, body: 20000 } as const;
export const MAX_STEPS = 50;
export const MAX_DEPTH = 3;
export const MAX_LOOP_ITEMS = 100;
export const MAX_SCRIPT_LENGTH = 20_000;

export type PlannedEmail = { to: string[]; subject: string; text: string };

/** The records a step works with: the one that started the run, and the one it's on now (inside a loop, the linked record). */
export type RunContext = { trigger: Row | null; current: Row | null };

/** What one step will do, in words, for the test panel. */
export type StepPreview =
  | { kind: "update" | "create"; tableName: string; cells: { field: string; value: string }[]; recordName?: string }
  | { kind: "email"; to: string[]; invalid: string[]; subject: string; text: string }
  | { kind: "condition"; matched: boolean | null; then: StepPreview[]; otherwise: StepPreview[] }
  | { kind: "forEach"; field: string; count: number; items: { name: string; steps: StepPreview[] }[] }
  | { kind: "script"; lines: number }
  | { kind: "post"; to: "slack" | "sheets" | "webhook"; connectionId: string; payload: string };

export type StepPlan = {
  /** Record changes a dry run would make (scripts and posts aren't run in a dry run). */
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

/** Does the trigger's condition hold for this record right now? ("matches conditions" and "enters a view" have one.) */
export function triggerMatches(state: BaseState, auto: Automation, row: Row): boolean {
  const t = auto.trigger;
  if (t.type === "recordMatches") return matchesFilters(new Computer(state), row, t.filters);
  if (t.type === "enteredView") {
    const view = state.views[t.viewId];
    return Boolean(view) && matchesFilters(new Computer(state), row, view.config.filters);
  }
  return true;
}

/**
 * A template with {fldId} placeholders replaced by record values, as text. Fields of
 * the current record's table come from it; fields of the trigger's table from the
 * trigger record. With `encode`, values are URL-encoded (except a placeholder at the
 * very start, which may hold a whole link).
 */
export function fillContext(state: BaseState, ctx: RunContext, template: string, now = new Date(), encode = false): string {
  const c = new Computer(state, now);
  return template.replace(/\{(fld[A-Za-z0-9]{14})\}/g, (_, id: string, offset: number) => {
    const f = state.fields[id];
    const row = f && ctx.current?.tableId === f.tableId ? ctx.current : f && ctx.trigger?.tableId === f.tableId ? ctx.trigger : null;
    if (!f || !row) return "";
    const v = c.value(row, f);
    const text = v instanceof CellError ? "" : c.display(row, f);
    return encode && offset > 0 ? encodeURIComponent(text) : text;
  });
}

/** fillContext for one record. */
export function fillTemplate(state: BaseState, row: Row, template: string, now = new Date(), encode = false): string {
  return fillContext(state, { trigger: row, current: row }, template, now, encode);
}

/** Field ids a template refers to. */
export function templateRefs(template: string): string[] {
  return [...template.matchAll(/\{(fld[A-Za-z0-9]{14})\}/g)].map((m) => m[1]);
}

/** Records linked from the current record through a link field. */
export function linkedRecords(state: BaseState, row: Row | null, linkFieldId: string): Row[] {
  const f = state.fields[linkFieldId];
  if (!row || !f || f.type !== "link" || f.tableId !== row.tableId) return [];
  return ((row.cells[f.id] as string[] | undefined) ?? []).map((id) => state.rows[id]).filter((r): r is Row => Boolean(r));
}

/**
 * The record change an update/create step makes, with any new select options it needs.
 * `newChoices` carries options created by earlier steps in the same dry run.
 */
export function recordStepActions(
  state: BaseState, step: Extract<AutomationStep, { type: "updateRecord" | "createRecord" }>, ctx: RunContext,
  newChoices = new Map<string, Field>(), now = new Date(),
): { action: Action | null; fieldUpdates: Action[]; preview: StepPreview } {
  const tableId = step.type === "createRecord" ? step.tableId : ctx.current?.tableId;
  const c = new Computer(state, now);
  const cells: Record<string, CellValue> = {};
  const shown: { field: string; value: string }[] = [];
  const touched = new Set<string>();
  const resolve = (field: Field, template: string): CellValue => {
    // A template that is exactly one link field copies the linked records.
    const only = /^\{(fld[A-Za-z0-9]{14})\}$/.exec(template.trim());
    if (only && field.type === "link") {
      const src = state.fields[only[1]];
      const row = src && (ctx.current?.tableId === src.tableId ? ctx.current : ctx.trigger?.tableId === src.tableId ? ctx.trigger : null);
      if (src?.type === "link" && row && src.options.linkedTableId === field.options.linkedTableId) return row.cells[src.id] ?? null;
    }
    const text = fillContext(state, ctx, template, now);
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
          touched.add(field.id);
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
  for (const [fieldId, template] of Object.entries(step.values)) {
    const f = state.fields[fieldId];
    if (!f || f.tableId !== tableId) continue;
    const v = resolve(f, template);
    cells[fieldId] = v;
    shown.push({ field: f.name, value: displayPlanned(state, c, f, v, newChoices.get(f.id)) });
  }
  const fieldUpdates: Action[] = [...touched].map((id) => ({ type: "field.update", fieldId: id, options: { choices: newChoices.get(id)!.options.choices } }));
  const tableName = state.tables[tableId ?? ""]?.name ?? "?";
  if (step.type === "updateRecord") {
    const preview: StepPreview = { kind: "update", tableName, cells: shown, recordName: ctx.current ? c.primaryName(ctx.current.id) : undefined };
    return { action: ctx.current ? { type: "row.update", rowId: ctx.current.id, cells } : null, fieldUpdates, preview };
  }
  return { action: tableId ? { type: "row.create", rowId: newId("rec"), tableId, cells } : null, fieldUpdates, preview: { kind: "create", tableName, cells: shown } };
}

/** The email an email step sends (or why it can't). */
export function emailStep(state: BaseState, autoName: string, step: Extract<AutomationStep, { type: "sendEmail" }>, ctx: RunContext, now = new Date()) {
  const { valid, invalid } = parseRecipients(fillContext(state, ctx, step.to, now));
  const subject = fillContext(state, ctx, step.subject, now).replace(/[\r\n\t]+/g, " ").trim() || autoName;
  const text = fillContext(state, ctx, step.body, now);
  const preview: StepPreview = { kind: "email", to: valid, invalid, subject, text };
  const problem = valid.length === 0 ? "no valid email address to send to" : valid.length > MAX_EMAIL_RECIPIENTS ? `more than ${MAX_EMAIL_RECIPIENTS} recipients` : null;
  return { email: problem ? null : { to: valid, subject, text }, preview, problem };
}

/** The JSON a Slack, Sheets or webhook step sends. */
export function postPayload(state: BaseState, step: Extract<AutomationStep, { type: "slack" | "sheets" | "webhook" }>, ctx: RunContext, now = new Date()): unknown {
  if (step.type === "slack") return { text: fillContext(state, ctx, step.text, now).slice(0, 3000) };
  if (step.type === "sheets") return { values: step.columns.map((c) => fillContext(state, ctx, c, now).slice(0, 5000)) };
  const raw = fillContext(state, ctx, step.body, now);
  try { return JSON.parse(raw); } catch { return { text: raw }; }
}

/** Dry run: what the steps would do for this record, without running scripts or posting anything. */
export function planSteps(state: BaseState, auto: Automation, trigger: Row | null, now = new Date()): StepPlan {
  const plan: StepPlan = { actions: [], fieldUpdates: [], emails: [], preview: [], problems: [] };
  const newChoices = new Map<string, Field>();
  let counter = 0;
  const walk = (steps: AutomationStep[], ctx: RunContext, out: StepPreview[], label: string) => {
    steps.forEach((step, i) => {
      const where = `${label}${i + 1}`;
      if (++counter > 500) return;
      switch (step.type) {
        case "updateRecord":
        case "createRecord": {
          const r = recordStepActions(state, step, ctx, newChoices, now);
          out.push(r.preview);
          if (r.action) plan.actions.push(r.action);
          else plan.problems.push(`Step ${where}: there's no record to update`);
          for (const u of r.fieldUpdates) {
            const at = plan.fieldUpdates.findIndex((x) => x.type === "field.update" && u.type === "field.update" && x.fieldId === u.fieldId);
            if (at >= 0) plan.fieldUpdates[at] = u; else plan.fieldUpdates.push(u);
          }
          return;
        }
        case "sendEmail": {
          const r = emailStep(state, auto.name, step, ctx, now);
          out.push(r.preview);
          if (r.email) plan.emails.push(r.email);
          else plan.problems.push(`Step ${where}: ${r.problem}`);
          return;
        }
        case "condition": {
          const matched = ctx.current ? matchesFilters(new Computer(state, now), ctx.current, step.filters) : null;
          const p: StepPreview = { kind: "condition", matched, then: [], otherwise: [] };
          out.push(p);
          if (matched === null) return;
          walk(matched ? step.then : step.otherwise, ctx, matched ? p.then : p.otherwise, `${where}.`);
          return;
        }
        case "forEach": {
          const list = linkedRecords(state, ctx.current, step.linkFieldId);
          const c = new Computer(state, now);
          const p: StepPreview = { kind: "forEach", field: state.fields[step.linkFieldId]?.name ?? "?", count: list.length, items: [] };
          out.push(p);
          for (const r of list.slice(0, MAX_LOOP_ITEMS)) {
            const item = { name: c.primaryName(r.id), steps: [] as StepPreview[] };
            p.items.push(item);
            walk(step.steps, { trigger: ctx.trigger, current: r }, item.steps, `${where}.`);
          }
          return;
        }
        case "script":
          out.push({ kind: "script", lines: step.code.split("\n").length });
          return;
        case "slack":
        case "sheets":
        case "webhook":
          out.push({ kind: "post", to: step.type, connectionId: step.connectionId, payload: JSON.stringify(postPayload(state, step, ctx, now), null, 2) });
          return;
      }
    });
  };
  walk(auto.steps, { trigger, current: trigger }, plan.preview, "");
  return plan;
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

/** Count every step, including ones inside branches and loops. */
export function countSteps(steps: AutomationStep[]): number {
  return steps.reduce((n, s) => n + 1 + (s.type === "condition" ? countSteps(s.then) + countSteps(s.otherwise) : s.type === "forEach" ? countSteps(s.steps) : 0), 0);
}

type ScheduleTrigger = Extract<Automation["trigger"], { type: "schedule" }>;

/** The most recent time this schedule was due, at or before `now` (all in UTC). */
export function lastScheduledTime(t: ScheduleTrigger, now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCSeconds(0, 0);
  if (t.every === "hour") {
    d.setUTCMinutes(t.minute);
    if (d > now) d.setUTCHours(d.getUTCHours() - 1);
    return d;
  }
  d.setUTCHours(t.hourUtc, t.minute);
  if (t.every === "day") {
    if (d > now) d.setUTCDate(d.getUTCDate() - 1);
    return d;
  }
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - t.weekdayUtc + 7) % 7));
  if (d > now) d.setUTCDate(d.getUTCDate() - 7);
  return d;
}

/** When this schedule runs next, after `now`. */
export function nextScheduledTime(t: ScheduleTrigger, now: Date): Date {
  const last = lastScheduledTime(t, now);
  const next = new Date(last.getTime());
  if (t.every === "hour") next.setUTCHours(next.getUTCHours() + 1);
  else next.setUTCDate(next.getUTCDate() + (t.every === "day" ? 1 : 7));
  return next;
}
