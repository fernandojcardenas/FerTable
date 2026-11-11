import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAction, applyActions, emptyBase } from "../src/shared/reducer";
import { Computer } from "../src/shared/compute";
import { inversePatch } from "../src/shared/history";
import { newId } from "../src/shared/ids";
import { cellMatches, recordColor, searchRows, summarize } from "../src/shared/viewTools";
import { permissionProblem } from "../src/shared/permissions";
import { copyBaseState, duplicateTableActions } from "../src/shared/duplicate";
import { TEMPLATES, templateActions } from "../src/shared/templates";
import { csvSourceState, csvUrlFor } from "../src/shared/urlSync";
import { buildSync } from "../src/shared/sync";
import { sharedViewData, sharedViewHasFile } from "../src/shared/publicView";
import { sharedPageData } from "../src/shared/publicPage";
import { narrowBy, sourceRows } from "../src/shared/interfaces";
import type { Action, BaseState, InterfacePage } from "../src/shared/types";

const AT = "2026-11-10T12:00:00.000Z";
const ME = newId("usr"), OTHER = newId("usr");

function setup() {
  const ids = {
    t: newId("tbl"), name: newId("fld"), stage: newId("fld"), amount: newId("fld"), done: newId("fld"), due: newId("fld"), notes: newId("fld"),
    parent: newId("fld"), total: newId("fld"), v: newId("viw"), a: newId("opt"), b: newId("opt"), other: newId("tbl"), otherName: newId("fld"), otherView: newId("viw"), link: newId("fld"), inv: newId("fld"),
  };
  const rows = [newId("rec"), newId("rec"), newId("rec")];
  const s = applyActions(emptyBase(newId("bas"), "Work"), [
    { type: "table.create", tableId: ids.t, name: "Tasks", primaryFieldId: ids.name, viewId: ids.v },
    { type: "field.create", fieldId: ids.stage, tableId: ids.t, name: "Stage", fieldType: "singleSelect", options: { choices: [{ id: ids.a, name: "Open", color: "blue" }, { id: ids.b, name: "Done", color: "green" }] } },
    { type: "field.create", fieldId: ids.amount, tableId: ids.t, name: "Hours", fieldType: "number", options: { precision: 1 } },
    { type: "field.create", fieldId: ids.done, tableId: ids.t, name: "Done", fieldType: "checkbox" },
    { type: "field.create", fieldId: ids.due, tableId: ids.t, name: "Due", fieldType: "date" },
    { type: "field.create", fieldId: ids.notes, tableId: ids.t, name: "Notes", fieldType: "longText", options: { richText: true } },
    { type: "field.create", fieldId: ids.parent, tableId: ids.t, name: "Depends on", fieldType: "link", options: { linkedTableId: ids.t } },
    { type: "field.create", fieldId: ids.total, tableId: ids.t, name: "Double", fieldType: "formula", options: { expression: `{${ids.amount}} * 2` } },
    { type: "table.create", tableId: ids.other, name: "People", primaryFieldId: ids.otherName, viewId: ids.otherView },
    { type: "field.create", fieldId: ids.link, tableId: ids.t, name: "Owner", fieldType: "link", options: { linkedTableId: ids.other }, inverseFieldId: ids.inv },
    { type: "row.create", rowId: rows[0], tableId: ids.t, cells: { [ids.name]: "Write plan", [ids.stage]: ids.a, [ids.amount]: 2, [ids.due]: "2026-11-01", [ids.notes]: "**Bold** start" } },
    { type: "row.create", rowId: rows[1], tableId: ids.t, cells: { [ids.name]: "Review", [ids.stage]: ids.b, [ids.amount]: 4.5, [ids.done]: true, [ids.due]: "2026-11-20", [ids.parent]: [rows[0]] } },
    { type: "row.create", rowId: rows[2], tableId: ids.t, cells: { [ids.name]: "Ship", [ids.amount]: 1 } },
  ], AT, ME);
  return { s, ids, rows };
}

