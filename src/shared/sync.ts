// Table sync: build the change that copies a view in one base into a synced table in another.
// Plain fields keep their type; computed, link, user and file fields arrive as text (or a number).

import type { Action, BaseState, CellValue, Field, FieldOptions, FieldType, SyncFieldDef, Table, View } from "./types";
import { Computer } from "./compute";
import { viewRows } from "./query";
import { applyAction, MAX_SYNC_ROWS } from "./reducer";
import { newId } from "./ids";

const SAME_TYPE = new Set<FieldType>(["text", "longText", "number", "checkbox", "singleSelect", "multiSelect", "date", "email", "url", "phone", "rating", "duration", "barcode"]);
const AS_NUMBER = new Set<FieldType>(["count", "autoNumber"]);

/** How a source field is stored in the synced table. */
export function syncedType(f: Field): FieldType {
  if (SAME_TYPE.has(f.type)) return f.type;
  if (AS_NUMBER.has(f.type)) return "number";
  if (f.type === "createdTime" || f.type === "lastModifiedTime") return "date";
  return f.type === "attachment" ? "longText" : "text";
}

function syncedOptions(f: Field, type: FieldType): FieldOptions {
  const o = f.options;
  switch (type) {
    case "number": return f.type === "number" ? { precision: o.precision, format: o.format, symbol: o.symbol } : { precision: 0 };
    case "singleSelect": case "multiSelect": return { choices: (o.choices ?? []).map((c) => ({ ...c })) };
    case "date": return { includeTime: f.type === "date" ? Boolean(o.includeTime) : true };
    case "rating": return { max: o.max };
    case "duration": return { durationFormat: o.durationFormat };
    default: return {};
  }
}

/** The source fields a sync copies: the view's visible fields, primary first; buttons are skipped. */
export function syncedSourceFields(source: BaseState, view: View): Field[] {
  const table = source.tables[view.tableId];
  const hidden = new Set(view.config.hiddenFieldIds);
  return table.fieldOrder
    .map((id) => source.fields[id])
    .filter((f): f is Field => Boolean(f) && f.type !== "button" && (f.id === table.primaryFieldId || !hidden.has(f.id)));
}

export const sourceLabel = (source: BaseState, view: View) => `${source.base.name} › ${source.tables[view.tableId]?.name ?? "?"} › ${view.name}`;

/**
 * The sync.apply action that makes `targetTable` match the source view now, or null
 * when nothing would change (so two bases syncing from each other can't loop forever).
 */
export function buildSync(source: BaseState, view: View, target: BaseState, targetTable: Table, now = new Date(), label?: string): Action | null {
  const sourceTable = source.tables[view.tableId];
  const c = new Computer(source, now);
  const existing = new Map<string, Field>();
  for (const id of targetTable.fieldOrder) {
    const f = target.fields[id];
    if (f?.syncSourceFieldId) existing.set(f.syncSourceFieldId, f);
  }
  const srcFields = syncedSourceFields(source, view);
  const defs: SyncFieldDef[] = srcFields.map((f) => {
    const fieldType = f.id === sourceTable.primaryFieldId && !SAME_TYPE.has(f.type) ? "text" : syncedType(f);
    const fieldId = f.id === sourceTable.primaryFieldId ? targetTable.primaryFieldId : existing.get(f.id)?.id ?? newId("fld");
    return { fieldId, sourceFieldId: f.id, name: f.name, fieldType, options: syncedOptions(f, fieldType) };
  });
  const wanted = new Set(defs.map((d) => d.fieldId));
  const removeFieldIds = [...existing.values()].filter((f) => !wanted.has(f.id) && f.id !== targetTable.primaryFieldId).map((f) => f.id);

  const rows = viewRows(c, source, view).slice(0, MAX_SYNC_ROWS);
  const upserts = rows.map((r) => {
    const cells: Record<string, CellValue> = {};
    srcFields.forEach((f, i) => {
      const def = defs[i];
      let v: CellValue;
      if (SAME_TYPE.has(f.type) && def.fieldType === f.type) v = r.cells[f.id] ?? null;
      else if (def.fieldType === "number") { const n = c.value(r, f); v = typeof n === "number" ? n : null; }
      else if (def.fieldType === "date") v = (c.value(r, f) as string | null) ?? null;
      else v = c.display(r, f) || null;
      if (v !== null && v !== undefined) cells[def.fieldId] = v;
    });
    return { rowId: newId("rec"), sourceRowId: r.id, cells };
  });
  const keep = new Set(rows.map((r) => r.id));
  const deleteRowIds = targetTable.rowOrder.filter((id) => {
    const r = target.rows[id];
    return r?.sourceRowId && !keep.has(r.sourceRowId);
  });
  const action: Action = { type: "sync.apply", tableId: targetTable.id, fields: defs, removeFieldIds, upserts, deleteRowIds, sourceLabel: label ?? sourceLabel(source, view), error: null };
  return changes(target, targetTable, action) ? action : null;
}

/** Would this sync change anything people can see? Tried on a copy, compared without timestamps. */
function changes(target: BaseState, t: Table, a: Action): boolean {
  if (t.sync?.error || !t.sync?.lastSyncAt) return true;
  const after = applyAction(target, a, new Date().toISOString());
  return snapshot(target, t.id) !== snapshot(after, t.id);
}

function snapshot(s: BaseState, tableId: string): string {
  const t = s.tables[tableId];
  const fields = t.fieldOrder.map((id) => s.fields[id]);
  const rows = t.rowOrder.map((id) => { const r = s.rows[id]; return r ? [r.id, r.sourceRowId, r.cells] : null; });
  return JSON.stringify([t.sync?.sourceLabel, fields, rows]);
}
