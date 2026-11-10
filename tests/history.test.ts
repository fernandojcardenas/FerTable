import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAction, emptyBase } from "../src/shared/reducer";
import { inversePatch, isEmptyPatch } from "../src/shared/history";
import { newId } from "../src/shared/ids";
import type { Action, BaseState } from "../src/shared/types";

const AT = "2026-11-09T12:00:00.000Z";
const run = (s: BaseState, actions: Action[]) => actions.reduce((acc, a) => applyAction(acc, a, AT), s);
const restore = (s: BaseState, before: BaseState, after: BaseState) => applyAction(s, { type: "restore", patch: inversePatch(before, after) }, AT);

/** Everything a user can see; the autonumber counter only moves forward, so it's left out. */
function visible(s: BaseState) {
  const tables = Object.fromEntries(Object.entries(s.tables).map(([id, t]) => [id, { ...t, nextAutoNumber: 0 }]));
  // Undo is itself an edit, so "last modified" moves on; compare everything else.
  const rows = Object.fromEntries(Object.entries(s.rows).map(([id, { modifiedAt: _a, modifiedBy: _b, ...r }]) => [id, r]));
  return { name: s.base.name, tableOrder: s.tableOrder, tables, fields: s.fields, rows, views: s.views, automations: s.automations };
}

/** Do the change, undo it, redo it, and check each step lands where it should. */
function roundTrip(start: BaseState, actions: Action[]) {
  const after = run(start, actions);
  const undone = restore(after, start, after);
  assert.deepEqual(visible(undone), visible(start), "undo should restore the earlier state");
  const redone = restore(undone, after, undone);
  assert.deepEqual(visible(redone), visible(after), "redo should reapply the change");
  return { after, undone, redone };
}

function setup() {
  const ids = {
    projects: newId("tbl"), tasks: newId("tbl"), pName: newId("fld"), tName: newId("fld"), hours: newId("fld"),
    status: newId("fld"), link: newId("fld"), inverse: newId("fld"), rollup: newId("fld"), pView: newId("viw"), tView: newId("viw"),
    p1: newId("rec"), p2: newId("rec"), t1: newId("rec"), t2: newId("rec"), todo: newId("opt"), done: newId("opt"),
  };
  const s = run(emptyBase(newId("bas"), "Test"), [
    { type: "table.create", tableId: ids.projects, name: "Projects", primaryFieldId: ids.pName, viewId: ids.pView },
    { type: "table.create", tableId: ids.tasks, name: "Tasks", primaryFieldId: ids.tName, viewId: ids.tView },
    { type: "field.create", fieldId: ids.hours, tableId: ids.tasks, name: "Hours", fieldType: "number" },
    { type: "field.create", fieldId: ids.status, tableId: ids.projects, name: "Status", fieldType: "singleSelect",
      options: { choices: [{ id: ids.todo, name: "Todo", color: "red" }, { id: ids.done, name: "Done", color: "green" }] } },
    { type: "field.create", fieldId: ids.link, tableId: ids.projects, name: "Tasks", fieldType: "link", options: { linkedTableId: ids.tasks }, inverseFieldId: ids.inverse },
    { type: "row.create", rowId: ids.p1, tableId: ids.projects, cells: { [ids.pName]: "Website", [ids.status]: ids.todo } },
    { type: "row.create", rowId: ids.p2, tableId: ids.projects, cells: { [ids.pName]: "App" } },
    { type: "row.create", rowId: ids.t1, tableId: ids.tasks, cells: { [ids.tName]: "Design", [ids.hours]: 3 } },
    { type: "row.create", rowId: ids.t2, tableId: ids.tasks, cells: { [ids.tName]: "Build", [ids.hours]: 5 } },
    { type: "row.update", rowId: ids.p1, cells: { [ids.link]: [ids.t1, ids.t2] } },
    { type: "field.create", fieldId: ids.rollup, tableId: ids.projects, name: "Hours", fieldType: "rollup", options: { linkFieldId: ids.link, targetFieldId: ids.hours, fn: "sum" } },
    { type: "view.update", viewId: ids.pView, config: { sorts: [{ fieldId: ids.link, direction: "asc" }], hiddenFieldIds: [ids.status] } },
  ]);
  return { s, ids };
}

test("cell edits, including links on both sides", () => {
  const { s, ids } = setup();
  roundTrip(s, [{ type: "row.update", rowId: ids.p1, cells: { [ids.pName]: "Website v2", [ids.status]: ids.done } }]);
  const { after } = roundTrip(s, [{ type: "row.update", rowId: ids.p2, cells: { [ids.link]: [ids.t1] } }]);
  assert.deepEqual(after.rows[ids.t1].cells[ids.inverse], [ids.p1, ids.p2]);
});