test("column summaries, search and record colors", () => {
  const { s, ids, rows } = setup();
  const c = new Computer(s);
  const list = rows.map((id) => s.rows[id]);
  const f = (id: string) => s.fields[id];
  assert.equal(summarize(c, list, f(ids.amount), "sum"), "7.5");
  assert.equal(summarize(c, list, f(ids.amount), "median"), "2.0");
  assert.equal(summarize(c, list, f(ids.amount), "range"), "3.5");
  assert.equal(summarize(c, list, f(ids.stage), "filled"), "2");
  assert.equal(summarize(c, list, f(ids.stage), "percentEmpty"), "33%");
  assert.equal(summarize(c, list, f(ids.done), "checked"), "1");
  assert.equal(summarize(c, list, f(ids.due), "dateRange"), "19 days");
  assert.equal(summarize(c, list, f(ids.stage), "unique"), "2");
  const fields = s.tables[ids.t].fieldOrder.map((id) => s.fields[id]);
  assert.deepEqual(searchRows(c, list, fields, "REVIEW").map((r) => r.id), [rows[1]], "search ignores case");
  assert.deepEqual(searchRows(c, list, fields, "done").map((r) => r.id), [rows[1]], "select names are searched");
  assert.ok(cellMatches(c, s.rows[rows[0]], f(ids.notes), "bold"));
  assert.equal(recordColor(c, s.rows[rows[1]], { mode: "select", fieldId: ids.stage }), "green");
  assert.equal(recordColor(c, s.rows[rows[2]], { mode: "select", fieldId: ids.stage }), null);
  const rules = { mode: "conditions" as const, rules: [
    { id: "r1", color: "red", filters: { conjunction: "and" as const, conditions: [{ id: "c", fieldId: ids.amount, operator: "gt", value: 3 }] } },
    { id: "r2", color: "gray", filters: { conjunction: "and" as const, conditions: [{ id: "c", fieldId: ids.amount, operator: "gt", value: 0 }] } },
  ] };
  assert.deepEqual(rows.map((id) => recordColor(c, s.rows[id], rules)), ["gray", "red", "gray"], "first matching rule wins");
});

test("view settings are checked, and deleting a field cleans them up", () => {
  const { s, ids } = setup();
  const up = (config: object) => applyAction(s, { type: "view.update", viewId: ids.v, config }, AT, ME);
  assert.throws(() => up({ rowHeight: "huge" }), /row height/);
  assert.throws(() => up({ frozenCount: 9 }), /Freeze/);
  assert.throws(() => up({ summaries: { [ids.amount]: "everything" } }), /summary/);
  assert.throws(() => up({ colors: { mode: "select", fieldId: ids.amount } }), /single select/);
  assert.throws(() => up({ timeline: { startFieldId: ids.name, endFieldId: null, scale: "week", dependencyFieldId: null } }), /date/);
  assert.throws(() => up({ timeline: { startFieldId: ids.due, endFieldId: null, scale: "week", dependencyFieldId: ids.link } }), /same table/);
  let t = up({ summaries: { [ids.amount]: "sum" }, colors: { mode: "select", fieldId: ids.stage }, rowHeight: "tall", frozenCount: 2,
    timeline: { startFieldId: ids.due, endFieldId: null, scale: "week", dependencyFieldId: ids.parent } });
  t = applyAction(t, { type: "field.delete", fieldId: ids.stage }, AT, ME);
  t = applyAction(t, { type: "field.delete", fieldId: ids.parent }, AT, ME);
  const cfg = t.views[ids.v].config;
  assert.equal(cfg.colors, null);
  assert.equal(cfg.timeline?.dependencyFieldId, null);
  assert.deepEqual(cfg.summaries, { [ids.amount]: "sum" });
});

