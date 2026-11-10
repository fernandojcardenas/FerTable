// Filtering, sorting and grouping rows for a view.

import type { BaseState, Field, FilterCondition, Filters, Row, SortSpec, View } from "./types";
import { CellError, Computer } from "./compute";
import { toNumber, toText, type FValue } from "./formula";
import { rollupKind } from "./fieldTypes";

export type FilterKind = "text" | "number" | "checkbox" | "select" | "multi" | "date";

export function filterKind(field: Field): FilterKind {
  switch (field.type) {
    case "number": case "count": case "autoNumber": case "rating": case "duration": return "number";
    case "rollup": return rollupKind(field);
    case "checkbox": return "checkbox";
    case "singleSelect": return "select";
    case "multiSelect": return "multi";
    case "date": case "createdTime": case "lastModifiedTime": return "date";
    default: return "text";
  }
}

export const OPERATORS: Record<FilterKind, { id: string; label: string; needsValue: boolean }[]> = {
  text: [
    { id: "contains", label: "contains", needsValue: true },
    { id: "notContains", label: "does not contain", needsValue: true },
    { id: "is", label: "is", needsValue: true },
    { id: "isNot", label: "is not", needsValue: true },
    { id: "isEmpty", label: "is empty", needsValue: false },
    { id: "isNotEmpty", label: "is not empty", needsValue: false },
  ],
  number: [
    { id: "eq", label: "=", needsValue: true },
    { id: "neq", label: "≠", needsValue: true },
    { id: "lt", label: "<", needsValue: true },
    { id: "lte", label: "≤", needsValue: true },
    { id: "gt", label: ">", needsValue: true },
    { id: "gte", label: "≥", needsValue: true },
    { id: "isEmpty", label: "is empty", needsValue: false },
    { id: "isNotEmpty", label: "is not empty", needsValue: false },
  ],
  checkbox: [
    { id: "checked", label: "is checked", needsValue: false },
    { id: "unchecked", label: "is not checked", needsValue: false },
  ],
  select: [
    { id: "is", label: "is", needsValue: true },
    { id: "isNot", label: "is not", needsValue: true },
    { id: "isEmpty", label: "is empty", needsValue: false },
    { id: "isNotEmpty", label: "is not empty", needsValue: false },
  ],
  multi: [
    { id: "hasAny", label: "has any of", needsValue: true },
    { id: "hasAll", label: "has all of", needsValue: true },
    { id: "hasNone", label: "has none of", needsValue: true },
    { id: "isEmpty", label: "is empty", needsValue: false },
    { id: "isNotEmpty", label: "is not empty", needsValue: false },
  ],
  date: [
    { id: "is", label: "is", needsValue: true },
    { id: "before", label: "is before", needsValue: true },
    { id: "after", label: "is after", needsValue: true },
    { id: "onOrBefore", label: "is on or before", needsValue: true },
    { id: "onOrAfter", label: "is on or after", needsValue: true },
    { id: "isEmpty", label: "is empty", needsValue: false },
    { id: "isNotEmpty", label: "is not empty", needsValue: false },
  ],
};

const empty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

function dayOf(v: FValue): string {
  return toText(v).slice(0, 10);
}

export function matchesCondition(c: Computer, row: Row, cond: FilterCondition): boolean {
  const field = c.field(cond.fieldId);
  if (!field || field.tableId !== row.tableId) return true;
  const kind = filterKind(field);
  const op = OPERATORS[kind].find((o) => o.id === cond.operator);
  if (!op) return true;
  // Conditions without a value yet don't filter anything.
  if (op.needsValue && empty(cond.value)) return true;
  const computed = c.value(row, field);
  const v: FValue = computed instanceof CellError ? null : computed;
  if (cond.operator === "isEmpty") return empty(v) || v === false;
  if (cond.operator === "isNotEmpty") return !(empty(v) || v === false);

  switch (kind) {
    case "text": {
      const hay = c.display(row, field).toLowerCase();
      const needle = toText(cond.value as FValue).toLowerCase();
      if (cond.operator === "contains") return hay.includes(needle);
      if (cond.operator === "notContains") return !hay.includes(needle);
      if (cond.operator === "is") return hay === needle;
      return hay !== needle;
    }
    case "number": {
      if (empty(v)) return cond.operator === "neq";
      const a = toNumber(v);
      const b = toNumber(cond.value as FValue);
      return { eq: a === b, neq: a !== b, lt: a < b, lte: a <= b, gt: a > b, gte: a >= b }[cond.operator as "eq"] ?? true;
    }
    case "checkbox":
      return cond.operator === "checked" ? v === true : v !== true;
    case "select": {
      const raw = row.cells[field.id];
      const wanted = Array.isArray(cond.value) ? (cond.value as string[]) : [String(cond.value)];
      const hit = typeof raw === "string" && wanted.includes(raw);
      return cond.operator === "is" ? hit : !hit;
    }
    case "multi": {
      const raw = (row.cells[field.id] as string[] | null) ?? [];
      const wanted = Array.isArray(cond.value) ? (cond.value as string[]) : [String(cond.value)];
      if (cond.operator === "hasAny") return wanted.some((w) => raw.includes(w));
      if (cond.operator === "hasAll") return wanted.every((w) => raw.includes(w));
      return !wanted.some((w) => raw.includes(w));
    }
    case "date": {
      if (empty(v)) return false;
      const a = dayOf(v);
      const b = dayOf(cond.value as FValue);
      return { is: a === b, before: a < b, after: a > b, onOrBefore: a <= b, onOrAfter: a >= b }[cond.operator as "is"] ?? true;
    }
  }
}

