// Per-record history. When a batch of changes is saved we compare each touched
// record before and after, and keep what changed as display text (so history
// still reads correctly after fields are renamed, retyped or options deleted).

import type { Action, BaseState, CellValue, FieldType, Row } from "./types";
import { Computer } from "./compute";
import { isComputed } from "./fieldTypes";

export type HistoryKind = "created" | "updated" | "deleted" | "restored";

export type FieldChange = {
  fieldId: string; name: string; from: string; to: string;
  /** For "updated" entries: the field's type and the stored value it had before, so it can be restored. */
  type?: FieldType;
  before?: CellValue | null;
};

/** Values bigger than this aren't kept for restoring (the text above still is). */
const MAX_RAW = 20_000;
const NOT_RESTORABLE = new Set<FieldType>(["attachment"]);

export type RowHistoryEntry = {
  rowId: string;
  kind: HistoryKind;
  /** The record's name at the time, so deleted records still read well. */
  title: string;
  changes: FieldChange[];
  /** For "deleted": the record as it was, with its fields' types, so it can be brought back. */
  snapshot?: DeletedSnapshot;
};

export type DeletedSnapshot = { row: Row; types: Record<string, FieldType> };

const MAX_TEXT = 500;
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * What happened to each record between two states. Only real edits to a record
 * count: cells that change because a field was deleted, added or retyped are
 * schema changes, not record edits, so they're left out.
 */
export function rowHistory(before: BaseState, after: BaseState, actions: Action[], at: string): RowHistoryEntry[] {
  if (before.rows === after.rows) return [];
  const when = new Date(at);
  const cBefore = new Computer(before, when);
  const cAfter = new Computer(after, when);
  const restoring = actions.some((a) => a.type === "restore");
  const out: RowHistoryEntry[] = [];

  const stableField = (fid: string) => {
    const f = after.fields[fid];
    const g = before.fields[fid];
    return f && g && f.type === g.type && f.tableId === g.tableId ? f : null;
  };
  const filled = (c: Computer, row: Row): FieldChange[] => {
    const table = c.state.tables[row.tableId];
    return (table?.fieldOrder ?? [])
      .map((fid) => c.state.fields[fid])
      .filter((f) => f && row.cells[f.id] !== undefined && row.cells[f.id] !== null)
      .map((f) => ({ fieldId: f.id, name: f.name, from: "", to: clip(c.display(row, f)) }))
      .filter((ch) => ch.to !== "");
  };

  for (const id of Object.keys(after.rows)) {
    const was = before.rows[id];
    const now = after.rows[id];
    if (was === now) continue;
    if (!was) {
      out.push({ rowId: id, kind: restoring ? "restored" : "created", title: clip(cAfter.primaryName(id)), changes: filled(cAfter, now) });
      continue;
    }
    const changes: FieldChange[] = [];
    for (const fid of new Set([...Object.keys(was.cells), ...Object.keys(now.cells)])) {
      if (same(was.cells[fid], now.cells[fid])) continue;
      const f = stableField(fid);
      if (!f) continue;
      const from = clip(cBefore.display(was, before.fields[fid]));
      const to = clip(cAfter.display(now, f));
      if (from === to) continue;
      const ch: FieldChange = { fieldId: fid, name: f.name, from, to };
      const raw = was.cells[fid] ?? null;
      if (!NOT_RESTORABLE.has(f.type) && JSON.stringify(raw).length <= MAX_RAW) { ch.type = f.type; ch.before = raw; }
      changes.push(ch);
    }
    if (changes.length) out.push({ rowId: id, kind: "updated", title: clip(cAfter.primaryName(id)), changes });
  }
  for (const id of Object.keys(before.rows)) {
    if (id in after.rows) continue;
    const row = before.rows[id];
    const types: Record<string, FieldType> = {};
    for (const fid of Object.keys(row.cells)) if (before.fields[fid]) types[fid] = before.fields[fid].type;
    // A whole table going away isn't something to restore record by record.
    const snapshot = after.tables[row.tableId] ? { row, types } : undefined;
    out.push({ rowId: id, kind: "deleted", title: clip(cBefore.primaryName(id)), changes: filled(cBefore, row), snapshot });
  }
  return out;
}