test("locked and personal views", () => {
  const { s, ids } = setup();
  const locked = applyAction(s, { type: "view.update", viewId: ids.v, config: { locked: true } }, AT, ME);
  assert.throws(() => applyAction(locked, { type: "view.update", viewId: ids.v, config: { sorts: [] } }, AT, ME), /locked/);
  assert.throws(() => applyAction(locked, { type: "view.update", viewId: ids.v, name: "X" }, AT, ME), /locked/);
  assert.doesNotThrow(() => applyAction(locked, { type: "view.update", viewId: ids.v, config: { fieldWidths: { [ids.name]: 300 } } }, AT, ME), "widths still adjust");
  assert.equal(permissionProblem(locked, [{ type: "view.update", viewId: ids.v, config: { locked: false } }], ME, "editor"), "Only owners can unlock a view");
  assert.equal(permissionProblem(locked, [{ type: "view.update", viewId: ids.v, config: { locked: false } }], ME, "owner"), null);
  const pv = newId("viw");
  const mine = applyAction(s, { type: "view.create", viewId: pv, tableId: ids.t, name: "Mine", viewType: "grid", personal: true }, AT, ME);
  assert.equal(mine.views[pv].personalFor, ME);
  assert.throws(() => applyAction(mine, { type: "view.update", viewId: pv, config: { sorts: [] } }, AT, OTHER), /someone else's/);
  assert.throws(() => applyAction(mine, { type: "view.delete", viewId: ids.v }, AT, ME), /everyone can see/, "the last shared view stays");
});

test("field and table permissions", () => {
  const { s, ids, rows } = setup();
  let t = applyAction(s, { type: "field.update", fieldId: ids.amount, editableBy: { userIds: [OTHER] } }, AT, ME);
  t = applyAction(t, { type: "table.permissions", tableId: ids.t, recordsEditableBy: "owners" }, AT, ME);
  const edit: Action = { type: "row.update", rowId: rows[0], cells: { [ids.amount]: 9 } };
  assert.match(permissionProblem(t, [edit], ME, "editor") ?? "", /Hours/);
  assert.equal(permissionProblem(t, [edit], OTHER, "editor"), null, "a chosen person may");
  assert.equal(permissionProblem(t, [edit], ME, "owner"), null, "owners always may");
  assert.match(permissionProblem(t, [{ type: "row.create", rowId: newId("rec"), tableId: ids.t }], OTHER, "editor") ?? "", /add records/);
  assert.match(permissionProblem(t, [{ type: "row.delete", rowIds: [rows[2]] }], OTHER, "editor") ?? "", /delete records/);
  assert.match(permissionProblem(t, [{ type: "restore", patch: { rows: { [rows[0]]: { kind: "cells", cells: { [ids.amount]: 1 } } } } }], ME, "editor") ?? "", /Hours/, "undo can't get around it");
  assert.match(permissionProblem(s, [{ type: "field.update", fieldId: ids.amount, editableBy: "owners" }], ME, "editor") ?? "", /Only owners/);
});

test("records remember who created them", () => {
  const { s, ids, rows } = setup();
  const by = newId("fld");
  const t = applyActions(s, [{ type: "field.create", fieldId: by, tableId: ids.t, name: "Creator", fieldType: "createdBy" }], AT, ME);
  const people = { ...t, people: { [ME]: { name: "Ana", email: "a@x.test" } } };
  const c = new Computer(people);
  assert.equal(c.display(people.rows[rows[0]], people.fields[by]), "Ana");
  const auto = applyAction(t, { type: "row.create", rowId: newId("rec"), tableId: ids.t }, AT, null);
  const last = auto.tables[ids.t].rowOrder.at(-1)!;
  assert.equal(new Computer(auto).display(auto.rows[last], auto.fields[by]), "Automation");
});

test("duplicating a table copies fields, views and records, and undoes cleanly", () => {
  const { s, ids, rows } = setup();
  const withView = applyAction(s, { type: "view.update", viewId: ids.v, config: { sorts: [{ fieldId: ids.amount, direction: "desc" }], summaries: { [ids.amount]: "sum" } } }, AT, ME);
  const { tableId, actions, rows: rowActions } = duplicateTableActions(withView, ids.t, true);
  const after = applyActions(withView, [...actions, ...rowActions], AT, ME);
  const copy = after.tables[tableId];
  assert.equal(copy.name, "Tasks copy");
  const names = copy.fieldOrder.map((id) => after.fields[id].name);
  assert.deepEqual(names, s.tables[ids.t].fieldOrder.map((id) => s.fields[id].name));
  const ft = (n: string) => after.fields[copy.fieldOrder.find((id) => after.fields[id].name === n)!];
  assert.equal(ft("Stage").type, "singleSelect");
  assert.equal(ft("Notes").options.richText, true);
  assert.equal(ft("Depends on").options.linkedTableId, tableId, "links within the table point at the copy");
  assert.equal(ft("Owner").options.linkedTableId, ids.other, "links to other tables stay");
  assert.notEqual(ft("Owner").options.inverseFieldId, ids.inv, "with a new field on the other side");
  const c = new Computer(after);
  const copyRows = copy.rowOrder.map((id) => after.rows[id]);
  assert.deepEqual(copyRows.map((r) => c.display(r, ft("Double"))), ["4", "9", "2"], "formulas use the copied fields");
  assert.equal(c.display(copyRows[1], ft("Depends on")), "Write plan");
  assert.ok(!(copyRows[1].cells[ft("Depends on").id] as string[]).includes(rows[0]), "linked to the copied record, not the original");
  const view = after.views[copy.viewOrder[0]];
  assert.equal(copy.viewOrder.length, 1);
  assert.deepEqual(view.config.sorts, [{ fieldId: ft("Hours").id, direction: "desc" }]);
  const undone = applyAction(after, { type: "restore", patch: inversePatch(withView, after) }, AT, ME);
  assert.equal(undone.tables[tableId], undefined);
  assert.deepEqual(Object.keys(undone.fields).sort(), Object.keys(withView.fields).sort(), "undo removes the other side's link field too");
});

test("a base copy has new ids everywhere and no public links", () => {
  const { s, ids } = setup();
  const linked = applyActions(s, [
    { type: "view.update", viewId: ids.v, config: { shareToken: "x".repeat(32) } },
    { type: "page.upsert", page: { id: newId("pag"), name: "Dash", elements: [], shareToken: "y".repeat(32) } },
  ], AT, ME);
  const { state } = copyBaseState(linked, newId("bas"), "Copy", true);
  const text = JSON.stringify(state);
  for (const id of [ids.t, ids.name, ids.v, ...Object.keys(s.rows)]) assert.ok(!text.includes(id), `${id} was replaced`);
  assert.ok(!text.includes("x".repeat(32)) && !text.includes("y".repeat(32)));
  const c = new Computer(state);
  const t = state.tables[state.tableOrder[0]];
  const double = t.fieldOrder.map((id) => state.fields[id]).find((f) => f.name === "Double")!;
  assert.deepEqual(t.rowOrder.map((id) => c.display(state.rows[id], double)), ["4", "9", "2"]);
  const empty = copyBaseState(linked, newId("bas"), "Empty", false).state;
  assert.equal(Object.keys(empty.rows).length, 0);
});

test("every template builds", () => {
  for (const t of TEMPLATES) {
    const s = applyActions(emptyBase(newId("bas"), t.name), templateActions(t.id)!, AT, ME);
    assert.ok(s.tableOrder.length > 0, t.id);
    assert.ok(Object.keys(s.rows).length > 0, `${t.id} has sample records`);
  }
  assert.equal(templateActions("nope"), null);
});

test("CSV and Google Sheets syncs keep records matched across refreshes", () => {
  assert.equal(csvUrlFor("https://docs.google.com/spreadsheets/d/AbC_123/edit#gid=77").url, "https://docs.google.com/spreadsheets/d/AbC_123/export?format=csv&gid=77");
  assert.throws(() => csvUrlFor("http://example.com/a.csv"), /https/);
  const csv1 = "Name,Qty,Kind,When\nBolt,3,Metal,2026-01-02\nNut,5,Metal,2026-01-03\nTape,1,Paper,2026-01-04\nGlue,2,Paper,2026-01-05\n";
  const a = csvSourceState(csv1, "parts.csv");
  const b = csvSourceState(csv1.replace("Nut,5", "Nut,6"), "parts.csv");
  assert.deepEqual(Object.keys(a.state.rows).sort(), Object.keys(b.state.rows).sort(), "same records keep their ids");
  const fieldTypes = a.state.tables[a.view.tableId].fieldOrder.map((id) => a.state.fields[id].type);
  assert.deepEqual(fieldTypes, ["text", "number", "singleSelect", "date"]);
  assert.throws(() => csvSourceState("<!DOCTYPE html><html>", "x"), /web page/);
  // Sync into a table, then refresh with one change.
  const tableId = newId("tbl");
  let target = applyAction(emptyBase(newId("bas"), "T"), { type: "table.create", tableId, name: "Parts", primaryFieldId: newId("fld"), viewId: newId("viw"),
    sync: { kind: "url", sourceBaseId: "url", sourceTableId: "url", sourceViewId: "url", sourceLabel: "parts.csv", createdBy: ME, lastSyncAt: null, error: null } }, AT);
  assert.equal(target.tables[tableId].sync?.kind, "url");
  target = applyAction(target, buildSync(a.state, a.view, target, target.tables[tableId], new Date(AT), "parts.csv")!, AT);
  const before = target.tables[tableId].rowOrder.slice();
  assert.equal(before.length, 4);
  assert.equal(buildSync(a.state, a.view, target, target.tables[tableId], new Date(AT), "parts.csv"), null, "nothing changed, nothing to do");
  target = applyAction(target, buildSync(b.state, b.view, target, target.tables[tableId], new Date(AT), "parts.csv")!, AT);
  assert.deepEqual(target.tables[tableId].rowOrder, before, "records updated in place");
  const qty = target.tables[tableId].fieldOrder.map((id) => target.fields[id]).find((f) => f.name === "Qty")!;
  assert.equal(target.rows[before[1]].cells[qty.id], 6);
});

test("public view and page data show only what's visible", () => {
  const { s, ids } = setup();
  const hidden = applyAction(s, { type: "view.update", viewId: ids.v, config: { hiddenFieldIds: [ids.notes], filters: { conjunction: "and", conditions: [{ id: "c", fieldId: ids.amount, operator: "gt", value: 1.5 }] } } }, AT, ME);
  const data = sharedViewData(hidden, hidden.views[ids.v]);
  assert.equal(data.rows.length, 2, "the view's filter applies");
  assert.ok(!data.fields.some((f) => f.id === ids.notes), "hidden fields stay hidden");
  assert.ok(!JSON.stringify(data).includes("Bold"));
  assert.deepEqual(data.rows[1].cells[ids.stage].chips, [{ name: "Done", color: "green" }]);
  assert.equal(sharedViewHasFile(data, newId("att")), false);
  const page: InterfacePage = { id: newId("pag"), name: "Dash", elements: [
    { id: newId("elm"), x: 0, y: 0, w: 3, h: 3, title: "Hours", kind: "number", source: { tableId: ids.t, viewId: null }, fn: "sum", fieldId: ids.amount },
    { id: newId("elm"), x: 3, y: 0, w: 3, h: 2, title: "", kind: "button", label: "Run", action: { type: "automation", automationId: "x" } },
  ] };
  const pd = sharedPageData(s, page);
  assert.equal(pd.elements.length, 1, "automation buttons aren't shown to visitors");
  assert.equal(pd.elements[0].kind === "number" && pd.elements[0].text, "7.5");
});

test("record pages, print layouts and viewer filters are checked", () => {
  const { s, ids, rows } = setup();
  const pid = newId("pag");
  const print: InterfacePage = { id: pid, name: "Invoice", elements: [], kind: "print", tableId: ids.t, paper: "letter",
    items: [{ id: newId("prt"), kind: "field", fieldId: ids.name, x: 10, y: 10, w: 100, h: 10, size: 99, bold: true, label: false, align: "left" }] };
  const t = applyAction(s, { type: "page.upsert", page: print }, AT, ME);
  assert.equal(t.pages[pid].items![0].size, 72, "font size is kept in range");
  assert.throws(() => applyAction(s, { type: "page.upsert", page: { ...print, items: [{ ...print.items![0], fieldId: ids.otherName }] } }, AT, ME), /isn't in the table/);
  assert.throws(() => applyAction(s, { type: "page.upsert", page: { ...print, shareToken: "z".repeat(32) } }, AT, ME), /can't be published/);
  const ctl = { id: newId("ctl"), tableId: ids.t, fieldId: ids.stage };
  const dash = applyAction(s, { type: "page.upsert", page: { id: newId("pag"), name: "D", elements: [], controls: [ctl] } }, AT, ME);
  assert.equal(Object.values(dash.pages)[0].controls?.length, 1);
  const c = new Computer(s);
  const narrow = narrowBy(c, s, [ctl], { [ctl.id]: ids.b });
  assert.deepEqual(sourceRows(c, s, { tableId: ids.t, viewId: null }, narrow).map((r) => r.id), [rows[1]]);
  assert.equal(sourceRows(c, s, { tableId: ids.other, viewId: null }, narrow).length, 0, "other tables aren't touched (and are empty)");
});

test("a snapshot restore puts the base back", () => {
  const { s, ids, rows } = setup();
  const saved: BaseState = structuredClone(s);
  let now = applyActions(s, [
    { type: "row.delete", rowIds: [rows[0]] },
    { type: "field.delete", fieldId: ids.total },
    { type: "table.rename", tableId: ids.t, name: "Renamed" },
    { type: "row.update", rowId: rows[1], cells: { [ids.amount]: 99 } },
  ], AT, ME);
  now = applyAction(now, { type: "restore", patch: inversePatch(saved, now) }, AT, ME);
  assert.equal(now.tables[ids.t].name, "Tasks");
  assert.deepEqual(now.tables[ids.t].rowOrder, s.tables[ids.t].rowOrder);
  assert.equal(now.rows[rows[1]].cells[ids.amount], 4.5);
  assert.ok(now.fields[ids.total]);
  assert.deepEqual(now.rows[rows[1]].cells[ids.parent], [rows[0]], "links come back with the record");
});

test("rich text reads cleanly as plain text", async () => {
  const { markdownToPlain } = await import("../src/shared/publicView");
  assert.equal(markdownToPlain("## Plan\n**Goal:** a *simple* [site](https://x.test)\n- one\n- `two`"), "Plan\nGoal: a simple site\n• one\n• two");
});
