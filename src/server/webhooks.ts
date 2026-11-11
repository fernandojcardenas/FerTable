// Outgoing webhooks: after each change to a base, POST what changed to each subscriber.
// Bodies are signed with the webhook's secret (HMAC-SHA256 over "<timestamp>.<body>").
// Delivery is one at a time per webhook; a webhook that keeps failing is switched off.

import { createHmac, randomBytes } from "node:crypto";
import type { ActionBatch, BaseState, People } from "../shared/types";
import { Computer } from "../shared/compute";
import { apiRecord } from "../shared/api";
import { newId } from "../shared/ids";
import { ValidationError } from "../shared/reducer";
import { checkConnectionUrl, safePost } from "./connections";
import { getDb } from "./db";

export type WebhookInfo = { id: string; url: string; tableId: string | null; enabled: boolean; failures: number; lastStatus: string | null; lastAt: string | null; createdAt: string };
type Hook = WebhookInfo & { secret: string };

const MAX_PER_BASE = 10;
const MAX_CHANGES = 500;
const DISABLE_AFTER = 20;
const PER_HOUR = Number(process.env.FERTABLE_WEBHOOKS_PER_HOUR ?? 1000);

const cache = new Map<string, Promise<Hook[]>>();

async function load(baseId: string): Promise<Hook[]> {
  const db = await getDb();
  const { rows } = await db.query<{ id: string; url: string; table_id: string | null; enabled: boolean; failures: number; last_status: string | null; last_at: string | null; created_at: string; secret: string }>(
    "select id, url, table_id, enabled, failures, last_status, last_at, created_at, secret from webhooks where base_id = $1 order by created_at", [baseId]);
  return rows.map((r) => ({ id: r.id, url: r.url, tableId: r.table_id, enabled: r.enabled, failures: r.failures, lastStatus: r.last_status,
    lastAt: r.last_at ? new Date(r.last_at).toISOString() : null, createdAt: new Date(r.created_at).toISOString(), secret: r.secret }));
}
const hooks = (baseId: string) => { let p = cache.get(baseId); if (!p) { p = load(baseId); cache.set(baseId, p); } return p; };
const strip = ({ secret: _, ...h }: Hook): WebhookInfo => h;

export async function listWebhooks(baseId: string): Promise<WebhookInfo[]> {
  cache.delete(baseId);
  return (await hooks(baseId)).map(strip);
}

/** Add a webhook. The secret is returned once, for checking signatures. */
export async function createWebhook(baseId: string, state: BaseState, userId: string, urlIn: unknown, tableIdIn: unknown): Promise<WebhookInfo & { secret: string }> {
  const url = checkConnectionUrl("webhook", String(urlIn ?? "")).toString();
  const tableId = tableIdIn === null || tableIdIn === undefined || tableIdIn === "" ? null : String(tableIdIn);
  if (tableId && !state.tables[tableId]) throw new ValidationError("That table isn't in this base");
  if ((await hooks(baseId)).length >= MAX_PER_BASE) throw new ValidationError(`A base can have at most ${MAX_PER_BASE} webhooks`);
  const id = newId("ach");
  const secret = randomBytes(32).toString("base64url");
  const db = await getDb();
  await db.query("insert into webhooks (id, base_id, created_by, url, table_id, secret) values ($1, $2, $3, $4, $5, $6)", [id, baseId, userId, url, tableId, secret]);
  cache.delete(baseId);
  return { id, url, tableId, enabled: true, failures: 0, lastStatus: null, lastAt: null, createdAt: new Date().toISOString(), secret };
}

export async function deleteWebhook(baseId: string, id: string): Promise<void> {
  const db = await getDb();
  await db.query("delete from webhooks where base_id = $1 and id = $2", [baseId, id]);
  cache.delete(baseId);
}

/** Switch a webhook back on (and reset its failure count). */
export async function enableWebhook(baseId: string, id: string): Promise<void> {
  const db = await getDb();
  await db.query("update webhooks set enabled = true, failures = 0 where base_id = $1 and id = $2", [baseId, id]);
  cache.delete(baseId);
}

export type Change = { action: "created" | "updated" | "deleted"; tableId: string; tableName: string; recordId: string; changedFields?: string[]; fields?: Record<string, unknown> };

