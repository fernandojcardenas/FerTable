import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAction, applyActions, emptyBase } from "../src/shared/reducer";
import { Computer } from "../src/shared/compute";
import { coerceValue, formatDuration, parseDuration } from "../src/shared/fieldTypes";
import { fillTemplate } from "../src/shared/automation";
import { filterKind } from "../src/shared/query";
import { newId } from "../src/shared/ids";
import type { Action, BaseState, Field } from "../src/shared/types";

const AT = "2026-11-10T12:00:00.000Z";
const LATER = "2026-11-10T13:00:00.000Z";
const ANA = newId("usr"), BO = newId("usr");

function setup() {
  const ids = {
    t: newId("tbl"), name: newId("fld"), rating: newId("fld"), dur: newId("fld"), code: newId("fld"), who: newId("fld"), team: newId("fld"),
    btn: newId("fld"), mod: newId("fld"), by: newId("fld"), ai: newId("fld"), v: newId("viw"), r: newId("rec"),
  };
  let s = applyActions(emptyBase(newId("bas"), "Test"), [
    { type: "table.create", tableId: ids.t, name: "Tasks", primaryFieldId: ids.name, viewId: ids.v },
    { type: "field.create", fieldId: ids.rating, tableId: ids.t, name: "Score", fieldType: "rating", options: { max: 5 } },
    { type: "field.create", fieldId: ids.dur, tableId: ids.t, name: "Time", fieldType: "duration" },
    { type: "field.create", fieldId: ids.code, tableId: ids.t, name: "Code", fieldType: "barcode" },
    { type: "field.create", fieldId: ids.who, tableId: ids.t, name: "Owner", fieldType: "user" },
    { type: "field.create", fieldId: ids.team, tableId: ids.t, name: "Team", fieldType: "user", options: { multiple: true } },
    { type: "field.create", fieldId: ids.btn, tableId: ids.t, name: "Map", fieldType: "button", options: { button: { label: "Map", kind: "url", url: `https://maps.example.com/?q={${ids.name}}` } } },
    { type: "field.create", fieldId: ids.mod, tableId: ids.t, name: "Changed", fieldType: "lastModifiedTime" },
    { type: "field.create", fieldId: ids.by, tableId: ids.t, name: "Changed by", fieldType: "lastModifiedBy" },
    { type: "field.create", fieldId: ids.ai, tableId: ids.t, name: "Summary", fieldType: "ai", options: { prompt: `Summarize {${ids.name}}` } },
    { type: "row.create", rowId: ids.r, tableId: ids.t, cells: { [ids.name]: "Fix login" } },
  ], AT, ANA);
  s = { ...s, people: { [ANA]: { name: "Ana", email: "ana@example.test" }, [BO]: { name: "Bo", email: "bo@example.test" } } };
  return { s, ids };
}
const f = (s: BaseState, id: string): Field => s.fields[id];

test("rating, duration, barcode and user values are cleaned up", () => {
  const { s, ids } = setup();
  assert.equal(coerceValue(f(s, ids.rating), 9), 5);
  assert.equal(coerceValue(f(s, ids.rating), "3"), 3);
  assert.equal(coerceValue(f(s, ids.rating), 0), null);
  assert.equal(coerceValue(f(s, ids.dur), "1:30"), 5400);
  assert.equal(coerceValue(f(s, ids.dur), "0:00:45"), 45);
  assert.equal(coerceValue(f(s, ids.dur), "soon"), null);
  assert.equal(coerceValue(f(s, ids.code), "ABC\n123"), "ABC 123");
  assert.deepEqual(coerceValue(f(s, ids.who), [ANA, BO]), [ANA], "single-person field keeps one");
  assert.deepEqual(coerceValue(f(s, ids.team), [ANA, BO, ANA, "not-a-user"]), [ANA, BO]);
  assert.equal(parseDuration("90"), 5400);
  assert.equal(formatDuration(3723, "h:mm:ss"), "1:02:03");
  assert.equal(formatDuration(5400), "1:30");
});

