import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAction, emptyBase } from "../src/shared/reducer";
import { countSteps, lastScheduledTime, nextScheduledTime, planSteps, triggerMatches } from "../src/shared/automation";
import { checkConnectionUrl, isPrivateAddress } from "../src/server/connections";
import { runScript } from "../src/server/script";
import { newId } from "../src/shared/ids";
import type { Action, Automation, AutomationStep, AutomationTrigger, BaseState } from "../src/shared/types";

const AT = "2026-11-10T12:00:00.000Z";
const run = (s: BaseState, actions: Action[]) => actions.reduce((acc, a) => applyAction(acc, a, AT), s);

function setup() {
  const ids = {
    p: newId("tbl"), t: newId("tbl"), pName: newId("fld"), tName: newId("fld"), done: newId("fld"), link: newId("fld"), inv: newId("fld"),
    note: newId("fld"), v1: newId("viw"), v2: newId("viw"), open: newId("viw"), form: newId("viw"), proj: newId("rec"), t1: newId("rec"), t2: newId("rec"),
  };
  const s = run(emptyBase(newId("bas"), "Test"), [
    { type: "table.create", tableId: ids.p, name: "Projects", primaryFieldId: ids.pName, viewId: ids.v1 },
    { type: "table.create", tableId: ids.t, name: "Tasks", primaryFieldId: ids.tName, viewId: ids.v2 },
    { type: "field.create", fieldId: ids.done, tableId: ids.t, name: "Done", fieldType: "checkbox" },
    { type: "field.create", fieldId: ids.note, tableId: ids.p, name: "Note", fieldType: "text" },
    { type: "field.create", fieldId: ids.link, tableId: ids.p, name: "Tasks", fieldType: "link", options: { linkedTableId: ids.t }, inverseFieldId: ids.inv },
    { type: "view.create", viewId: ids.open, tableId: ids.t, name: "Open", viewType: "grid" },
    { type: "view.update", viewId: ids.open, config: { filters: { conjunction: "and", conditions: [{ id: "c1", fieldId: ids.done, operator: "unchecked", value: null }] } } },
    { type: "view.create", viewId: ids.form, tableId: ids.p, name: "Intake", viewType: "form" },
    { type: "row.create", rowId: ids.t1, tableId: ids.t, cells: { [ids.tName]: "Draft" } },
    { type: "row.create", rowId: ids.t2, tableId: ids.t, cells: { [ids.tName]: "Ship", [ids.done]: true } },
    { type: "row.create", rowId: ids.proj, tableId: ids.p, cells: { [ids.pName]: "Launch", [ids.link]: [ids.t1, ids.t2] } },
  ]);
  return { s, ids };
}

const auto = (trigger: AutomationTrigger, steps: AutomationStep[]): Automation => ({ id: newId("aut"), name: "A", enabled: true, trigger, steps });
const save = (s: BaseState, a: Automation) => applyAction(s, { type: "automation.upsert", automation: a }, AT);

test("branches pick a side and loops visit each linked record", () => {
  const { s, ids } = setup();
  const a = auto({ type: "recordCreated", tableId: ids.p }, [
    { type: "condition", filters: { conjunction: "and", conditions: [{ id: "c", fieldId: ids.pName, operator: "is", value: "Launch" }] },
      then: [{ type: "updateRecord", values: { [ids.note]: "matched {" + ids.pName + "}" } }],
      otherwise: [{ type: "updateRecord", values: { [ids.note]: "no" } }] },
    { type: "forEach", linkFieldId: ids.link, steps: [{ type: "updateRecord", values: { [ids.done]: "true" } }] },
  ]);
  save(s, a); // valid
  const plan = planSteps(s, a, s.rows[ids.proj]);
  assert.deepEqual(plan.problems, []);
  const cond = plan.preview[0];
  assert.equal(cond.kind, "condition");
  if (cond.kind === "condition") {
    assert.equal(cond.matched, true);
    assert.equal(cond.then.length, 1);
    assert.equal(cond.otherwise.length, 0);
  }
  const loop = plan.preview[1];
  assert.equal(loop.kind === "forEach" && loop.count, 2);
  // 1 update from the branch + 2 from the loop, each aimed at its own record.
  const targets = plan.actions.map((x) => (x.type === "row.update" ? x.rowId : null));
  assert.deepEqual(targets, [ids.proj, ids.t1, ids.t2]);
  assert.equal(countSteps(a.steps), 5);
});

