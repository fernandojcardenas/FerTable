// What the iOS app reads. The server works out everything the web app works out (view filters
// and sorts, formulas, lookups, display text, record colors and edit permissions) so the app
// only shows values and sends ordinary actions back.

import type { BaseState, CellValue, Field, FieldOptions, Role, Row, View } from "./types";
import { CellError, Computer } from "./compute";
import { viewRows, visibleFields } from "./query";
import { isReadOnly } from "./fieldTypes";
import { recordColor, searchRows } from "./viewTools";
import { canChangeRecords, canEditFieldValues } from "./permissions";

export type MobileField = {
  id: string;
  name: string;
  type: Field["type"];
  primary: boolean;
  /** Whether this person can change the field's values. */
  editable: boolean;
  description?: string;
  options: Pick<FieldOptions, "choices" | "includeTime" | "max" | "precision" | "format" | "symbol" | "multiple" | "linkedTableId" | "richText" | "durationFormat">;
};

export type MobileRow = {
  id: string;
  /** Stored values (select option ids, people ids, linked record ids…), for editing. */
  cells: Record<string, CellValue>;
  /** Text to show for every field, computed fields included. */
  display: Record<string, string>;
  color: string | null;
};

const canWrite = (role: Role) => role === "owner" || role === "editor";

function mobileField(f: Field, primaryFieldId: string, userId: string | null, role: Role): MobileField {
  const o = f.options;
  const options: MobileField["options"] = {};
  for (const k of ["choices", "includeTime", "max", "precision", "format", "symbol", "multiple", "linkedTableId", "richText", "durationFormat"] as const) {
    if (o[k] !== undefined) (options as Record<string, unknown>)[k] = o[k];
  }
  return {
    id: f.id, name: f.name, type: f.type, primary: f.id === primaryFieldId,
    editable: canWrite(role) && !isReadOnly(f) && canEditFieldValues(f, userId, role),
    ...(f.description ? { description: f.description } : {}),
    options,
  };
}

function mobileRow(c: Computer, row: Row, fields: Field[], view?: View): MobileRow {
  const display: Record<string, string> = {};
  for (const f of fields) {
    const v = c.value(row, f);
    const text = v instanceof CellError ? "#ERROR" : c.display(row, f);
    if (text) display[f.id] = text;
  }
  return { id: row.id, cells: row.cells, display, color: view ? recordColor(c, row, view.config.colors) : null };
}

/** Tables and views of a base, without records. Other people's personal views are left out. */
export function baseOutline(state: BaseState, userId: string | null, role: Role) {
  return {
    base: { id: state.base.id, name: state.base.name, txn: state.base.txn },
    role,
    tables: state.tableOrder.map((id) => state.tables[id]).filter(Boolean).map((t) => ({
      id: t.id,
      name: t.name,
      primaryFieldId: t.primaryFieldId,
      synced: Boolean(t.sync),
      canAddRecords: canWrite(role) && !t.sync && canChangeRecords(t, userId, role),
      views: t.viewOrder.map((v) => state.views[v])
        .filter((v): v is View => Boolean(v) && (!v.personalFor || v.personalFor === userId))
        .map((v) => ({ id: v.id, name: v.name, type: v.type })),
    })),
  };
}

export const MOBILE_MAX_ROWS = 2000;

/** A view's records as the app shows them: its filters, sorts and visible fields. */
export function mobileViewRecords(state: BaseState, view: View, userId: string | null, role: Role, query = "") {
  const c = new Computer(state);
  const table = state.tables[view.tableId];
  const fields = visibleFields(state, view);
  const all = searchRows(c, viewRows(c, state, view), fields, query);
  const rows = all.slice(0, MOBILE_MAX_ROWS);
  // Kanban views stack by a select field; grids may group. The app shows these as sections.
  const groupFieldId = view.type === "kanban" ? view.config.kanban?.stackFieldId ?? null : view.config.groupBy?.[0]?.fieldId ?? null;
  return {
    view: { id: view.id, name: view.name, type: view.type, tableId: view.tableId, groupFieldId },
    fields: fields.map((f) => mobileField(f, table.primaryFieldId, userId, role)),
    rows: rows.map((r) => mobileRow(c, r, fields, view)),
    total: all.length,
    truncated: all.length > rows.length,
  };
}

/** One record with every field of its table, for the record screen. */
export function mobileRecord(state: BaseState, rowId: string, userId: string | null, role: Role) {
  const row = state.rows[rowId];
  if (!row) return null;
  const table = state.tables[row.tableId];
  const c = new Computer(state);
  const fields = table.fieldOrder.map((id) => state.fields[id]).filter((f): f is Field => Boolean(f));
  // Names for linked records and people, so the app can show chips without loading other tables.
  const names: Record<string, string> = {};
  for (const f of fields) {
    const raw = row.cells[f.id];
    if (f.type === "link" && Array.isArray(raw)) for (const id of raw as string[]) names[id] = c.primaryName(id);
  }
  return {
    table: { id: table.id, name: table.name, synced: Boolean(table.sync), canDelete: canWrite(role) && !table.sync && canChangeRecords(table, userId, role) },
    fields: fields.map((f) => mobileField(f, table.primaryFieldId, userId, role)),
    row: { ...mobileRow(c, row, fields), createdAt: row.createdAt, autoNumber: row.autoNumber },
    names,
    people: Object.fromEntries(Object.entries(state.people ?? {}).map(([id, p]) => [id, p.name])),
  };
}