test("records remember when and by whom they last changed", () => {
  const { s, ids } = setup();
  const c0 = new Computer(s);
  assert.equal(c0.display(s.rows[ids.r], f(s, ids.by)), "Ana");
  const after = applyAction(s, { type: "row.update", rowId: ids.r, cells: { [ids.rating]: 4, [ids.team]: [ANA, BO] } }, LATER, BO);
  const c = new Computer(after);
  const row = after.rows[ids.r];
  assert.equal(row.modifiedAt, LATER);
  assert.equal(c.display(row, f(after, ids.by)), "Bo");
  assert.equal(c.display(row, f(after, ids.team)), "Ana, Bo");
  assert.equal(c.value(row, f(after, ids.mod)), LATER);
  // Changes from automations, forms or AI have no person.
  const auto = applyAction(after, { type: "row.update", rowId: ids.r, cells: { [ids.code]: "X1" } }, LATER, null);
  assert.equal(new Computer(auto).display(auto.rows[ids.r], f(auto, ids.by)), "Automation");
  // Someone who left the base still reads sensibly.
  const gone = { ...after, people: {} };
  assert.equal(new Computer(gone).display(gone.rows[ids.r], f(gone, ids.by)), "Former member");
  assert.equal(filterKind(f(s, ids.dur)), "number");
  assert.equal(filterKind(f(s, ids.mod)), "date");
});

test("AI results come from ai.set, keep errors, and don't count as an edit", () => {
  const { s, ids } = setup();
  const before = s.rows[ids.r];
  const ok = applyAction(s, { type: "ai.set", rowId: ids.r, fieldId: ids.ai, value: "Login bug" }, LATER, null);
  assert.equal(ok.rows[ids.r].cells[ids.ai], "Login bug");
  assert.equal(ok.rows[ids.r].modifiedAt, before.modifiedAt, "not an edit");
  assert.equal(ok.rows[ids.r].modifiedBy, before.modifiedBy);
  const failed = applyAction(ok, { type: "ai.set", rowId: ids.r, fieldId: ids.ai, value: "Login bug", error: "AI isn't set up" }, LATER, null);
  assert.equal(new Computer(failed).isError(failed.rows[ids.r], f(failed, ids.ai)), "AI isn't set up");
  assert.equal(failed.rows[ids.r].cells[ids.ai], "Login bug", "the last good answer is kept");
  const cleared = applyAction(failed, { type: "ai.set", rowId: ids.r, fieldId: ids.ai, value: "New" }, LATER, null);
  assert.equal(cleared.rows[ids.r].aiErrors, undefined);
  assert.throws(() => applyAction(s, { type: "ai.set", rowId: ids.r, fieldId: ids.code, value: "x" }, LATER), /Not an AI field/);
  assert.throws(() => applyAction(s, { type: "row.update", rowId: ids.r, cells: { [ids.ai]: "typed" } }, LATER), /computed/);
  assert.equal(fillTemplate(s, s.rows[ids.r], f(s, ids.ai).options.prompt!), "Summarize Fix login");
});

test("button and AI settings are checked", () => {
  const { s, ids } = setup();
  const make = (type: Field["type"], options: Field["options"]): Action => ({ type: "field.create", fieldId: newId("fld"), tableId: ids.t, name: `F ${Math.random()}`, fieldType: type, options });
  assert.throws(() => applyAction(s, make("button", { button: { label: "Go", kind: "url", url: "javascript:alert(1)" } })), /must start with https/);
  assert.throws(() => applyAction(s, make("button", { button: { label: "Go", kind: "automation", automationId: newId("aut") } })), /doesn't exist/);
  assert.throws(() => applyAction(s, make("ai", { prompt: `Use {${newId("fld")}}` })), /doesn't exist/);
  assert.throws(() => applyAction(s, make("ai", { prompt: "x".repeat(10_001) })), /too long/);
  const rated = applyAction(s, make("rating", { max: 99 }));
  assert.equal(Object.values(rated.fields).find((x) => x.type === "rating" && x.id !== ids.rating)?.options.max, 10);
  assert.equal(fillTemplate(s, s.rows[ids.r], f(s, ids.btn).options.button!.url!, new Date(), true), "https://maps.example.com/?q=Fix%20login");
  const tricky = applyAction(s, { type: "row.update", rowId: ids.r, cells: { [ids.name]: "A&B #1" } }, LATER);
  assert.equal(fillTemplate(tricky, tricky.rows[ids.r], f(s, ids.btn).options.button!.url!, new Date(), true), "https://maps.example.com/?q=A%26B%20%231");
});
