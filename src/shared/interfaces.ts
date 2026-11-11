// Data for interface elements: which records an element uses, totals, chart groups and map points.

import type { Aggregate, BaseState, ElementSource, Field, InterfacePage, PageControl, PageElement, Row } from "./types";
import { CellError, Computer } from "./compute";
import { viewRows } from "./query";
import { newId } from "./ids";

export const PIE_MAX = 8;
export const BAR_MAX = 30;

/** Narrows an element's records by the page's viewer filters (identity when none are set). */
export type Narrow = (tableId: string, rows: Row[]) => Row[];

export function sourceRows(c: Computer, state: BaseState, src: ElementSource, narrow?: Narrow): Row[] {
  const t = state.tables[src.tableId];
  if (!t) return [];
  const view = src.viewId ? state.views[src.viewId] : undefined;
  const rows = view && view.tableId === t.id ? viewRows(c, state, view) : t.rowOrder.map((id) => state.rows[id]).filter(Boolean);
  return narrow ? narrow(t.id, rows) : rows;
}

/** Choices a viewer filter offers: select options, people, yes/no; other fields filter by text. */
export function controlChoices(c: Computer, state: BaseState, ctl: PageControl): { value: string; label: string }[] | null {
  const f = state.fields[ctl.fieldId];
  if (!f) return null;
  if (f.type === "singleSelect" || f.type === "multiSelect") return (f.options.choices ?? []).map((ch) => ({ value: ch.id, label: ch.name }));
  if (f.type === "checkbox") return [{ value: "checked", label: "Checked" }, { value: "unchecked", label: "Not checked" }];
  if (f.type === "user") return Object.entries(state.people ?? {}).map(([id, p]) => ({ value: id, label: p.name }));
  if (f.type === "link") {
    const t = state.tables[f.options.linkedTableId ?? ""];
    return t ? t.rowOrder.slice(0, 500).map((id) => ({ value: id, label: c.primaryName(id) })) : null;
  }
  return null;
}

/** Apply viewer filter values (by control id; "" or missing = any). */
export function narrowBy(c: Computer, state: BaseState, controls: PageControl[], values: Record<string, string>): Narrow {
  const active = controls.filter((ctl) => values[ctl.id]);
  if (!active.length) return (_t, rows) => rows;
  return (tableId, rows) => {
    const mine = active.filter((ctl) => ctl.tableId === tableId && state.fields[ctl.fieldId]);
    if (!mine.length) return rows;
    return rows.filter((r) => mine.every((ctl) => {
      const f = state.fields[ctl.fieldId];
      const want = values[ctl.id];
      const raw = r.cells[f.id];
      switch (f.type) {
        case "singleSelect": return raw === want;
        case "multiSelect": case "user": case "link": return Array.isArray(raw) && (raw as string[]).includes(want);
        case "checkbox": return want === "checked" ? raw === true : raw !== true;
        default: return c.display(r, f).toLowerCase().includes(want.toLowerCase());
      }
    }));
  };
}

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (Array.isArray(v)) { const nums = v.map(num).filter((x): x is number => x !== null); return nums.length ? nums.reduce((a, b) => a + b, 0) : null; }
  return null;
};

/** Sum up a field over rows (count ignores the field). Null when there's nothing to sum. */
export function aggregate(c: Computer, rows: Row[], field: Field | undefined, fn: Aggregate): number | null {
  if (fn === "count") return rows.length;
  if (!field) return null;
  const vals: number[] = [];
  for (const r of rows) {
    const v = c.value(r, field);
    if (v instanceof CellError) continue;
    const n = num(v);
    if (n !== null) vals.push(n);
  }
  if (vals.length === 0) return null;
  switch (fn) {
    case "sum": return vals.reduce((a, b) => a + b, 0);
    case "avg": return vals.reduce((a, b) => a + b, 0) / vals.length;
    case "min": return Math.min(...vals);
    case "max": return Math.max(...vals);
  }
}

export type ChartPoint = { key: string; label: string; value: number; rowIds: string[] };

