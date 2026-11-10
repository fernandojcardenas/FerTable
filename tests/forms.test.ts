import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAction, emptyBase } from "../src/shared/reducer";
import { missingAnswers, questionHelp, questionLabel, requiredIds } from "../src/shared/forms";
import { newId } from "../src/shared/ids";
import type { Action, BaseState, FormConfig } from "../src/shared/types";

const AT = "2026-11-10T12:00:00.000Z";
const run = (s: BaseState, actions: Action[]) => actions.reduce((acc, a) => applyAction(acc, a, AT), s);

function setup() {
  const ids = { t: newId("tbl"), name: newId("fld"), notes: newId("fld"), done: newId("fld"), grid: newId("viw"), form: newId("viw") };
  const s = run(emptyBase(newId("bas"), "Test"), [
    { type: "table.create", tableId: ids.t, name: "Requests", primaryFieldId: ids.name, viewId: ids.grid },
    { type: "field.create", fieldId: ids.notes, tableId: ids.t, name: "Notes", fieldType: "longText" },
    { type: "field.create", fieldId: ids.done, tableId: ids.t, name: "Agree", fieldType: "checkbox" },
    { type: "view.create", viewId: ids.form, tableId: ids.t, name: "Form", viewType: "form" },
  ]);
  return { s, ids };
}

test("new forms ask every question and require the name", () => {
  const { s, ids } = setup();
  const form = s.views[ids.form].config.form!;
  assert.deepEqual(form.fieldIds, [ids.name, ids.notes, ids.done]);
  assert.deepEqual(form.requiredFieldIds, [ids.name]);
  // Forms saved before this setting existed still require only the name.
  assert.deepEqual(requiredIds({ ...form, requiredFieldIds: undefined }, ids.name), [ids.name]);
});

test("required questions must be answered; blank text, empty lists and unticked boxes don't count", () => {
  const { s, ids } = setup();
  const form: FormConfig = { ...s.views[ids.form].config.form!, requiredFieldIds: [ids.name, ids.notes, ids.done] };
  const fields = form.fieldIds.map((id) => s.fields[id]);
  const names = (v: Record<string, unknown>) => missingAnswers(form, fields, v as never, ids.name).map((f) => f.name);
  assert.deepEqual(names({}), ["Name", "Notes", "Agree"]);
  assert.deepEqual(names({ [ids.name]: "  ", [ids.notes]: "Hi", [ids.done]: false }), ["Name", "Agree"]);
  assert.deepEqual(names({ [ids.name]: "Ana", [ids.notes]: "Hi", [ids.done]: true }), []);
  // A required field that was taken off the form isn't asked for.
  assert.deepEqual(missingAnswers(form, [s.fields[ids.name]], {}, ids.name).map((f) => f.name), ["Name"]);
});

test("question text and help text fall back to the field", () => {
  const { s, ids } = setup();
  const form: FormConfig = { ...s.views[ids.form].config.form!, labels: { [ids.notes]: "Anything else?" }, help: { [ids.name]: "  " } };
  const withDesc = { ...s.fields[ids.name], description: "Your full name" };
  assert.equal(questionLabel(form, s.fields[ids.notes]), "Anything else?");
  assert.equal(questionLabel(form, s.fields[ids.name]), "Name");
  assert.equal(questionHelp(form, withDesc), "Your full name");
});

test("form settings are checked, and deleting a field cleans them up", () => {
  const { s, ids } = setup();
  const form = s.views[ids.form].config.form!;
  const update = (f: Partial<FormConfig>): Action => ({ type: "view.update", viewId: ids.form, config: { form: { ...form, ...f } } });
  assert.throws(() => applyAction(s, update({ thankYou: "x".repeat(5001) }), AT), /too long/);
  assert.throws(() => applyAction(s, update({ labels: "nope" as never }), AT), /must be a map/);
  assert.throws(() => applyAction(s, update({ help: { [ids.name]: 5 as never } }), AT), /must be text/);
  const set = run(s, [update({ requiredFieldIds: [ids.name, ids.notes], labels: { [ids.notes]: "More?" }, help: { [ids.notes]: "Optional" }, thankYou: "Got it!" })]);
  const after = run(set, [{ type: "field.delete", fieldId: ids.notes }]).views[ids.form].config.form!;
  assert.deepEqual(after.requiredFieldIds, [ids.name]);
  assert.deepEqual(after.labels, {});
  assert.deepEqual(after.help, {});
  assert.equal(after.thankYou, "Got it!");
});
