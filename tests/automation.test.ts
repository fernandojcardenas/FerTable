import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAction, emptyBase } from "../src/shared/reducer";
import { parseRecipients, planSteps, triggerMatches } from "../src/shared/automation";
import { newId } from "../src/shared/ids";
import type { Action, Automation, BaseState } from "../src/shared/types";

const AT = "2026-11-10T12:00:00.000Z";
const run = (s: BaseState, actions: Action[]) => actions.reduce((acc, a) => applyAction(acc, a, AT), s);

function setup() {
  const ids = {
    t: newId("tbl"), log: newId("tbl"), name: newId("fld"), email: newId("fld"), status: newId("fld"), logName: newId("fld"),
    v1: newId("viw"), v2: newId("viw"), r: newId("rec"), todo: newId("opt"),
  };
  const s = run(emptyBase(newId("bas"), "Test"), [
    { type: "table.create", tableId: ids.t, name: "Requests", primaryFieldId: ids.name, viewId: ids.v1 },
    { type: "table.create", tableId: ids.log, name: "Log", primaryFieldId: ids.logName, viewId: ids.v2 },
    { type: "field.create", fieldId: ids.email, tableId: ids.t, name: "Email", fieldType: "email" },
    { type: "field.create", fieldId: ids.status, tableId: ids.t, name: "Status", fieldType: "singleSelect", options: { choices: [{ id: ids.todo, name: "Todo", color: "red" }] } },
    { type: "row.create", rowId: ids.r, tableId: ids.t, cells: { [ids.name]: "Ana", [ids.email]: "ana@example.com" } },
  ]);
  return { s, ids };
}

const auto = (steps: Automation["steps"], tableId: string, extra: Partial<Automation> = {}): Automation =>
  ({ id: newId("aut"), name: "Notify", enabled: true, trigger: { type: "recordCreated", tableId }, steps, ...extra });

test("record steps preview in plain words, including new select options", () => {
  const { s, ids } = setup();
  const a = auto([
    { type: "updateRecord", values: { [ids.status]: "Done" } },
    { type: "createRecord", tableId: ids.log, values: { [ids.logName]: `Request from {${ids.name}}` } },
  ], ids.t);
  const plan = planSteps(s, a, s.rows[ids.r]);
  assert.deepEqual(plan.preview, [
    { kind: "update", tableName: "Requests", cells: [{ field: "Status", value: "Done" }] },
    { kind: "create", tableName: "Log", cells: [{ field: "Name", value: "Request from Ana" }] },
  ]);
  assert.equal(plan.actions.length, 2);
  assert.equal(plan.fieldUpdates.length, 1, "the new option Done is created first");
  // Planning changes nothing.
  assert.equal(s.rows[ids.r].cells[ids.status], undefined);
});

test("email steps fill in placeholders and check addresses", () => {
  const { s, ids } = setup();
  const a = auto([{ type: "sendEmail", to: `{${ids.email}}, Boss@Example.com; not-an-address`, subject: `New request from {${ids.name}}\nBcc: x@evil.test`, body: `Hi,\n{${ids.name}} wrote in.` }], ids.t);
  const plan = planSteps(s, a, s.rows[ids.r]);
  assert.deepEqual(plan.emails, [{ to: ["ana@example.com", "boss@example.com"], subject: "New request from Ana Bcc: x@evil.test", text: "Hi,\nAna wrote in." }]);
  assert.deepEqual(plan.preview[0], { kind: "email", to: ["ana@example.com", "boss@example.com"], invalid: ["not-an-address"], subject: "New request from Ana Bcc: x@evil.test", text: "Hi,\nAna wrote in." });
  assert.deepEqual(plan.problems, []);
});

test("an email with nobody to send to, or too many people, stops the run", () => {
  const { s, ids } = setup();
  const empty = run(s, [{ type: "row.update", rowId: ids.r, cells: { [ids.email]: null } }]);
  const p1 = planSteps(empty, auto([{ type: "sendEmail", to: `{${ids.email}}`, subject: "Hi", body: "" }], ids.t), empty.rows[ids.r]);
  assert.match(p1.problems[0], /no valid email address/);
  assert.equal(p1.emails.length, 0);
  const many = Array.from({ length: 11 }, (_, i) => `p${i}@example.com`).join(",");
  assert.match(planSteps(s, auto([{ type: "sendEmail", to: many, subject: "Hi", body: "" }], ids.t), s.rows[ids.r]).problems[0], /more than 10/);
  assert.deepEqual(parseRecipients("a@b.co, A@B.co, x"), { valid: ["a@b.co"], invalid: ["x"] });
});

test("email steps are validated when saved", () => {
  const { s, ids } = setup();
  const save = (steps: unknown) => applyAction(s, { type: "automation.upsert", automation: auto(steps as Automation["steps"], ids.t) }, AT);
  assert.throws(() => save([{ type: "sendEmail", to: " ", subject: "", body: "" }]), /someone to send to/);
  assert.throws(() => save([{ type: "sendEmail", to: "a@b.co", subject: "x".repeat(301), body: "" }]), /too long/);
  assert.throws(() => save([{ type: "sendEmail", to: "a@b.co", subject: 3, body: "" }]), /recipient, subject and message/);
  assert.throws(() => save([{ type: "deleteEverything" }]), /Unknown automation step/);
  assert.doesNotThrow(() => save([{ type: "sendEmail", to: "a@b.co", subject: "Hi", body: "Body" }]));
});

test("the test panel can tell whether a record matches the trigger's conditions", () => {
  const { s, ids } = setup();
  const a = auto([], ids.t, { trigger: { type: "recordMatches", tableId: ids.t, filters: { conjunction: "and", conditions: [{ id: "c1", fieldId: ids.status, operator: "is", value: ids.todo }] } } } as Partial<Automation>);
  assert.equal(triggerMatches(s, a, s.rows[ids.r]), false);
  const todo = run(s, [{ type: "row.update", rowId: ids.r, cells: { [ids.status]: ids.todo } }]);
  assert.equal(triggerMatches(todo, a, todo.rows[ids.r]), true);
});
