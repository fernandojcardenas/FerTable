import { test } from "node:test";
import assert from "node:assert/strict";
import { applyActions, emptyBase } from "../src/shared/reducer";
import { newId } from "../src/shared/ids";
import { baseOutline, mobileRecord, mobileViewRecords } from "../src/shared/mobile";

const AT = "2026-11-11T12:00:00.000Z";
const ME = newId("usr");

function setup() {
  const ids = { t: newId("tbl"), name: newId("fld"), qty: newId("fld"), dbl: newId("fld"), stage: newId("fld"), v: newId("viw"), mine: newId("viw"), a: newId("opt"), b: newId("opt") };
  const rows = [newId("rec"), newId("rec")];
  const s = applyActions(emptyBase(newId("bas"), "Shop"), [
    { type: "table.create", tableId: ids.t, name: "Items", primaryFieldId: ids.name, viewId: ids.v },
    { type: "field.create", fieldId: ids.qty, tableId: ids.t, name: "Qty", fieldType: "number" },
    { type: "field.create", fieldId: ids.dbl, tableId: ids.t, name: "Double", fieldType: "formula", options: { expression: `{${ids.qty}} * 2` } },
    { type: "field.create", fieldId: ids.stage, tableId: ids.t, name: "Stage", fieldType: "singleSelect", options: { choices: [{ id: ids.a, name: "New", color: "blue" }, { id: ids.b, name: "Done", color: "green" }] } },
    { type: "row.create", rowId: rows[0], tableId: ids.t, cells: { [ids.name]: "Bolt", [ids.qty]: 3, [ids.stage]: ids.a } },
    { type: "row.create", rowId: rows[1], tableId: ids.t, cells: { [ids.name]: "Nut", [ids.qty]: 5, [ids.stage]: ids.b } },
    { type: "view.update", viewId: ids.v, config: { sorts: [{ fieldId: ids.qty, direction: "desc" }], colors: { mode: "select", fieldId: ids.stage } } },
    { type: "view.create", viewId: ids.mine, tableId: ids.t, name: "Mine", viewType: "grid", personal: true },
  ], AT, ME);
  return { s, ids, rows };
}

test("the app's outline lists tables and views, hiding others' personal views", () => {
  const { s, ids } = setup();
  const mine = baseOutline(s, ME, "owner");
  assert.deepEqual(mine.tables[0].views.map((v) => v.name), ["Grid view", "Mine"]);
  assert.equal(mine.tables[0].canAddRecords, true);
  const other = baseOutline(s, newId("usr"), "viewer");
  assert.deepEqual(other.tables[0].views.map((v) => v.id), [ids.v]);
  assert.equal(other.tables[0].canAddRecords, false);
});

test("view records come sorted, with computed display text and colors", () => {
  const { s, ids } = setup();
  const data = mobileViewRecords(s, s.views[ids.v], ME, "editor");
  assert.deepEqual(data.rows.map((r) => r.display[ids.name]), ["Nut", "Bolt"], "the view's sort applies");
  assert.equal(data.rows[0].display[ids.dbl], "10", "formulas are worked out on the server");
  assert.equal(data.rows[0].display[ids.stage], "Done");
  assert.equal(data.rows[0].color, "green");
  assert.equal(data.fields.find((f) => f.id === ids.dbl)?.editable, false);
  assert.equal(data.fields.find((f) => f.id === ids.qty)?.editable, true);
  assert.equal(mobileViewRecords(s, s.views[ids.v], ME, "editor", "bol").rows.length, 1, "search narrows");
  assert.equal(mobileViewRecords(s, s.views[ids.v], ME, "viewer").fields.some((f) => f.editable), false, "viewers can't edit");
});

test("a record has every field and its stored values", () => {
  const { s, ids, rows } = setup();
  const rec = mobileRecord(s, rows[0], ME, "owner")!;
  assert.equal(rec.fields.length, 4);
  assert.equal(rec.row.cells[ids.stage], ids.a);
  assert.equal(rec.row.display[ids.dbl], "6");
  assert.equal(rec.table.canDelete, true);
  assert.equal(mobileRecord(s, newId("rec"), ME, "owner"), null);
});
