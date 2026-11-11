// Copying tables and whole bases. A table copy is made of ordinary actions (so it
// syncs and undoes like any other change); a base copy rewrites every id.

import type { Action, BaseState, CellValue, Field, Table, View } from "./types";
import { newId } from "./ids";
import { isComputed } from "./fieldTypes";

const ID_RE = /(?:tbl|fld|viw|rec|aut|pag|elm|att|prt|ctl|cnx)[0-9A-Za-z]{14}/g;

/** Replace every old id with its new one, anywhere in a JSON-able value (other text is left alone). */
export function remapIds<T>(value: T, map: Map<string, string>): T {
  if (map.size === 0 || value === undefined) return value;
  return JSON.parse(JSON.stringify(value).replace(ID_RE, (m) => map.get(m) ?? m)) as T;
}

function uniqueTableName(state: BaseState, name: string): string {
  const taken = new Set(Object.values(state.tables).map((t) => t.name.toLowerCase()));
  let n = `${name} copy`;
  for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${name} copy ${i}`;
  return n;
}

/** Order fields so the ones a field depends on are set up before it. */
function setupRank(f: Field): number {
  if (f.type === "link") return 0;
  if (f.type === "lookup" || f.type === "rollup" || f.type === "count") return 2;
  if (f.type === "formula") return 3;
  return 1;
}

/**
 * Actions that copy a table: its fields (with their settings), views and, optionally, records.
 * Links to other tables get a new link field on the other side; links within the table point
 * at the copied records. A synced table's copy is a normal table.
 */
export function duplicateTableActions(state: BaseState, tableId: string, withRecords: boolean): { tableId: string; actions: Action[]; rows: Action[] } {
  const src = state.tables[tableId];
  if (!src) throw new Error("Table not found");
  const fields = src.fieldOrder.map((id) => state.fields[id]).filter((f): f is Field => Boolean(f));
  const views = src.viewOrder.map((id) => state.views[id]).filter((v): v is View => Boolean(v) && !v.personalFor);
  const rows = withRecords ? src.rowOrder.map((id) => state.rows[id]).filter(Boolean) : [];

  const map = new Map<string, string>();
  const newTableId = newId("tbl");
  map.set(src.id, newTableId);
  for (const f of fields) map.set(f.id, newId("fld"));
  for (const v of views) map.set(v.id, newId("viw"));
  for (const r of rows) map.set(r.id, newId("rec"));
  const firstViewId = newId("viw");

  const actions: Action[] = [
    { type: "table.create", tableId: newTableId, name: uniqueTableName(state, src.name), primaryFieldId: map.get(src.primaryFieldId)!, viewId: firstViewId },
  ];
  // 1. Every other field starts as plain text so later settings can refer to any of them.
  let prev = map.get(src.primaryFieldId)!;
  for (const f of fields) {
    if (f.id === src.primaryFieldId) continue;
    actions.push({ type: "field.create", fieldId: map.get(f.id)!, tableId: newTableId, name: f.name, fieldType: "text", afterFieldId: prev });
    prev = map.get(f.id)!;
  }
  // 2. Then each gets its real type and settings: links first, then lookups and rollups, then formulas.
  for (const f of [...fields].sort((a, b) => setupRank(a) - setupRank(b))) {
    const options = remapIds(f.options, map);
    const sameAsPlainText = f.type === "text" && Object.keys(f.options).length === 0;
    const fieldId = map.get(f.id)!;
    if (f.id === src.primaryFieldId) {
      actions.push({ type: "field.update", fieldId, name: f.name, ...(f.description ? { description: f.description } : {}),
        ...(sameAsPlainText ? {} : { fieldType: f.type, options }) });
      continue;
    }
    if (f.type === "link") {
      // Links within the table have no other side; links elsewhere get a fresh field over there.
      const selfLink = f.options.linkedTableId === src.id;
      actions.push({ type: "field.update", fieldId, fieldType: "link", options: { linkedTableId: selfLink ? newTableId : f.options.linkedTableId },
        ...(selfLink ? {} : { inverseFieldId: newId("fld") }) });
    } else if (!sameAsPlainText) {
      actions.push({ type: "field.update", fieldId, fieldType: f.type, options });
    }
    if (f.description) actions.push({ type: "field.update", fieldId, description: f.description });
  }
  // 3. Views, with their settings pointing at the copied fields. The starter view goes last.
  for (const v of views) {
    const config = remapIds(v.config, map);
    delete config.shareToken;
    delete config.locked;
    if (config.form) delete config.form.publicToken;
    const viewId = map.get(v.id)!;
    actions.push({ type: "view.create", viewId, tableId: newTableId, name: v.name, viewType: v.type });
    actions.push({ type: "view.update", viewId, config });
  }
  if (views.length) actions.push({ type: "view.delete", viewId: firstViewId });
  // 4. Records, keeping their order. Links inside the table point at the copies.
  const copyable = fields.filter((f) => !isComputed(f.type));
  const rowActions: Action[] = [];
  for (const r of rows) {
    const cells: Record<string, CellValue> = {};
    for (const f of copyable) {
      const v = r.cells[f.id];
      if (v === undefined || v === null) continue;
      cells[map.get(f.id)!] = f.type === "link" ? (v as string[]).map((id) => map.get(id) ?? id) : (structuredClone(v) as CellValue);
    }
    rowActions.push({ type: "row.create", rowId: map.get(r.id)!, tableId: newTableId, cells });
  }
  return { tableId: newTableId, actions, rows: rowActions };
}

/**
 * A full copy of a base with new ids everywhere. Records keep their created time and number.
 * Returns the new state and the attachment file ids that need copying (old → new).
 */
export function copyBaseState(state: BaseState, newBaseId: string, name: string, withRecords: boolean, extra?: Map<string, string>): { state: BaseState; files: Map<string, string> } {
  const map = new Map<string, string>(extra ?? []);
  const prefixOf = (id: string) => id.slice(0, 3) as "tbl";
  for (const coll of [state.tables, state.fields, state.views, state.automations, state.pages, withRecords ? state.rows : {}] as Record<string, { id: string }>[]) {
    for (const id of Object.keys(coll)) map.set(id, newId(prefixOf(id)));
  }
  for (const pg of Object.values(state.pages ?? {})) for (const el of pg.elements) map.set(el.id, newId("elm"));
  // Select option ids, filter ids and the like stay as they are: they only need to be unique within their field or view.
  const files = new Map<string, string>();
  if (withRecords) {
    for (const r of Object.values(state.rows)) {
      for (const v of Object.values(r.cells)) {
        if (Array.isArray(v)) for (const a of v) if (a && typeof a === "object" && "url" in a && !files.has(a.id)) files.set(a.id, newId("att"));
      }
    }
  }
  for (const [a, b] of files) map.set(a, b);
  const pick = <T extends { id: string }>(coll: Record<string, T>) => {
    const out: Record<string, T> = {};
    for (const x of Object.values(coll)) out[map.get(x.id)!] = remapIds(x, map);
    return out;
  };
  const tables: Record<string, Table> = {};
  for (const t of Object.values(state.tables)) {
    const copy = remapIds(t, map);
    if (!withRecords) { copy.rowOrder = []; copy.nextAutoNumber = 1; }
    tables[copy.id] = copy;
  }
  const views = pick(state.views);
  for (const v of Object.values(views)) {
    // Public links and personal views belong to the original.
    delete v.config.shareToken;
    if (v.config.form) delete v.config.form.publicToken;
  }
  for (const id of Object.keys(views)) if (views[id].personalFor) {
    const t = tables[views[id].tableId];
    if (t && t.viewOrder.length > 1) { t.viewOrder = t.viewOrder.filter((x) => x !== id); delete views[id]; }
  }
  const automations = pick(state.automations);
  for (const a of Object.values(automations)) a.enabled = false; // copies start switched off
  const pages = pick(state.pages ?? {});
  for (const p of Object.values(pages)) delete p.shareToken;
  const out: BaseState = {
    base: { id: newBaseId, name, txn: 0 },
    tableOrder: state.tableOrder.map((id) => map.get(id)!),
    tables, fields: pick(state.fields), views, automations, pages,
    rows: withRecords ? pick(state.rows) : {},
  };
  return { state: out, files };
}
