import { test } from "node:test";
import assert from "node:assert/strict";
import { applyActions, emptyBase } from "../src/shared/reducer";
import { inversePatch } from "../src/shared/history";
import { rowHistory } from "../src/shared/activity";
import { newId } from "../src/shared/ids";
import type { Action, BaseState } from "../src/shared/types";

const AT = "2026-11-10T12:00:00.000Z";
const run = (s: BaseState, actions: Action[]) => ({ after: applyActions(s, actions, AT), actions });

function setup() {
  const ids = {
    p: newId("tbl"), t: newId("tbl"), pName: newId("fld"), tName: newId("fld"), status: newId("fld"), link: newId("fld"), inv: newId("fld"),
    budget: newId("fld"), p1: newId("rec"), t1: newId("rec"), todo: newId("opt"), done: newId("opt"),
  };
  const s = applyActions(emptyBase(newId("bas"), "B"), [
    { type: "table.create", tableId: ids.p, name: "Projects", primaryFieldId: ids.pName, viewId: newId("viw") },
    { type: "table.create", tableId: ids.t, name: "Tasks", primaryFieldId: ids.tName, viewId: newId("viw") },
    { type: "field.create", fieldId: ids.status, tableId: ids.p, name: "Status", fieldType: "singleSelect",
      options: { choices: [{ id: ids.todo, name: "Todo", color: "red" }, { id: ids.done, name: "Done", color: "green" }] } },
    { type: "field.create", fieldId: ids.budget, tableId: ids.p, name: "Budget", fieldType: "number", options: { format: "currency", precision: 0 } },
    { type: "field.create", fieldId: ids.link, tableId: ids.p, name: "Tasks", fieldType: "link", options: { linkedTableId: ids.t }, inverseFieldId: ids.inv },
    { type: "row.create", rowId: ids.p1, tableId: ids.p, cells: { [ids.pName]: "Website", [ids.status]: ids.todo, [ids.budget]: 1000 } },
    { type: "row.create", rowId: ids.t1, tableId: ids.t, cells: { [ids.tName]: "Design" } },
  ], AT);
  return { s, ids };
}

test("edits record readable before/after values", () => {
  const { s, ids } = setup();
  const { after, actions } = run(s, [{ type: "row.update", rowId: ids.p1, cells: { [ids.status]: ids.done, [ids.budget]: 2500 } }]);
  const h = rowHistory(s, after, actions, AT);
  assert.equal(h.length, 1);
  assert.equal(h[0].kind, "updated");
  assert.deepEqual(h[0].changes.map((c) => [c.name, c.from, c.to]).sort(), [["Budget", "$1,000", "$2,500"], ["Status", "Todo", "Done"]]);
});

test("linking shows up on both records", () => {
  const { s, ids } = setup();
  const { after, actions } = run(s, [{ type: "row.update", rowId: ids.p1, cells: { [ids.link]: [ids.t1] } }]);
  const h = rowHistory(s, after, actions, AT);
  const byRow = Object.fromEntries(h.map((e) => [e.rowId, e.changes[0]]));
  assert.deepEqual([byRow[ids.p1].name, byRow[ids.p1].to], ["Tasks", "Design"]);
  assert.deepEqual([byRow[ids.t1].name, byRow[ids.t1].to], ["Projects", "Website"]);
});

test("creates, deletes and undo restores", () => {
  const { s, ids } = setup();
  const id = newId("rec");
  const created = run(s, [{ type: "row.create", rowId: id, tableId: ids.p, cells: { [ids.pName]: "App", [ids.status]: ids.todo } }]);
  const c = rowHistory(s, created.after, created.actions, AT);
  assert.equal(c[0].kind, "created");
  assert.deepEqual(c[0].changes.map((x) => `${x.name}=${x.to}`), ["Name=App", "Status=Todo"]);

  const deleted = run(s, [{ type: "row.delete", rowIds: [ids.p1] }]);
  const d = rowHistory(s, deleted.after, deleted.actions, AT);
  assert.deepEqual(d.map((e) => [e.kind, e.title]), [["deleted", "Website"]]);

  const undo = run(deleted.after, [{ type: "restore", patch: inversePatch(s, deleted.after) }]);
  const r = rowHistory(deleted.after, undo.after, undo.actions, AT);
  assert.equal(r[0].kind, "restored");
});

test("schema changes don't fill every record's history", () => {
  const { s, ids } = setup();
  const removed = run(s, [{ type: "field.delete", fieldId: ids.status }]);
  assert.deepEqual(rowHistory(s, removed.after, removed.actions, AT), []);
  const retyped = run(s, [{ type: "field.update", fieldId: ids.budget, fieldType: "text" }]);
  assert.deepEqual(rowHistory(s, retyped.after, retyped.actions, AT), []);
});
