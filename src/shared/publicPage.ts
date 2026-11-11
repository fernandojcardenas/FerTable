// What someone with an interface page's public link sees: each element's numbers,
// chart groups, list rows and map points as display values, worked out on the
// server. No ids of records or people, no base data beyond what the page shows.

import type { BaseState, Field, InterfacePage } from "./types";
import { Computer } from "./compute";
import { aggregate, chartData, formatTotal, mapPoints, sourceRows } from "./interfaces";
import { viewRows } from "./query";

export const MAX_SHARED_LIST = 200;

export type SharedElement = { id: string; x: number; y: number; w: number; h: number; title: string } & (
  | { kind: "number"; text: string; caption: string }
  | { kind: "chart"; chartType: "bar" | "line" | "pie"; valueLabel: string; points: { key: string; label: string; value: number; text: string }[] }
  | { kind: "list"; fields: string[]; rows: string[][] }
  | { kind: "map"; points: { lat: number; lng: number; label: string }[] }
  | { kind: "text"; text: string }
  | { kind: "button"; label: string; url: string }
);

export type SharedPage = {
  baseName: string;
  name: string;
  kind: "dashboard" | "record";
  elements: SharedElement[];
  /** Record pages: each record's name and fields. */
  records?: { name: string; fields: { name: string; text: string }[] }[];
};

const FN_LABEL = { count: "Records", sum: "Sum", avg: "Average", min: "Smallest", max: "Largest" } as const;

export function sharedPageData(state: BaseState, page: InterfacePage): SharedPage {
  const c = new Computer(state);
  const out: SharedPage = { baseName: state.base.name, name: page.name, kind: page.kind === "record" ? "record" : "dashboard", elements: [] };
  if (page.kind === "record") {
    const view = page.viewId ? state.views[page.viewId] : undefined;
    const t = page.tableId ? state.tables[page.tableId] : undefined;
    const rows = !t ? [] : view ? viewRows(c, state, view) : t.rowOrder.map((id) => state.rows[id]).filter(Boolean);
    const fields = (page.fieldIds ?? []).map((id) => state.fields[id]).filter((f): f is Field => Boolean(f) && f.type !== "button");
    out.records = rows.slice(0, 1000).map((r) => ({ name: c.primaryName(r.id), fields: fields.map((f) => ({ name: f.name, text: c.display(r, f) })) }));
    return out;
  }
  for (const el of page.elements) {
    const box = { id: el.id, x: el.x, y: el.y, w: el.w, h: el.h, title: el.title };
    if ("source" in el && !state.tables[el.source.tableId]) continue;
    switch (el.kind) {
      case "number": {
        const field = el.fieldId ? state.fields[el.fieldId] : undefined;
        const v = aggregate(c, sourceRows(c, state, el.source), field, el.fn);
        out.elements.push({ ...box, kind: "number", text: formatTotal(v, field, el.fn), caption: el.fn === "count" ? "records" : `${FN_LABEL[el.fn].toLowerCase()} of ${field?.name ?? "?"}` });
        break;
      }
      case "chart": {
        const field = el.fieldId ? state.fields[el.fieldId] : undefined;
        const points = chartData(c, state, el).map((p) => ({ key: p.key, label: p.label, value: p.value, text: formatTotal(p.value, field, el.fn) }));
        out.elements.push({ ...box, kind: "chart", chartType: el.chartType, valueLabel: el.fn === "count" ? "Records" : `${FN_LABEL[el.fn]} of ${field?.name ?? "?"}`, points });
        break;
      }
      case "list": {
        const fields = el.fieldIds.map((id) => state.fields[id]).filter((f): f is Field => Boolean(f));
        const rows = sourceRows(c, state, el.source).slice(0, Math.min(el.limit, MAX_SHARED_LIST));
        out.elements.push({ ...box, kind: "list", fields: fields.map((f) => f.name), rows: rows.map((r) => fields.map((f) => c.display(r, f))) });
        break;
      }
      case "map":
        out.elements.push({ ...box, kind: "map", points: mapPoints(c, state, el).points.map((p) => ({ lat: p.lat, lng: p.lng, label: p.label })) });
        break;
      case "text":
        out.elements.push({ ...box, kind: "text", text: el.text });
        break;
      case "button":
        // Only link buttons work for visitors; automations and views need an account.
        if (el.action.type === "url") out.elements.push({ ...box, kind: "button", label: el.label, url: el.action.url });
        break;
    }
  }
  return out;
}

/** Public pages never serve files. */
export function sharedPageHasFile(_data: SharedPage, _fileId: string): boolean {
  return false;
}