/**
 * Group rows by a field and sum up each group. Select fields keep their option order and
 * each option of a multi-select counts; other fields group by what they show.
 * Bars and lines keep the field's order (dates and numbers ascending); pies go largest first.
 * Past the limit, the smallest groups fold into "Other".
 */
export function chartData(c: Computer, state: BaseState, el: Extract<PageElement, { kind: "chart" }>, narrow?: Narrow): ChartPoint[] {
  const rows = sourceRows(c, state, el.source, narrow);
  const group = state.fields[el.groupFieldId];
  const value = el.fieldId ? state.fields[el.fieldId] : undefined;
  if (!group) return [];
  const buckets = new Map<string, { label: string; rows: Row[]; sort: string | number }>();
  const add = (key: string, label: string, sort: string | number, r: Row) => {
    const b = buckets.get(key) ?? { label, rows: [], sort };
    b.rows.push(r);
    buckets.set(key, b);
  };
  const choices = group.options.choices ?? [];
  for (const r of rows) {
    if (group.type === "singleSelect" || group.type === "multiSelect") {
      const raw = r.cells[group.id];
      const ids = Array.isArray(raw) ? (raw as string[]) : raw ? [raw as string] : [];
      if (ids.length === 0) add("", "(empty)", Number.MAX_SAFE_INTEGER, r);
      for (const id of ids) { const i = choices.findIndex((ch) => ch.id === id); if (i >= 0) add(id, choices[i].name, i, r); }
      continue;
    }
    const v = c.value(r, group);
    if (v instanceof CellError) continue;
    const label = c.display(r, group);
    if (!label) { add("", "(empty)", "￿", r); continue; }
    const n = typeof v === "number" ? v : null;
    const sort = n ?? (group.type === "date" || group.type === "createdTime" || group.type === "lastModifiedTime" ? String(v) : label.toLowerCase());
    add(label, label, sort, r);
  }
  let points = [...buckets.entries()].map(([key, b]) => ({ key, label: b.label, value: aggregate(c, b.rows, value, el.fn) ?? 0, rowIds: b.rows.map((r) => r.id), sort: b.sort }));
  const byField = (a: { sort: string | number }, b: { sort: string | number }) =>
    typeof a.sort === "number" && typeof b.sort === "number" ? a.sort - b.sort : String(a.sort).localeCompare(String(b.sort));
  if (el.chartType === "pie") points.sort((a, b) => b.value - a.value);
  else points.sort(byField);
  const max = el.chartType === "pie" ? PIE_MAX : BAR_MAX;
  if (points.length > max) {
    const bySize = [...points].sort((a, b) => b.value - a.value);
    const keep = new Set(bySize.slice(0, max - 1).map((p) => p.key));
    const rest = points.filter((p) => !keep.has(p.key));
    const restRows = rest.flatMap((p) => p.rowIds).map((id) => state.rows[id]);
    points = points.filter((p) => keep.has(p.key));
    points.push({ key: "__other", label: `Other (${rest.length})`, value: aggregate(c, restRows, value, el.fn) ?? 0, rowIds: restRows.map((r) => r.id), sort: "￿" });
  }
  return points.map(({ sort: _s, ...p }) => p);
}

export type MapPoint = { rowId: string; lat: number; lng: number; label: string };

/** Points for a map: "lat, lng" in one text field, or latitude and longitude in two number fields. */
export function mapPoints(c: Computer, state: BaseState, el: Extract<PageElement, { kind: "map" }>, narrow?: Narrow): { points: MapPoint[]; skipped: number } {
  const rows = sourceRows(c, state, el.source, narrow);
  const locF = state.fields[el.locationFieldId];
  const lngF = el.lngFieldId ? state.fields[el.lngFieldId] : undefined;
  const labelF = el.labelFieldId ? state.fields[el.labelFieldId] : undefined;
  const points: MapPoint[] = [];
  let skipped = 0;
  if (!locF) return { points, skipped: rows.length };
  for (const r of rows.slice(0, 2000)) {
    let lat: number | null = null, lng: number | null = null;
    if (lngF) { lat = num(c.value(r, locF)); lng = num(c.value(r, lngF)); }
    else {
      const m = /(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)/.exec(c.display(r, locF));
      if (m) { lat = Number(m[1]); lng = Number(m[2]); }
    }
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) { if (c.display(r, locF)) skipped++; continue; }
    points.push({ rowId: r.id, lat, lng, label: labelF ? c.display(r, labelF) : c.primaryName(r.id) });
  }
  return { points, skipped };
}

