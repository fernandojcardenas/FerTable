import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAction, applyActions, emptyBase } from "../src/shared/reducer";
import { buildSync } from "../src/shared/sync";
import { newId } from "../src/shared/ids";
import type { Action, BaseState } from "../src/shared/types";

const AT = "2026-11-10T12:00:00.000Z";

function setup() {
  const ids = {
    t: newId("tbl"), name: newId("fld"), status: newId("fld"), hours: newId("fld"), secret: newId("fld"), count: newId("fld"),
    other: newId("tbl"), oName: newId("fld"), link: newId("fld"), inv: newId("fld"), oView: newId("viw"),
    v: newId("viw"), team: newId("viw"), r1: newId("rec"), r2: newId("rec"), r3: newId("rec"), o1: newId("rec"), opt: newId("opt"),
    target: newId("tbl"), tPrimary: newId("fld"), tView: newId("viw"), note: newId("fld"),
  };
  const source = applyActions(emptyBase(newId("bas"), "Ops"), [
    { type: "table.create", tableId: ids.t, name: "Tasks", primaryFieldId: ids.name, viewId: ids.v },
    { type: "table.create", tableId: ids.other, name: "People", primaryFieldId: ids.oName, viewId: ids.oView },
    { type: "field.create", fieldId: ids.status, tableId: ids.t, name: "Status", fieldType: "singleSelect", options: { choices: [{ id: ids.opt, name: "Open", color: "blue" }] } },
    { type: "field.create", fieldId: ids.hours, tableId: ids.t, name: "Hours", fieldType: "number", options: { precision: 1 } },
    { type: "field.create", fieldId: ids.secret, tableId: ids.t, name: "Secret", fieldType: "text" },
    { type: "field.create", fieldId: ids.link, tableId: ids.t, name: "Owner", fieldType: "link", options: { linkedTableId: ids.other }, inverseFieldId: ids.inv },
    { type: "field.create", fieldId: ids.count, tableId: ids.t, name: "Owners", fieldType: "count", options: { linkFieldId: ids.link } },
    { type: "view.create", viewId: ids.team, tableId: ids.t, name: "Team view", viewType: "grid" },
    { type: "view.update", viewId: ids.team, config: { hiddenFieldIds: [ids.secret], filters: { conjunction: "and", conditions: [{ id: "c", fieldId: ids.status, operator: "is", value: ids.opt }] } } },
    { type: "row.create", rowId: ids.o1, tableId: ids.other, cells: { [ids.oName]: "Ana" } },
    { type: "row.create", rowId: ids.r1, tableId: ids.t, cells: { [ids.name]: "Fix bug", [ids.status]: ids.opt, [ids.hours]: 2.5, [ids.secret]: "s3", [ids.link]: [ids.o1] } },
    { type: "row.create", rowId: ids.r2, tableId: ids.t, cells: { [ids.name]: "Write docs", [ids.status]: ids.opt } },
    { type: "row.create", rowId: ids.r3, tableId: ids.t, cells: { [ids.name]: "Closed one" } },
  ], AT);
  const target = applyActions(emptyBase(newId("bas"), "Exec"), [
    { type: "table.create", tableId: ids.target, name: "Team tasks", primaryFieldId: ids.tPrimary, viewId: ids.tView,
      sync: { sourceBaseId: source.base.id, sourceTableId: ids.t, sourceViewId: ids.team, sourceLabel: "", createdBy: "usrAAAAAAAAAAAAAA", lastSyncAt: null, error: null } },
  ], AT);
  return { source, target, ids };
}

const sync = (source: BaseState, target: BaseState, ids: ReturnType<typeof setup>["ids"]) => {
  const a = buildSync(source, source.views[ids.team], target, target.tables[ids.target], new Date(AT));
  return { action: a, after: a ? applyAction(target, a, AT) : target };
};

