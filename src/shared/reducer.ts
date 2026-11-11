// Applies one action to a base. The server uses this to validate and persist
// changes; the browser uses the same code for instant (optimistic) updates.
// It must be deterministic: anything time-based comes from the action itself.

import type {
  Action, Automation, AutomationStep, BaseState, CellValue, EditPermission, Field, FieldOptions, FieldType, InterfacePage, PageElement, PrintItem, RestorePatch, Row, Table, TableSync, View, ViewConfig, ViewType,
} from "./types";
import { applyOrderPatch } from "./history";
import { CHOICE_COLORS, choicesFromText, coerceValue, defaultOptions, isComputed } from "./fieldTypes";
import { ALL_SUMMARIES, MAX_FROZEN, ROW_HEIGHTS } from "./viewTools";
import { CellError, Computer } from "./compute";
import { FormulaError, parseFormula, referencedIds, toText } from "./formula";
import { isId } from "./ids";
import { countSteps, EMAIL_LIMITS, MAX_DEPTH, MAX_SCRIPT_LENGTH, MAX_STEPS } from "./automation";
import { PUBLIC_TOKEN_RE } from "./publicForm";

export class ValidationError extends Error {}

const fail = (msg: string): never => {
  throw new ValidationError(msg);
};

export function defaultViewConfig(): ViewConfig {
  return { hiddenFieldIds: [], filters: { conjunction: "and", conditions: [] }, sorts: [], groupBy: [] };
}

export function emptyBase(id: string, name: string): BaseState {
  return { base: { id, name, txn: 0 }, tableOrder: [], tables: {}, fields: {}, rows: {}, views: {}, automations: {}, pages: {} };
}

type MapKey = "tables" | "fields" | "rows" | "views" | "automations" | "pages";

/** Copy-on-write helper so unchanged objects keep their identity (used to find what to save). */
class Draft {
  base;
  tableOrder;
  private maps: { [K in MapKey]: BaseState[K] };
  private copiedMaps = new Set<string>();
  private copied = new Set<string>();

  /** Who and when, stamped on every record this change touches. */
  stamp: { at: string; by: string | null } | null = null;

  constructor(private src: BaseState) {
    this.base = src.base;
    this.tableOrder = src.tableOrder;
    this.maps = { tables: src.tables, fields: src.fields, rows: src.rows, views: src.views, automations: src.automations, pages: src.pages ?? {} };
  }

  private map<K extends MapKey>(k: K): BaseState[K] {
    if (!this.copiedMaps.has(k)) {
      this.maps[k] = { ...this.maps[k] } as never;
      this.copiedMaps.add(k);
    }
    return this.maps[k] as unknown as BaseState[K];
  }

  get tables() { return this.maps.tables; }
  get fields() { return this.maps.fields; }
  get rows() { return this.maps.rows; }
  get views() { return this.maps.views; }
  get automations() { return this.maps.automations; }
  get pages() { return this.maps.pages; }

  table(id: string): Table {
    const t = this.tables[id] ?? fail(`Table ${id} not found`);
    if (this.copied.has(id)) return t;
    this.copied.add(id);
    return (this.map("tables")[id] = { ...t, fieldOrder: [...t.fieldOrder], rowOrder: [...t.rowOrder], viewOrder: [...t.viewOrder] });
  }
  field(id: string): Field {
    const f = this.fields[id] ?? fail(`Field ${id} not found`);
    if (this.copied.has(id)) return f;
    this.copied.add(id);
    return (this.map("fields")[id] = structuredClone(f));
  }
  row(id: string): Row {
    const r = this.rows[id] ?? fail(`Row ${id} not found`);
    if (this.copied.has(id)) return r;
    this.copied.add(id);
    const copy: Row = { ...r, cells: { ...r.cells } };
    if (this.stamp) { copy.modifiedAt = this.stamp.at; copy.modifiedBy = this.stamp.by; }
    return (this.map("rows")[id] = copy);
  }
  view(id: string): View {
    const v = this.views[id] ?? fail(`View ${id} not found`);
    if (this.copied.has(id)) return v;
    this.copied.add(id);
    return (this.map("views")[id] = structuredClone(v));
  }
  put<K extends MapKey>(k: K, obj: BaseState[K][string]) {
    this.copied.add(obj.id);
    (this.map(k) as Record<string, unknown>)[obj.id] = obj;
  }
  remove(k: MapKey, id: string) {
    delete (this.map(k) as Record<string, unknown>)[id];
  }
  snapshot(): BaseState {
    const out: BaseState = { base: this.base, tableOrder: this.tableOrder, ...this.maps };
    if (this.src.people) out.people = this.src.people;
    return out;
  }
  finish(): BaseState {
    return this.snapshot();
  }
}

function requireNewId(d: Draft, id: string, prefix: "tbl" | "fld" | "viw" | "rec", map: Record<string, unknown>) {
  if (!isId(id, prefix)) fail(`Invalid id ${id}`);
  if (map[id]) fail(`${id} already exists`);
  void d;
}

function cleanName(name: string | undefined, what: string): string {
  const n = (name ?? "").trim();
  if (!n) fail(`${what} name can't be empty`);
  if (n.length > 200) fail(`${what} name is too long`);
  return n;
}

function uniqueFieldName(d: Draft, tableId: string, name: string, exceptId?: string): string {
  const taken = new Set(
    d.tables[tableId].fieldOrder.filter((id) => id !== exceptId).map((id) => d.fields[id]?.name.toLowerCase()),
  );
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
}

function assertFieldNameFree(d: Draft, tableId: string, name: string, exceptId?: string) {
  if (uniqueFieldName(d, tableId, name, exceptId) !== name) fail(`A field named "${name}" already exists`);
}

