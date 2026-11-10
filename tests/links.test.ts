import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAction, emptyBase } from "../src/shared/reducer";
import { inversePatch } from "../src/shared/history";
import { newId } from "../src/shared/ids";
import { cellActions } from "../src/client/ui/actions";
import type { Action, BaseState } from "../src/shared/types";

const AT = "2026-11-10T12:00:00.000Z";
const run = (s: BaseState, actions: Action[]) => actions.reduce((acc, a) => applyAction(acc, a, AT), s);
const undo = (s: BaseState, before: BaseState, after: BaseState) => applyAction(s, { type: "restore", patch: inversePatch(before, after) }, AT);

function setup() {
  const ids = {
    projects: newId("tbl"), tasks: newId("tbl"), pName: newId("fld"), tName: newId("fld"), link: newId("fld"), inverse: newId("fld"),
    notes: newId("fld"), count: newId("fld"), pView: newId("viw"), tView: newId("viw"),
    p1: newId("rec"), p2: newId("rec"), t1: newId("rec"), t2: newId("rec"), t3: newId("rec"), t4: newId("rec"),
  };
  const s = run(emptyBase(newId("bas"), "Test"), [
    { type: "table.create", tableId: ids.projects, name: "Projects", primaryFieldId: ids.pName, viewId: ids.pView },
    { type: "table.create", tableId: ids.tasks, name: "Tasks", primaryFieldId: ids.tName, viewId: ids.tView },
    { type: "field.create", fieldId: ids.link, tableId: ids.projects, name: "Tasks", fieldType: "link", options: { linkedTableId: ids.tasks }, inverseFieldId: ids.inverse },
    { type: "field.create", fieldId: ids.notes, tableId: ids.projects, name: "Notes", fieldType: "text" },
    { type: "row.create", rowId: ids.p1, tableId: ids.projects, cells: { [ids.pName]: "Website" } },
    { type: "row.create", rowId: ids.p2, tableId: ids.projects, cells: { [ids.pName]: "App" } },
    ...[ids.t1, ids.t2, ids.t3, ids.t4].map((rowId, i): Action => ({ type: "row.create", rowId, tableId: ids.tasks, cells: { [ids.tName]: `Task ${i + 1}` } })),
    { type: "row.update", rowId: ids.p1, cells: { [ids.link]: [ids.t1, ids.t2] } },
    { type: "field.create", fieldId: ids.count, tableId: ids.projects, name: "Count", fieldType: "count", options: { linkFieldId: ids.link } },
  ]);
  return { s, ids };
}

const links = (s: BaseState, rowId: string, fieldId: string) => s.rows[rowId].cells[fieldId] ?? [];
/** Records without their "last modified" stamp (undo is itself an edit, so that moves on). */
const plain = (rows: BaseState["rows"]) => Object.fromEntries(Object.entries(rows).map(([id, { modifiedAt: _a, modifiedBy: _b, ...r }]) => [id, r]));

test("link.add appends, updates the other side, and repeating it changes nothing", () => {
  const { s, ids } = setup();
  const add: Action = { type: "link.add", rowId: ids.p1, fieldId: ids.link, linkedRowIds: [ids.t3] };
  const after = run(s, [add]);
  assert.deepEqual(links(after, ids.p1, ids.link), [ids.t1, ids.t2, ids.t3]);
  assert.deepEqual(links(after, ids.t3, ids.inverse), [ids.p1]);
  const again = run(after, [add, { type: "link.add", rowId: ids.p1, fieldId: ids.link, linkedRowIds: [ids.t1] }]);
  assert.equal(again.rows, after.rows, "nothing new to link, so no record is touched");
});

test("two people adding links to the same cell at once both keep theirs", () => {
  const { s, ids } = setup();
  const p1 = s.rows[ids.p1];
  // Both start from the same screen; each picks a different task.
  const fromAna = cellActions(s, ids.p1, s.fields[ids.link], [...(p1.cells[ids.link] as string[]), ids.t3]);
  const fromBo = cellActions(s, ids.p1, s.fields[ids.link], [...(p1.cells[ids.link] as string[]), ids.t4]);
  assert.deepEqual(fromAna, [{ type: "link.add", rowId: ids.p1, fieldId: ids.link, linkedRowIds: [ids.t3] }]);
  // The server applies them one after the other.
  const server = run(run(s, fromAna), fromBo);
  assert.deepEqual(links(server, ids.p1, ids.link), [ids.t1, ids.t2, ids.t3, ids.t4]);
  assert.deepEqual(links(server, ids.t3, ids.inverse), [ids.p1]);
  assert.deepEqual(links(server, ids.t4, ids.inverse), [ids.p1]);
});

test("unlinking removes only those records, even while someone else adds one", () => {
  const { s, ids } = setup();
  const unlink = cellActions(s, ids.p1, s.fields[ids.link], [ids.t2]);
  assert.deepEqual(unlink, [{ type: "link.remove", rowId: ids.p1, fieldId: ids.link, linkedRowIds: [ids.t1] }]);
  const server = run(s, [{ type: "link.add", rowId: ids.p1, fieldId: ids.link, linkedRowIds: [ids.t3] }, ...unlink]);
  assert.deepEqual(links(server, ids.p1, ids.link), [ids.t2, ids.t3]);
  assert.equal(server.rows[ids.t1].cells[ids.inverse], undefined, "the other side is cleared too");
  // Removing everything leaves the cell empty, not an empty list.
  const cleared = run(server, cellActions(server, ids.p1, server.fields[ids.link], null));
  assert.equal(cleared.rows[ids.p1].cells[ids.link], undefined);
});

