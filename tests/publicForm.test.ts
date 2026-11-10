import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAction, emptyBase } from "../src/shared/reducer";
import { checkSubmission, publicFormDefinition } from "../src/shared/publicForm";
import { newId } from "../src/shared/ids";
import type { Action, BaseState, FormConfig } from "../src/shared/types";

const AT = "2026-11-10T12:00:00.000Z";
const run = (s: BaseState, actions: Action[]) => actions.reduce((acc, a) => applyAction(acc, a, AT), s);
const TOKEN = "abcdefghijklmnopqrstuvwxyz012345";

function setup() {
  const ids = {
    t: newId("tbl"), other: newId("tbl"), name: newId("fld"), count: newId("fld"), topic: newId("fld"), tags: newId("fld"), agree: newId("fld"),
    files: newId("fld"), link: newId("fld"), inv: newId("fld"), oName: newId("fld"), grid: newId("viw"), og: newId("viw"), form: newId("viw"),
    a: newId("opt"), b: newId("opt"), secret: newId("rec"),
  };
  let s = run(emptyBase(newId("bas"), "Test"), [
    { type: "table.create", tableId: ids.t, name: "Requests", primaryFieldId: ids.name, viewId: ids.grid },
    { type: "table.create", tableId: ids.other, name: "Clients", primaryFieldId: ids.oName, viewId: ids.og },
    { type: "row.create", rowId: ids.secret, tableId: ids.other, cells: { [ids.oName]: "Secret client" } },
    { type: "field.create", fieldId: ids.count, tableId: ids.t, name: "Count", fieldType: "number" },
    { type: "field.create", fieldId: ids.topic, tableId: ids.t, name: "Topic", fieldType: "singleSelect", options: { choices: [{ id: ids.a, name: "Bug", color: "red" }, { id: ids.b, name: "Idea", color: "green" }] } },
    { type: "field.create", fieldId: ids.tags, tableId: ids.t, name: "Tags", fieldType: "multiSelect", options: { choices: [{ id: ids.a, name: "Bug", color: "red" }] } },
    { type: "field.create", fieldId: ids.agree, tableId: ids.t, name: "Agree", fieldType: "checkbox" },
    { type: "field.create", fieldId: ids.files, tableId: ids.t, name: "Files", fieldType: "attachment" },
    { type: "field.create", fieldId: ids.link, tableId: ids.t, name: "Client", fieldType: "link", options: { linkedTableId: ids.other }, inverseFieldId: ids.inv },
    { type: "view.create", viewId: ids.form, tableId: ids.t, name: "Form", viewType: "form" },
  ]);
  const form = s.views[ids.form].config.form!;
  s = run(s, [{ type: "view.update", viewId: ids.form, config: { form: { ...form, publicToken: TOKEN, requiredFieldIds: [ids.name, ids.topic] } } }]);
  return { s, ids, view: s.views[ids.form] };
}

test("the public form shows only safe questions and nothing from the base's records", () => {
  const { s, ids, view } = setup();
  const def = publicFormDefinition(s, view)!;
  assert.deepEqual(def.questions.map((q) => q.label), ["Name", "Count", "Topic", "Tags", "Agree"]);
  assert.deepEqual(def.questions.filter((q) => q.required).map((q) => q.label), ["Name", "Topic"]);
  assert.deepEqual(def.questions.find((q) => q.fieldId === ids.topic)?.choices?.map((c) => c.name), ["Bug", "Idea"]);
  const text = JSON.stringify(def);
  assert.ok(!text.includes("Secret client") && !text.includes(ids.secret) && !text.includes(TOKEN), "no records or link code leak");
});

test("answers are checked: unknown fields ignored, options must exist, required enforced", () => {
  const { s, ids, view } = setup();
  const ok = checkSubmission(s, view, { [ids.name]: "Ana", [ids.count]: "3", [ids.topic]: ids.b, [ids.tags]: [ids.a, ids.a], [ids.agree]: true,
    [ids.link]: [ids.secret], [ids.files]: [{ id: "x", url: "/evil" }], fldNotARealField00: "x" });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.cells, { [ids.name]: "Ana", [ids.count]: 3, [ids.topic]: ids.b, [ids.tags]: [ids.a], [ids.agree]: true });
  assert.deepEqual(checkSubmission(s, view, { [ids.topic]: ids.a }).errors, ["“Name” is required"]);
  assert.match(checkSubmission(s, view, { [ids.name]: "Ana", [ids.topic]: "selMadeUpChoice01" }).errors[0], /Pick one of the options/);
  assert.match(checkSubmission(s, view, { [ids.name]: "x".repeat(10_001), [ids.topic]: ids.a }).errors[0], /too long/);
  assert.match(checkSubmission(s, view, { [ids.name]: { nested: true }, [ids.topic]: ids.a }).errors[0], /doesn't look right/);
  assert.deepEqual(checkSubmission(s, view, "nonsense").errors.length, 2);
});

test("public link codes are checked, and a copied form doesn't share its link", () => {
  const { s, ids, view } = setup();
  const form = view.config.form as FormConfig;
  assert.throws(() => applyAction(s, { type: "view.update", viewId: ids.form, config: { form: { ...form, publicToken: "short" } } }, AT), /Invalid public form link/);
  const copy = newId("viw");
  const after = applyAction(s, { type: "view.create", viewId: copy, tableId: ids.t, name: "Copy", viewType: "form", copyFromViewId: ids.form }, AT);
  assert.equal(after.views[copy].config.form?.publicToken, undefined);
  assert.equal(after.views[ids.form].config.form?.publicToken, TOKEN);
  const off = applyAction(s, { type: "view.update", viewId: ids.form, config: { form: { ...form, publicToken: null } } }, AT);
  assert.equal(off.views[ids.form].config.form?.publicToken, null);
});
