import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAction, emptyBase } from "../src/shared/reducer";
import { inversePatch } from "../src/shared/history";
import { Computer } from "../src/shared/compute";
import { newId } from "../src/shared/ids";
import type { Action, BaseState } from "../src/shared/types";

const AT = "2026-11-10T12:00:00.000Z";
const run = (s: BaseState, actions: Action[]) => actions.reduce((acc, a) => applyAction(acc, a, AT), s);

function setup() {
  const ids = {
    p: newId("tbl"), t: newId("tbl"), pName: newId("fld"), tName: newId("fld"), status: newId("fld"), link: newId("fld"), inv: newId("fld"),
    look: newId("fld"), grid: newId("viw"), kanban: newId("viw"), gallery: newId("viw"), tGrid: newId("viw"), tCal: newId("viw"),
    p1: newId("rec"), t1: newId("rec"), t2: newId("rec"), t3: newId("rec"), todo: newId("opt"), done: newId("opt"),
  };
  const s = run(emptyBase(newId("bas"), "Test"), [
    { type: "table.create", tableId: ids.p, name: "Projects", primaryFieldId: ids.pName, viewId: ids.grid },
    { type: "table.create", tableId: ids.t, name: "Tasks", primaryFieldId: ids.tName, viewId: ids.tGrid },
    { type: "view.create", viewId: ids.kanban, tableId: ids.p, name: "Board", viewType: "kanban" },
    { type: "view.create", viewId: ids.gallery, tableId: ids.p, name: "Cards", viewType: "gallery" },
    { type: "view.create", viewId: ids.tCal, tableId: ids.t, name: "Calendar", viewType: "calendar" },
    { type: "field.create", fieldId: ids.status, tableId: ids.t, name: "Status", fieldType: "singleSelect",
      options: { choices: [{ id: ids.todo, name: "Todo", color: "red" }, { id: ids.done, name: "Done", color: "green" }] } },
  ]);
  return { s, ids };
}

test("new fields start hidden in kanban, calendar and gallery views, but not in grids", () => {
  const { s, ids } = setup();
  const before = s;
  const after = run(s, [{ type: "field.create", fieldId: ids.link, tableId: ids.p, name: "Tasks", fieldType: "link", options: { linkedTableId: ids.t }, inverseFieldId: ids.inv }]);
  assert.ok(after.views[ids.kanban].config.hiddenFieldIds.includes(ids.link));
  assert.ok(after.views[ids.gallery].config.hiddenFieldIds.includes(ids.link));
  assert.ok(!after.views[ids.grid].config.hiddenFieldIds.includes(ids.link));
  // The back-link made in the other table follows the same rule.
  assert.ok(after.views[ids.tCal].config.hiddenFieldIds.includes(ids.inv));
  assert.ok(!after.views[ids.tGrid].config.hiddenFieldIds.includes(ids.inv));
  // Undo puts the views back exactly.
  const undone = applyAction(after, { type: "restore", patch: inversePatch(before, after) }, AT);
  assert.deepEqual(undone.views, before.views);
});

test("lookup values stay grouped by the record they came from", () => {
  const { s, ids } = setup();
  const after = run(s, [
    { type: "field.create", fieldId: ids.link, tableId: ids.p, name: "Tasks", fieldType: "link", options: { linkedTableId: ids.t }, inverseFieldId: ids.inv },
    { type: "row.create", rowId: ids.p1, tableId: ids.p, cells: { [ids.pName]: "Website" } },
    { type: "row.create", rowId: ids.t1, tableId: ids.t, cells: { [ids.tName]: "Design", [ids.status]: ids.done } },
    { type: "row.create", rowId: ids.t2, tableId: ids.t, cells: { [ids.tName]: "Build" } },
    { type: "row.create", rowId: ids.t3, tableId: ids.t, cells: { [ids.tName]: "Test", [ids.status]: ids.todo } },
    { type: "link.add", rowId: ids.p1, fieldId: ids.link, linkedRowIds: [ids.t1, ids.t2, ids.t3] },
    { type: "field.create", fieldId: ids.look, tableId: ids.p, name: "Task status", fieldType: "lookup", options: { linkFieldId: ids.link, targetFieldId: ids.status } },
  ]);
  const c = new Computer(after);
  const row = after.rows[ids.p1];
  assert.deepEqual(c.lookupGroups(row, after.fields[ids.look]), [
    { rowId: ids.t1, name: "Design", values: ["Done"] },
    { rowId: ids.t2, name: "Build", values: [] },
    { rowId: ids.t3, name: "Test", values: ["Todo"] },
  ]);
  // Formulas and filters still see one flat list.
  assert.deepEqual(c.value(row, after.fields[ids.look]), ["Done", "Todo"]);
  assert.deepEqual(c.lookupGroups(row, after.fields[ids.pName]), []);
});
