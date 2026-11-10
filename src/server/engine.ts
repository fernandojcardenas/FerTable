// The sync engine: keeps each base in memory, applies action batches under a
// per-base lock, saves what changed to Postgres, logs the transaction and
// broadcasts it to every connected client. Then it runs automations.

import type { Action, ActionBatch, Attachment, Automation, BaseState, CellValue, Field, Role, Row, ServerMessage, View } from "../shared/types";
import { applyActions, emptyBase, ValidationError } from "../shared/reducer";
import { Computer, CellError } from "../shared/compute";
import { matchesFilters } from "../shared/query";
import { planSteps } from "../shared/automation";
import { checkSubmission, PUBLIC_TOKEN_RE } from "../shared/publicForm";
import { oneLine, sendMail } from "./mail";
import { starterTableActions } from "../shared/starter";
import { rowHistory, type DeletedSnapshot } from "../shared/activity";
import { newId } from "../shared/ids";
import { getDb, type Queryable } from "./db";

type Listener = (msg: ServerMessage) => void;

export type ApplyRequest = {
  clientId: string | null;
  requestId: string | null;
  actions: Action[];
  userId?: string | null;
  /** Who to show in record history when there's no user (e.g. an automation). */
  actor?: string;
};

const COLLECTIONS = [
  ["tables", "tables_"],
  ["fields", "fields"],
  ["rows", "rows_"],
  ["views", "views"],
  ["automations", "automations"],
] as const;

const MAX_BACKFILL = 2000;

export class Engine {
  private states = new Map<string, Promise<BaseState | null>>();
  private locks = new Map<string, Promise<unknown>>();
  /** Open sockets per base, with the user each one belongs to. */
  private listeners = new Map<string, Map<Listener, string | null>>();

