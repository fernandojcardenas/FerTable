// Helpers for grid extras: column summaries, searching a view, and record colors.

import type { Field, RecordColoring, Row, RowHeight, SummaryFn, View } from "./types";
import { CellError, Computer } from "./compute";
import { formatDuration, rollupKind } from "./fieldTypes";
import { matchesFilters } from "./query";
import { toNumber, toText } from "./formula";

export const ROW_HEIGHTS: Record<RowHeight, number> = { short: 34, medium: 56, tall: 88, extraTall: 136 };
export const ROW_HEIGHT_LABELS: Record<RowHeight, string> = { short: "Short", medium: "Medium", tall: "Tall", extraTall: "Extra tall" };
export const MAX_FROZEN = 5;

type SummaryKind = "number" | "date" | "checkbox" | "other";

export function summaryKind(f: Field): SummaryKind {
  switch (f.type) {
    case "number": case "count": case "autoNumber": case "rating": case "duration": return "number";
    case "rollup": return rollupKind(f) === "number" ? "number" : rollupKind(f) === "checkbox" ? "checkbox" : "other";
    case "date": case "createdTime": case "lastModifiedTime": return "date";
    case "checkbox": return "checkbox";
    default: return "other";
  }
}

export const SUMMARY_LABELS: Record<SummaryFn, string> = {
  filled: "Filled", empty: "Empty", percentFilled: "Percent filled", percentEmpty: "Percent empty", unique: "Unique",
  sum: "Sum", avg: "Average", median: "Median", min: "Min", max: "Max", range: "Range",
  checked: "Checked", unchecked: "Unchecked", percentChecked: "Percent checked",
  earliest: "Earliest", latest: "Latest", dateRange: "Date range",
};

/** Summaries that make sense for a field. */
export function summariesFor(f: Field): SummaryFn[] {
  const basic: SummaryFn[] = ["filled", "empty", "percentFilled", "percentEmpty", "unique"];
  switch (summaryKind(f)) {
    case "number": return ["sum", "avg", "median", "min", "max", "range", ...basic];
    case "date": return ["earliest", "latest", "dateRange", ...basic];
    case "checkbox": return ["checked", "unchecked", "percentChecked"];
    default: return basic;
  }
}

export const ALL_SUMMARIES = new Set(Object.keys(SUMMARY_LABELS));

const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || v === false || (Array.isArray(v) && v.length === 0);
const pct = (n: number, total: number) => (total ? `${Math.round((n / total) * 100)}%` : "0%");

function formatNum(f: Field, n: number): string {
  if (f.type === "duration") return formatDuration(n, f.options.durationFormat);
  const precision = f.type === "number" ? f.options.precision ?? 0 : Number.isInteger(n) ? 0 : 2;
  const s = n.toLocaleString(undefined, { minimumFractionDigits: Math.min(precision, 8), maximumFractionDigits: Math.max(precision, Number.isInteger(n) ? 0 : 2) });
  if (f.type === "number" && f.options.format === "currency") return `${f.options.symbol ?? "$"}${s}`;
  if (f.type === "number" && f.options.format === "percent") return `${s}%`;
  return s;
}

/** The text for one column summary over these rows. */
export function summarize(c: Computer, rows: Row[], f: Field, fn: SummaryFn): string {
  const vals = rows.map((r) => c.value(r, f)).map((v) => (v instanceof CellError ? null : v));
  const total = rows.length;
  const filled = vals.filter((v) => !isEmpty(v)).length;
  switch (fn) {
    case "filled": return String(filled);
    case "empty": return String(total - filled);
    case "percentFilled": return pct(filled, total);
    case "percentEmpty": return pct(total - filled, total);
    case "unique": return String(new Set(rows.map((r) => c.display(r, f)).filter(Boolean)).size);
    case "checked": return String(vals.filter((v) => v === true).length);
    case "unchecked": return String(vals.filter((v) => v !== true).length);
    case "percentChecked": return pct(vals.filter((v) => v === true).length, total);
    case "earliest": case "latest": case "dateRange": {
      const days = vals.filter((v) => !isEmpty(v)).map((v) => toText(v as never)).sort();
      if (!days.length) return "–";
      const show = (s: string) => new Date(s.length === 10 ? `${s}T00:00:00Z` : s).toLocaleDateString(undefined, { timeZone: s.length === 10 ? "UTC" : undefined });
      if (fn === "earliest") return show(days[0]);
      if (fn === "latest") return show(days[days.length - 1]);
      const ms = Date.parse(days[days.length - 1]) - Date.parse(days[0]);
      return `${Math.round(ms / 86_400_000)} days`;
    }
    default: {
      const nums = vals.filter((v) => !isEmpty(v) || v === 0).map((v) => (Array.isArray(v) ? v.reduce<number>((a, x) => a + toNumber(x as never), 0) : toNumber(v as never))).filter(Number.isFinite);
      if (!nums.length) return "–";
      const sorted = [...nums].sort((a, b) => a - b);
      const sum = nums.reduce((a, b) => a + b, 0);
      const n = fn === "sum" ? sum
        : fn === "avg" ? sum / nums.length
        : fn === "median" ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
        : fn === "min" ? sorted[0]
        : fn === "max" ? sorted[sorted.length - 1]
        : sorted[sorted.length - 1] - sorted[0];
      return formatNum(f, n);
    }
  }
}

/** Rows where any of these fields shows the text (case-insensitive). */
export function searchRows(c: Computer, rows: Row[], fields: Field[], query: string): Row[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => fields.some((f) => c.display(r, f).toLowerCase().includes(q)));
}

/** Whether one cell matches a search (for highlighting). */
export function cellMatches(c: Computer, row: Row, f: Field, query: string): boolean {
  const q = query.trim().toLowerCase();
  return Boolean(q) && c.display(row, f).toLowerCase().includes(q);
}

/** The color name for a record under a view's coloring, or null. */
export function recordColor(c: Computer, row: Row, coloring: RecordColoring | null | undefined): string | null {
  if (!coloring) return null;
  if (coloring.mode === "select") {
    const f = c.field(coloring.fieldId);
    if (!f || f.type !== "singleSelect") return null;
    return f.options.choices?.find((ch) => ch.id === row.cells[f.id])?.color ?? null;
  }
  for (const rule of coloring.rules ?? []) {
    if (rule.filters.conditions.length && matchesFilters(c, row, rule.filters)) return rule.color;
  }
  return null;
}

export const rowHeightOf = (view: View) => ROW_HEIGHTS[view.config.rowHeight ?? "short"] ?? ROW_HEIGHTS.short;
