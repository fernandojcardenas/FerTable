import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAction, emptyBase, ValidationError } from "../src/shared/reducer";
import { Computer } from "../src/shared/compute";
import { evaluate, parseFormula, namesToIds } from "../src/shared/formula";
import { viewRows, groupRows } from "../src/shared/query";
import { newId } from "../src/shared/ids";
import type { Action, BaseState } from "../src/shared/types";

const run = (s: BaseState, actions: Action[]) => actions.reduce((acc, a) => applyAction(acc, a, "2026-11-09T12:00:00.000Z"), s);

function setup() {
  const ids = {
    projects: newId("tbl"), tasks: newId("tbl"),
    pName: newId("fld"), tName: newId("fld"), hours: newId("fld"), done: newId("fld"), status: newId("fld"),
    link: newId("fld"), inverse: newId("fld"), lookup: newId("fld"), rollup: newId("fld"), count: newId("fld"), formula: newId("fld"),
    pView: newId("viw"), tView: newId("viw"),
    p1: newId("rec"), p2: newId("rec"), t1: newId("rec"), t2: newId("rec"), t3: newId("rec"),
    todo: newId("opt"), doing: newId("opt"),
  };
  let s = emptyBase(newId("bas"), "Test");
  s = run(s, [
    { type: "table.create", tableId: ids.projects, name: "Projects", primaryFieldId: ids.pName, viewId: ids.pView },
    { type: "table.create", tableId: ids.tasks, name: "Tasks", primaryFieldId: ids.tName, viewId: ids.tView },
    { type: "field.create", fieldId: ids.hours, tableId: ids.tasks, name: "Hours", fieldType: "number", options: { precision: 1 } },
    { type: "field.create", fieldId: ids.done, tableId: ids.tasks, name: "Done", fieldType: "checkbox" },
    { type: "field.create", fieldId: ids.status, tableId: ids.projects, name: "Status", fieldType: "singleSelect",
      options: { choices: [{ id: ids.todo, name: "Todo", color: "red" }, { id: ids.doing, name: "Doing", color: "yellow" }] } },
    { type: "field.create", fieldId: ids.link, tableId: ids.projects, name: "Tasks", fieldType: "link", options: { linkedTableId: ids.tasks }, inverseFieldId: ids.inverse },
    { type: "row.create", rowId: ids.p1, tableId: ids.projects, cells: { [ids.pName]: "Website", [ids.status]: ids.doing } },
    { type: "row.create", rowId: ids.p2, tableId: ids.projects, cells: { [ids.pName]: "App", [ids.status]: ids.todo } },
    { type: "row.create", rowId: ids.t1, tableId: ids.tasks, cells: { [ids.tName]: "Design", [ids.hours]: 3 } },
    { type: "row.create", rowId: ids.t2, tableId: ids.tasks, cells: { [ids.tName]: "Build", [ids.hours]: "5.25", [ids.done]: true } },
    { type: "row.create", rowId: ids.t3, tableId: ids.tasks, cells: { [ids.tName]: "Ship", [ids.hours]: 1 } },
    { type: "row.update", rowId: ids.p1, cells: { [ids.link]: [ids.t1, ids.t2] } },
    { type: "field.create", fieldId: ids.lookup, tableId: ids.projects, name: "Task names", fieldType: "lookup", options: { linkFieldId: ids.link, targetFieldId: ids.tName } },
    { type: "field.create", fieldId: ids.rollup, tableId: ids.projects, name: "Total hours", fieldType: "rollup", options: { linkFieldId: ids.link, targetFieldId: ids.hours, fn: "sum" } },
    { type: "field.create", fieldId: ids.count, tableId: ids.projects, name: "Task count", fieldType: "count", options: { linkFieldId: ids.link } },
  ]);
  return { s, ids };
}

test("formula parser and evaluator", () => {
  const ev = (src: string) => evaluate(parseFormula(src), { ref: () => null, now: new Date("2026-11-09T00:00:00Z") });
  assert.equal(ev("1 + 2 * 3"), 7);
  assert.equal(ev("(1 + 2) * 3"), 9);
  assert.equal(ev('"a" & "b" & 3'), "ab3");
  assert.equal(ev("IF(2 > 1, \"yes\", \"no\")"), "yes");
  assert.equal(ev("ROUND(2.345, 2)"), 2.35);
  assert.equal(ev("-2 * 3"), -6);
  assert.equal(ev("1 = 1"), true);
  assert.equal(ev("SWITCH(\"b\", \"a\", 1, \"b\", 2, 0)"), 2);
  assert.equal(ev("DATETIME_DIFF(\"2026-11-10\", \"2026-11-01\", \"days\")"), 9);
  assert.equal(ev("UPPER(LEFT(\"hello\", 2))"), "HE");
  assert.throws(() => parseFormula("1 +"));
  assert.throws(() => parseFormula("NOPE(1)"));
});

test("links stay two-way and computed fields follow", () => {
  const { s, ids } = setup();
  assert.deepEqual(s.rows[ids.t1].cells[ids.inverse], [ids.p1]);
  assert.deepEqual(s.rows[ids.t2].cells[ids.inverse], [ids.p1]);
  const c = new Computer(s);
  assert.deepEqual(c.value(s.rows[ids.p1], s.fields[ids.lookup]), ["Design", "Build"]);
  assert.equal(c.value(s.rows[ids.p1], s.fields[ids.rollup]), 8.3); // 3 + 5.3 (number rounded to 1 decimal)
  assert.equal(c.value(s.rows[ids.p1], s.fields[ids.count]), 2);
  assert.equal(c.display(s.rows[ids.p1], s.fields[ids.link]), "Design, Build");

  // Unlink from the other side.
  const s2 = run(s, [{ type: "row.update", rowId: ids.t2, cells: { [ids.inverse]: null } }]);
  assert.deepEqual(s2.rows[ids.p1].cells[ids.link], [ids.t1]);
  assert.equal(new Computer(s2).value(s2.rows[ids.p1], s2.fields[ids.count]), 1);

  // Deleting a task removes it from the project.
  const s3 = run(s, [{ type: "row.delete", rowIds: [ids.t1] }]);
  assert.deepEqual(s3.rows[ids.p1].cells[ids.link], [ids.t2]);
});