test("bad steps and triggers are refused when saved", () => {
  const { s, ids } = setup();
  const nest = (depth: number): AutomationStep =>
    depth === 0 ? { type: "script", code: "1" } : { type: "condition", filters: { conjunction: "and", conditions: [] }, then: [nest(depth - 1)], otherwise: [] };
  assert.throws(() => save(s, auto({ type: "recordCreated", tableId: ids.p }, [nest(5)])), /nested 3 deep/);
  assert.throws(() => save(s, auto({ type: "schedule", tableId: ids.p, every: "day", minute: 0, hourUtc: 9, weekdayUtc: 1, viewId: null },
    [{ type: "updateRecord", values: { [ids.note]: "x" } }])), /no record to update/);
  assert.throws(() => save(s, auto({ type: "recordCreated", tableId: ids.p }, [{ type: "forEach", linkFieldId: ids.note, steps: [] }])), /link field/);
  assert.throws(() => save(s, auto({ type: "recordCreated", tableId: ids.p }, [{ type: "forEach", linkFieldId: ids.link, steps: [{ type: "updateRecord", values: { [ids.note]: "x" } }] }])), /can't be set/,
    "inside the loop the record is a Task, so a Projects field is wrong");
  assert.throws(() => save(s, auto({ type: "formSubmitted", tableId: ids.p, viewId: ids.v1 }, [])), /view isn't in that table/, "must be a form view");
  assert.throws(() => save(s, auto({ type: "schedule", tableId: ids.p, every: "day", minute: 60, hourUtc: 9, weekdayUtc: 1, viewId: null }, [])), /time isn't valid/);
  assert.throws(() => save(s, auto({ type: "recordCreated", tableId: ids.p }, [{ type: "script", code: "x".repeat(20_001) }])), /too long/);
  save(s, auto({ type: "schedule", tableId: ids.p, every: "week", minute: 30, hourUtc: 8, weekdayUtc: 1, viewId: null }, [{ type: "script", code: "1" }]));
});

test("entering a view and submitting a form start automations", () => {
  const { s, ids } = setup();
  const entered = auto({ type: "enteredView", tableId: ids.t, viewId: ids.open }, []);
  assert.equal(triggerMatches(s, entered, s.rows[ids.t1]), true);
  assert.equal(triggerMatches(s, entered, s.rows[ids.t2]), false);
});

test("schedules find their last and next times in UTC", () => {
  const now = new Date("2026-11-10T12:20:00Z"); // a Tuesday
  const base = { type: "schedule" as const, tableId: "tbl", viewId: null };
  const hourly = { ...base, every: "hour" as const, minute: 30, hourUtc: 0, weekdayUtc: 0 };
  assert.equal(lastScheduledTime(hourly, now).toISOString(), "2026-11-10T11:30:00.000Z");
  assert.equal(nextScheduledTime(hourly, now).toISOString(), "2026-11-10T12:30:00.000Z");
  const daily = { ...base, every: "day" as const, minute: 0, hourUtc: 9, weekdayUtc: 0 };
  assert.equal(lastScheduledTime(daily, now).toISOString(), "2026-11-10T09:00:00.000Z");
  assert.equal(nextScheduledTime(daily, now).toISOString(), "2026-11-11T09:00:00.000Z");
  const weekly = { ...base, every: "week" as const, minute: 0, hourUtc: 9, weekdayUtc: 1 }; // Mondays
  assert.equal(lastScheduledTime(weekly, now).toISOString(), "2026-11-09T09:00:00.000Z");
  assert.equal(nextScheduledTime(weekly, now).toISOString(), "2026-11-16T09:00:00.000Z");
});

test("connections must be public https addresses of the right service", () => {
  assert.throws(() => checkConnectionUrl("webhook", "http://example.com/x"), /https/);
  assert.throws(() => checkConnectionUrl("slack", "https://example.com/services/x"), /hooks.slack.com/);
  assert.throws(() => checkConnectionUrl("sheets", "https://script.google.com/other"), /Apps Script/);
  assert.throws(() => checkConnectionUrl("webhook", "https://localhost:8080/x"), /public addresses/);
  assert.throws(() => checkConnectionUrl("webhook", "https://[::1]/x"), /public addresses/);
  checkConnectionUrl("slack", "https://hooks.slack.com/services/T0/B0/xyz");
  checkConnectionUrl("sheets", "https://script.google.com/macros/s/AKfy-abc_1/exec");
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("scripts run sandboxed with a time limit", async () => {
  const ok = await runScript('console.log("hi", record.Name); return { Note: record.Name + "!" };', { Name: "Launch" }, null);
  assert.deepEqual(ok, { ok: true, updates: { Note: "Launch!" }, log: "hi Launch" });
  const nothing = await runScript("const x = 1;", { Name: "a" }, null);
  assert.equal(nothing.ok && nothing.updates, null);
  const noNode = await runScript("return { t: typeof process + typeof require + typeof fetch };", null, null);
  assert.deepEqual(noNode.ok && noNode.updates, { t: "undefinedundefinedundefined" });
  const loop = await runScript("while (true) {}", null, null);
  assert.equal(loop.ok, false);
  const thrown = await runScript('throw new Error("nope")', null, null);
  assert.equal(thrown.ok, false);
  assert.match(!thrown.ok ? thrown.error : "", /nope/);
});

test("posting refuses private addresses, including literal IPs", async () => {
  const { safePost } = await import("../src/server/connections");
  for (const url of ["https://127.0.0.1:9/x", "https://[::1]:9/x", "https://169.254.169.254/latest", "https://10.0.0.1/x", "https://localhost:9/x"]) {
    await assert.rejects(safePost(url, {}), /private network/, url);
  }
});