/** Format a total for a number tile or a chart label. */
export function formatTotal(n: number | null, field?: Field, fn?: Aggregate): string {
  if (n === null) return "–";
  if (fn === "count") return n.toLocaleString();
  const precision = field?.options.precision ?? (Number.isInteger(n) ? 0 : 2);
  const s = n.toLocaleString(undefined, { minimumFractionDigits: fn === "avg" ? Math.min(precision, 2) : precision, maximumFractionDigits: Math.max(precision, fn === "avg" ? 2 : 0) });
  if (field?.options.format === "currency") return `${field.options.symbol ?? "$"}${s}`;
  if (field?.options.format === "percent") return `${s}%`;
  return s;
}

/** The first empty spot for an element w×h (rows below the lowest element). */
export function nextSpot(page: InterfacePage, w: number): { x: number; y: number } {
  const bottom = page.elements.reduce((m, e) => Math.max(m, e.y + e.h), 0);
  const lastRow = page.elements.filter((e) => e.y + e.h === bottom);
  const usedRight = lastRow.reduce((m, e) => Math.max(m, e.x + e.w), 0);
  const top = lastRow.reduce((m, e) => Math.min(m, e.y), bottom);
  if (lastRow.length && usedRight + w <= 12) return { x: usedRight, y: top };
  return { x: 0, y: bottom };
}

/** A starting element of each kind, filled in from the base's first table. */
export function newElement(state: BaseState, kind: PageElement["kind"], page: InterfacePage, tableId?: string): PageElement {
  const t = state.tables[tableId ?? state.tableOrder[0]];
  const fields = t ? t.fieldOrder.map((id) => state.fields[id]).filter(Boolean) : [];
  const source = { tableId: t?.id ?? "", viewId: null };
  const numeric = fields.find((f) => ["number", "rating", "duration", "count", "rollup"].includes(f.type));
  const groupable = fields.find((f) => f.type === "singleSelect") ?? fields.find((f) => ["multiSelect", "checkbox", "user", "date"].includes(f.type)) ?? fields[0];
  const size: Record<PageElement["kind"], [number, number]> = { number: [3, 3], chart: [6, 7], list: [6, 7], map: [6, 8], text: [12, 2], button: [3, 2] };
  const [w, h] = size[kind];
  const box = { id: newId("elm"), ...nextSpot(page, w), w, h, title: "" };
  switch (kind) {
    case "number": return { ...box, kind, source, fn: "count", fieldId: null, title: t ? `${t.name}` : "Total" };
    case "chart": return { ...box, kind, source, chartType: "bar", groupFieldId: groupable?.id ?? "", fn: "count", fieldId: numeric?.id ?? null, title: groupable ? `${t!.name} by ${groupable.name}` : "Chart" };
    case "list": return { ...box, kind, source, fieldIds: fields.slice(0, 4).map((f) => f.id), limit: 50, title: t?.name ?? "Records" };
    case "map": {
      const loc = fields.find((f) => /loc|coord|lat|address|place/i.test(f.name)) ?? fields.find((f) => f.type === "text") ?? fields[0];
      return { ...box, kind, source, locationFieldId: loc?.id ?? "", lngFieldId: null, labelFieldId: t?.primaryFieldId ?? null, title: "Map" };
    }
    case "text": return { ...box, kind, text: "# Heading\nWrite something here.", title: "" };
    case "button": return { ...box, kind, label: "Open link", action: { type: "url", url: "https://" }, title: "" };
  }
}
