import type { Attachment, BaseState, Field, Row, View } from "@/shared/types";
import { Computer } from "@/shared/compute";
import { viewRows, visibleFields } from "@/shared/query";
import { neutralizeFormula, toCsv } from "@/shared/csv";

const pad = (n: number) => String(n).padStart(2, "0");

/** One cell as CSV text: what you see in the grid, with dates in a form spreadsheets and our importer read back. */
function cellText(c: Computer, row: Row, field: Field): string {
  const raw = row.cells[field.id];
  switch (field.type) {
    case "checkbox":
      return raw ? "checked" : "";
    case "date": {
      if (typeof raw !== "string") return "";
      if (!field.options.includeTime) return raw.slice(0, 10);
      const d = new Date(raw);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    case "attachment":
      return ((raw as Attachment[] | undefined) ?? []).map((a) => `${a.name} (${location.origin}${a.url})`).join(", ");
    case "number": case "count": case "autoNumber": case "rollup":
      return c.display(row, field); // numbers can't be formulas, so no guard needed
    default:
      return neutralizeFormula(c.display(row, field));
  }
}

/** Download what a view shows (its fields, filters and sort) as a CSV file. */
export function downloadViewCsv(state: BaseState, view: View) {
  const c = new Computer(state);
  const fields = visibleFields(state, view);
  const rows = viewRows(c, state, view);
  const csv = toCsv([fields.map((f) => f.name), ...rows.map((r) => fields.map((f) => cellText(c, r, f)))]);
  const table = state.tables[view.tableId];
  const name = `${table.name} - ${view.name}.csv`.replace(/[\\/:*?"<>|]+/g, "_");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { rows: rows.length, fields: fields.length, name };
}