test("replacing the whole list (paste) becomes add + remove, and no change sends nothing", () => {
  const { s, ids } = setup();
  const replace = cellActions(s, ids.p1, s.fields[ids.link], [ids.t2, ids.t4]);
  assert.deepEqual(replace.map((a) => a.type), ["link.add", "link.remove"]);
  assert.deepEqual(links(run(s, replace), ids.p1, ids.link), [ids.t2, ids.t4]);
  assert.deepEqual(cellActions(s, ids.p1, s.fields[ids.link], [ids.t2, ids.t1]), []);
});

test("bad link changes are rejected; records deleted meanwhile are skipped", () => {
  const { s, ids } = setup();
  const bad: [Action, RegExp][] = [
    [{ type: "link.add", rowId: ids.p1, fieldId: ids.notes, linkedRowIds: [ids.t1] }, /not a link field/],
    [{ type: "link.add", rowId: ids.t1, fieldId: ids.link, linkedRowIds: [ids.p1] }, /not in this table/],
    [{ type: "link.add", rowId: ids.p1, fieldId: ids.link, linkedRowIds: [ids.p2] }, /different table/],
    [{ type: "link.add", rowId: ids.p1, fieldId: ids.link, linkedRowIds: [] }, /No records/],
    [{ type: "link.remove", rowId: newId("rec"), fieldId: ids.link, linkedRowIds: [ids.t1] }, /Row not found/],
    [{ type: "link.add", rowId: ids.p1, fieldId: ids.link, linkedRowIds: "x" as unknown as string[] }, /No records/],
  ];
  for (const [a, msg] of bad) assert.throws(() => applyAction(s, a, AT), msg);
  const gone = run(s, [{ type: "row.delete", rowIds: [ids.t3] }]);
  const after = run(gone, [{ type: "link.add", rowId: ids.p1, fieldId: ids.link, linkedRowIds: [ids.t3, ids.t4] }]);
  assert.deepEqual(links(after, ids.p1, ids.link), [ids.t1, ids.t2, ids.t4]);
});

test("undo and redo of link changes are exact", () => {
  const { s, ids } = setup();
  for (const a of [
    { type: "link.add", rowId: ids.p2, fieldId: ids.link, linkedRowIds: [ids.t1, ids.t3] },
    { type: "link.remove", rowId: ids.p1, fieldId: ids.link, linkedRowIds: [ids.t1, ids.t2] },
  ] as Action[]) {
    const after = run(s, [a]);
    const undone = undo(after, s, after);
    assert.deepEqual(plain(undone.rows), plain(s.rows), `undo ${a.type}`);
    const redone = undo(undone, after, undone);
    assert.deepEqual(plain(redone.rows), plain(after.rows), `redo ${a.type}`);
  }
});

test("undoing your link leaves links other people made since", () => {
  const { s, ids } = setup();
  const mine = run(s, [{ type: "link.add", rowId: ids.p1, fieldId: ids.link, linkedRowIds: [ids.t3] }]);
  const theirs = run(mine, [{ type: "link.add", rowId: ids.p1, fieldId: ids.link, linkedRowIds: [ids.t4] }]);
  const undone = undo(theirs, s, mine);
  assert.deepEqual(links(undone, ids.p1, ids.link), [ids.t1, ids.t2, ids.t4]);
  assert.equal(undone.rows[ids.t3].cells[ids.inverse], undefined);
  assert.deepEqual(links(undone, ids.t4, ids.inverse), [ids.p1]);

  // Same for undoing an unlink: it comes back without dropping their new link.
  const removed = run(s, [{ type: "link.remove", rowId: ids.p1, fieldId: ids.link, linkedRowIds: [ids.t1] }]);
  const added = run(removed, [{ type: "link.add", rowId: ids.p1, fieldId: ids.link, linkedRowIds: [ids.t4] }]);
  const back = undo(added, s, removed);
  assert.deepEqual(links(back, ids.p1, ids.link), [ids.t1, ids.t2, ids.t4]);
  assert.deepEqual(links(back, ids.t1, ids.inverse), [ids.p1]);
});

test("undoing a record delete links it back on both sides", () => {
  const { s, ids } = setup();
  const deleted = run(s, [{ type: "row.delete", rowIds: [ids.t1] }]);
  assert.deepEqual(links(deleted, ids.p1, ids.link), [ids.t2]);
  const undone = undo(deleted, s, deleted);
  assert.deepEqual(links(undone, ids.p1, ids.link), [ids.t1, ids.t2]);
  assert.deepEqual(links(undone, ids.t1, ids.inverse), [ids.p1]);
});

test("undo steps saved before this change (whole link lists) still work", () => {
  const { s, ids } = setup();
  const after = run(s, [{ type: "link.add", rowId: ids.p1, fieldId: ids.link, linkedRowIds: [ids.t3] }]);
  const oldStyle: Action = {
    type: "restore",
    patch: { rows: { [ids.p1]: { kind: "cells", cells: { [ids.link]: [ids.t1, ids.t2] } }, [ids.t3]: { kind: "cells", cells: { [ids.inverse]: null } } } },
  };
  const undone = run(after, [oldStyle]);
  assert.deepEqual(plain(undone.rows), plain(s.rows));
});
