import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAction, applyActions, emptyBase } from "../src/shared/reducer";
import { Computer } from "../src/shared/compute";
import { inversePatch } from "../src/shared/history";
import { aggregate, chartData, mapPoints, newElement, sourceRows } from "../src/shared/interfaces";
import { newId } from "../src/shared/ids";
import type { InterfacePage, PageElement } from "../src/shared/types";

const AT = "2026-11-10T12:00:00.000Z";
function setup() {
  const ids = { t: newId("tbl"), name: newId("fld"), status: newId("fld"), amount: newId("fld"), loc: newId("fld"), v: newId("viw"), big: newId("viw"),
    a: newId("opt"), b: newId("opt") };
  const rows = [["One", ids.a, 10, "40.71, -74.00"], ["Two", ids.a, 5, "nowhere"], ["Three", ids.b, 1, "51.5,-0.12"], ["Four", null, 7, ""]] as const;
  const s = applyActions(emptyBase(newId("bas"), "Sales"), [
    { type: "table.create", tableId: ids.t, name: "Deals", primaryFieldId: ids.name, viewId: ids.v },
    { type: "field.create", fieldId: ids.status, tableId: ids.t, name: "Stage", fieldType: "singleSelect", options: { choices: [{ id: ids.a, name: "Open", color: "blue" }, { id: ids.b, name: "Won", color: "green" }] } },
    { type: "field.create", fieldId: ids.amount, tableId: ids.t, name: "Amount", fieldType: "number" },
    { type: "field.create", fieldId: ids.loc, tableId: ids.t, name: "Location", fieldType: "text" },
    ...rows.map(([n, st, amt, loc]) => ({ type: "row.create" as const, rowId: newId("rec"), tableId: ids.t, cells: { [ids.name]: n, [ids.status]: st, [ids.amount]: amt, [ids.loc]: loc } })),
    { type: "view.create", viewId: ids.big, tableId: ids.t, name: "Big", viewType: "grid" },
    { type: "view.update", viewId: ids.big, config: { filters: { conjunction: "and", conditions: [{ id: "c", fieldId: ids.amount, operator: "gt", value: 6 }] } } },
  ], AT);
  return { s, ids };
}
const src = (tableId: string, viewId: string | null = null) => ({ tableId, viewId });

test("totals, chart groups and map points come from the element's records", () => {
  const { s, ids } = setup();
  const c = new Computer(s);
  assert.equal(aggregate(c, sourceRows(c, s, src(ids.t)), s.fields[ids.amount], "sum"), 23);
  assert.equal(aggregate(c, sourceRows(c, s, src(ids.t, ids.big)), undefined, "count"), 2, "a view narrows the records");
  assert.equal(aggregate(c, sourceRows(c, s, src(ids.t)), s.fields[ids.amount], "avg"), 5.75);
  const chart = { id: newId("elm"), x: 0, y: 0, w: 6, h: 6, title: "", kind: "chart", source: src(ids.t), chartType: "bar", groupFieldId: ids.status, fn: "sum", fieldId: ids.amount } as Extract<PageElement, { kind: "chart" }>;
  assert.deepEqual(chartData(c, s, chart).map((p) => [p.label, p.value]), [["Open", 15], ["Won", 1], ["(empty)", 7]], "option order, empty last");
  assert.deepEqual(chartData(c, s, { ...chart, chartType: "pie" }).map((p) => p.label), ["Open", "(empty)", "Won"], "pies go largest first");
  const map = { id: newId("elm"), x: 0, y: 0, w: 6, h: 6, title: "", kind: "map", source: src(ids.t), locationFieldId: ids.loc, lngFieldId: null, labelFieldId: null } as Extract<PageElement, { kind: "map" }>;
  const { points, skipped } = mapPoints(c, s, map);
  assert.deepEqual(points.map((p) => [p.label, p.lat, p.lng]), [["One", 40.71, -74], ["Three", 51.5, -0.12]]);
  assert.equal(skipped, 1, "unreadable text counts, empty doesn't");
});

test("pages are checked when saved and come back with undo", () => {
  const { s, ids } = setup();
  const page: InterfacePage = { id: newId("pag"), name: "Pipeline", elements: [] };
  page.elements.push(newElement(s, "number", page), newElement(s, "chart", page));
  const saved = applyAction(s, { type: "page.upsert", page }, AT);
  assert.equal(saved.pages[page.id].elements.length, 2);
  const bad = (el: Partial<PageElement>) => ({ ...page, elements: [{ ...page.elements[0], ...el } as PageElement] });
  assert.throws(() => applyAction(s, { type: "page.upsert", page: bad({ x: 10, w: 4 }) }, AT), /doesn't fit/);
  assert.throws(() => applyAction(s, { type: "page.upsert", page: bad({ source: src(newId("tbl")) } as Partial<PageElement>) }, AT), /missing table/);
  assert.throws(() => applyAction(s, { type: "page.upsert", page: bad({ kind: "button", label: "x", action: { type: "url", url: "javascript:alert(1)" } } as Partial<PageElement>) }, AT), /must start with/);
  // Delete then undo.
  const gone = applyAction(saved, { type: "page.delete", pageId: page.id }, AT);
  assert.equal(gone.pages[page.id], undefined);
  const back = applyAction(gone, { type: "restore", patch: inversePatch(saved, gone) }, AT);
  assert.deepEqual(back.pages[page.id], saved.pages[page.id]);
  // Undo after the table is gone drops the elements that used it instead of failing.
  const noTable = { ...gone, tables: {}, tableOrder: [] };
  const lenient = applyAction(noTable, { type: "restore", patch: inversePatch(saved, gone) }, AT);
  assert.equal(lenient.pages[page.id].elements.length, 0);
  void ids;
});
