// What someone with a view's public link sees: the view's records and visible
// fields as display text, never hidden fields, other views, comments or ids of
// people. The server builds this; the page never gets the base itself.

import type { Attachment, BaseState, FieldType, View } from "./types";
import { CellError, Computer } from "./compute";
import { viewRows, visibleFields } from "./query";
import { recordColor } from "./viewTools";
import { isImage } from "./fieldTypes";

export const MAX_SHARED_ROWS = 5000;

/** Rich text as plain text: formatting marks dropped, list items kept as bullets. */
export function markdownToPlain(md: string): string {
  return md
    .split("\n")
    .map((l) => l.replace(/^#{1,3}\s+/, "").replace(/^\s*[-*]\s+/, "• ").replace(/^>\s?/, ""))
    .join("\n")
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(\*|_)([^*_\s][^*_]*?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1");
}

export type SharedCell = { text: string; chips?: { name: string; color: string }[]; files?: { id: string; name: string; image: boolean }[] };
export type SharedView = {
  baseName: string;
  name: string;
  type: View["type"];
  fields: { id: string; name: string; type: FieldType }[];
  rows: { id: string; color: string | null; cells: Record<string, SharedCell> }[];
  truncated: boolean;
};

export function sharedViewData(state: BaseState, view: View): SharedView {
  const c = new Computer(state);
  const fields = visibleFields(state, view).filter((f) => f.type !== "button");
  const all = viewRows(c, state, view);
  const rows = all.slice(0, MAX_SHARED_ROWS);
  return {
    baseName: state.base.name,
    name: view.name,
    type: view.type,
    fields: fields.map((f) => ({ id: f.id, name: f.name, type: f.type })),
    truncated: all.length > rows.length,
    rows: rows.map((r) => {
      const cells: Record<string, SharedCell> = {};
      for (const f of fields) {
        const v = c.value(r, f);
        if (v instanceof CellError) { cells[f.id] = { text: "#ERROR" }; continue; }
        const shown = c.display(r, f);
        const text = f.type === "longText" && f.options.richText ? markdownToPlain(shown) : shown;
        const cell: SharedCell = { text };
        if (f.type === "singleSelect" || f.type === "multiSelect") {
          const raw = r.cells[f.id];
          const ids = Array.isArray(raw) ? (raw as string[]) : typeof raw === "string" ? [raw] : [];
          cell.chips = ids.map((id) => f.options.choices?.find((ch) => ch.id === id)).filter(Boolean).map((ch) => ({ name: ch!.name, color: ch!.color }));
        }
        if (f.type === "attachment") {
          cell.files = ((r.cells[f.id] as Attachment[] | undefined) ?? []).map((a) => ({ id: a.id, name: a.name, image: isImage(a) }));
        }
        if (text || cell.files?.length) cells[f.id] = cell;
      }
      return { id: r.id, color: recordColor(c, r, view.config.colors), cells };
    }),
  };
}

/** Whether a file shows in the shared view (so the link may serve it). */
export function sharedViewHasFile(data: SharedView, fileId: string): boolean {
  return data.rows.some((r) => Object.values(r.cells).some((cell) => cell.files?.some((f) => f.id === fileId)));
}