test("formula fields use names in the editor and ids in storage", () => {
  const { s, ids } = setup();
  const fields = Object.values(s.fields).filter((f) => f.tableId === ids.projects);
  const expr = namesToIds('{Name} & " (" & {Total hours} & "h)"', fields);
  const s2 = run(s, [{ type: "field.create", fieldId: ids.formula, tableId: ids.projects, name: "Label", fieldType: "formula", options: { expression: expr } }]);
  const c = new Computer(s2);
  assert.equal(c.value(s2.rows[ids.p1], s2.fields[ids.formula]), "Website (8.3h)");
  // A formula can't point at itself.
  assert.throws(
    () => run(s2, [{ type: "field.update", fieldId: ids.formula, options: { expression: `{${ids.formula}}` } }]),
    ValidationError,
  );
});

test("changing a field type converts values", () => {
  const { s, ids } = setup();
  const s2 = run(s, [{ type: "field.update", fieldId: ids.status, fieldType: "text" }]);
  assert.equal(s2.rows[ids.p1].cells[ids.status], "Doing");
  const s3 = run(s2, [{ type: "field.update", fieldId: ids.status, fieldType: "singleSelect" }]);
  const choices = s3.fields[ids.status].options.choices!;
  assert.deepEqual(choices.map((c) => c.name).sort(), ["Doing", "Todo"]);
  assert.equal(new Computer(s3).value(s3.rows[ids.p2], s3.fields[ids.status]), "Todo");
});

test("deleting a link field removes its inverse and cleans views", () => {
  const { s, ids } = setup();
  const s2 = run(s, [
    { type: "view.update", viewId: ids.pView, config: { sorts: [{ fieldId: ids.link, direction: "asc" }] } },
    { type: "field.delete", fieldId: ids.link },
  ]);
  assert.equal(s2.fields[ids.inverse], undefined);
  assert.equal(s2.rows[ids.t1].cells[ids.inverse], undefined);
  assert.deepEqual(s2.views[ids.pView].config.sorts, []);
  assert.equal(new Computer(s2).display(s2.rows[ids.p1], s2.fields[ids.rollup]), "#ERROR");
});

test("filters, sorts and groups", () => {
  const { s, ids } = setup();
  const s2 = run(s, [{
    type: "view.update", viewId: ids.tView, config: {
      filters: { conjunction: "and", conditions: [{ id: newId("flt"), fieldId: ids.hours, operator: "gte", value: 2 }] },
      sorts: [{ fieldId: ids.hours, direction: "desc" }],
    },
  }]);
  const c = new Computer(s2);
  assert.deepEqual(viewRows(c, s2, s2.views[ids.tView]).map((r) => r.id), [ids.t2, ids.t1]);
  const groups = groupRows(c, viewRows(c, s2, s2.views[ids.pView]), [{ fieldId: ids.status, direction: "asc" }]);
  assert.deepEqual(groups?.map((g) => g.label), ["Todo", "Doing"]);
});

test("validation rejects bad actions without changing state", () => {
  const { s, ids } = setup();
  assert.throws(() => run(s, [{ type: "field.delete", fieldId: ids.pName }]), /primary field/);
  assert.throws(() => run(s, [{ type: "row.update", rowId: ids.p1, cells: { [ids.rollup]: 5 } }]), /computed/);
  assert.throws(() => run(s, [{ type: "field.create", fieldId: newId("fld"), tableId: ids.projects, name: "status", fieldType: "text" }]), /already exists/);
  assert.throws(() => run(s, [{ type: "field.create", fieldId: newId("fld"), tableId: ids.projects, name: "L", fieldType: "lookup", options: {} }]), /link field/);
});

test("unknown action types are rejected, not ignored", () => {
  const s = emptyBase(newId("bas"), "Test");
  assert.throws(() => applyAction(s, { type: "nope" } as unknown as Action), /Unknown action type/);
});

test("attachment cells only accept files stored by this server", () => {
  const s0 = emptyBase(newId("bas"), "Test");
  const t = newId("tbl"), files = newId("fld"), r = newId("rec");
  const s = run(s0, [
    { type: "table.create", tableId: t, name: "T", primaryFieldId: newId("fld"), viewId: newId("viw") },
    { type: "field.create", fieldId: files, tableId: t, name: "Files", fieldType: "attachment" },
    { type: "row.create", rowId: r, tableId: t },
  ]);
  const good = { id: newId("att"), name: "a.png", size: 10, type: "image/png", url: "" };
  good.url = `/api/files/${good.id}/a.png`;
  const evil = { id: newId("att"), name: "x", size: 1, type: "text/html", url: "https://evil.example/x" };
  const s2 = run(s, [{ type: "row.update", rowId: r, cells: { [files]: [good, evil, good] as never } }]);
  assert.deepEqual(s2.rows[r].cells[files], [good]);
  assert.deepEqual(new Computer(s2).value(s2.rows[r], s2.fields[files]), ["a.png"]);
});
