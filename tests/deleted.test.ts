import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAction, emptyBase } from "../src/shared/reducer";
import { restoreDeletedActions, rowHistory } from "../src/shared/activity";
import { newId } from "../src/shared/ids";
import type { Action, BaseState } from "../src/shared/types";

const AT = "2026-11-10T12:00:00.000Z";
const run = (s: BaseState, actions: Action[]) => actions.reduce((acc, a) => applyAction(acc, a, AT), s);

function setup() {
  const ids = {
    p: newId("tbl"), t: newId("tbl"), name: newId("fld"), notes: newId("fld"), status: newId("fld"), link: newId("fld"), inv: newId("fld"), tName: newId("fld"),
    v1: newId("viw"), v2: newId("viw"), r: newId("rec"), r2: newId("rec"), t1: newId("rec"), t2: newId("rec"), todo: newId("opt"),
  };
  const s = run(emptyBase(newId("bas"), "Test"), [
    { type: "table.create", tableId: ids.p, name: "Projects", primaryFieldId: ids.name, viewId: ids.v1 },
    { type: "table.create", tableId: ids.t, name: "Tasks", primaryFieldId: ids.tName, viewId: ids.v2 },
    { type: "field.create", fieldId: ids.notes, tableId: ids.p, name: "Notes", fieldType: "longText" },
    { type: "field.create", fieldId: ids.status, tableId: ids.p, name: "Status", fieldType: "singleSelect", options: { choices: [{ id: ids.todo, name: "Todo", color: "red" }] } },
    { type: "field.create", fieldId: ids.link, tableId: ids.p, name: "Tasks", fieldType: "link", options: { linkedTableId: ids.t }, inverseFieldId: ids.inv },
    { type: "row.create", rowId: ids.t1, tableId: ids.t, cells: { [ids.tName]: "Design" } },
    { type: "row.create", rowId: ids.t2, tableId: ids.t, cells: { [ids.tName]: "Build" } },
    { type: "row.create", rowId: ids.r, tableId: ids.p, createdAt: "2026-01-02T03:04:05.000Z", cells: { [ids.name]: "Website", [ids.notes]: "Plan", [ids.status]: ids.todo } },
    { type: "row.create", rowId: ids.r2, tableId: ids.p, cells: { [ids.name]: "App" } },
    { type: "link.add", rowId: ids.r, fieldId: ids.link, linkedRowIds: [ids.t1, ids.t2] },
  ]);
  return { s, ids };
}

function deleteRow(s: BaseState, rowId: string) {
  const actions: Action[] = [{ type: "row.delete", rowIds: [rowId] }];
  const after = run(s, actions);
  return { after, entry: rowHistory(s, after, actions, AT).find((e) => e.rowId === rowId && e.kind === "deleted")! };
}

test("a deleted record comes back as it was: same id, created time, number, values and links", () => {
  const { s, ids } = setup();
  const original = s.rows[ids.r];
  const { after, entry } = deleteRow(s, ids.r);
  assert.ok(entry.snapshot, "the record is kept");
  assert.deepEqual(entry.changes.map((c) => c.name), ["Name", "Notes", "Status", "Tasks"], "what was deleted is shown");
  assert.equal(after.rows[ids.t1].cells[ids.inv], undefined);

  // One linked task is deleted too in the meantime.
  const later = run(after, [{ type: "row.delete", rowIds: [ids.t2] }]);
  const { actions, skipped } = restoreDeletedActions(later, entry.snapshot!);
  assert.deepEqual(skipped, []);
  const back = run(later, actions);
  const row = back.rows[ids.r];
  assert.equal(row.createdAt, original.createdAt);
  assert.equal(row.autoNumber, original.autoNumber);
  assert.equal(row.cells[ids.notes], "Plan");
  assert.equal(row.cells[ids.status], ids.todo);
  assert.deepEqual(row.cells[ids.link], [ids.t1]);
  assert.deepEqual(back.rows[ids.t1].cells[ids.inv], [ids.r], "linked on both sides again");
  assert.ok(back.tables[ids.p].rowOrder.includes(ids.r));
  // History calls it restored.
  assert.equal(rowHistory(later, back, actions, AT).find((e) => e.rowId === ids.r)?.kind, "restored");
  // Restoring twice does nothing.
  assert.deepEqual(restoreDeletedActions(back, entry.snapshot!).actions, []);
});

test("values whose field changed since are left empty and named", () => {
  const { s, ids } = setup();
  const { after, entry } = deleteRow(s, ids.r);
  const changed = run(after, [
    { type: "field.update", fieldId: ids.notes, fieldType: "number", options: {} },
    { type: "field.update", fieldId: ids.status, options: { choices: [] } },
  ]);
  const { actions, skipped } = restoreDeletedActions(changed, entry.snapshot!);
  assert.deepEqual(skipped.sort(), ["Notes", "Status"]);
  const row = run(changed, actions).rows[ids.r];
  assert.equal(row.cells[ids.notes], undefined);
  assert.equal(row.cells[ids.status], undefined);
  assert.equal(row.cells[ids.name], "Website");
});

test("records in a deleted table aren't offered one by one", () => {
  const { s, ids } = setup();
  const actions: Action[] = [{ type: "table.delete", tableId: ids.p }];
  const after = run(s, actions);
  const entries = rowHistory(s, after, actions, AT).filter((e) => e.kind === "deleted" && s.rows[e.rowId]?.tableId === ids.p);
  assert.ok(entries.length >= 2);
  assert.ok(entries.every((e) => e.snapshot === undefined));
});