/** Link or unlink only what differs, so other people's links in the same cell are kept. */
export function linkChangeActions(state: BaseState, rowId: string, fieldId: string, wanted: string[]): Action[] {
  const current = (state.rows[rowId]?.cells[fieldId] as string[] | undefined) ?? [];
  const add = wanted.filter((id) => !current.includes(id));
  const remove = current.filter((id) => !wanted.includes(id));
  const out: Action[] = [];
  if (add.length) out.push({ type: "link.add", rowId, fieldId, linkedRowIds: add });
  if (remove.length) out.push({ type: "link.remove", rowId, fieldId, linkedRowIds: remove });
  return out;
}

/**
 * Put fields back the way they were before a history entry's change. Fields that
 * were deleted or changed type since, select options that no longer exist, and
 * values too big to have been kept are skipped and named in `skipped`.
 */
export function restoreActions(state: BaseState, rowId: string, changes: FieldChange[]): { actions: Action[]; skipped: string[]; unchanged: boolean } {
  const row = state.rows[rowId];
  const skipped: string[] = [];
  if (!row) return { actions: [], skipped: changes.map((c) => c.name), unchanged: false };
  const cells: Record<string, CellValue> = {};
  const linkActions: Action[] = [];
  let considered = 0;
  for (const ch of changes) {
    const f = state.fields[ch.fieldId];
    if (ch.before === undefined || !ch.type || !f || f.tableId !== row.tableId || f.type !== ch.type || isComputed(f.type)) {
      skipped.push(ch.name);
      continue;
    }
    let v = ch.before;
    if (f.type === "singleSelect" || f.type === "multiSelect") {
      const ids = new Set((f.options.choices ?? []).map((c) => c.id));
      const list = Array.isArray(v) ? (v as string[]) : v ? [v as string] : [];
      if (list.some((id) => !ids.has(id))) { skipped.push(ch.name); continue; }
    }
    considered++;
    if (f.type === "link") {
      const wanted = ((v as string[] | null) ?? []).filter((id) => state.rows[id]);
      linkActions.push(...linkChangeActions(state, rowId, f.id, wanted));
      continue;
    }
    if (v === undefined) v = null;
    if (!same(row.cells[f.id], v)) cells[f.id] = v;
  }
  const actions: Action[] = [...(Object.keys(cells).length ? [{ type: "row.update", rowId, cells } as Action] : []), ...linkActions];
  return { actions, skipped, unchanged: considered > 0 && actions.length === 0 };
}

/**
 * Bring a deleted record back as it was: same id, created time and number. Cells
 * whose field was deleted or retyped since, or whose select option is gone, are
 * left empty; links come back on both sides for linked records that still exist.
 */
export function restoreDeletedActions(state: BaseState, snap: DeletedSnapshot): { actions: Action[]; skipped: string[] } {
  const { row, types } = snap;
  if (state.rows[row.id]) return { actions: [], skipped: [] };
  if (!state.tables[row.tableId]) return { actions: [], skipped: ["the whole table was deleted"] };
  const cells: Record<string, CellValue> = {};
  const links: Action[] = [];
  const skipped: string[] = [];
  for (const [fid, v] of Object.entries(row.cells)) {
    const f = state.fields[fid];
    if (!f || f.tableId !== row.tableId || f.type !== types[fid] || isComputed(f.type)) {
      if (f || types[fid]) skipped.push(f?.name ?? "a deleted field");
      continue;
    }
    if (f.type === "singleSelect" || f.type === "multiSelect") {
      const ids = new Set((f.options.choices ?? []).map((c) => c.id));
      const list = Array.isArray(v) ? (v as string[]) : [v as string];
      if (list.some((id) => !ids.has(id))) { skipped.push(f.name); continue; }
    }
    if (f.type === "link") {
      const ids = ((v as string[]) ?? []).filter((id) => state.rows[id]);
      if (ids.length) links.push({ type: "link.add", rowId: row.id, fieldId: f.id, linkedRowIds: ids });
      continue;
    }
    cells[fid] = v;
  }
  const restore: Action = { type: "restore", patch: { rows: { [row.id]: { kind: "put", row: { ...row, cells } } } } };
  return { actions: [restore, ...links], skipped };
}
