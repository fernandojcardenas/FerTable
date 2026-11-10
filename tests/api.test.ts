import { test } from "node:test";
import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { applyActions, emptyBase } from "../src/shared/reducer";
import { Computer } from "../src/shared/compute";
import { apiRecord, cellsFromApi, choiceActions, formulaFilter } from "../src/shared/api";
import { recordChanges, signature } from "../src/server/webhooks";
import { starterTableActions } from "../src/shared/starter";
import { newId } from "../src/shared/ids";
import type { ActionBatch, SelectChoice } from "../src/shared/types";

const AT = "2026-11-10T12:00:00.000Z";
function setup() {
  const st = starterTableActions("Tasks");
  const s = applyActions(emptyBase(newId("bas"), "Ops"), st.actions, AT);
  const t = s.tables[st.tableId];
  const field = (n: string) => t.fieldOrder.map((id) => s.fields[id]).find((f) => f.name === n)!;
  return { s, t, field };
}

test("API fields are matched by name, select options by name, and typecast creates options", () => {
  const { s, t, field } = setup();
  const pending = new Map<string, SelectChoice[]>();
  assert.throws(() => cellsFromApi(s, t, { Status: "Blocked" }, false, pending), /typecast/);
  assert.throws(() => cellsFromApi(s, t, { Nope: "x" }, false), /Unknown field/);
  assert.throws(() => cellsFromApi(s, t, { Name: 5 }, false), /can't take/);
  const cells = cellsFromApi(s, t, { name: "Fix", Status: "Blocked" }, true, pending);
  const rid = newId("rec");
  const after = applyActions(s, [...choiceActions(pending), { type: "row.create", rowId: rid, tableId: t.id, cells }], AT);
  const rec = apiRecord(after, new Computer(after), after.rows[rid]);
  assert.deepEqual(rec.fields, { Name: "Fix", Status: "Blocked" });
  assert.equal(rec.createdTime, AT);
  const todo = cellsFromApi(s, t, { Status: "Todo" }, false);
  assert.equal(todo[field("Status").id], field("Status").options.choices![0].id);
  const keep = formulaFilter(after, t, new Computer(after), '{Status} = "Blocked"');
  assert.deepEqual(t.rowOrder.concat(rid).filter((id) => after.rows[id] && keep(after.rows[id])), [rid]);
  assert.throws(() => formulaFilter(after, t, new Computer(after), "{Status} = "), /Invalid filterByFormula/);
});

test("webhook payloads list created, updated and deleted records, and are signed", () => {
  const { s, t } = setup();
  const [a, b] = t.rowOrder;
  const c = newId("rec");
  const actions = [
    { type: "row.create" as const, rowId: c, tableId: t.id, cells: { [t.primaryFieldId]: "New" } },
    { type: "row.update" as const, rowId: a, cells: { [t.primaryFieldId]: "Changed" } },
    { type: "row.delete" as const, rowIds: [b] },
  ];
  const after = applyActions(s, actions, AT);
  const batch: ActionBatch = { txn: 2, userId: null, at: AT, actions, clientId: null, requestId: null, source: "api" };
  const changes = recordChanges(s, after, batch);
  const by = Object.fromEntries(changes.map((x) => [x.recordId, x]));
  assert.equal(by[c].action, "created");
  assert.deepEqual(by[a].changedFields, ["Name"]);
  assert.equal(by[a].fields?.Name, "Changed");
  assert.equal(by[b].action, "deleted");
  assert.equal(changes.length, 3);
  assert.equal(signature("k", "1", "{}"), "sha256=" + createHmac("sha256", "k").update("1.{}").digest("hex"));
  assert.notEqual(signature("k", "1", "{}"), signature("k", "2", "{}"));
});