/** Record changes between two states (computed values included in `fields`). */
export function recordChanges(before: BaseState, after: BaseState, batch: ActionBatch): Change[] {
  // Link changes, restores, syncs and field edits touch more records than they name: compare everything that differs.
  const ids = new Set([...Object.keys(before.rows), ...Object.keys(after.rows)]);
  const c = new Computer(after, new Date(batch.at));
  const out: Change[] = [];
  for (const id of ids) {
    const b = before.rows[id];
    const a = after.rows[id];
    if (b === a) continue;
    if (!a) { out.push({ action: "deleted", tableId: b.tableId, tableName: before.tables[b.tableId]?.name ?? "", recordId: id }); continue; }
    const table = after.tables[a.tableId];
    if (!b) { out.push({ action: "created", tableId: a.tableId, tableName: table.name, recordId: id, fields: apiRecord(after, c, a).fields }); continue; }
    const changed = table.fieldOrder.filter((f) => JSON.stringify(a.cells[f] ?? null) !== JSON.stringify(b.cells[f] ?? null));
    if (changed.length === 0) continue;
    out.push({ action: "updated", tableId: a.tableId, tableName: table.name, recordId: id, changedFields: changed.map((f) => after.fields[f]?.name ?? f), fields: apiRecord(after, c, a).fields });
  }
  return out;
}

const queues = new Map<string, Promise<void>>();
const budget = new Map<string, { start: number; used: number }>();

/** Called after every committed batch. Doesn't wait for delivery. */
export async function deliverWebhooks(baseId: string, before: BaseState, after: BaseState, batch: ActionBatch, people: () => Promise<People>): Promise<void> {
  const list = (await hooks(baseId)).filter((h) => h.enabled);
  if (list.length === 0) return;
  const all = recordChanges(before, { ...after, people: await people() }, batch);
  if (all.length === 0) return;
  for (const h of list) {
    const changes = h.tableId ? all.filter((x) => x.tableId === h.tableId) : all;
    if (changes.length === 0) continue;
    const b = budget.get(baseId);
    const now = Date.now();
    if (!b || now - b.start > 3600_000) budget.set(baseId, { start: now, used: 1 });
    else if (++b.used > PER_HOUR) continue;
    const payload = {
      webhookId: h.id, baseId, txn: batch.txn, timestamp: batch.at, source: batch.source,
      changes: changes.slice(0, MAX_CHANGES), ...(changes.length > MAX_CHANGES ? { truncated: true, totalChanges: changes.length } : {}),
    };
    let body = JSON.stringify(payload);
    if (body.length > 190_000) body = JSON.stringify({ ...payload, changes: payload.changes.map(({ fields: _f, ...rest }) => rest), fieldsOmitted: true });
    const prev = queues.get(h.id) ?? Promise.resolve();
    const next = prev.then(() => send(baseId, h, body)).catch(() => {});
    queues.set(h.id, next);
  }
}

/** Sign and POST one delivery, then record how it went. */
async function send(baseId: string, h: Hook, body: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", h.secret).update(`${ts}.${body}`).digest("hex");
  let status: string;
  let ok = false;
  try {
    const r = await safePost(h.url, body, 10_000, { "x-fertable-webhook": h.id, "x-fertable-timestamp": ts, "x-fertable-signature": `sha256=${sig}` });
    ok = r.status >= 200 && r.status < 300;
    status = `HTTP ${r.status}`;
  } catch (e) {
    status = e instanceof Error ? e.message.slice(0, 200) : "Failed";
  }
  const db = await getDb();
  const { rows } = await db.query<{ failures: number }>(
    `update webhooks set last_status = $3, last_at = now(), failures = case when $4 then 0 else failures + 1 end,
       enabled = case when not $4 and failures + 1 >= $5 then false else enabled end
     where base_id = $1 and id = $2 returning failures`, [baseId, h.id, status, ok, DISABLE_AFTER]);
  const cached = (await hooks(baseId)).find((x) => x.id === h.id);
  if (cached && rows[0]) { cached.failures = rows[0].failures; cached.lastStatus = status; if (rows[0].failures >= DISABLE_AFTER) cached.enabled = false; }
}

/** How a receiver checks a delivery (also used by tests). */
export function signature(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}
