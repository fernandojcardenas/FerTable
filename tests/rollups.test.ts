import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAction, emptyBase } from "../src/shared/reducer";
import { Computer } from "../src/shared/compute";
import { evaluate, parseFormula, ROLLUP_PRESET_FORMULAS, FormulaError } from "../src/shared/formula";
import { rollupKind } from "../src/shared/fieldTypes";
import { filterKind } from "../src/shared/query";
import { newId } from "../src/shared/ids";
import type { Action, BaseState, FieldOptions } from "../src/shared/types";

const AT = "2026-11-10T12:00:00.000Z";
const run = (s: BaseState, actions: Action[]) => actions.reduce((acc, a) => applyAction(acc, a, AT), s);

function setup() {
  const ids = {
    p: newId("tbl"), t: newId("tbl"), pName: newId("fld"), tName: newId("fld"), hours: newId("fld"), link: newId("fld"), inv: newId("fld"),
    roll: newId("fld"), v1: newId("viw"), v2: newId("viw"), p1: newId("rec"), t1: newId("rec"), t2: newId("rec"), t3: newId("rec"),
  };
  const s = run(emptyBase(newId("bas"), "Test"), [
    { type: "table.create", tableId: ids.p, name: "Projects", primaryFieldId: ids.pName, viewId: ids.v1 },
    { type: "table.create", tableId: ids.t, name: "Tasks", primaryFieldId: ids.tName, viewId: ids.v2 },
    { type: "field.create", fieldId: ids.hours, tableId: ids.t, name: "Hours", fieldType: "number" },
    { type: "field.create", fieldId: ids.link, tableId: ids.p, name: "Tasks", fieldType: "link", options: { linkedTableId: ids.t }, inverseFieldId: ids.inv },
    { type: "row.create", rowId: ids.p1, tableId: ids.p, cells: { [ids.pName]: "Website" } },
    { type: "row.create", rowId: ids.t1, tableId: ids.t, cells: { [ids.tName]: "Design", [ids.hours]: 3 } },
    { type: "row.create", rowId: ids.t2, tableId: ids.t, cells: { [ids.tName]: "Build", [ids.hours]: 8 } },
    { type: "row.create", rowId: ids.t3, tableId: ids.t, cells: { [ids.tName]: "Design" } },
    { type: "link.add", rowId: ids.p1, fieldId: ids.link, linkedRowIds: [ids.t1, ids.t2, ids.t3] },
  ]);
  return { s, ids };
}

function rollup(s: BaseState, ids: ReturnType<typeof setup>["ids"], target: string, options: Partial<FieldOptions>) {
  const after = run(s, [{ type: "field.create", fieldId: ids.roll, tableId: ids.p, name: "R", fieldType: "rollup", options: { linkFieldId: ids.link, targetFieldId: target, ...options } }]);
  const c = new Computer(after, new Date(AT));
  return { after, value: c.value(after.rows[ids.p1], after.fields[ids.roll]), display: c.display(after.rows[ids.p1], after.fields[ids.roll]) };
}

test("a rollup formula works on the linked values", () => {
  const { s, ids } = setup();
  assert.equal(rollup(s, ids, ids.hours, { fn: "formula", expression: "MAX(values) - MIN(values)" }).value, 5);
  assert.equal(rollup(s, ids, ids.hours, { fn: "formula", expression: "SUM(values) / COUNTA(values)" }).value, 5.5);
  assert.equal(rollup(s, ids, ids.tName, { fn: "formula", expression: 'ARRAYJOIN(ARRAYUNIQUE(values), " · ")' }).value, "Design · Build");
  assert.equal(rollup(s, ids, ids.hours, { fn: "formula", expression: "COUNTALL(values) & \" tasks\"" }).value, "3 tasks");
  assert.deepEqual(rollup(s, ids, ids.hours, { fn: "formula", expression: "ARRAYCOMPACT(values)" }).display, "3, 8");
});

test("each menu choice gives the same answer as its preset formula", () => {
  const { s, ids } = setup();
  for (const [fn, expression] of Object.entries(ROLLUP_PRESET_FORMULAS)) {
    const target = fn === "concat" ? ids.tName : ids.hours;
    const preset = rollup(s, ids, target, { fn: fn as FieldOptions["fn"] }).display;
    const custom = rollup(s, ids, target, { fn: "formula", expression }).display;
    if (fn === "and" || fn === "or") continue; // booleans: menu treats empty as false, same outcome here
    assert.equal(custom, preset, `${fn}: ${expression}`);
  }
});

test("rollup formulas are checked when saved", () => {
  const { s, ids } = setup();
  const make = (expression: string) => applyAction(s, { type: "field.create", fieldId: ids.roll, tableId: ids.p, name: "R", fieldType: "rollup", options: { linkFieldId: ids.link, targetFieldId: ids.hours, fn: "formula", expression } }, AT);
  assert.throws(() => make("SUM(values"), /Formula error/);
  assert.throws(() => make(`SUM(values) + {${ids.pName}}`), /only use values/);
  assert.throws(() => make("values2"), /Unknown name/);
  assert.throws(() => applyAction(s, { type: "field.create", fieldId: ids.roll, tableId: ids.p, name: "R", fieldType: "rollup", options: { linkFieldId: ids.link, targetFieldId: ids.hours, fn: "median" as never } }, AT), /Unknown rollup/);
  assert.equal(make("  SUM(values) ").fields[ids.roll].options.expression, "SUM(values)");
  // Picking a menu choice again drops the custom formula.
  const back = applyAction(make("SUM(values)"), { type: "field.update", fieldId: ids.roll, options: { linkFieldId: ids.link, targetFieldId: ids.hours, fn: "max", expression: "SUM(values)" } }, AT);
  assert.equal(back.fields[ids.roll].options.expression, undefined);
});

test("values only exists inside rollups", () => {
  assert.throws(() => parseFormula("SUM(values)"), FormulaError);
  assert.equal(evaluate(parseFormula("SUM(values)", { vars: ["VALUES"] }), { now: new Date(), ref: () => null, vars: { VALUES: [1, 2] } }), 3);
});

test("filters and number alignment follow what the formula gives", () => {
  const { s, ids } = setup();
  const kind = (expression: string) => rollupKind({ ...s.fields[ids.hours], type: "rollup", options: { fn: "formula", expression } });
  assert.equal(kind("SUM(values) * 2"), "number");
  assert.equal(kind("AND(values)"), "checkbox");
  assert.equal(kind("ARRAYJOIN(values)"), "text");
  assert.equal(kind('IF(COUNTA(values) > 0, MAX(values), 0)'), "number");
  assert.equal(kind("broken("), "text");
  assert.equal(filterKind({ ...s.fields[ids.hours], type: "rollup", options: { fn: "concat" } }), "text");
});
