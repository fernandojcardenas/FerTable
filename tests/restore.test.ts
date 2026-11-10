import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAction, emptyBase } from "../src/shared/reducer";
import { restoreActions, rowHistory } from "../src/shared/activity";
import { newId } from "../src/shared/ids";
import type { Action, BaseState } from "../src/shared/types";

const AT = "2026-11-10T12:00:00.000Z";
const run = (s: BaseState, actions: Action[]) => actions.reduce((acc, a) => applyAction(acc, a, AT), s);

function setup() {
  const ids = {
    p: newId("tbl"), t: newId("tbl"), name: newId("fld"), notes: newId("fld"), status: newId("fld"), link: newId("fld"), inv: newId("fld"), tName: newId("fld"),
    v1: newId("viw"), v2: newId("viw"), r: newId("rec"), t1: newId("rec"), t2: newId("rec"), t3: newId("rec"), todo: newId("opt"), done: newId("opt"),
  };
  const s = run(emptyBase(newId("bas"), "Test"), [
    { type: "table.create", tableId: ids.p, name: "Projects", primaryFieldId: ids.name, viewId: ids.v1 },
    { type: "table.create", tableId: ids.t, name: "Tasks", primaryFieldId: ids.tName, viewId: ids.v2 },
    { type: "field.create", fieldId: ids.notes, tableId: ids.p, name: "Notes", fieldType: "longText" },
    { type: "field.create", fieldId: ids.status, tableId: ids.p, name: "Status", fieldType: "singleSelect",
      options: { choices: [{ id: ids.todo, name: "Todo", color: "red" }, { id: ids.done, name: "Done", color: "green" }] } },
    { type: "field.create", fieldId: ids.link, tableId: ids.p, name: "Tasks", fieldType: "link", options: { linkedTableId: ids.t }, inverseFieldId: ids.inv },
    ...[ids.t1, ids.t2, ids.t3].map((rowId, i): Action => ({ type: "row.create", rowId, tableId: ids.t, cells: { [ids.tName]: `T${i + 1}` } })),
    { type: "row.create", rowId: ids.r, tableId: ids.p, cells: { [ids.name]: "Website", [ids.notes]: "First draft", [ids.status]: ids.todo } },
    { type: "link.add", rowId: ids.r, fieldId: ids.link, linkedRowIds: [ids.t1] },
  ]);
  return { s, ids };
}

/** Make a change and return the history entry it wrote for the record. */
function change(s: BaseState, rowId: string, actions: Action[]) {
  const after = run(s, actions);
  const entry = rowHistory(s, after, actions, AT).find((e) => e.rowId === rowId)!;
  return { after, entry };
}

test("history keeps the old values, and restoring puts them back", () => {
  const { s, ids } = setup();
  const { after, entry } = change(s, ids.r, [
    { type: "row.update", rowId: ids.r, cells: { [ids.notes]: "Rewritten", [ids.status]: ids.done } },
    { type: "link.add", rowId: ids.r, fieldId: ids.link, linkedRowIds: [ids.t2] },
  ]);
  assert.deepEqual(entry.changes.map((c) => [c.name, c.type, c.before]), [
    ["Notes", "longText", "First draft"], ["Status", "singleSelect", ids.todo], ["Tasks", "link", [ids.t1]],
  ]);
  // Someone else links another task afterwards; restoring keeps their link.
  const later = run(after, [{ type: "link.add", rowId: ids.r, fieldId: ids.link, linkedRowIds: [ids.t3] }]);
  const { actions, skipped } = restoreActions(later, ids.r, entry.changes);
  assert.deepEqual(skipped, []);
  const restored = run(later, actions);
  const cells = restored.rows[ids.r].cells;
  assert.equal(cells[ids.notes], "First draft");
  assert.equal(cells[ids.status], ids.todo);
  assert.deepEqual(cells[ids.link], [ids.t1]);
  assert.equal(restored.rows[ids.t2].cells[ids.inv], undefined, "the other side is unlinked too");
  // Restoring again changes nothing.
  assert.equal(restoreActions(restored, ids.r, entry.changes).unchanged, true);
});

test("restoring an empty value clears the field", () => {
  const { s, ids } = setup();
  const blank = run(s, [{ type: "row.update", rowId: ids.r, cells: { [ids.notes]: null } }]);
  const { after, entry } = change(blank, ids.r, [{ type: "row.update", rowId: ids.r, cells: { [ids.notes]: "Added later" } }]);
  assert.equal(entry.changes[0].before, null);
  assert.equal(run(after, restoreActions(after, ids.r, entry.changes).actions).rows[ids.r].cells[ids.notes], undefined);
});

test("fields that changed type, lost the option, or can't be kept are skipped", () => {
  const { s, ids } = setup();
  const { after, entry } = change(s, ids.r, [{ type: "row.update", rowId: ids.r, cells: { [ids.notes]: "New", [ids.status]: ids.done } }]);
  const changed = run(after, [
    { type: "field.update", fieldId: ids.notes, fieldType: "number", options: {} },
    { type: "field.update", fieldId: ids.status, options: { choices: [{ id: ids.done, name: "Done", color: "green" }] } },
  ]);
  const r = restoreActions(changed, ids.r, entry.changes);
  assert.deepEqual(r.skipped, ["Notes", "Status"]);
  assert.deepEqual(r.actions, []);
  assert.equal(r.unchanged, false);
  // Entries written before old values were kept have nothing to restore.
  assert.deepEqual(restoreActions(after, ids.r, entry.changes.map(({ before: _b, type: _t, ...c }) => c)).skipped, ["Notes", "Status"]);
  // Huge values are described but not kept.
  const huge = change(after, ids.r, [{ type: "row.update", rowId: ids.r, cells: { [ids.notes]: "x".repeat(30_000) } }]);
  const big = change(huge.after, ids.r, [{ type: "row.update", rowId: ids.r, cells: { [ids.notes]: "short" } }]);
  assert.equal(big.entry.changes[0].before, undefined);
});
