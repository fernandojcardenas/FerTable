// CSV reading and writing, plus guessing a field type for each imported column.

import type { CellValue, FieldOptions, FieldType } from "./types";
import { CHOICE_COLORS } from "./fieldTypes";

// ---- parsing ----

/** Pick the delimiter that splits the first lines most consistently. */
export function detectDelimiter(text: string): string {
  const sample = text.slice(0, 20_000).split(/\r?\n/).slice(0, 20).filter(Boolean);
  let best = ",";
  let bestScore = -1;
  for (const d of [",", ";", "\t", "|"]) {
    const counts = sample.map((line) => splitOutsideQuotes(line, d));
    if (!counts.length || counts[0] === 0) continue;
    const consistent = counts.filter((c) => c === counts[0]).length;
    const score = consistent * 100 + counts[0];
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

function splitOutsideQuotes(line: string, d: string): number {
  let n = 0, quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === d && !quoted) n++;
  }
  return n;
}

/** RFC 4180 parsing: quoted fields, "" escapes, newlines inside quotes, CRLF, and a leading BOM. */
export function parseCsv(input: string, delimiter = detectDelimiter(input)): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  // Drop completely empty lines (e.g. a trailing newline).
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// ---- writing ----

/**
 * Text starting with = + - @ (or a tab/CR) can run as a formula when the file is
 * opened in a spreadsheet app. Prefix it with ' so it stays plain text.
 */
export function neutralizeFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export function toCsv(rows: string[][]): string {
  const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}

// ---- guessing column types ----

const NUM = /^\(?-?\s*[$€£¥]?\s*-?\d{1,3}(,\d{3})*(\.\d+)?\s*%?\)?$|^\(?-?\s*[$€£¥]?\s*-?\d+(\.\d+)?\s*%?\)?$/;
const TRUE_WORDS = ["true", "yes", "y", "checked", "x", "✓", "✔"];
const FALSE_WORDS = ["false", "no", "n", "unchecked"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^(https?:\/\/|www\.)\S+$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})( \d{1,2}:\d{2}(:\d{2})?\s*([AaPp][Mm])?)?$/;

export function parseNumber(raw: string): number | null {
  const s = raw.trim();
  if (!NUM.test(s)) return null;
  const negative = /^\(.*\)$/.test(s) || /-/.test(s);
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n)) return null;
  const v = negative ? -n : n;
  return s.includes("%") ? v / 100 : v;
}

