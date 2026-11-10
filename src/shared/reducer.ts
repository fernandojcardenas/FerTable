// Applies one action to a base. The server uses this to validate and persist
// changes; the browser uses the same code for instant (optimistic) updates.
// It must be deterministic: anything time-based comes from the action itself.

import type {
  Action, Automation, BaseState, CellValue, Field, FieldOptions, FieldType, RestorePatch, Row, Table, View, ViewConfig, ViewType,
} from "./types";
import { applyOrderPatch } from "./history";
import { choicesFromText, coerceValue, defaultOptions, isComputed } from "./fieldTypes";
import { CellError, Computer } from "./compute";
import { FormulaError, parseFormula, referencedIds, toText } from "./formula";
import { isId } from "./ids";
import { EMAIL_LIMITS } from "./automation";
import { PUBLIC_TOKEN_RE } from "./publicForm";

export class ValidationError extends Error {}

const fail = (msg: string): never => {
  throw new ValidationError(msg);
};

export function defaultViewConfig(): ViewConfig {
  return { hiddenFieldIds: [], filters: { conjunction: "and", conditions: [] }, sorts: [], groupBy: [] };
}

export function emptyBase(id: string, name: string): BaseState {
  return { base: { id, name, txn: 0 }, tableOrder: [], tables: {}, fields: {}, rows: {}, views: {}, automations: {} };
}

type MapKey = "tables" | "fields" | "rows" | "views" | "automations";

/** Copy-on-write helper so unchanged objects keep their identity (used to find what to save). */
class Draft {
  base;
  tableOrder;
  private maps: { [K in MapKey]: BaseState[K] };
  private copiedMaps = new Set<string>();
  private copied = new Set<string>();

  constructor(private src: BaseState) {
    this.base = src.base;
    this.tableOrder = src.tableOrder;
    this.maps = { tables: src.tables, fields: src.fields, rows: src.rows, views: src.views, automations: src.automations };
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
    return (this.map("rows")[id] = { ...r, cells: { ...r.cells } });
  }
  view(id: string): View {
    const v = this.views[id] ?? fail(`View ${id} not found`);
    if (this.copied.has(id)) return v;
    this.copied.add(id);
    return (this.map("views")[id] = structuredClone(v));
  }
  put<K extends "tables" | "fields" | "rows" | "views" | "automations">(k: K, obj: BaseState[K][string]) {
    this.copied.add(obj.id);
    (this.map(k) as Record<string, unknown>)[obj.id] = obj;
  }
  remove(k: "tables" | "fields" | "rows" | "views" | "automations", id: string) {
    delete (this.map(k) as Record<string, unknown>)[id];
  }
  snapshot(): BaseState {
    return { base: this.base, tableOrder: this.tableOrder, ...this.maps };
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
      c.form?.fieldIds.includes(fieldId);
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

export function applyAction(state: BaseState, action: Action, at?: string): BaseState {
  const d = new Draft(state);
  apply(d, action, at ?? "1970-01-01T00:00:00.000Z");
  return d.finish();
}

/**
 * Apply a whole batch to one working copy. Same result as applying them one by
 * one, but big batches (imports) don't copy the row map for every action.
 * Throws if any action is invalid; the input state is never modified.
 */
export function applyActions(state: BaseState, actions: Action[], at?: string): BaseState {
  const d = new Draft(state);
  for (const a of actions) apply(d, a, at ?? "1970-01-01T00:00:00.000Z");
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
      d.put("tables", { id: a.tableId, name, primaryFieldId: a.primaryFieldId, fieldOrder: [a.primaryFieldId], rowOrder: [], viewOrder: [a.viewId], nextAutoNumber: 1 });
      d.put("fields", { id: a.primaryFieldId, tableId: a.tableId, name: "Name", type: "text", options: {} });
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
      const table = d.tables[old.tableId];
      const f = d.field(a.fieldId);
      if (a.name !== undefined) {
        const name = cleanName(a.name, "Field");
        assertFieldNameFree(d, f.tableId, name, f.id);
        f.name = name;
      }
      if (a.description !== undefined) f.description = a.description;
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
      requireNewId(d, a.rowId, "rec", d.rows);
      const t = d.table(a.tableId);
      const row: Row = { id: a.rowId, tableId: a.tableId, cells: {}, createdAt: a.createdAt ?? at, autoNumber: t.nextAutoNumber };
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
      const config = defaultConfigFor(d, a.tableId, a.viewType, from && from.tableId === a.tableId ? from.config : undefined);
      d.put("views", { id: a.viewId, tableId: a.tableId, name, type: a.viewType, config });
      d.table(a.tableId).viewOrder.push(a.viewId);
      return;
    }
    case "view.update": {
      const v = d.view(a.viewId);
      if (a.name !== undefined) v.name = cleanName(a.name, "View");
      if (a.config) {
        const next = { ...v.config, ...structuredClone(a.config) } as ViewConfig;
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
      const t = d.table(v.tableId);
      if (t.viewOrder.length <= 1) fail("A table needs at least one view");
      t.viewOrder = t.viewOrder.filter((id) => id !== v.id);
      d.remove("views", v.id);
      return;
    }

    case "automation.upsert": {
      const au: Automation = structuredClone(a.automation);
      if (!isId(au.id, "aut")) fail("Invalid automation id");
      cleanName(au.name, "Automation");
      if (!d.tables[au.trigger.tableId]) fail("Pick a table for the trigger");
      if (!Array.isArray(au.steps) || au.steps.length > 50) fail("An automation can have up to 50 steps");
      for (const s of au.steps) {
        if (s.type === "sendEmail") {
          for (const k of ["to", "subject", "body"] as const) {
            if (typeof s[k] !== "string") fail("An email step needs a recipient, subject and message");
            if (s[k].length > EMAIL_LIMITS[k]) fail(`The email ${k === "to" ? "recipient list" : k} is too long`);
          }
          if (!s.to.trim()) fail("An email step needs someone to send to");
          continue;
        }
        if (s.type !== "updateRecord" && s.type !== "createRecord") fail("Unknown automation step");
        const tableId = s.type === "createRecord" ? s.tableId : au.trigger.tableId;
        if (!d.tables[tableId]) fail("A step points to a missing table");
        for (const fid of Object.keys(s.values)) {
          const f = d.fields[fid];
          if (!f || f.tableId !== tableId || isComputed(f.type)) fail("A step sets a field that can't be set");
        }
      }
      d.put("automations", au);
      return;
    }
    case "automation.delete":
      if (!d.automations[a.automationId]) fail("Automation not found");
      d.remove("automations", a.automationId);
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
  const ok = (id: string, prefix: "tbl" | "fld" | "viw" | "rec" | "aut") => isId(id, prefix);

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