test("adding and deleting records", () => {
  const { s, ids } = setup();
  roundTrip(s, [{ type: "row.create", rowId: newId("rec"), tableId: ids.projects, afterRowId: ids.p1, cells: { [ids.pName]: "New", [ids.link]: [ids.t2] } }]);
  // Deleting a linked record removes it from the other table too; undo brings both back in place.
  const { undone } = roundTrip(s, [{ type: "row.delete", rowIds: [ids.p1] }]);
  assert.deepEqual(undone.tables[ids.projects].rowOrder, [ids.p1, ids.p2]);
  assert.deepEqual(undone.rows[ids.t2].cells[ids.inverse], [ids.p1]);
});

test("deleting a link field brings back its inverse, cells and view settings", () => {
  const { s, ids } = setup();
  const { after } = roundTrip(s, [{ type: "field.delete", fieldId: ids.link }]);
  assert.equal(after.fields[ids.inverse], undefined);
  assert.deepEqual(after.views[ids.pView].config.sorts, []);
});

test("changing a field type and its options", () => {
  const { s, ids } = setup();
  roundTrip(s, [{ type: "field.update", fieldId: ids.status, fieldType: "text" }]);
  roundTrip(s, [{ type: "field.update", fieldId: ids.link, fieldType: "text" }]);
  roundTrip(s, [{ type: "field.update", fieldId: ids.status, name: "Stage", options: { choices: [{ id: ids.todo, name: "To do", color: "blue" }] } }]);
  roundTrip(s, [{ type: "field.move", fieldId: ids.status, toIndex: 3 }]);
});

test("tables, views, automations and the base name", () => {
  const { s, ids } = setup();
  roundTrip(s, [{ type: "table.delete", tableId: ids.tasks }]);
  roundTrip(s, [{ type: "table.create", tableId: newId("tbl"), name: "Notes", primaryFieldId: newId("fld"), viewId: newId("viw") }]);
  roundTrip(s, [{ type: "table.rename", tableId: ids.projects, name: "Initiatives" }]);
  const kanban = newId("viw");
  roundTrip(s, [{ type: "view.create", viewId: kanban, tableId: ids.projects, name: "Board", viewType: "kanban", copyFromViewId: ids.pView }]);
  roundTrip(s, [{ type: "view.update", viewId: ids.pView, config: { filters: { conjunction: "or", conditions: [{ id: newId("flt"), fieldId: ids.pName, operator: "contains", value: "x" }] } } }]);
  const withBoard = run(s, [{ type: "view.create", viewId: kanban, tableId: ids.projects, name: "Board", viewType: "kanban" }]);
  roundTrip(withBoard, [{ type: "view.delete", viewId: kanban }]);
  roundTrip(s, [{ type: "automation.upsert", automation: { id: newId("aut"), name: "A", enabled: true, trigger: { type: "recordCreated", tableId: ids.tasks }, steps: [] } }]);
  roundTrip(s, [{ type: "base.rename", name: "Renamed" }]);
});

test("undo leaves other people's later edits alone", () => {
  const { s, ids } = setup();
  const mine = run(s, [{ type: "row.update", rowId: ids.p1, cells: { [ids.pName]: "Mine" } }]);
  const patch = inversePatch(s, mine);
  // Someone else edits another cell in the same row, and adds a record.
  const extra = newId("rec");
  const theirs = run(mine, [
    { type: "row.update", rowId: ids.p1, cells: { [ids.status]: ids.done } },
    { type: "row.create", rowId: extra, tableId: ids.projects },
  ]);
  const undone = applyAction(theirs, { type: "restore", patch }, AT);
  assert.equal(undone.rows[ids.p1].cells[ids.pName], "Website");
  assert.equal(undone.rows[ids.p1].cells[ids.status], ids.done);
  assert.ok(undone.tables[ids.projects].rowOrder.includes(extra));
});

test("undo skips parts that no longer apply", () => {
  const { s, ids } = setup();
  const mine = run(s, [{ type: "row.update", rowId: ids.p2, cells: { [ids.pName]: "Changed" } }]);
  const patch = inversePatch(s, mine);
  const gone = run(mine, [{ type: "row.delete", rowIds: [ids.p2] }]);
  const undone = applyAction(gone, { type: "restore", patch }, AT);
  assert.equal(undone.rows[ids.p2], undefined);
  assert.ok(isEmptyPatch(inversePatch(s, s)));
});

test("moving records, and undo patches stay small even in big tables", () => {
  const { s, ids } = setup();
  roundTrip(s, [{ type: "row.move", rowIds: [ids.p2], afterRowId: null }]);
  const extra = Array.from({ length: 2000 }, () => newId("rec"));
  const big = run(s, extra.map((rowId) => ({ type: "row.create", rowId, tableId: ids.tasks }) as Action));
  const { after } = roundTrip(big, [{ type: "row.move", rowIds: [extra[1500]], afterRowId: ids.t1 }]);
  assert.equal(after.tables[ids.tasks].rowOrder[1], extra[1500]);
  const patch = inversePatch(big, after);
  assert.ok(JSON.stringify(patch).length < 500, `patch is ${JSON.stringify(patch).length} bytes`);
  assert.throws(() => run(s, [{ type: "row.move", rowIds: [ids.p1], afterRowId: ids.t1 }]), /Can't move rows there/);
});