export function matchesFilters(c: Computer, row: Row, filters: Filters | undefined): boolean {
  const conds = filters?.conditions ?? [];
  if (conds.length === 0) return true;
  return filters!.conjunction === "or"
    ? conds.some((cond) => matchesCondition(c, row, cond))
    : conds.every((cond) => matchesCondition(c, row, cond));
}

/** Comparable key for sorting and grouping. Empty values sort last. */
function sortKey(c: Computer, row: Row, field: Field): { empty: boolean; n?: number; s?: string } {
  const v = c.value(row, field);
  if (v instanceof CellError || empty(v)) return { empty: true };
  switch (field.type) {
    case "singleSelect": {
      const idx = field.options.choices?.findIndex((ch) => ch.id === row.cells[field.id]) ?? -1;
      return { empty: idx < 0, n: idx };
    }
    case "checkbox":
      return { empty: false, n: v ? 1 : 0 };
    case "number": case "count": case "autoNumber": case "rollup": case "rating": case "duration":
      return typeof v === "number" ? { empty: false, n: v } : { empty: false, s: toText(v).toLowerCase() };
    case "date": case "createdTime": case "lastModifiedTime":
      return { empty: false, s: toText(v) };
    case "formula":
      return typeof v === "number" ? { empty: false, n: v } : { empty: false, s: toText(v).toLowerCase() };
    default:
      return { empty: false, s: c.display(row, field).toLowerCase() };
  }
}

function compareKeys(a: ReturnType<typeof sortKey>, b: ReturnType<typeof sortKey>): number {
  if (a.empty || b.empty) return a.empty === b.empty ? 0 : a.empty ? 1 : -1;
  if (a.n !== undefined && b.n !== undefined) return a.n - b.n;
  return (a.s ?? String(a.n)).localeCompare(b.s ?? String(b.n), undefined, { numeric: true });
}

export function sortRows(c: Computer, rows: Row[], sorts: SortSpec[]): Row[] {
  const specs = sorts.map((s) => ({ s, f: c.field(s.fieldId) })).filter((x): x is { s: SortSpec; f: Field } => Boolean(x.f));
  if (specs.length === 0) return rows;
  const keyed = rows.map((row, i) => ({ row, i, keys: specs.map(({ f }) => sortKey(c, row, f)) }));
  keyed.sort((a, b) => {
    for (let k = 0; k < specs.length; k++) {
      const ka = a.keys[k], kb = b.keys[k];
      let r = compareKeys(ka, kb);
      if (r !== 0) {
        // Empty values stay last in either direction.
        if (!ka.empty && !kb.empty && specs[k].s.direction === "desc") r = -r;
        return r;
      }
    }
    return a.i - b.i;
  });
  return keyed.map((k) => k.row);
}

export type RowGroup = { key: string; label: string; field: Field; rows: Row[]; children?: RowGroup[] };

export function groupRows(c: Computer, rows: Row[], groupBy: SortSpec[]): RowGroup[] | null {
  const specs = groupBy.filter((g) => c.field(g.fieldId));
  if (specs.length === 0) return null;
  const build = (list: Row[], level: number): RowGroup[] => {
    const spec = specs[level];
    const field = c.field(spec.fieldId)!;
    const sorted = sortRows(c, list, [spec]);
    const groups: RowGroup[] = [];
    for (const row of sorted) {
      const label = c.display(row, field);
      const key = label;
      let g = groups[groups.length - 1];
      if (!g || g.key !== key) {
        g = { key, label: label || "(Empty)", field, rows: [] };
        groups.push(g);
      }
      g.rows.push(row);
    }
    if (level + 1 < specs.length) for (const g of groups) g.children = build(g.rows, level + 1);
    return groups;
  };
  return build(rows, 0);
}

/** Rows of a view after its filters and sorts (grouping is applied by the caller). */
export function viewRows(c: Computer, state: BaseState, view: View): Row[] {
  const table = state.tables[view.tableId];
  if (!table) return [];
  const rows = table.rowOrder.map((id) => state.rows[id]).filter((r): r is Row => Boolean(r));
  const filtered = rows.filter((r) => matchesFilters(c, r, view.config.filters));
  const sorts = [...(view.config.groupBy ?? []), ...(view.config.sorts ?? [])];
  return sortRows(c, filtered, sorts);
}

export function visibleFields(state: BaseState, view: View): Field[] {
  const table = state.tables[view.tableId];
  if (!table) return [];
  const hidden = new Set(view.config.hiddenFieldIds ?? []);
  return table.fieldOrder
    .map((id) => state.fields[id])
    .filter((f): f is Field => Boolean(f) && (f.id === table.primaryFieldId || !hidden.has(f.id)));
}
