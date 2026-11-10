// Undo/redo support. After any change we compare the base before and after and
// build a patch that puts it back. Because the reducer copies only what it
// changes, unchanged objects keep their identity and the comparison is cheap.

import type { Action, BaseState, CellValue, OrderPatch, RestorePatch, RowPatch, Table, TablePatch } from "./types";

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Patch that turns the order `now` back into `was`. */
export function orderPatch(was: string[], now: string[]): OrderPatch | undefined {
  if (was === now) return undefined;
  const wasSet = new Set(was);
  const nowSet = new Set(now);
  const remove = now.filter((id) => !wasSet.has(id));
  const insert: OrderPatch["insert"] = [];
  was.forEach((id, i) => {
    if (!nowSet.has(id)) insert.push({ id, after: i === 0 ? null : was[i - 1] });
  });
  // Items in both lists that changed place (a dragged row or field): keep the longest
  // run that's still in order, and move only the rest back. One drag = a tiny patch.
  const kept = now.filter((id) => wasSet.has(id));
  const wasIndex = new Map(was.map((id, i) => [id, i]));
  const stay = longestInOrder(kept.map((id) => wasIndex.get(id)!));
  if (stay.size !== kept.length) {
    kept.forEach((id) => {
      if (stay.has(wasIndex.get(id)!)) return;
      remove.push(id);
      const i = wasIndex.get(id)!;
      insert.push({ id, after: i === 0 ? null : was[i - 1] });
    });
    insert.sort((a, b) => wasIndex.get(a.id)! - wasIndex.get(b.id)!);
  }
  return remove.length || insert.length ? { remove, insert } : undefined;
}

/** Values of the longest increasing subsequence (O(n log n)). */
function longestInOrder(seq: number[]): Set<number> {
  const tails: number[] = []; // index into seq of the smallest tail for each length
  const prev: number[] = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.add(seq[i]);
  return out;
}

export function applyOrderPatch(list: string[], patch: OrderPatch | undefined, exists: (id: string) => boolean): string[] {
  if (!patch) return list;
  const removed = new Set(patch.remove);
  const out = list.filter((id) => !removed.has(id));
  for (const { id, after } of patch.insert) {
    if (out.includes(id) || !exists(id)) continue;
    if (after === null) out.unshift(id);
    else {
      const i = out.indexOf(after);
      if (i < 0) out.push(id); // its neighbor is gone; put it at the end
      else out.splice(i + 1, 0, id);
    }
  }
  return out;
}

function tablePatch(was: Table | undefined, now: Table | undefined): TablePatch | undefined {
  if (was === now) return undefined;
  if (!was) return { kind: "delete" };
  if (!now) return { kind: "put", table: was };
  const p: Extract<TablePatch, { kind: "change" }> = { kind: "change" };
  if (was.name !== now.name) p.name = was.name;
  p.rowOrder = orderPatch(was.rowOrder, now.rowOrder);
  p.fieldOrder = orderPatch(was.fieldOrder, now.fieldOrder);
  p.viewOrder = orderPatch(was.viewOrder, now.viewOrder);
  return p.name !== undefined || p.rowOrder || p.fieldOrder || p.viewOrder ? p : undefined;
}

function entityPatch<T>(was: Record<string, T>, now: Record<string, T>): Record<string, T | null> | undefined {
  if (was === now) return undefined;
  const out: Record<string, T | null> = {};
  for (const id of Object.keys(now)) if (was[id] !== now[id] && !same(was[id], now[id])) out[id] = was[id] ?? null;
  for (const id of Object.keys(was)) if (!(id in now)) out[id] = was[id];
  return Object.keys(out).length ? out : undefined;
}

/** Build the patch that undoes going from `before` to `after`. */
export function inversePatch(before: BaseState, after: BaseState): RestorePatch {
  const patch: RestorePatch = {};
  if (before.base.name !== after.base.name) patch.baseName = before.base.name;
  const to = orderPatch(before.tableOrder, after.tableOrder);
  if (to) patch.tableOrder = to;

  if (before.tables !== after.tables) {
    const tables: Record<string, TablePatch> = {};
    const ids = new Set([...Object.keys(before.tables), ...Object.keys(after.tables)]);
    for (const id of ids) {
      const p = tablePatch(before.tables[id], after.tables[id]);
      if (p) tables[id] = p;
    }
    if (Object.keys(tables).length) patch.tables = tables;
  }

  const fields = entityPatch(before.fields, after.fields);
  if (fields) patch.fields = fields;
  const views = entityPatch(before.views, after.views);
  if (views) patch.views = views;
  const automations = entityPatch(before.automations, after.automations);
  if (automations) patch.automations = automations;

  if (before.rows !== after.rows) {
    const rows: Record<string, RowPatch> = {};
    for (const id of Object.keys(after.rows)) {
      const was = before.rows[id];
      const now = after.rows[id];
      if (was === now) continue;
      if (!was) { rows[id] = { kind: "delete" }; continue; }
      const cells: Record<string, CellValue> = {};
      const links: Record<string, OrderPatch> = {};
      for (const f of new Set([...Object.keys(was.cells), ...Object.keys(now.cells)])) {
        if (same(was.cells[f], now.cells[f])) continue;
        // Link cells undo as add/remove lists, so links someone else made in between survive.
        if (before.fields[f]?.type === "link" && after.fields[f]?.type === "link") {
          const lp = orderPatch((was.cells[f] as string[] | undefined) ?? [], (now.cells[f] as string[] | undefined) ?? []);
          if (lp) links[f] = lp;
        } else {
          cells[f] = was.cells[f] ?? null;
        }
      }
      const hasLinks = Object.keys(links).length > 0;
      if (Object.keys(cells).length || hasLinks) rows[id] = hasLinks ? { kind: "cells", cells, links } : { kind: "cells", cells };
    }
    for (const id of Object.keys(before.rows)) if (!(id in after.rows)) rows[id] = { kind: "put", row: before.rows[id] };
    if (Object.keys(rows).length) patch.rows = rows;
  }
  return patch;
}

export function isEmptyPatch(p: RestorePatch): boolean {
  return Object.keys(p).length === 0;
}

const LABELS: Partial<Record<Action["type"], string>> = {
  "row.update": "edit", "row.create": "add record", "row.delete": "delete record", "row.move": "move record",
  "link.add": "link record", "link.remove": "unlink record",
  "field.create": "add field", "field.update": "edit field", "field.delete": "delete field", "field.move": "move field",
  "table.create": "add table", "table.rename": "rename table", "table.delete": "delete table",
  "view.create": "add view", "view.update": "change view", "view.delete": "delete view",
  "base.rename": "rename base", "automation.upsert": "change automation", "automation.delete": "delete automation",
};

/** Short description of a change, for "Undo edit" style labels. */
export function describeActions(actions: Action[]): string {
  const main = actions.find((a) => a.type !== "field.update") ?? actions[0];
  if (main?.type === "row.delete" && main.rowIds.length > 1) return `delete ${main.rowIds.length} records`;
  if (main?.type === "table.create") return "add table";
  return (main && LABELS[main.type]) ?? "change";
}