/** Check type-specific options; returns the cleaned options. */
function validateOptions(d: Draft, tableId: string, fieldId: string, type: FieldType, options: FieldOptions | undefined): FieldOptions {
  const o: FieldOptions = { ...defaultOptions(type), ...(options ?? {}) };
  switch (type) {
    case "singleSelect":
    case "multiSelect": {
      const seen = new Set<string>();
      o.choices = (o.choices ?? []).map((c) => {
        if (!c.id || seen.has(c.id)) fail("Each option needs a unique id");
        seen.add(c.id);
        return { id: c.id, name: String(c.name ?? "").trim() || "Option", color: c.color || "gray" };
      });
      return { choices: o.choices };
    }
    case "number":
      return { precision: Math.min(8, Math.max(0, Math.round(o.precision ?? 0))), format: o.format ?? "decimal", symbol: o.symbol };
    case "date":
      return { includeTime: Boolean(o.includeTime) };
    case "longText":
      return o.richText ? { richText: true } : {};
    case "link":
      if (!o.linkedTableId || !d.tables[o.linkedTableId]) fail("Pick a table to link to");
      return { linkedTableId: o.linkedTableId, inverseFieldId: o.inverseFieldId ?? null };
    case "lookup":
    case "rollup":
    case "count": {
      const lf = d.fields[o.linkFieldId ?? ""];
      if (!lf || lf.type !== "link" || lf.tableId !== tableId) fail("Pick a link field in this table");
      if (type === "count") return { linkFieldId: lf.id };
      const tf = d.fields[o.targetFieldId ?? ""];
      if (!tf || tf.tableId !== lf.options.linkedTableId) fail("Pick a field from the linked table");
      if (type === "lookup") return { linkFieldId: lf.id, targetFieldId: tf.id };
      if (o.fn === "formula") return { linkFieldId: lf.id, targetFieldId: tf.id, fn: "formula", expression: checkRollupFormula(o.expression) };
      if (o.fn && !ROLLUP_FNS.includes(o.fn)) fail("Unknown rollup summary");
      return { linkFieldId: lf.id, targetFieldId: tf.id, fn: o.fn ?? "sum" };
    }
    case "rating":
      return { max: Math.min(Math.max(Math.round(Number(o.max) || 5), 1), 10) };
    case "duration":
      return { durationFormat: o.durationFormat === "h:mm:ss" ? "h:mm:ss" : "h:mm" };
    case "user":
      return { multiple: Boolean(o.multiple) };
    case "button": {
      const b = o.button ?? { label: "Open", kind: "url" };
      const label = String(b.label ?? "").trim().slice(0, 60) || "Open";
      if (b.kind === "automation") {
        if (b.automationId && !d.automations[b.automationId]) fail("That automation doesn't exist");
        return { button: { label, kind: "automation", automationId: b.automationId } };
      }
      const url = String(b.url ?? "").slice(0, 2000);
      if (url && !/^(https?:\/\/|mailto:|tel:|\{fld)/i.test(url.trim())) fail("Button links must start with https://, mailto: or tel:");
      checkTemplateRefs(d, tableId, url);
      return { button: { label, kind: "url", url } };
    }
    case "formula": {
      const expr = (o.expression ?? "").trim();
      try {
        const refs = referencedIds(parseFormula(expr));
        for (const id of refs) {
          const f = d.fields[id];
          if (!f || f.tableId !== tableId) fail("The formula refers to a field that doesn't exist");
          if (id === fieldId) fail("A formula can't refer to itself");
        }
      } catch (e) {
        if (e instanceof FormulaError) fail(`Formula error: ${e.message}`);
        throw e;
      }
      return { expression: expr };
    }
    default:
      return {};
  }
}

function checkTrigger(d: Draft, au: Automation) {
  const t = au.trigger;
  const viewIn = (viewId: string | null, type?: string) => {
    if (viewId === null) return;
    const v = d.views[viewId];
    if (!v || v.tableId !== t.tableId || (type && v.type !== type)) fail("The trigger's view isn't in that table");
  };
  switch (t.type) {
    case "recordCreated": case "recordUpdated": case "recordMatches": return;
    case "formSubmitted": return viewIn(t.viewId, "form");
    case "enteredView": if (!t.viewId) fail("Pick a view"); return viewIn(t.viewId);
    case "schedule":
      if (!["hour", "day", "week"].includes(t.every)) fail("Pick how often the schedule runs");
      for (const [k, max] of [["minute", 59], ["hourUtc", 23], ["weekdayUtc", 6]] as const) {
        if (!Number.isInteger(t[k]) || t[k] < 0 || t[k] > max) fail("The schedule's time isn't valid");
      }
      return viewIn(t.viewId);
    default:
      fail("Unknown trigger");
  }
}

/** Check steps (and the steps inside branches and loops). `tableId` is the current record's table, or null when there's none. */
function checkSteps(d: Draft, steps: AutomationStep[], tableId: string | null, depth: number) {
  if (depth > MAX_DEPTH) fail(`Branches and loops can be nested ${MAX_DEPTH} deep at most`);
  const fieldsIn = (values: Record<string, string>, table: string) => {
    if (!values || typeof values !== "object") fail("A step's values must be a map");
    for (const [fid, v] of Object.entries(values)) {
      const f = d.fields[fid];
      if (!f || f.tableId !== table || isComputed(f.type)) fail("A step sets a field that can't be set");
      if (typeof v !== "string" || v.length > 10_000) fail("A step's value is too long");
    }
  };
  const text = (v: unknown, max: number, what: string) => { if (typeof v !== "string" || v.length > max) fail(`The ${what} is missing or too long`); };
  for (const s of steps) {
    switch (s.type) {
      case "sendEmail":
        for (const k of ["to", "subject", "body"] as const) {
          if (typeof s[k] !== "string") fail("An email step needs a recipient, subject and message");
          if (s[k].length > EMAIL_LIMITS[k]) fail(`The email ${k === "to" ? "recipient list" : k} is too long`);
        }
        if (!s.to.trim()) fail("An email step needs someone to send to");
        break;
      case "updateRecord":
        if (!tableId) fail("There's no record to update here (a schedule needs a view for that)");
        fieldsIn(s.values, tableId!);
        break;
      case "createRecord":
        if (!d.tables[s.tableId]) fail("A step points to a missing table");
        fieldsIn(s.values, s.tableId);
        break;
      case "condition":
        if (!tableId) fail("Conditions need a record to check (a schedule needs a view for that)");
        if (!s.filters || !Array.isArray(s.filters.conditions)) fail("A condition needs its rules");
        for (const c of s.filters.conditions) if (d.fields[c.fieldId]?.tableId !== tableId) fail("A condition checks a field that isn't on the record");
        if (!Array.isArray(s.then) || !Array.isArray(s.otherwise)) fail("A condition needs its two branches");
        checkSteps(d, s.then, tableId, depth + 1);
        checkSteps(d, s.otherwise, tableId, depth + 1);
        break;
      case "forEach": {
        const lf = d.fields[s.linkFieldId];
        if (!tableId || !lf || lf.type !== "link" || lf.tableId !== tableId) fail("Repeat needs a link field on the record");
        if (!Array.isArray(s.steps)) fail("Repeat needs its steps");
        checkSteps(d, s.steps, lf!.options.linkedTableId ?? null, depth + 1);
        break;
      }
      case "script":
        text(s.code, MAX_SCRIPT_LENGTH, "script");
        break;
      case "slack":
        text(s.connectionId, 40, "Slack connection"); text(s.text, 3000, "Slack message");
        break;
      case "sheets":
        text(s.connectionId, 40, "Google Sheets connection");
        if (!Array.isArray(s.columns) || s.columns.length > 50) fail("A sheet row can have up to 50 columns");
        s.columns.forEach((c) => text(c, 5000, "column value"));
        break;
      case "webhook":
        text(s.connectionId, 40, "webhook connection"); text(s.body, 20_000, "webhook body");
        break;
      default:
        fail("Unknown automation step");
    }
  }
}

export const MAX_PAGE_ELEMENTS = 40;
const AGGREGATES = new Set(["count", "sum", "avg", "min", "max"]);

/**
 * Check a page and its elements. References to things that no longer exist are
 * dropped (`lenient`, used by undo) or refused.
 */
function checkPage(d: Draft, input: InterfacePage, lenient = false): InterfacePage {
  if (!input || !isId(input.id, "pag")) fail("Invalid page id");
  const name = cleanName(input.name, "Page");
  if (!Array.isArray(input.elements) || input.elements.length > MAX_PAGE_ELEMENTS) fail(`A page can have up to ${MAX_PAGE_ELEMENTS} elements`);
  const ids = new Set<string>();
  const elements: PageElement[] = [];
  const bad = (msg: string): null => { if (lenient) return null; return fail(msg); };
  for (const raw of input.elements) {
    const e = structuredClone(raw) as PageElement;
    if (!isId(e?.id, "elm") || ids.has(e.id)) fail("Each element needs a unique id");
    ids.add(e.id);
    for (const [k, min, max] of [["x", 0, 11], ["y", 0, 500], ["w", 1, 12], ["h", 1, 40]] as const) {
      if (!Number.isInteger(e[k]) || e[k] < min || e[k] > max) fail("An element's position isn't valid");
    }
    if (e.x + e.w > 12) fail("An element doesn't fit on the page");
    e.title = typeof e.title === "string" ? e.title.slice(0, 200) : "";
    const fieldIn = (id: string | null, tableId: string) => id === null || d.fields[id]?.tableId === tableId;
    if ("source" in e) {
      const t = d.tables[e.source?.tableId];
      if (!t) { if (bad("An element points to a missing table") === null) continue; }
      if (e.source.viewId !== null && d.views[e.source.viewId]?.tableId !== e.source.tableId) {
        if (lenient) e.source.viewId = null; else fail("An element points to a view that isn't in its table");
      }
    }
    switch (e.kind) {
      case "number":
      case "chart":
        if (!AGGREGATES.has(e.fn)) fail("Pick how to sum up the values");
        if (e.fn !== "count" && !e.fieldId) fail("Pick a field to sum up");
        if (!fieldIn(e.fieldId, e.source.tableId)) { if (bad("An element uses a missing field") === null) continue; }
        if (e.kind === "chart") {
          if (!["bar", "line", "pie"].includes(e.chartType)) fail("Unknown chart type");
          if (!fieldIn(e.groupFieldId, e.source.tableId) || !e.groupFieldId) { if (bad("Pick a field to group the chart by") === null) continue; }
        }
        break;
      case "list":
        if (!Array.isArray(e.fieldIds) || e.fieldIds.length > 20) fail("A list shows up to 20 fields");
        e.fieldIds = e.fieldIds.filter((id) => fieldIn(id, e.source.tableId));
        if (!Number.isInteger(e.limit) || e.limit < 1 || e.limit > 500) e.limit = 50;
        break;
      case "map":
        if (!e.locationFieldId || !fieldIn(e.locationFieldId, e.source.tableId) || !fieldIn(e.lngFieldId, e.source.tableId) || !fieldIn(e.labelFieldId, e.source.tableId)) {
          if (bad("Pick the map's location fields") === null) continue;
        }
        break;
      case "text":
        if (typeof e.text !== "string" || e.text.length > 20_000) fail("The text is too long");
        break;
      case "button": {
        e.label = typeof e.label === "string" && e.label.trim() ? e.label.slice(0, 80) : "Button";
        const act = e.action;
        if (act?.type === "url") { if (!/^(https?:\/\/|mailto:|tel:)/i.test(act.url ?? "") || act.url.length > 2000) fail("A button link must start with https://, http://, mailto: or tel:"); }
        else if (act?.type === "automation") { if (!d.automations[act.automationId]) { if (bad("The button's automation doesn't exist") === null) continue; } }
        else if (act?.type === "view") { if (!d.views[act.viewId]) { if (bad("The button's view doesn't exist") === null) continue; } }
        else fail("Pick what the button does");
        break;
      }
      default:
        fail("Unknown element type");
    }
    elements.push(e);
  }
  const page: InterfacePage = { id: input.id, name, elements };
  const kind = input.kind ?? "dashboard";
  if (!["dashboard", "record", "print"].includes(kind)) fail("Unknown page type");
  if (kind !== "dashboard") page.kind = kind;
  const tableOk = (id: string | null | undefined) => Boolean(id && d.tables[id]);
  if (kind === "record" || kind === "print") {
    if (!tableOk(input.tableId)) { if (!lenient) fail("Pick a table for the page"); }
    else page.tableId = input.tableId!;
    page.viewId = input.viewId && page.tableId && d.views[input.viewId]?.tableId === page.tableId ? input.viewId : null;
    const inTable = (id: string | null | undefined) => Boolean(id && page.tableId && d.fields[id]?.tableId === page.tableId);
    if (kind === "record") {
      if (!Array.isArray(input.fieldIds ?? []) || (input.fieldIds ?? []).length > 100) fail("A record page shows up to 100 fields");
      page.fieldIds = (input.fieldIds ?? []).filter(inTable);
    } else {
      page.paper = input.paper === "letter" ? "letter" : "a4";
      if (!Array.isArray(input.items ?? []) || (input.items ?? []).length > MAX_PRINT_ITEMS) fail(`A print layout holds up to ${MAX_PRINT_ITEMS} items`);
      const seen = new Set<string>();
      page.items = [];
      for (const raw of input.items ?? []) {
        const it = structuredClone(raw) as PrintItem;
        if (!isId(it?.id, "prt") || seen.has(it.id)) fail("Each print item needs a unique id");
        seen.add(it.id);
        if (!["field", "text", "image", "line"].includes(it.kind)) fail("Unknown print item");
        for (const k of ["x", "y", "w", "h"] as const) if (typeof it[k] !== "number" || !Number.isFinite(it[k]) || it[k] < 0 || it[k] > 400) fail("A print item's position isn't valid");
        if ((it.kind === "field" || it.kind === "image") && !inTable(it.fieldId)) { if (lenient) continue; fail("A print item uses a field that isn't in the table"); }
        it.text = typeof it.text === "string" ? it.text.slice(0, 5000) : "";
        it.size = Math.min(72, Math.max(6, Number(it.size) || 11));
        it.bold = Boolean(it.bold);
        it.label = Boolean(it.label);
        it.align = it.align === "center" || it.align === "right" ? it.align : "left";
        page.items.push(it);
      }
    }
  }
  if (input.controls !== undefined) {
    if (!Array.isArray(input.controls) || input.controls.length > 8) fail("A page can have up to 8 filters");
    page.controls = [];
    for (const ctl of input.controls) {
      if (!isId(ctl?.id, "ctl")) fail("Invalid filter id");
      if (!tableOk(ctl.tableId) || d.fields[ctl.fieldId]?.tableId !== ctl.tableId) { if (lenient) continue; fail("A page filter uses a missing field"); }
      page.controls.push({ id: ctl.id, tableId: ctl.tableId, fieldId: ctl.fieldId });
    }
  }
  if (input.shareToken != null) {
    if (typeof input.shareToken !== "string" || !PUBLIC_TOKEN_RE.test(input.shareToken)) fail("Invalid public page link");
    if (kind === "print") fail("Print layouts can't be published");
    page.shareToken = input.shareToken;
  }
  return page;
}

export const MAX_PRINT_ITEMS = 60;

/** {fldId} placeholders must point at fields in this table. */
function checkTemplateRefs(d: Draft, tableId: string, template: string) {
  for (const m of template.matchAll(/\{(fld[A-Za-z0-9]{14})\}/g)) {
    if (d.fields[m[1]]?.tableId !== tableId) fail("The text refers to a field that doesn't exist");
  }
}

const ROLLUP_FNS: string[] = ["sum", "avg", "min", "max", "count", "counta", "concat", "and", "or"];

/** A rollup formula works on `values` only; other fields belong in a formula field. */
function checkRollupFormula(src: string | undefined): string {
  const expr = (src ?? "").trim();
  if (expr.length > 5000) fail("The rollup formula is too long");
  try {
    if (referencedIds(parseFormula(expr, { vars: ["VALUES"] })).size) fail("A rollup formula can only use values, not other fields");
  } catch (e) {
    if (e instanceof FormulaError) fail(`Formula error: ${e.message}`);
    throw e;
  }
  return expr;
}

/** Set a link cell and keep the other side in sync. */
function setLinkCell(d: Draft, field: Field, rowId: string, value: CellValue) {
  const row = d.row(rowId);
  const linkedTableId = field.options.linkedTableId!;
  const wanted = ((value as string[] | null) ?? []).filter((id) => d.rows[id]?.tableId === linkedTableId);
  const before = ((row.cells[field.id] as string[] | undefined) ?? []).slice();
  if (wanted.length) row.cells[field.id] = wanted;
  else delete row.cells[field.id];
  syncInverse(d, field, rowId, wanted.filter((id) => !before.includes(id)), before.filter((id) => !wanted.includes(id)));
}

/** Most links one link.add / link.remove may carry. */
const MAX_LINK_IDS = 5000;

/**
 * Add or remove some links in one cell without touching the others. Records
 * already linked (or already unlinked) are left as they are, so repeating a
 * change, or two people making the same change, is harmless.
 */
function changeLinks(d: Draft, a: { rowId: string; fieldId: string; linkedRowIds: string[] }, adding: boolean) {
  const row = d.rows[a.rowId] ?? fail("Row not found");
  const field = d.fields[a.fieldId];
  if (!field || field.tableId !== row.tableId) fail("Field is not in this table");
  if (field!.type !== "link") fail(`"${field!.name}" is not a link field`);
  if (!Array.isArray(a.linkedRowIds) || a.linkedRowIds.length === 0) fail("No records to link");
  if (a.linkedRowIds.length > MAX_LINK_IDS) fail("Too many records in one change");
  const linkedTableId = field!.options.linkedTableId!;
  const ids = [...new Set(a.linkedRowIds)];
  for (const id of ids) {
    if (typeof id !== "string") fail("Invalid record id");
    // A record someone else just deleted is simply skipped; one from another table is a mistake.
    if (d.rows[id] && d.rows[id].tableId !== linkedTableId) fail("That record is in a different table");
  }
  const current = (row.cells[field!.id] as string[] | undefined) ?? [];
  if (adding) {
    const added = ids.filter((id) => d.rows[id] && !current.includes(id));
    if (!added.length) return;
    d.row(row.id).cells[field!.id] = [...current, ...added];
    syncInverse(d, field!, row.id, added, []);
  } else {
    const removed = ids.filter((id) => current.includes(id));
    if (!removed.length) return;
    const left = current.filter((id) => !removed.includes(id));
    const r = d.row(row.id);
    if (left.length) r.cells[field!.id] = left;
    else delete r.cells[field!.id];
    syncInverse(d, field!, row.id, [], removed);
  }
}

/** Mirror link changes on the other table's side. */
function syncInverse(d: Draft, field: Field, rowId: string, added: string[], removed: string[]) {
  const inverseId = field.options.inverseFieldId;
  if (!inverseId || !d.fields[inverseId]) return;
  for (const id of added) {
    const other = d.row(id);
    const list = (other.cells[inverseId] as string[] | undefined) ?? [];
    if (!list.includes(rowId)) other.cells[inverseId] = [...list, rowId];
  }
  for (const id of removed) {
    if (!d.rows[id]) continue;
    const other = d.row(id);
    const list = ((other.cells[inverseId] as string[] | undefined) ?? []).filter((x) => x !== rowId);
    if (list.length) other.cells[inverseId] = list;
    else delete other.cells[inverseId];
  }
}

function writeCells(d: Draft, row: Row, cells: Record<string, CellValue>) {
  for (const [fieldId, raw] of Object.entries(cells)) {
    const field = d.fields[fieldId];
    if (!field || field.tableId !== row.tableId) fail(`Field ${fieldId} is not in this table`);
    if (isComputed(field.type)) fail(`"${field.name}" is computed and can't be edited`);
    if (field.syncSourceFieldId) fail(`"${field.name}" is synced from another base and can't be edited here`);
    if (field.type === "link") {
      setLinkCell(d, field, row.id, coerceValue(field, raw));
      continue;
    }
    const v = coerceValue(field, raw);
    const r = d.row(row.id);
    if (v === null || v === false) delete r.cells[fieldId];
    else r.cells[fieldId] = v;
  }
}

const SYNC_ID = /^[A-Za-z0-9]{1,40}$/;

function checkSyncConfig(c: TableSync): TableSync {
  for (const k of ["sourceBaseId", "sourceTableId", "sourceViewId", "createdBy"] as const) {
    if (typeof c?.[k] !== "string" || !SYNC_ID.test(c[k])) fail("The sync settings aren't valid");
  }
  return { ...(c.kind === "url" ? { kind: "url" as const } : {}), sourceBaseId: c.sourceBaseId, sourceTableId: c.sourceTableId, sourceViewId: c.sourceViewId, createdBy: c.createdBy,
    sourceLabel: String(c.sourceLabel ?? "").slice(0, 300), lastSyncAt: null, error: null };
}

/** Field types a sync can create (everything else arrives as text or a number). */
const SYNC_TYPES = new Set<FieldType>(["text", "longText", "number", "checkbox", "singleSelect", "multiSelect", "date", "email", "url", "phone", "rating", "duration", "barcode"]);
export const MAX_SYNC_ROWS = 10_000;

/** Write a sync: add/change/drop synced fields, upsert rows matched by source record, remove the rest. */
function applySync(d: Draft, a: Extract<Action, { type: "sync.apply" }>, at: string) {
  const t0 = d.tables[a.tableId] ?? fail("Table not found");
  if (!t0.sync) fail("That table isn't synced");
  if (!Array.isArray(a.fields) || !Array.isArray(a.upserts) || !Array.isArray(a.deleteRowIds) || !Array.isArray(a.removeFieldIds)) fail("Invalid sync");
  if (a.upserts.length > MAX_SYNC_ROWS) fail("Too many records to sync");
  const t = d.table(a.tableId);
  if (a.error) {
    // The source couldn't be read: keep the last good copy and say why.
    t.sync = { ...t.sync!, error: String(a.error).slice(0, 500) };
    return;
  }
  for (const id of a.removeFieldIds) {
    const f = d.fields[id];
    if (f && f.tableId === t.id && f.syncSourceFieldId && f.id !== t.primaryFieldId) deleteField(d, id, true);
  }
  const allowed = new Set<string>();
  for (const def of a.fields) {
    if (!SYNC_TYPES.has(def.fieldType)) fail("A synced field has a type that can't be synced");
    const existing = d.fields[def.fieldId];
    const name = cleanName(def.name, "Field");
    if (existing) {
      if (existing.tableId !== t.id || !existing.syncSourceFieldId) fail("Invalid sync field");
      const f = d.field(def.fieldId);
      const options = validateOptions(d, t.id, f.id, def.fieldType, def.options);
      if (f.type !== def.fieldType) {
        for (const rowId of t.rowOrder) if (d.rows[rowId] && f.id in d.rows[rowId].cells) delete d.row(rowId).cells[f.id];
      }
      f.type = def.fieldType;
      f.options = options;
      f.syncSourceFieldId = def.sourceFieldId;
      if (f.name !== name) {
        // Keep the source's name unless someone here already uses it.
        if (!Object.values(d.fields).some((x) => x.tableId === t.id && x.id !== f.id && x.name.toLowerCase() === name.toLowerCase())) f.name = name;
      }
    } else {
      requireNewId(d, def.fieldId, "fld", d.fields);
      let unique = name;
      for (let n = 2; Object.values(d.fields).some((x) => x.tableId === t.id && x.name.toLowerCase() === unique.toLowerCase()); n++) unique = `${name} (${n})`;
      const options = validateOptions(d, t.id, def.fieldId, def.fieldType, def.options);
      d.put("fields", { id: def.fieldId, tableId: t.id, name: unique, type: def.fieldType, options, syncSourceFieldId: def.sourceFieldId });
      t.fieldOrder.push(def.fieldId);
      hideInCardViews(d, def.fieldId);
    }
    allowed.add(def.fieldId);
  }
  const bySource = new Map<string, string>();
  for (const id of t.rowOrder) { const r = d.rows[id]; if (r?.sourceRowId) bySource.set(r.sourceRowId, id); }
  const newOrder: string[] = [];
  for (const u of a.upserts) {
    if (typeof u.sourceRowId !== "string" || !SYNC_ID.test(u.sourceRowId)) fail("Invalid sync record");
    let rowId = bySource.get(u.sourceRowId);
    if (!rowId) {
      requireNewId(d, u.rowId, "rec", d.rows);
      rowId = u.rowId;
      d.put("rows", { id: rowId, tableId: t.id, cells: {}, createdAt: at, autoNumber: t.nextAutoNumber, sourceRowId: u.sourceRowId, modifiedAt: at, modifiedBy: null });
      t.nextAutoNumber += 1;
      bySource.set(u.sourceRowId, rowId);
    }
    const row = d.rows[rowId];
    let changed = false;
    const next: Record<string, CellValue> = {};
    for (const [fid, raw] of Object.entries(u.cells ?? {})) {
      if (!allowed.has(fid)) fail("A synced record sets a field that isn't synced");
      const v = coerceValue(d.fields[fid], raw);
      if (v !== null && v !== false) next[fid] = v;
    }
    for (const fid of allowed) {
      if (JSON.stringify(row.cells[fid] ?? null) !== JSON.stringify(next[fid] ?? null)) { changed = true; break; }
    }
    if (changed) {
      const r = d.row(rowId);
      for (const fid of allowed) { if (fid in next) r.cells[fid] = next[fid]; else delete r.cells[fid]; }
      r.modifiedAt = at;
      r.modifiedBy = null;
    }
    newOrder.push(rowId);
  }
  const keep = new Set(newOrder);
  const toDelete = a.deleteRowIds.filter((id) => d.rows[id]?.tableId === t.id && !keep.has(id));
  for (const id of toDelete) {
    for (const fid of t.fieldOrder) {
      const f = d.fields[fid];
      if (f?.type === "link" && d.rows[id].cells[fid]) setLinkCell(d, f, id, null);
    }
    d.remove("rows", id);
  }
  // Rows follow the source view's order.
  const gone = new Set(toDelete);
  const extra = t.rowOrder.filter((id) => !keep.has(id) && !gone.has(id) && d.rows[id]);
  t.rowOrder = [...newOrder, ...extra];
  t.sync = { ...t.sync!, sourceLabel: String(a.sourceLabel ?? "").slice(0, 300), lastSyncAt: at, error: a.error ? String(a.error).slice(0, 500) : null };
}

/** Remove a field and every reference to it. */
function deleteField(d: Draft, fieldId: string, removeInverse: boolean) {
  const field = d.fields[fieldId];
  if (!field) return;
  const table = d.table(field.tableId);
  table.fieldOrder = table.fieldOrder.filter((id) => id !== fieldId);
  for (const rowId of table.rowOrder) {
    if (d.rows[rowId] && fieldId in d.rows[rowId].cells) delete d.row(rowId).cells[fieldId];
  }
  for (const viewId of table.viewOrder) {
    const v = d.views[viewId];
    if (!v) continue;
    const c = v.config;
    const refs =
      c.hiddenFieldIds.includes(fieldId) ||
      c.filters.conditions.some((x) => x.fieldId === fieldId) ||
      c.sorts.some((x) => x.fieldId === fieldId) ||
      c.groupBy.some((x) => x.fieldId === fieldId) ||
      c.kanban?.stackFieldId === fieldId ||
      c.kanban?.coverFieldId === fieldId ||
      c.calendar?.dateFieldId === fieldId ||
      c.gallery?.coverFieldId === fieldId ||
      c.form?.fieldIds.includes(fieldId) ||
      (c.summaries && fieldId in c.summaries) ||
      JSON.stringify(c.colors ?? null).includes(fieldId) ||
      JSON.stringify(c.timeline ?? null).includes(fieldId) ||
      c.list?.nestFieldId === fieldId;
    if (!refs) continue;
    const vc = d.view(viewId).config;
    vc.hiddenFieldIds = vc.hiddenFieldIds.filter((x) => x !== fieldId);
    vc.filters.conditions = vc.filters.conditions.filter((x) => x.fieldId !== fieldId);
    vc.sorts = vc.sorts.filter((x) => x.fieldId !== fieldId);
    vc.groupBy = vc.groupBy.filter((x) => x.fieldId !== fieldId);
    if (vc.kanban?.stackFieldId === fieldId) vc.kanban.stackFieldId = null;
    if (vc.kanban?.coverFieldId === fieldId) vc.kanban.coverFieldId = null;
    if (vc.calendar?.dateFieldId === fieldId) vc.calendar.dateFieldId = null;
    if (vc.gallery?.coverFieldId === fieldId) vc.gallery.coverFieldId = null;
    if (vc.summaries) delete vc.summaries[fieldId];
    if (vc.colors?.mode === "select" && vc.colors.fieldId === fieldId) vc.colors = null;
    if (vc.colors?.mode === "conditions") vc.colors.rules = vc.colors.rules.map((r) => ({ ...r, filters: { ...r.filters, conditions: r.filters.conditions.filter((x) => x.fieldId !== fieldId) } }));
    if (vc.timeline) for (const k of ["startFieldId", "endFieldId", "dependencyFieldId"] as const) if (vc.timeline[k] === fieldId) vc.timeline[k] = null;
    if (vc.list?.nestFieldId === fieldId) vc.list.nestFieldId = null;
    if (vc.form) {
      vc.form.fieldIds = vc.form.fieldIds.filter((x) => x !== fieldId);
      if (vc.form.requiredFieldIds) vc.form.requiredFieldIds = vc.form.requiredFieldIds.filter((x) => x !== fieldId);
      if (vc.form.labels) delete vc.form.labels[fieldId];
      if (vc.form.help) delete vc.form.help[fieldId];
    }
  }
  d.remove("fields", fieldId);
  const inv = field.type === "link" ? field.options.inverseFieldId : null;
  if (removeInverse && inv && d.fields[inv]) deleteField(d, inv, false);
}

function createInverseLink(d: Draft, source: Field, inverseFieldId: string | undefined) {
  const linkedTableId = source.options.linkedTableId!;
  if (linkedTableId === source.tableId) {
    source.options.inverseFieldId = null; // links within one table have no inverse
    return;
  }
  if (!inverseFieldId) fail("A link field needs an id for its inverse field");
  requireNewId(d, inverseFieldId!, "fld", d.fields);
  const name = uniqueFieldName(d, linkedTableId, d.tables[source.tableId].name);
  d.put("fields", {
    id: inverseFieldId!, tableId: linkedTableId, name, type: "link",
    options: { linkedTableId: source.tableId, inverseFieldId: source.id },
  });
  d.table(linkedTableId).fieldOrder.push(inverseFieldId!);
  source.options.inverseFieldId = inverseFieldId!;
  hideInCardViews(d, inverseFieldId!);
}

/**
 * Kanban, calendar and gallery cards stay tidy: a new field starts hidden there
 * (like Airtable), and only grid views show it straight away.
 */
const CARD_VIEWS = new Set(["kanban", "calendar", "gallery"]);
function hideInCardViews(d: Draft, fieldId: string) {
  const f = d.fields[fieldId];
  if (!f) return;
  for (const viewId of d.tables[f.tableId]?.viewOrder ?? []) {
    const v = d.views[viewId];
    if (!v || !CARD_VIEWS.has(v.type) || v.config.hiddenFieldIds.includes(fieldId)) continue;
    d.view(viewId).config.hiddenFieldIds.push(fieldId);
  }
}

function defaultConfigFor(d: Draft, tableId: string, type: ViewType, base?: ViewConfig): ViewConfig {
  const c: ViewConfig = base ? structuredClone(base) : defaultViewConfig();
  // A copied form gets its own public link (none until someone turns it on).
  if (c.form) delete c.form.publicToken;
  const fields = d.tables[tableId].fieldOrder.map((id) => d.fields[id]).filter(Boolean);
  if (type === "kanban" && !c.kanban?.stackFieldId) {
    c.kanban = { stackFieldId: fields.find((f) => f.type === "singleSelect")?.id ?? null, coverFieldId: fields.find((f) => f.type === "attachment")?.id ?? null };
  }
  const firstAttachment = fields.find((f) => f.type === "attachment")?.id ?? null;
  if (type === "kanban" && c.kanban && c.kanban.coverFieldId === undefined) c.kanban.coverFieldId = firstAttachment;
  if (type === "gallery" && !c.gallery) c.gallery = { coverFieldId: firstAttachment };
  if (type === "calendar" && !c.calendar?.dateFieldId) {
    c.calendar = { dateFieldId: fields.find((f) => f.type === "date")?.id ?? null };
  }
  if (type === "timeline" && !c.timeline) {
    const dates = fields.filter((f) => f.type === "date");
    c.timeline = { startFieldId: dates[0]?.id ?? null, endFieldId: dates[1]?.id ?? null, scale: "week", dependencyFieldId: null };
  }
  if (type === "list" && !c.list) c.list = { nestFieldId: null };
  if (type === "form" && !c.form) {
    c.form = {
      title: d.tables[tableId].name,
      description: "",
      fieldIds: fields.filter((f) => !isComputed(f.type)).map((f) => f.id),
      submitLabel: "Submit",
      requiredFieldIds: [d.tables[tableId].primaryFieldId],
    };
  }
  return c;
}

/** Keep form settings to sane shapes and sizes. */
function checkForm(f: NonNullable<ViewConfig["form"]>) {
  const text = (v: unknown, max: number, what: string) => {
    if (v === undefined) return;
    if (typeof v !== "string") fail(`Form ${what} must be text`);
    if ((v as string).length > max) fail(`Form ${what} is too long`);
  };
  text(f.title, 500, "title");
  text(f.description, 5000, "description");
  text(f.submitLabel, 100, "button text");
  text(f.thankYou, 5000, "thank-you message");
  if (f.publicToken != null && (typeof f.publicToken !== "string" || !PUBLIC_TOKEN_RE.test(f.publicToken))) fail("Invalid public form link");
  if (!Array.isArray(f.fieldIds)) fail("Form questions must be a list");
  if (f.requiredFieldIds !== undefined && !Array.isArray(f.requiredFieldIds)) fail("Required questions must be a list");
  for (const [key, max] of [["labels", 500], ["help", 2000]] as const) {
    const m = f[key];
    if (m === undefined) continue;
    if (!m || typeof m !== "object" || Array.isArray(m)) fail(`Form ${key} must be a map`);
    for (const v of Object.values(m)) text(v, max, key === "labels" ? "question" : "help text");
  }
}

const VIEW_TYPES = new Set<ViewType>(["grid", "kanban", "calendar", "gallery", "form", "timeline", "list"]);

/** Someone else's personal view can't be changed. */
function checkViewOwner(d: Draft, v: View) {
  if (v.personalFor && d.stamp?.by && v.personalFor !== d.stamp.by) fail("That's someone else's personal view");
}

function checkPermission(d: Draft, p: EditPermission | null | undefined): EditPermission | null {
  if (p === null || p === undefined || p === "editors") return null;
  if (p === "owners") return "owners";
  if (typeof p === "object" && Array.isArray(p.userIds)) {
    const ids = [...new Set(p.userIds.filter((x) => isId(x, "usr")))].slice(0, 200);
    return { userIds: ids };
  }
  return fail("Unknown permission");
}

/** Row height, frozen columns, summaries, colors, timeline and list settings, public link. */
function checkViewExtras(d: Draft, v: View, c: ViewConfig) {
  const fieldIn = (id: string | null | undefined, types?: string[]) => {
    if (!id) return true;
    const f = d.fields[id];
    return Boolean(f && f.tableId === v.tableId && (!types || types.includes(f.type)));
  };
  if (c.rowHeight !== undefined && !(c.rowHeight in ROW_HEIGHTS)) fail("Unknown row height");
  if (c.frozenCount !== undefined && (!Number.isInteger(c.frozenCount) || c.frozenCount < 1 || c.frozenCount > MAX_FROZEN)) fail(`Freeze between 1 and ${MAX_FROZEN} columns`);
  if (c.summaries !== undefined) {
    if (!c.summaries || typeof c.summaries !== "object") fail("Summaries must be a map");
    for (const [fid, fn] of Object.entries(c.summaries)) {
      if (!ALL_SUMMARIES.has(fn)) fail("Unknown summary");
      if (!fieldIn(fid)) delete c.summaries[fid];
    }
  }
  if (c.colors) {
    if (c.colors.mode === "select") {
      if (!fieldIn(c.colors.fieldId, ["singleSelect"])) fail("Color records by a single select field in this table");
    } else if (c.colors.mode === "conditions") {
      if (!Array.isArray(c.colors.rules) || c.colors.rules.length > 20) fail("Up to 20 color rules");
      for (const r of c.colors.rules) {
        if (!CHOICE_COLORS.includes(r.color)) fail("Unknown color");
        if (!r.filters || !Array.isArray(r.filters.conditions)) fail("A color rule needs conditions");
        for (const cond of r.filters.conditions) if (!fieldIn(cond.fieldId)) fail("A color rule checks a field that isn't in this table");
      }
    } else fail("Unknown coloring");
  }
  if (c.timeline) {
    const t = c.timeline;
    const dates = ["date", "createdTime", "lastModifiedTime"];
    if (!fieldIn(t.startFieldId, dates) || !fieldIn(t.endFieldId, dates)) fail("The timeline needs date fields");
    if (!["day", "week", "month"].includes(t.scale)) fail("Unknown timeline scale");
    if (t.dependencyFieldId) {
      const f = d.fields[t.dependencyFieldId];
      if (!f || f.tableId !== v.tableId || f.type !== "link" || f.options.linkedTableId !== v.tableId) fail("Dependencies need a link field to this same table");
    }
  }
  if (c.list?.nestFieldId && !fieldIn(c.list.nestFieldId, ["link"])) fail("Nest records by a link field");
  if (c.shareToken != null && (typeof c.shareToken !== "string" || !PUBLIC_TOKEN_RE.test(c.shareToken))) fail("Invalid public view link");
  if (c.locked !== undefined && typeof c.locked !== "boolean") fail("Invalid lock setting");
}

/** `by` is who made the change (a user id, or null for automations, forms and AI); it's stamped on the records it touches. */
export function applyAction(state: BaseState, action: Action, at?: string, by: string | null = null): BaseState {
  return applyActions(state, [action], at, by);
}

/**
 * Apply a whole batch to one working copy. Same result as applying them one by
 * one, but big batches (imports) don't copy the row map for every action.
 * Throws if any action is invalid; the input state is never modified.
 */
export function applyActions(state: BaseState, actions: Action[], at?: string, by: string | null = null): BaseState {
  const d = new Draft(state);
  const when = at ?? "1970-01-01T00:00:00.000Z";
  d.stamp = { at: when, by };
  for (const a of actions) apply(d, a, when);
  return d.finish();
}

function apply(d: Draft, a: Action, at: string): void {
  switch (a.type) {
    case "base.rename":
      d.base = { ...d.base, name: cleanName(a.name, "Base") };
      return;

    case "table.create": {
      requireNewId(d, a.tableId, "tbl", d.tables);
      requireNewId(d, a.primaryFieldId, "fld", d.fields);
      requireNewId(d, a.viewId, "viw", d.views);
      const name = cleanName(a.name, "Table");
      if (Object.values(d.tables).some((t) => t.name.toLowerCase() === name.toLowerCase())) fail(`A table named "${name}" already exists`);
      const sync = a.sync ? checkSyncConfig(a.sync) : undefined;
      d.put("tables", { id: a.tableId, name, primaryFieldId: a.primaryFieldId, fieldOrder: [a.primaryFieldId], rowOrder: [], viewOrder: [a.viewId], nextAutoNumber: 1, ...(sync ? { sync } : {}) });
      // A synced table's primary field copies the source's primary field (filled in by the first sync).
      d.put("fields", { id: a.primaryFieldId, tableId: a.tableId, name: "Name", type: "text", options: {}, ...(sync ? { syncSourceFieldId: "primary" } : {}) });
      d.put("views", { id: a.viewId, tableId: a.tableId, name: "Grid view", type: "grid", config: defaultViewConfig() });
      d.tableOrder = [...d.tableOrder, a.tableId];
      return;
    }
    case "table.rename": {
      const name = cleanName(a.name, "Table");
      if (Object.values(d.tables).some((t) => t.id !== a.tableId && t.name.toLowerCase() === name.toLowerCase())) fail(`A table named "${name}" already exists`);
      d.table(a.tableId).name = name;
      return;
    }
    case "table.permissions": {
      const t = d.table(a.tableId);
      const p = checkPermission(d, a.recordsEditableBy);
      if (p) t.recordsEditableBy = p;
      else delete t.recordsEditableBy;
      return;
    }
    case "table.delete": {
      const t = d.tables[a.tableId] ?? fail("Table not found");
      if (d.tableOrder.length <= 1) fail("A base needs at least one table");
      // Links from other tables into this one go away too.
      for (const f of Object.values(d.fields)) {
        if (f.tableId !== t.id && f.type === "link" && f.options.linkedTableId === t.id) deleteField(d, f.id, false);
      }
      for (const id of t.rowOrder) d.remove("rows", id);
      for (const id of t.fieldOrder) d.remove("fields", id);
      for (const id of t.viewOrder) d.remove("views", id);
      d.remove("tables", t.id);
      d.tableOrder = d.tableOrder.filter((id) => id !== t.id);
      return;
    }

    case "field.create": {
      if (!d.tables[a.tableId]) fail("Table not found");
      requireNewId(d, a.fieldId, "fld", d.fields);
      const name = cleanName(a.name, "Field");
      assertFieldNameFree(d, a.tableId, name);
      const options = validateOptions(d, a.tableId, a.fieldId, a.fieldType, a.options);
      const field: Field = { id: a.fieldId, tableId: a.tableId, name, type: a.fieldType, options };
      d.put("fields", field);
      const t = d.table(a.tableId);
      const idx = a.afterFieldId ? t.fieldOrder.indexOf(a.afterFieldId) : -1;
      if (idx >= 0) t.fieldOrder.splice(idx + 1, 0, a.fieldId);
      else t.fieldOrder.push(a.fieldId);
      if (a.fieldType === "link") createInverseLink(d, d.field(a.fieldId), a.inverseFieldId);
      hideInCardViews(d, a.fieldId);
      return;
    }
    case "field.update": {
      const old = d.fields[a.fieldId] ?? fail("Field not found");
      if (old.syncSourceFieldId && (a.fieldType !== undefined || a.options !== undefined)) fail("Synced fields take their type and settings from the source base");
      const table = d.tables[old.tableId];
      const f = d.field(a.fieldId);
      if (a.name !== undefined) {
        const name = cleanName(a.name, "Field");
        assertFieldNameFree(d, f.tableId, name, f.id);
        f.name = name;
      }
      if (a.description !== undefined) f.description = a.description;
      if (a.editableBy !== undefined) {
        const p = checkPermission(d, a.editableBy);
        if (p) f.editableBy = p;
        else delete f.editableBy;
      }
      const newType = a.fieldType ?? old.type;
      if (newType === "link" && table.primaryFieldId === f.id) fail("The primary field can't be a link");
      if (a.fieldType !== undefined || a.options !== undefined) {
        const options = validateOptions(d, f.tableId, f.id, newType, a.options ?? (newType === old.type ? old.options : undefined));
        if (newType !== old.type) convertField(d, old, newType, options, a.inverseFieldId, at);
        else {
          // Same type: keep the existing link wiring; drop cells whose select option was removed.
          if (newType === "link") options.inverseFieldId = old.options.inverseFieldId;
          if (newType === "link" && options.linkedTableId !== old.options.linkedTableId) fail("Change the type to switch which table a link points to");
          f.options = options;
          if (newType === "singleSelect" || newType === "multiSelect") {
            for (const rowId of table.rowOrder) {
              const r = d.rows[rowId];
              if (r && f.id in r.cells) {
                const v = coerceValue(f, r.cells[f.id]);
                const nr = d.row(rowId);
                if (v === null) delete nr.cells[f.id];
                else nr.cells[f.id] = v;
              }
            }
          }
        }
      }
      return;
    }
    case "field.delete": {
      const f = d.fields[a.fieldId] ?? fail("Field not found");
      if (d.tables[f.tableId].primaryFieldId === f.id) fail("The primary field can't be deleted");
      if (f.syncSourceFieldId) fail("Synced fields come from the source view; hide the field, or hide it in the source view to stop syncing it");
      deleteField(d, f.id, true);
      return;
    }
    case "field.move": {
      const f = d.fields[a.fieldId] ?? fail("Field not found");
      const t = d.table(f.tableId);
      if (t.primaryFieldId === f.id) fail("The primary field stays first");
      t.fieldOrder = t.fieldOrder.filter((id) => id !== f.id);
      t.fieldOrder.splice(Math.max(1, Math.min(a.toIndex, t.fieldOrder.length)), 0, f.id);
      return;
    }

    case "row.create": {
      if (!d.tables[a.tableId]) fail("Table not found");
      if (d.tables[a.tableId].sync) fail("Records in a synced table come from the source base");
      requireNewId(d, a.rowId, "rec", d.rows);
      const t = d.table(a.tableId);
      const row: Row = { id: a.rowId, tableId: a.tableId, cells: {}, createdAt: a.createdAt ?? at, autoNumber: t.nextAutoNumber };
      if (d.stamp) { row.modifiedAt = d.stamp.at; row.modifiedBy = d.stamp.by; row.createdBy = d.stamp.by; }
      t.nextAutoNumber += 1;
      d.put("rows", row);
      const idx = a.afterRowId ? t.rowOrder.indexOf(a.afterRowId) : -1;
      if (idx >= 0) t.rowOrder.splice(idx + 1, 0, a.rowId);
      else t.rowOrder.push(a.rowId);
      if (a.cells) writeCells(d, row, a.cells);
      return;
    }
    case "row.update": {
      const row = d.rows[a.rowId] ?? fail("Row not found");
      writeCells(d, row, a.cells);
      return;
    }
    case "sync.apply":
      return applySync(d, a, at);
    case "link.add":
    case "link.remove":
      changeLinks(d, a, a.type === "link.add");
      return;
    case "row.move": {
      const ids = [...new Set(a.rowIds)].filter((id) => d.rows[id]);
      if (ids.length === 0) fail("Row not found");
      const tableId = d.rows[ids[0]].tableId;
      if (ids.some((id) => d.rows[id].tableId !== tableId)) fail("Rows can only be moved within one table");
      if (a.afterRowId !== null && (d.rows[a.afterRowId]?.tableId !== tableId || ids.includes(a.afterRowId))) fail("Can't move rows there");
      const t = d.table(tableId);
      const moving = new Set(ids);
      const rest = t.rowOrder.filter((id) => !moving.has(id));
      const at = a.afterRowId === null ? 0 : rest.indexOf(a.afterRowId) + 1;
      rest.splice(at, 0, ...t.rowOrder.filter((id) => moving.has(id)));
      t.rowOrder = rest;
      return;
    }
    case "row.delete": {
      const ids = a.rowIds.filter((id) => d.rows[id]);
      if (ids.length === 0) fail("Row not found");
      if (ids.some((id) => d.tables[d.rows[id].tableId]?.sync)) fail("Records in a synced table come from the source base");
      for (const id of ids) {
        const row = d.rows[id];
        if (!row) continue;
        // Unlink from the other side first.
        for (const fid of d.tables[row.tableId].fieldOrder) {
          const f = d.fields[fid];
          if (f?.type === "link" && row.cells[fid]) setLinkCell(d, f, id, null);
        }
        const t = d.table(row.tableId);
        t.rowOrder = t.rowOrder.filter((x) => x !== id);
        d.remove("rows", id);
      }
      return;
    }

    case "view.create": {
      if (!d.tables[a.tableId]) fail("Table not found");
      requireNewId(d, a.viewId, "viw", d.views);
      const name = cleanName(a.name, "View");
      const from = a.copyFromViewId ? d.views[a.copyFromViewId] : undefined;
      if (!VIEW_TYPES.has(a.viewType)) fail("Unknown view type");
      const config = defaultConfigFor(d, a.tableId, a.viewType, from && from.tableId === a.tableId ? from.config : undefined);
      // A copy starts unlocked and without a public link.
      delete config.locked;
      delete config.shareToken;
      const view: View = { id: a.viewId, tableId: a.tableId, name, type: a.viewType, config };
      if (a.personal) {
        if (!d.stamp?.by) fail("Only a person can have a personal view");
        view.personalFor = d.stamp!.by;
      }
      d.put("views", view);
      d.table(a.tableId).viewOrder.push(a.viewId);
      return;
    }
    case "view.update": {
      const old = d.views[a.viewId] ?? fail("View not found");
      checkViewOwner(d, old);
      // A locked view keeps its settings until someone unlocks it (column widths still adjust).
      const keys = Object.keys(a.config ?? {});
      if (old.config.locked && (a.name !== undefined || keys.some((k) => k !== "locked" && k !== "fieldWidths"))) fail("This view is locked. Unlock it to change it.");
      const v = d.view(a.viewId);
      if (a.name !== undefined) v.name = cleanName(a.name, "View");
      if (a.config) {
        const next = { ...v.config, ...structuredClone(a.config) } as ViewConfig;
        checkViewExtras(d, v, next);
        if (next.kanban?.stackFieldId) {
          const f = d.fields[next.kanban.stackFieldId];
          if (!f || f.tableId !== v.tableId || f.type !== "singleSelect") fail("Kanban stacks need a single select field");
        }
        for (const cover of [next.kanban?.coverFieldId, next.gallery?.coverFieldId]) {
          if (!cover) continue;
          const f = d.fields[cover];
          if (!f || f.tableId !== v.tableId || f.type !== "attachment") fail("The cover must be an attachment field");
        }
        if (next.form) checkForm(next.form);
        if (next.calendar?.dateFieldId) {
          const f = d.fields[next.calendar.dateFieldId];
          if (!f || f.tableId !== v.tableId || !["date", "createdTime"].includes(f.type)) fail("Calendar needs a date field");
        }
        v.config = next;
      }
      return;
    }
    case "view.delete": {
      const v = d.views[a.viewId] ?? fail("View not found");
      checkViewOwner(d, v);
      if (v.config.locked) fail("This view is locked. Unlock it before deleting it.");
      const t = d.table(v.tableId);
      if (t.viewOrder.length <= 1) fail("A table needs at least one view");
      if (!v.personalFor && t.viewOrder.every((id) => id === v.id || d.views[id]?.personalFor)) fail("A table needs at least one view everyone can see");
      t.viewOrder = t.viewOrder.filter((id) => id !== v.id);
      d.remove("views", v.id);
      return;
    }

    case "automation.upsert": {
      const au: Automation = structuredClone(a.automation);
      if (!isId(au.id, "aut")) fail("Invalid automation id");
      cleanName(au.name, "Automation");
      if (!d.tables[au.trigger.tableId]) fail("Pick a table for the trigger");
      checkTrigger(d, au);
      if (!Array.isArray(au.steps)) fail("Steps must be a list");
      if (countSteps(au.steps) > MAX_STEPS) fail(`An automation can have up to ${MAX_STEPS} steps`);
      // A schedule without a view runs with no record; steps can't update "the" record then.
      const startTable = au.trigger.type === "schedule" && !au.trigger.viewId ? null : au.trigger.tableId;
      checkSteps(d, au.steps, startTable, 0);
      d.put("automations", au);
      return;
    }
    case "automation.delete":
      if (!d.automations[a.automationId]) fail("Automation not found");
      d.remove("automations", a.automationId);
      return;
    case "page.upsert":
      d.put("pages", checkPage(d, a.page));
      return;
    case "page.delete":
      if (!d.pages[a.pageId]) fail("Page not found");
      d.remove("pages", a.pageId);
      return;

    case "restore":
      applyRestore(d, a.patch);
      return;

    default:
      // Never silently skip an action this version doesn't understand.
      fail(`Unknown action type "${(a as { type?: unknown }).type}"`);
  }
}

/**
 * Put things back the way a patch describes (undo/redo). Parts that no longer
 * make sense — say, a cell in a row someone else deleted — are skipped, so an
 * undo never fails halfway.
 */
function applyRestore(d: Draft, p: RestorePatch) {
  if (!p || typeof p !== "object") fail("Invalid restore patch");
  const ok = (id: string, prefix: "tbl" | "fld" | "viw" | "rec" | "aut" | "pag") => isId(id, prefix);

  // 1. Tables that need to come back.
  for (const [id, tp] of Object.entries(p.tables ?? {})) {
    if (tp.kind === "put" && ok(id, "tbl") && !d.tables[id] && tp.table.id === id) d.put("tables", structuredClone(tp.table));
  }
  // 2. Remove fields, views, automations and rows the change added.
  for (const [id, f] of Object.entries(p.fields ?? {})) {
    if (f === null && d.fields[id] && d.tables[d.fields[id].tableId]) deleteField(d, id, false);
    else if (f === null) d.remove("fields", id);
  }
  for (const [id, v] of Object.entries(p.views ?? {})) if (v === null && d.views[id]) d.remove("views", id);
  for (const [id, au] of Object.entries(p.automations ?? {})) if (au === null && d.automations[id]) d.remove("automations", id);
  for (const [id, pg] of Object.entries(p.pages ?? {})) if (pg === null && d.pages[id]) d.remove("pages", id);
  for (const [id, rp] of Object.entries(p.rows ?? {})) {
    if (rp.kind !== "delete" || !d.rows[id]) continue;
    const t = d.tables[d.rows[id].tableId];
    if (t) d.table(t.id).rowOrder = d.table(t.id).rowOrder.filter((x) => x !== id);
    d.remove("rows", id);
  }
  // 3. Bring back fields, views and automations as they were.
  for (const [id, f] of Object.entries(p.fields ?? {})) {
    if (f && ok(id, "fld") && f.id === id && d.tables[f.tableId]) d.put("fields", structuredClone(f));
  }
  for (const [id, v] of Object.entries(p.views ?? {})) {
    if (v && ok(id, "viw") && v.id === id && d.tables[v.tableId]) d.put("views", structuredClone(v));
  }
  for (const [id, au] of Object.entries(p.automations ?? {})) {
    if (au && ok(id, "aut") && au.id === id) d.put("automations", structuredClone(au));
  }
  for (const [id, pg] of Object.entries(p.pages ?? {})) {
    if (pg && ok(id, "pag") && pg.id === id) d.put("pages", checkPage(d, structuredClone(pg), true));
  }
  // 4. Rows: whole rows that were deleted, or just the cells that changed.
  for (const [id, rp] of Object.entries(p.rows ?? {})) {
    if (rp.kind === "put") {
      if (ok(id, "rec") && rp.row.id === id && d.tables[rp.row.tableId]) {
        const cells: Record<string, CellValue> = {};
        for (const [fid, v] of Object.entries(rp.row.cells)) if (d.fields[fid]?.tableId === rp.row.tableId) cells[fid] = v;
        d.put("rows", { ...structuredClone(rp.row), cells });
      }
    } else if (rp.kind === "cells" && d.rows[id]) {
      const row = d.row(id);
      for (const [fid, v] of Object.entries(rp.cells)) {
        const f = d.fields[fid];
        if (v === null || v === undefined || !f || f.tableId !== row.tableId) { delete row.cells[fid]; continue; }
        if (isComputed(f.type)) continue;
        // Values were valid when saved, but the field may have changed type since.
        const cv = f.type === "link" ? (v as string[]) : coerceValue(f, v);
        if (cv === null || cv === false) delete row.cells[fid];
        else row.cells[fid] = cv;
      }
    }
  }
  // 4b. Link cells, as add/remove changes. This runs after whole rows come back so
  // a restored record can be linked again. Both sides of each link are in the patch.
  for (const [id, rp] of Object.entries(p.rows ?? {})) {
    if (rp.kind !== "cells" || !rp.links || !d.rows[id]) continue;
    for (const [fid, lp] of Object.entries(rp.links)) {
      const f = d.fields[fid];
      if (!f || f.type !== "link" || f.tableId !== d.rows[id].tableId || !lp) continue;
      const linkedTableId = f.options.linkedTableId;
      const current = (d.rows[id].cells[fid] as string[] | undefined) ?? [];
      const next = applyOrderPatch(current, lp, (x) => d.rows[x]?.tableId === linkedTableId).filter((x) => d.rows[x]);
      if (same(next, current)) continue;
      const row = d.row(id);
      if (next.length) row.cells[fid] = next;
      else delete row.cells[fid];
    }
  }
  // 5. Names and orders of tables that still exist.
  for (const [id, tp] of Object.entries(p.tables ?? {})) {
    if (tp.kind !== "change" || !d.tables[id]) continue;
    const t = d.table(id);
    if (tp.name !== undefined) t.name = tp.name;
    t.rowOrder = applyOrderPatch(t.rowOrder, tp.rowOrder, (x) => d.rows[x]?.tableId === id);
    t.fieldOrder = applyOrderPatch(t.fieldOrder, tp.fieldOrder, (x) => d.fields[x]?.tableId === id);
    t.viewOrder = applyOrderPatch(t.viewOrder, tp.viewOrder, (x) => d.views[x]?.tableId === id);
    // The primary field always stays first.
    if (t.fieldOrder[0] !== t.primaryFieldId && t.fieldOrder.includes(t.primaryFieldId)) {
      t.fieldOrder = [t.primaryFieldId, ...t.fieldOrder.filter((x) => x !== t.primaryFieldId)];
    }
  }
  // Restored rows/fields/views must appear in their table even if order info was lost.
  for (const [id, rp] of Object.entries(p.rows ?? {})) {
    if (rp.kind === "put" && d.rows[id] && !d.tables[d.rows[id].tableId].rowOrder.includes(id)) d.table(d.rows[id].tableId).rowOrder.push(id);
  }
  for (const [id, f] of Object.entries(p.fields ?? {})) {
    if (f && d.fields[id] && !d.tables[f.tableId].fieldOrder.includes(id)) d.table(f.tableId).fieldOrder.push(id);
  }
  for (const [id, v] of Object.entries(p.views ?? {})) {
    if (v && d.views[id] && !d.tables[v.tableId].viewOrder.includes(id)) d.table(v.tableId).viewOrder.push(id);
  }
  // 6. Tables the change added go away, with anything still inside them.
  for (const [id, tp] of Object.entries(p.tables ?? {})) {
    if (tp.kind !== "delete" || !d.tables[id]) continue;
    for (const f of Object.values(d.fields)) {
      if (f.tableId !== id && f.type === "link" && f.options.linkedTableId === id) deleteField(d, f.id, false);
    }
    for (const r of Object.values(d.rows)) if (r.tableId === id) d.remove("rows", r.id);
    for (const f of Object.values(d.fields)) if (f.tableId === id) d.remove("fields", f.id);
    for (const v of Object.values(d.views)) if (v.tableId === id) d.remove("views", v.id);
    d.remove("tables", id);
  }
  // 7. Table order and base name.
  if (p.tableOrder || p.tables) {
    let order = applyOrderPatch(d.tableOrder, p.tableOrder, (x) => Boolean(d.tables[x]));
    order = order.filter((x) => d.tables[x]);
    for (const id of Object.keys(d.tables)) if (!order.includes(id)) order.push(id);
    if (!same(order, d.tableOrder)) d.tableOrder = order;
  }
  if (p.baseName !== undefined) d.base = { ...d.base, name: cleanName(p.baseName, "Base") };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Change a field's type, converting the existing values where it makes sense. */
function convertField(d: Draft, old: Field, newType: FieldType, options: FieldOptions, inverseFieldId: string | undefined, at: string) {
  const table = d.tables[old.tableId];
  // Read the old values as text before changing anything.
  const computer = new Computer(d.snapshot(), new Date(at));
  const texts = new Map<string, string[]>();
  for (const rowId of table.rowOrder) {
    const row = d.rows[rowId];
    if (!row) continue;
    const v = computer.value(row, old);
    if (v instanceof CellError || v === null) continue;
    const list = Array.isArray(v) ? v.map((x) => toText(x)) : [toText(v)];
    texts.set(rowId, list.filter((s) => s !== ""));
  }
  if (old.type === "link" && old.options.inverseFieldId && d.fields[old.options.inverseFieldId]) {
    deleteField(d, old.options.inverseFieldId, false);
  }
  const f = d.field(old.id);
  f.type = newType;
  f.options = options;
  if (newType === "link") createInverseLink(d, f, inverseFieldId);

  for (const rowId of table.rowOrder) {
    if (!d.rows[rowId]) continue;
    const r = d.row(rowId);
    delete r.cells[f.id];
    const list = texts.get(rowId);
    if (!list?.length || isComputed(newType) || newType === "link") continue;
    let value: CellValue;
    if (newType === "singleSelect" || newType === "multiSelect") {
      const parts = newType === "multiSelect" ? list.flatMap((s) => s.split(",")) : [list.join(", ")];
      const { choices, ids } = choicesFromText(f, parts);
      f.options = { ...f.options, choices };
      value = newType === "singleSelect" ? ids[0] ?? null : ids;
    } else if (newType === "checkbox") {
      value = coerceValue(f, list[0]);
    } else {
      value = coerceValue(f, list.join(", "));
    }
    if (value !== null && value !== false) r.cells[f.id] = value;
  }
}
