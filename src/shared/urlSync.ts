// Syncing a table from a CSV file on the web or a Google Sheet. The file is turned
// into a one-table "source base" with stable ids, so the regular table sync does the rest.

import type { BaseState, Field, Row, View } from "./types";
import { choiceColor, choiceNames, importValue, inferColumn, parseCsv } from "./csv";
import { emptyBase, defaultViewConfig } from "./reducer";

const A = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A stable 14-character id from text (FNV-1a, twice with different seeds). */
function stableId(prefix: string, text: string): string {
  let out = prefix;
  for (const seed of [0x811c9dc5, 0x1234567]) {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    for (let i = 0; i < 7; i++) { out += A[h % 62]; h = (Math.floor(h / 62) ^ Math.imul(h, 2654435761)) >>> 0; }
  }
  return out;
}

/** Turn a Google Sheets link into its CSV download link; other links are used as they are. */
export function csvUrlFor(raw: string): { url: string; label: string } {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new Error("That isn't a valid web address"); }
  if (u.protocol !== "https:") throw new Error("The link must start with https://");
  const sheet = /^\/spreadsheets\/d\/([\w-]+)/.exec(u.pathname);
  if (u.hostname === "docs.google.com" && sheet) {
    const gid = u.searchParams.get("gid") ?? /gid=(\d+)/.exec(u.hash)?.[1] ?? "0";
    return { url: `https://docs.google.com/spreadsheets/d/${sheet[1]}/export?format=csv&gid=${gid}`, label: "Google Sheet" };
  }
  return { url: u.toString(), label: `${u.hostname}${u.pathname.length > 1 ? u.pathname : ""}`.slice(0, 120) };
}

export const MAX_URL_ROWS = 10_000;

/** Build the stand-in source base for a CSV file (first row = column names). */
export function csvSourceState(text: string, label: string): { state: BaseState; view: View } {
  const grid = parseCsv(text.replace(/^﻿/, ""));
  const header = (grid[0] ?? []).map((h, i) => h.trim() || `Column ${i + 1}`);
  if (header.length === 0) throw new Error("The file is empty");
  if (/^\s*<(!doctype|html)/i.test(text)) throw new Error("That link opens a web page, not a CSV file. For Google Sheets, share the sheet so anyone with the link can view it.");
  const body = grid.slice(1, MAX_URL_ROWS + 1).filter((r) => r.some((v) => v.trim() !== ""));
  const state = emptyBase("basurlsync00000000", label);
  const tableId = stableId("tbl", "table");
  const viewId = stableId("viw", "view");
  // Repeated column names get a number so every field has its own id.
  const seen = new Map<string, number>();
  const fields: Field[] = header.map((name, i) => {
    const n = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), n);
    const fieldName = n > 1 ? `${name} (${n})` : name;
    const values = body.map((r) => r[i] ?? "");
    const guess = i === 0 ? { type: "text" as const, options: {} } : inferColumn(values);
    const options = { ...guess.options };
    if (guess.type === "singleSelect" || guess.type === "multiSelect") {
      options.choices = choiceNames(values, guess.type === "multiSelect").map((c, j) => ({ id: stableId("opt", c.toLowerCase()), name: c, color: choiceColor(j) }));
    }
    return { id: stableId("fld", fieldName.toLowerCase()), tableId, name: fieldName, type: guess.type, options };
  });
  // Records are matched by their first column; repeats are told apart by how many came before.
  const counts = new Map<string, number>();
  const rows: Row[] = body.map((r, idx) => {
    const key = (r[0] ?? "").trim().toLowerCase();
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const cells: Row["cells"] = {};
    fields.forEach((f, i) => { const v = importValue(r[i] ?? "", f.type, f.options); if (v !== null) cells[f.id] = v; });
    return { id: stableId("rec", key ? `${key}#${n}` : `#row${idx}`), tableId, cells, createdAt: "1970-01-01T00:00:00.000Z", autoNumber: idx + 1 };
  });
  state.tables[tableId] = { id: tableId, name: label, primaryFieldId: fields[0].id, fieldOrder: fields.map((f) => f.id), rowOrder: rows.map((r) => r.id), viewOrder: [viewId], nextAutoNumber: rows.length + 1 };
  for (const f of fields) state.fields[f.id] = f;
  for (const r of rows) state.rows[r.id] = r;
  const view: View = { id: viewId, tableId, name: "CSV", type: "grid", config: defaultViewConfig() };
  state.views[viewId] = view;
  state.tableOrder = [tableId];
  return { state, view };
}