  /** Run fn while holding the base's lock, so batches apply one at a time in txn order. */
  private withLock<T>(baseId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(baseId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(baseId, run.catch(() => undefined));
    return run;
  }

  /** Bases this user can open, with their role in each. */
  async listBases(userId: string): Promise<{ id: string; name: string; txn: number; role: Role }[]> {
    const db = await getDb();
    const { rows } = await db.query<{ id: string; name: string; txn: number; role: Role }>(
      "select b.id, b.name, b.txn, m.role from bases b join base_members m on m.base_id = b.id where m.user_id = $1 order by b.created_at",
      [userId],
    );
    return rows;
  }

  getState(baseId: string): Promise<BaseState | null> {
    let p = this.states.get(baseId);
    if (!p) {
      p = this.loadFromDb(baseId);
      this.states.set(baseId, p);
      p.then((s) => { if (!s) this.states.delete(baseId); });
    }
    return p;
  }

  private async loadFromDb(baseId: string): Promise<BaseState | null> {
    const db = await getDb();
    const base = await db.query<{ id: string; name: string; txn: number }>("select id, name, txn from bases where id = $1", [baseId]);
    if (!base.rows[0]) return null;
    const state = emptyBase(baseId, base.rows[0].name);
    state.base.txn = base.rows[0].txn;
    for (const [key, table] of COLLECTIONS) {
      const { rows } = await db.query<{ data: { id: string } }>(`select data from ${table} where base_id = $1`, [baseId]);
      const map: Record<string, unknown> = {};
      for (const r of rows) map[r.data.id] = r.data;
      (state as Record<string, unknown>)[key] = map;
    }
    const meta = await db.query<{ table_order: string[] }>("select table_order from base_meta where base_id = $1", [baseId]);
    state.tableOrder = (meta.rows[0]?.table_order ?? Object.keys(state.tables)).filter((id) => state.tables[id]);
    return state;
  }

  async createBase(name: string, ownerId: string): Promise<string> {
    const db = await getDb();
    const id = newId("bas");
    const clean = name.trim().slice(0, 200) || "Untitled base";
    await db.tx(async (q) => {
      await q.query("insert into bases (id, name, txn) values ($1, $2, 0)", [id, clean]);
      await q.query("insert into base_meta (base_id, table_order) values ($1, '[]'::jsonb)", [id]);
      await q.query("insert into base_members (base_id, user_id, role) values ($1, $2, 'owner')", [id, ownerId]);
    });
    this.states.delete(id);
    await this.apply(id, { clientId: null, requestId: null, userId: ownerId, actions: starterTableActions("Table 1").actions });
    return id;
  }

  async deleteBase(baseId: string): Promise<void> {
    await this.withLock(baseId, async () => {
      const db = await getDb();
      await db.query("delete from bases where id = $1", [baseId]);
      this.states.delete(baseId);
      this.broadcast(baseId, { type: "resync", reason: "Base deleted" });
    });
  }

  /** Apply a batch from a client. Throws ValidationError if any action is invalid (nothing is saved). */
  async apply(baseId: string, req: ApplyRequest, source: ActionBatch["source"] = "client"): Promise<ActionBatch> {
    const result = await this.withLock(baseId, () => this.applyLocked(baseId, req, source));
    if (source === "client") {
      // Automations run after the lock is released, as their own transactions.
      this.runAutomations(baseId, result.before, result.after, result.batch).catch((e) => console.error("automation error", e));
    }
    return result.batch;
  }

  private async applyLocked(baseId: string, req: ApplyRequest, source: ActionBatch["source"]) {
    const before = await this.getState(baseId);
    if (!before) throw new ValidationError("Base not found");
    if (!Array.isArray(req.actions) || req.actions.length === 0) throw new ValidationError("No actions");
    if (req.actions.length > 5000) throw new ValidationError("Too many actions in one request");

    const at = new Date().toISOString();
    // The server decides creation times.
    const actions = req.actions.map((a): Action => (a.type === "row.create" ? { ...a, createdAt: at } : a));
    let after = applyActions(before, actions, at);
    const txn = before.base.txn + 1;
    after = { ...after, base: { ...after.base, txn } };
    const batch: ActionBatch = { txn, at, actions, clientId: req.clientId, requestId: req.requestId, source, userId: req.userId ?? null };

    // What happened to each record, for its history.
    const history = rowHistory(before, after, actions, at);
    const note = actions.every((a) => a.type === "restore") ? "undo" : null;

    const db = await getDb();
    await db.tx(async (q) => {
      await persistDiff(q, baseId, before, after);
      for (let i = 0; i < history.length; i += SAVE_CHUNK) {
        const part = history.slice(i, i + SAVE_CHUNK);
        await q.query(
          `insert into row_history (base_id, row_id, txn, user_id, actor, kind, note, title, changes, at, snapshot)
             select $1, x.row_id, $2, $3, $4, x.kind, $5, x.title, x.changes::jsonb, $6, x.snapshot::jsonb
             from unnest($7::text[], $8::text[], $9::text[], $10::text[], $11::text[]) as x(row_id, kind, title, changes, snapshot)
           on conflict do nothing`,
          [baseId, txn, req.userId ?? null, req.actor ?? null, note, at,
            part.map((h) => h.rowId), part.map((h) => h.kind), part.map((h) => h.title), part.map((h) => JSON.stringify(h.changes)),
            part.map((h) => (h.snapshot ? JSON.stringify(h.snapshot) : null))],
        );
      }
      await q.query("update bases set txn = $2, name = $3 where id = $1", [baseId, txn, after.base.name]);
      await q.query(
        "insert into action_log (base_id, txn, client_id, request_id, source, at, actions, user_id) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)",
        [baseId, txn, req.clientId, req.requestId, source, at, JSON.stringify(actions), req.userId ?? null],
      );
    });
    this.states.set(baseId, Promise.resolve(after));
    this.broadcast(baseId, { type: "batch", batch });
    return { before, after, batch };
  }

  /**
   * Subscribe a socket. Sends every batch after `since` first, or asks the
   * client to reload if it's too far behind.
   */
  subscribe(baseId: string, since: number, listener: Listener, userId: string | null = null): Promise<() => void> {
    return this.withLock(baseId, async () => {
      const state = await this.getState(baseId);
      if (!state) {
        listener({ type: "resync", reason: "Base not found" });
        return () => {};
      }
      listener({ type: "hello", txn: state.base.txn });
      if (since < state.base.txn) {
        if (state.base.txn - since > MAX_BACKFILL || since < 0) {
          listener({ type: "resync", reason: "Too far behind" });
        } else {
          const db = await getDb();
          const { rows } = await db.query<{ txn: number; client_id: string | null; request_id: string | null; source: string; at: string; actions: Action[]; user_id: string | null }>(
            "select txn, client_id, request_id, source, at, actions, user_id from action_log where base_id = $1 and txn > $2 order by txn",
            [baseId, since],
          );
          for (const r of rows) {
            listener({
              type: "batch",
              batch: { txn: r.txn, at: r.at, actions: r.actions, clientId: r.client_id, requestId: r.request_id, source: r.source as ActionBatch["source"], userId: r.user_id },
            });
          }
        }
      }
      let set = this.listeners.get(baseId);
      if (!set) this.listeners.set(baseId, (set = new Map()));
      set.set(listener, userId);
      return () => { set!.delete(listener); };
    });
  }

  private broadcast(baseId: string, msg: ServerMessage) {
    for (const l of this.listeners.get(baseId)?.keys() ?? []) {
      try { l(msg); } catch (e) { console.error("listener failed", e); }
    }
  }

  /** Send a message to everyone with the base open (used for comment events). */
  publish(baseId: string, msg: ServerMessage) {
    this.broadcast(baseId, msg);
  }

  /** Tell a user's open windows their access changed; removed users stop receiving changes. */
  notifyAccess(baseId: string, userId: string, role: Role | null) {
    const set = this.listeners.get(baseId);
    if (!set) return;
    for (const [l, uid] of [...set]) {
      if (uid !== userId) continue;
      try { l({ type: "access", role }); } catch { /* socket closed */ }
      if (role === null) set.delete(l);
    }
  }

  // ---- files ----

  /** Store an uploaded file and return the attachment to put in a cell. */
  async saveFile(baseId: string, name: string, type: string, data: Buffer): Promise<Attachment> {
    const db = await getDb();
    const base = await db.query("select 1 from bases where id = $1", [baseId]);
    if (!base.rows[0]) throw new ValidationError("Base not found");
    const id = newId("att");
    const cleanName = name.replace(/[\u0000-\u001f/\\]/g, "_").trim().slice(0, 255) || "file";
    const cleanType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(type) ? type.toLowerCase().slice(0, 100) : "application/octet-stream";
    await db.query("insert into files (id, base_id, name, type, size, data) values ($1, $2, $3, $4, $5, $6)", [id, baseId, cleanName, cleanType, data.length, data]);
    return { id, name: cleanName, size: data.length, type: cleanType, url: `/api/files/${id}/${encodeURIComponent(cleanName)}` };
  }

  async getFile(id: string): Promise<{ baseId: string; name: string; type: string; data: Buffer } | null> {
    const db = await getDb();
    const { rows } = await db.query<{ base_id: string; name: string; type: string; data: Uint8Array }>("select base_id, name, type, data from files where id = $1", [id]);
    return rows[0] ? { baseId: rows[0].base_id, name: rows[0].name, type: rows[0].type, data: Buffer.from(rows[0].data) } : null;
  }

  /**
   * Delete uploaded files that no cell uses anymore. Files younger than the grace
   * period are kept, so undoing a removal can still bring them back.
   */
  async cleanupFiles(graceHours = 24 * 7): Promise<number> {
    const db = await getDb();
    const { rows } = await db.query<{ id: string }>(
      `delete from files f
        where f.created_at < now() - ($1 || ' hours')::interval
          and not exists (select 1 from rows_ r where r.base_id = f.base_id and position(f.id in r.data::text) > 0)
          -- Records deleted recently can still be restored with their files.
          and not exists (select 1 from row_history h where h.base_id = f.base_id and h.kind = 'deleted' and h.snapshot is not null
                            and h.at::timestamptz > now() - interval '${DELETED_DAYS} days' and position(f.id in h.snapshot::text) > 0)
        returning f.id`,
      [String(Math.max(0, graceHours))],
    );
    return rows.length;
  }

  /** A record's history, newest first. Page with `beforeTxn`. */
  async rowHistory(baseId: string, rowId: string, beforeTxn: number | null, limit = 50) {
    const db = await getDb();
    const { rows } = await db.query<{ txn: number; user_id: string | null; name: string | null; actor: string | null; kind: string; note: string | null; title: string; changes: unknown; at: string }>(
      `select h.txn, h.user_id, u.name, h.actor, h.kind, h.note, h.title, h.changes, h.at
         from row_history h left join users u on u.id = h.user_id
        where h.base_id = $1 and h.row_id = $2 and ($3::int is null or h.txn < $3::int)
        order by h.txn desc limit $4`,
      [baseId, rowId, beforeTxn, Math.min(Math.max(limit, 1), 200)],
    );
    return {
      entries: rows.map((r) => ({
        txn: r.txn, at: r.at, kind: r.kind, note: r.note, title: r.title, changes: r.changes,
        who: r.name ?? r.actor ?? "Someone",
      })),
      nextBefore: rows.length === Math.min(Math.max(limit, 1), 200) ? rows[rows.length - 1].txn : null,
    };
  }

  /** The base and form view a public link points to, if the link is still switched on. */
  async findPublicForm(token: string): Promise<{ baseId: string; state: BaseState; view: View } | null> {
    if (!PUBLIC_TOKEN_RE.test(token)) return null;
    const db = await getDb();
    const { rows } = await db.query<{ id: string; base_id: string }>(
      "select id, base_id from views where data->'config'->'form'->>'publicToken' = $1 limit 1", [token],
    );
    if (!rows[0]) return null;
    const state = await this.getState(rows[0].base_id);
    const view = state?.views[rows[0].id];
    // Check the live copy too: the link may have been turned off a moment ago.
    if (!state || !view || view.type !== "form" || view.config.form?.publicToken !== token) return null;
    return { baseId: rows[0].base_id, state, view };
  }

  /** Save a public form response as a new record (history shows the form as the author). */
  async submitPublicForm(token: string, answers: unknown): Promise<void> {
    const found = await this.findPublicForm(token);
    if (!found) throw new ValidationError("This form is no longer available");
    const { cells, errors } = checkSubmission(found.state, found.view, answers);
    if (errors.length) throw new ValidationError(errors.join(". "));
    const form = found.view.config.form!;
    await this.apply(found.baseId, {
      clientId: null, requestId: null, userId: null, actor: `Form “${(form.title || found.view.name).slice(0, 80)}”`,
      actions: [{ type: "row.create", rowId: newId("rec"), tableId: found.view.tableId, cells }],
    });
  }

  /**
   * Records deleted from a table in the last DELETED_DAYS days that haven't been
   * brought back, newest first. Attachments whose files are gone are left out.
   */
  async deletedRows(baseId: string, tableId: string) {
    const state = await this.getState(baseId);
    if (!state?.tables[tableId]) throw new ValidationError("Table not found");
    const db = await getDb();
    const { rows } = await db.query<{ row_id: string; txn: number; at: string; title: string; changes: unknown; snapshot: DeletedSnapshot; name: string | null; actor: string | null }>(
      `select h.row_id, h.txn, h.at, h.title, h.changes, h.snapshot, u.name, h.actor
         from row_history h left join users u on u.id = h.user_id
        where h.base_id = $1 and h.kind = 'deleted' and h.snapshot is not null
          and h.snapshot->'row'->>'tableId' = $2 and h.at::timestamptz > now() - interval '${DELETED_DAYS} days'
        order by h.txn desc limit 300`,
      [baseId, tableId],
    );
    const seen = new Set<string>();
    const list = rows.filter((r) => !state.rows[r.row_id] && !seen.has(r.row_id) && seen.add(r.row_id)).slice(0, 100);
    // Drop attachments whose files have been cleaned up.
    const fileIds = new Set<string>();
    for (const r of list) for (const v of Object.values(r.snapshot.row.cells)) if (isAttachmentList(v)) v.forEach((a) => fileIds.add(a.id));
    const present = new Set<string>();
    if (fileIds.size) {
      const { rows: f } = await db.query<{ id: string }>("select id from files where base_id = $1 and id = any($2::text[])", [baseId, [...fileIds]]);
      f.forEach((x) => present.add(x.id));
    }
    for (const r of list) {
      for (const [fid, v] of Object.entries(r.snapshot.row.cells)) {
        if (!isAttachmentList(v)) continue;
        const kept = v.filter((a) => present.has(a.id));
        if (kept.length) r.snapshot.row.cells[fid] = kept;
        else delete r.snapshot.row.cells[fid];
      }
    }
    return list.map((r) => ({ rowId: r.row_id, txn: r.txn, at: r.at, title: r.title, changes: r.changes, snapshot: r.snapshot, who: r.name ?? r.actor ?? "Someone" }));
  }

  async automationRuns(baseId: string) {
    const db = await getDb();
    const { rows } = await db.query(
      "select id, automation_id, txn, status, message, created_at from automation_runs where base_id = $1 order by id desc limit 50",
      [baseId],
    );
    return rows;
  }

  // ---- automations ----

  private async runAutomations(baseId: string, before: BaseState, after: BaseState, batch: ActionBatch) {
    const autos = Object.values(after.automations).filter((a) => a.enabled);
    if (autos.length === 0) return;
    const created = new Set<string>();
    const updated = new Map<string, Set<string>>();
    for (const a of batch.actions) {
      if (a.type === "row.create") created.add(a.rowId);
      if (a.type === "row.update" || a.type === "link.add" || a.type === "link.remove") {
        const s = updated.get(a.rowId) ?? new Set();
        if (a.type === "row.update") Object.keys(a.cells).forEach((k) => s.add(k));
        else s.add(a.fieldId);
        updated.set(a.rowId, s);
      }
    }
    if (created.size === 0 && updated.size === 0) return;
    const now = new Date(batch.at);
    const cBefore = new Computer(before, now);
    const cAfter = new Computer(after, now);

    for (const auto of autos) {
      const tableId = auto.trigger.tableId;
      const hits: string[] = [];
      const touched = [...created, ...updated.keys()];
      for (const rowId of new Set(touched)) {
        const row = after.rows[rowId];
        if (!row || row.tableId !== tableId) continue;
        const t = auto.trigger;
        if (t.type === "recordCreated" && created.has(rowId)) hits.push(rowId);
        if (t.type === "recordUpdated" && updated.has(rowId) && !created.has(rowId)) {
          const changed = updated.get(rowId)!;
          if (t.watchFieldIds.length === 0 || t.watchFieldIds.some((f) => changed.has(f))) hits.push(rowId);
        }
        if (t.type === "recordMatches") {
          const now = matchesFilters(cAfter, row, t.filters);
          const prevRow = before.rows[rowId];
          const was = prevRow ? matchesFilters(cBefore, prevRow, t.filters) : false;
          if (now && !was) hits.push(rowId);
        }
      }
      for (const rowId of hits) await this.runOne(baseId, auto, rowId, batch.txn);
    }
  }

  private async runOne(baseId: string, auto: Automation, rowId: string, txn: number): Promise<RunResult> {
    const db = await getDb();
    let status: RunResult["status"] = "success";
    let message: string;
    let runTxn: number | null = txn;
    try {
      const state = await this.getState(baseId);
      if (!state?.rows[rowId]) throw new Error("The trigger record no longer exists");
      const plan = planSteps(state, auto, state.rows[rowId]);
      if (plan.problems.length) throw new Error(plan.problems.join("; "));
      if (plan.actions.length === 0 && plan.emails.length === 0) throw new Error("Nothing to do");
      if (plan.actions.length) {
        // Create any select options the steps need first.
        const batch = await this.apply(baseId, { clientId: null, requestId: null, actions: [...plan.fieldUpdates, ...plan.actions], actor: `Automation “${auto.name}”` }, "automation");
        runTxn = batch.txn;
      }
      const parts = [];
      if (plan.actions.length) parts.push(`${plan.actions.length} record change${plan.actions.length === 1 ? "" : "s"}`);
      let sent = 0;
      for (const mail of plan.emails) {
        if (!takeEmailBudget(baseId, mail.to.length)) {
          status = "failed";
          parts.push(`stopped: more than ${EMAILS_PER_HOUR} automation emails this hour`);
          break;
        }
        await sendMail({ to: mail.to.join(", "), subject: mail.subject, text: mail.text + automationFooter(auto.name) });
        sent += mail.to.length;
      }
      if (plan.emails.length) parts.push(`emailed ${sent} ${sent === 1 ? "person" : "people"}`);
      message = `${parts.join(", ")} for record ${rowId}`;
    } catch (e) {
      status = "failed";
      message = e instanceof Error ? e.message : String(e);
    }
    await db.query(
      "insert into automation_runs (base_id, automation_id, txn, status, message) values ($1, $2, $3, $4, $5)",
      [baseId, auto.id, runTxn, status, message],
    );
    return { status, message };
  }

  /** Run a saved automation once on one record, whatever its trigger says ("Run now" in the editor). */
  async runNow(baseId: string, automationId: string, rowId: string): Promise<RunResult> {
    const state = await this.getState(baseId);
    const auto = state?.automations[automationId];
    if (!auto) throw new ValidationError("Save the automation first");
    const row = state!.rows[rowId];
    if (!row || row.tableId !== auto.trigger.tableId) throw new ValidationError("Pick a record from the trigger's table");
    return this.runOne(baseId, auto, rowId, state!.base.txn);
  }
}

export type RunResult = { status: "success" | "failed"; message: string };

/** How long deleted records can be restored (and keep their files). */
export const DELETED_DAYS = 30;

const isAttachmentList = (v: unknown): v is Attachment[] =>
  Array.isArray(v) && v.length > 0 && v.every((a) => a && typeof a === "object" && typeof (a as Attachment).id === "string" && typeof (a as Attachment).url === "string");

/** Automation emails per base per hour, so a busy or careless automation can't flood inboxes. */
export const EMAILS_PER_HOUR = Number(process.env.GRIDBASE_AUTOMATION_EMAILS_PER_HOUR ?? 100);
const emailBudget = new Map<string, { windowStart: number; used: number }>();
function takeEmailBudget(baseId: string, count: number): boolean {
  const now = Date.now();
  let b = emailBudget.get(baseId);
  if (!b || now - b.windowStart > 3600_000) emailBudget.set(baseId, (b = { windowStart: now, used: 0 }));
  if (b.used + count > EMAILS_PER_HOUR) return false;
  b.used += count;
  return true;
}

function automationFooter(name: string): string {
  return `\n\n—\nSent by the gridbase automation “${oneLine(name, 80)}”.\n`;
}

const SAVE_CHUNK = 500;

async function persistDiff(q: Queryable, baseId: string, before: BaseState, after: BaseState) {
  for (const [key, table] of COLLECTIONS) {
    const a = before[key] as Record<string, unknown>;
    const b = after[key] as Record<string, unknown>;
    if (a === b) continue;
    const changed = Object.keys(b).filter((id) => a[id] !== b[id]);
    const removed = Object.keys(a).filter((id) => !(id in b));
    // Many rows at a time (imports, big deletes) go in a few statements, not one per row.
    for (let i = 0; i < changed.length; i += SAVE_CHUNK) {
      const ids = changed.slice(i, i + SAVE_CHUNK);
      await q.query(
        `insert into ${table} (id, base_id, data)
           select x.id, $2, x.data::jsonb from unnest($1::text[], $3::text[]) as x(id, data)
           on conflict (id) do update set data = excluded.data`,
        [ids, baseId, ids.map((id) => JSON.stringify(b[id]))],
      );
    }
    for (let i = 0; i < removed.length; i += SAVE_CHUNK) {
      await q.query(`delete from ${table} where id = any($1::text[])`, [removed.slice(i, i + SAVE_CHUNK)]);
    }
  }
  if (before.tableOrder !== after.tableOrder) {
    await q.query(
      "insert into base_meta (base_id, table_order) values ($1, $2::jsonb) on conflict (base_id) do update set table_order = excluded.table_order",
      [baseId, JSON.stringify(after.tableOrder)],
    );
  }
}

// One engine per process, shared through globalThis.
const g = globalThis as { __gridbaseEngine?: Engine };
export function getEngine(): Engine {
  return (g.__gridbaseEngine ??= new Engine());
}

export { ValidationError };