test("a synced table copies the view's visible fields and matching records", () => {
  const { source, target, ids } = setup();
  const { after } = sync(source, target, ids);
  const t = after.tables[ids.target];
  const fields = t.fieldOrder.map((id) => after.fields[id]);
  assert.deepEqual(fields.map((f) => [f.name, f.type]), [["Name", "text"], ["Status", "singleSelect"], ["Hours", "number"], ["Owner", "text"], ["Owners", "number"]]);
  assert.ok(!fields.some((f) => f.name === "Secret"), "hidden fields aren't copied");
  const rows = t.rowOrder.map((id) => after.rows[id]);
  assert.deepEqual(rows.map((r) => r.sourceRowId), [ids.r1, ids.r2], "only records the view shows");
  const byName = (n: string) => fields.find((f) => f.name === n)!.id;
  assert.equal(rows[0].cells[byName("Status")], ids.opt);
  assert.equal(rows[0].cells[byName("Hours")], 2.5);
  assert.equal(rows[0].cells[byName("Owner")], "Ana");
  assert.equal(rows[0].cells[byName("Owners")], 1);
  assert.equal(t.sync?.sourceLabel, "Ops › Tasks › Team view");
  assert.ok(t.sync?.lastSyncAt);
  // Nothing changed: no new transaction.
  assert.equal(sync(source, after, ids).action, null);
});

test("changes in the source flow through, and synced data is read-only", () => {
  const { source, target, ids } = setup();
  const first = sync(source, target, ids).after;
  const t = first.tables[ids.target];
  const status = t.fieldOrder.find((id) => first.fields[id].name === "Status")!;
  const keepId = t.rowOrder[0];
  // People can add their own fields and fill them in.
  const note = newId("fld");
  let mine = applyActions(first, [
    { type: "field.create", fieldId: note, tableId: ids.target, name: "My note", fieldType: "text" },
    { type: "row.update", rowId: keepId, cells: { [note]: "follow up" } },
  ], AT);
  const blocked: Action[] = [
    { type: "row.update", rowId: keepId, cells: { [status]: null } },
    { type: "row.create", rowId: newId("rec"), tableId: ids.target },
    { type: "row.delete", rowIds: [keepId] },
    { type: "field.delete", fieldId: status },
    { type: "field.update", fieldId: status, fieldType: "text" },
  ];
  for (const a of blocked) assert.throws(() => applyAction(mine, a, AT), /synced|source base|source view/, a.type);
  mine = applyAction(mine, { type: "field.update", fieldId: status, name: "State" }, AT); // renaming is fine

  // Source: r2 closes (leaves the view), r1 renamed, Hours hidden.
  const changed = applyActions(source, [
    { type: "row.update", rowId: ids.r2, cells: { [ids.status]: null } },
    { type: "row.update", rowId: ids.r1, cells: { [ids.name]: "Fix login bug" } },
    { type: "view.update", viewId: ids.team, config: { hiddenFieldIds: [ids.secret, ids.hours] } },
  ], AT);
  const after = sync(changed, mine, ids).after;
  const t2 = after.tables[ids.target];
  assert.deepEqual(t2.rowOrder, [keepId], "r2 left the view");
  assert.equal(after.rows[keepId].cells[ids.tPrimary], "Fix login bug");
  assert.equal(after.rows[keepId].cells[note], "follow up", "your own fields are kept");
  assert.ok(!t2.fieldOrder.some((id) => after.fields[id].name === "Hours"), "fields hidden in the source view go away");

  // If the source can't be read, the last copy stays.
  const failed = applyAction(after, { type: "sync.apply", tableId: ids.target, fields: [], removeFieldIds: [], upserts: [], deleteRowIds: [], sourceLabel: "", error: "You no longer have access" }, AT);
  assert.deepEqual(failed.tables[ids.target].rowOrder, [keepId]);
  assert.equal(failed.tables[ids.target].sync?.error, "You no longer have access");
});