/** Dates as ISO (2026-11-09, with optional time) or US style (11/9/2026). Returns an ISO string. */
export function parseDate(raw: string): { iso: string; hasTime: boolean } | null {
  const s = raw.trim();
  if (ISO_DATE.test(s)) {
    const hasTime = s.length > 10;
    const d = new Date(hasTime ? s.replace(" ", "T") : `${s}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) return null;
    return { iso: hasTime ? d.toISOString() : s, hasTime };
  }
  const m = US_DATE.exec(s);
  if (m) {
    const [, mo, da, yRaw, time] = m;
    const year = yRaw.length === 2 ? 2000 + Number(yRaw) : Number(yRaw);
    const month = Number(mo), day = Number(da);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (!time) return { iso: date, hasTime: false };
    const d = new Date(`${date} ${time.trim()}`);
    return Number.isNaN(d.getTime()) ? { iso: date, hasTime: false } : { iso: d.toISOString(), hasTime: true };
  }
  return null;
}

export function parseBool(raw: string): boolean | null {
  const s = raw.trim().toLowerCase();
  if (TRUE_WORDS.includes(s)) return true;
  if (FALSE_WORDS.includes(s)) return false;
  return null;
}

export type ImportType = Extract<FieldType, "text" | "longText" | "number" | "checkbox" | "date" | "singleSelect" | "multiSelect" | "email" | "url" | "phone">;

export const IMPORT_TYPES: ImportType[] = ["text", "longText", "number", "checkbox", "date", "singleSelect", "multiSelect", "email", "url", "phone"];

/** Look at a column's values and suggest a field type and options. */
export function inferColumn(values: string[]): { type: ImportType; options: FieldOptions } {
  const filled = values.map((v) => v.trim()).filter((v) => v !== "");
  if (filled.length === 0) return { type: "text", options: {} };
  if (filled.every((v) => parseBool(v) !== null) && filled.some((v) => !/^[yn]$/i.test(v))) return { type: "checkbox", options: {} };
  // Codes like ZIPs (02134) or IDs (007) keep their leading zeros as text.
  if (filled.every((v) => parseNumber(v) !== null) && !filled.some((v) => /^0\d/.test(v))) {
    const currency = filled.filter((v) => /[$€£¥]/.test(v));
    const percent = filled.every((v) => v.includes("%"));
    const decimals = Math.min(8, Math.max(0, ...filled.map((v) => (v.replace(/[^0-9.]/g, "").split(".")[1] ?? "").length)));
    if (percent) return { type: "number", options: { format: "percent", precision: Math.min(8, decimals + 2) } };
    if (currency.length > filled.length / 2) return { type: "number", options: { format: "currency", precision: Math.max(2, decimals), symbol: currency[0].match(/[$€£¥]/)![0] } };
    return { type: "number", options: { format: decimals === 0 ? "integer" : "decimal", precision: decimals } };
  }
  const dates = filled.map(parseDate);
  if (dates.every(Boolean)) return { type: "date", options: { includeTime: dates.some((d) => d!.hasTime) } };
  if (filled.every((v) => EMAIL.test(v))) return { type: "email", options: {} };
  if (filled.every((v) => URL_RE.test(v))) return { type: "url", options: {} };
  if (filled.some((v) => v.includes("\n") || v.length > 120)) return { type: "longText", options: {} };
  // A few values repeated many times reads like a category.
  const distinct = new Set(filled.map((v) => v.toLowerCase()));
  if (filled.length >= 4 && distinct.size <= Math.max(2, Math.min(25, filled.length / 2)) && [...distinct].every((v) => v.length <= 40)) {
    return { type: "singleSelect", options: {} };
  }
  return { type: "text", options: {} };
}

/** Option names for a select column, in first-seen order. Multi-select values are split on commas. */
export function choiceNames(values: string[], multi: boolean): string[] {
  const seen = new Map<string, string>();
  for (const v of values) {
    for (const part of multi ? v.split(",") : [v]) {
      const name = part.trim();
      if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
    }
  }
  return [...seen.values()];
}

export const choiceColor = (i: number) => CHOICE_COLORS[i % CHOICE_COLORS.length];

/** Turn one CSV cell into a stored value for a field of the given type. */
export function importValue(
  raw: string,
  type: FieldType,
  options: FieldOptions,
  lookup?: (name: string) => string | undefined,
): CellValue {
  const s = raw.trim();
  if (s === "") return null;
  switch (type) {
    case "number": return parseNumber(s);
    case "checkbox": {
      const b = parseBool(s);
      if (b !== null) return b || null;
      return s === "0" ? null : true; // "1" or any other mark counts as checked
    }
    case "date": {
      const d = parseDate(s);
      if (!d) return null;
      return options.includeTime ? (d.hasTime ? d.iso : `${d.iso}T00:00:00.000Z`) : d.iso.slice(0, 10);
    }
    case "singleSelect": {
      const id = options.choices?.find((c) => c.name.toLowerCase() === s.toLowerCase())?.id;
      return id ?? null;
    }
    case "multiSelect": {
      const ids = s.split(",").map((p) => options.choices?.find((c) => c.name.toLowerCase() === p.trim().toLowerCase())?.id).filter((x): x is string => Boolean(x));
      return ids.length ? [...new Set(ids)] : null;
    }
    case "link": {
      if (!lookup) return null;
      const ids = s.split(",").map((p) => lookup(p.trim())).filter((x): x is string => Boolean(x));
      return ids.length ? [...new Set(ids)] : null;
    }
    case "text": case "email": case "url": case "phone":
      return s.replace(/[\r\n]+/g, " ");
    case "longText":
      return raw.replace(/\r\n/g, "\n");
    default:
      return null;
  }
}
