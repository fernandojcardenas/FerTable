// The sync engine: keeps each base in memory, applies action batches under a
// per-base lock, saves what changed to Postgres, logs the transaction and
// broadcasts it to every connected client. Then it runs automations.

import type { Action, ActionBatch, Attachment, Automation, AutomationStep, BaseState, CellValue, Field, People, Role, Row, ServerMessage, View } from "../shared/types";
import { applyActions, emptyBase, ValidationError } from "../shared/reducer";
import { Computer, CellError } from "../shared/compute";
import { matchesFilters, viewRows } from "../shared/query";
import { emailStep, fillTemplate, lastScheduledTime, linkedRecords, MAX_LOOP_ITEMS, postPayload, recordStepActions, templateRefs, type RunContext } from "../shared/automation";
import { connectionUrl, safePost } from "./connections";
import { runScript } from "./script";
import { isComputed } from "../shared/fieldTypes";
import { generateCell, type AiResult } from "./ai";
import { checkSubmission, PUBLIC_TOKEN_RE } from "../shared/publicForm";
import { oneLine, sendMail } from "./mail";
import { starterTableActions } from "../shared/starter";
import { rowHistory, type DeletedSnapshot } from "../shared/activity";
import { newId } from "../shared/ids";
import { getDb, type Queryable } from "./db";
import { deliverWebhooks } from "./webhooks";
import { buildSync, sourceLabel } from "../shared/sync";
import { roleFor } from "./auth";

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
    deliverWebhooks(baseId, result.before, result.after, result.batch, () => this.people(baseId)).catch((e) => console.error("webhook error", e));
    this.scheduleSyncsFrom(baseId);
    if (source === "client" || source === "api") {
      // Automations run after the lock is released, as their own transactions.
      this.runAutomations(baseId, result.before, result.after, result.batch).catch((e) => console.error("automation error", e));
    }
    if (!req.actions.every((a) => a.type === "ai.set")) this.scheduleAi(baseId, result.before, result.after);
    return result.batch;
  }

  // ---- AI fields ----

  private aiQueue: { baseId: string; rowId: string; fieldId: string }[] = [];
  private aiQueued = new Set<string>();
  private aiRunning = 0;
  private aiUsage = new Map<string, { windowStart: number; used: number }>();

  /** Queue AI cells whose prompt inputs changed (new records, edited fields, or a new/edited prompt). */
  private scheduleAi(baseId: string, before: BaseState, after: BaseState) {
    for (const f of Object.values(after.fields)) {
      if (f.type !== "ai" || !f.options.prompt?.trim()) continue;
      const prev = before.fields[f.id];
      const promptChanged = !prev || prev.type !== "ai" || prev.options.prompt !== f.options.prompt;
      if (!promptChanged && before.rows === after.rows) continue;
      const refs = templateRefs(f.options.prompt);
      let queued = 0;
      for (const rowId of after.tables[f.tableId]?.rowOrder ?? []) {
        const now = after.rows[rowId];
        const was = before.rows[rowId];
        if (!now) continue;
        const changed = promptChanged || !was || refs.some((r) => JSON.stringify(was.cells[r] ?? null) !== JSON.stringify(now.cells[r] ?? null));
        if (!changed) continue;
        // A new prompt on a big table fills the first rows; Regenerate does the rest.
        if (promptChanged && queued >= AI_AUTO_ROWS) break;
        this.enqueueAi(baseId, rowId, f.id);
        queued++;
      }
    }
  }

  /** Fill AI cells now (the "Generate" button). Returns how many were queued. */
  queueAiField(baseId: string, state: BaseState, fieldId: string, rowIds?: string[]): number {
    const f = state.fields[fieldId];
    if (!f || f.type !== "ai") throw new ValidationError("Not an AI field");
    const ids = (rowIds?.length ? rowIds : state.tables[f.tableId]?.rowOrder ?? []).filter((id) => state.rows[id]?.tableId === f.tableId).slice(0, 2000);
    ids.forEach((id) => this.enqueueAi(baseId, id, fieldId));
    return ids.length;
  }

  private enqueueAi(baseId: string, rowId: string, fieldId: string) {
    const key = `${baseId}|${rowId}|${fieldId}`;
    if (this.aiQueued.has(key)) return;
    this.aiQueued.add(key);
    this.aiQueue.push({ baseId, rowId, fieldId });
    this.pumpAi();
  }

  private pumpAi() {
    while (this.aiRunning < AI_CONCURRENCY && this.aiQueue.length) {
      const job = this.aiQueue.shift()!;
      this.aiQueued.delete(`${job.baseId}|${job.rowId}|${job.fieldId}`);
      this.aiRunning++;
      this.runAiJob(job).catch((e) => console.error("AI field error", e)).finally(() => { this.aiRunning--; this.pumpAi(); });
    }
  }

  private async runAiJob({ baseId, rowId, fieldId }: { baseId: string; rowId: string; fieldId: string }) {
    const state = await this.getState(baseId);
    const row = state?.rows[rowId];
    const field = state?.fields[fieldId];
    if (!state || !row || !field || field.type !== "ai") return;
    const prompt = fillTemplate(state, row, field.options.prompt ?? "");
    let result: AiResult;
    const now = Date.now();
    let u = this.aiUsage.get(baseId);
    if (!u || now - u.windowStart > 3600_000) this.aiUsage.set(baseId, (u = { windowStart: now, used: 0 }));
    if (u.used >= AI_PER_HOUR) result = { error: `This base reached its limit of ${AI_PER_HOUR} AI answers this hour` };
    else { u.used++; result = await generateCell(prompt); }
    // The record may have changed or gone while we waited.
    const latest = (await this.getState(baseId))?.rows[rowId];
    if (!latest) return;
    const current = typeof latest.cells[fieldId] === "string" ? (latest.cells[fieldId] as string) : null;
    const action: Action = "text" in result
      ? { type: "ai.set", rowId, fieldId, value: result.text.slice(0, 100_000) }
      : { type: "ai.set", rowId, fieldId, value: current, error: result.error };
    await this.apply(baseId, { clientId: null, requestId: null, actions: [action], actor: "AI" }, "automation");
  }

  private async applyLocked(baseId: string, req: ApplyRequest, source: ActionBatch["source"]) {
    const before = await this.getState(baseId);
    if (!before) throw new ValidationError("Base not found");
    if (!Array.isArray(req.actions) || req.actions.length === 0) throw new ValidationError("No actions");
    if (req.actions.length > 5000) throw new ValidationError("Too many actions in one request");

    // Only the server writes AI results.
    if (source === "client" || source === "api") {
      if (req.actions.some((a) => a.type === "ai.set")) throw new ValidationError("AI fields are filled in by the server");
      if (req.actions.some((a) => a.type === "sync.apply" || (a.type === "table.create" && a.sync))) throw new ValidationError("Synced tables are set up and filled in by the server");
    }
    await this.checkPeople(baseId, before, req.actions);

    const at = new Date().toISOString();
    // The server decides creation times.
    const actions = req.actions.map((a): Action => (a.type === "row.create" ? { ...a, createdAt: at } : a));
    let after = applyActions(before, actions, at, req.userId ?? null);
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

  /** User fields may only name people who are members of this base. */
  private async checkPeople(baseId: string, state: BaseState, actions: Action[]) {
    const ids = new Set<string>();
    const collect = (cells: Record<string, CellValue> | undefined) => {
      for (const [fid, v] of Object.entries(cells ?? {})) {
        if (state.fields[fid]?.type !== "user" || v === null) continue;
        for (const id of Array.isArray(v) ? v : [v]) if (typeof id === "string") ids.add(id);
      }
    };
    for (const a of actions) if (a.type === "row.create" || a.type === "row.update") collect(a.cells);
    if (!ids.size) return;
    const db = await getDb();
    const { rows } = await db.query<{ user_id: string }>("select user_id from base_members where base_id = $1 and user_id = any($2::text[])", [baseId, [...ids]]);
    if (rows.length !== ids.size) throw new ValidationError("A user field can only name people in this base");
  }

  /** Members' names, for showing user fields and "last modified by". */
  async people(baseId: string): Promise<People> {
    const db = await getDb();
    const { rows } = await db.query<{ id: string; name: string; email: string }>(
      "select u.id, u.name, u.email from base_members m join users u on u.id = m.user_id where m.base_id = $1", [baseId],
    );
    return Object.fromEntries(rows.map((r) => [r.id, { name: r.name, email: r.email }]));
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
      actions: [{ type: "row.create", rowId: newId("rec"), tableId: found.view.tableId, cells, formViewId: found.view.id }],
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
    const autos = Object.values(after.automations).filter((a) => a.enabled && a.trigger.type !== "schedule");
    if (autos.length === 0) return;
    const created = new Set<string>();
    const viaForm = new Map<string, string>();
    const updated = new Map<string, Set<string>>();
    for (const a of batch.actions) {
      if (a.type === "row.create") {
        created.add(a.rowId);
        if (a.formViewId) viaForm.set(a.rowId, a.formViewId);
      }
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
    /** Started matching these filters with this change (new records count as not matching before). */
    const entered = (rowId: string, filters: Parameters<typeof matchesFilters>[2]) => {
      const row = after.rows[rowId];
      const prev = before.rows[rowId];
      return matchesFilters(cAfter, row, filters) && !(prev && matchesFilters(cBefore, prev, filters));
    };

    for (const auto of autos) {
      const t = auto.trigger;
      const hits: string[] = [];
      for (const rowId of new Set([...created, ...updated.keys()])) {
        const row = after.rows[rowId];
        if (!row || row.tableId !== t.tableId) continue;
        if (t.type === "recordCreated" && created.has(rowId)) hits.push(rowId);
        if (t.type === "recordUpdated" && updated.has(rowId) && !created.has(rowId)) {
          const changed = updated.get(rowId)!;
          if (t.watchFieldIds.length === 0 || t.watchFieldIds.some((f) => changed.has(f))) hits.push(rowId);
        }
        if (t.type === "recordMatches" && entered(rowId, t.filters)) hits.push(rowId);
        if (t.type === "formSubmitted" && viaForm.has(rowId) && (t.viewId === null || viaForm.get(rowId) === t.viewId)) hits.push(rowId);
        if (t.type === "enteredView" && after.views[t.viewId] && entered(rowId, after.views[t.viewId].config.filters)) hits.push(rowId);
      }
      for (const rowId of hits) await this.runOne(baseId, auto, rowId, batch.txn);
    }
  }

  /** Run an automation's steps for one record (or none, for a schedule without a view) and log the run. */
  private async runOne(baseId: string, auto: Automation, rowId: string | null, txn: number): Promise<RunResult> {
    const db = await getDb();
    const run: RunState = { steps: 0, records: 0, emailed: 0, posts: 0, scripts: 0, logs: [], txn };
    let status: RunResult["status"] = "success";
    let error = "";
    try {
      const state = await this.getState(baseId);
      if (rowId && !state?.rows[rowId]) throw new Error("The trigger record no longer exists");
      await this.execSteps(baseId, auto, auto.steps, { triggerId: rowId, currentId: rowId }, run, "");
    } catch (e) {
      status = "failed";
      error = e instanceof Error ? e.message : String(e);
    }
    const done = [
      run.records && `${run.records} record change${run.records === 1 ? "" : "s"}`,
      run.emailed && `emailed ${run.emailed} ${run.emailed === 1 ? "person" : "people"}`,
      run.posts && `${run.posts} message${run.posts === 1 ? "" : "s"} sent`,
      run.scripts && `${run.scripts} script${run.scripts === 1 ? "" : "s"} run`,
    ].filter(Boolean).join(", ");
    const where = rowId ? ` for record ${rowId}` : "";
    const message = (status === "failed" ? `${error}${done ? ` (after ${done})` : ""}` : `${done || "Nothing to do"}${where}`)
      + (run.logs.length ? `\n${run.logs.join("\n")}`.slice(0, 2000) : "");
    await db.query(
      "insert into automation_runs (base_id, automation_id, txn, status, message) values ($1, $2, $3, $4, $5)",
      [baseId, auto.id, run.txn, status, message],
    );
    return { status, message };
  }

  /** Run steps in order. Each step sees the base as the steps before it left it. */
  private async execSteps(baseId: string, auto: Automation, steps: AutomationStep[], ids: { triggerId: string | null; currentId: string | null }, run: RunState, label: string): Promise<void> {
    for (const [i, step] of steps.entries()) {
      const where = `Step ${label}${i + 1}`;
      if (++run.steps > MAX_RUN_STEPS) throw new Error(`Stopped after ${MAX_RUN_STEPS} steps in one run`);
      const state = await this.getState(baseId);
      if (!state) throw new Error("The base is gone");
      const ctx: RunContext = { trigger: ids.triggerId ? state.rows[ids.triggerId] ?? null : null, current: ids.currentId ? state.rows[ids.currentId] ?? null : null };
      const actor = `Automation “${auto.name}”`;
      const applyRecordStep = async (s: Extract<AutomationStep, { type: "updateRecord" | "createRecord" }>) => {
        const r = recordStepActions(state, s, ctx);
        if (!r.action) throw new Error(`${where}: there's no record to update`);
        const batch = await this.apply(baseId, { clientId: null, requestId: null, actions: [...r.fieldUpdates, r.action], actor }, "automation");
        run.txn = batch.txn;
        run.records++;
      };
      switch (step.type) {
        case "updateRecord":
        case "createRecord":
          await applyRecordStep(step);
          break;
        case "sendEmail": {
          const r = emailStep(state, auto.name, step, ctx);
          if (!r.email) throw new Error(`${where}: ${r.problem}`);
          if (!takeBudget(emailBudget, baseId, r.email.to.length, EMAILS_PER_HOUR)) throw new Error(`${where}: more than ${EMAILS_PER_HOUR} automation emails this hour`);
          await sendMail({ to: r.email.to.join(", "), subject: r.email.subject, text: r.email.text + automationFooter(auto.name) });
          run.emailed += r.email.to.length;
          break;
        }
        case "condition": {
          if (!ctx.current) throw new Error(`${where}: there's no record to check`);
          const yes = matchesFilters(new Computer(state), ctx.current, step.filters);
          await this.execSteps(baseId, auto, yes ? step.then : step.otherwise, ids, run, `${label}${i + 1}.`);
          break;
        }
        case "forEach": {
          const list = linkedRecords(state, ctx.current, step.linkFieldId).slice(0, MAX_LOOP_ITEMS);
          for (const r of list) await this.execSteps(baseId, auto, step.steps, { triggerId: ids.triggerId, currentId: r.id }, run, `${label}${i + 1}.`);
          break;
        }
        case "script": {
          const asObject = (row: Row | null) => {
            if (!row) return null;
            const c = new Computer(state);
            const out: Record<string, unknown> = { id: row.id };
            for (const fid of state.tables[row.tableId]?.fieldOrder ?? []) {
              const f = state.fields[fid];
              if (!f) continue;
              const v = c.value(row, f);
              out[f.name] = v instanceof CellError ? null : v;
            }
            return out;
          };
          const result = await runScript(step.code, asObject(ctx.current), asObject(ctx.trigger));
          run.scripts++;
          if (result.log) run.logs.push(`${where} log: ${result.log}`);
          if (!result.ok) throw new Error(`${where}: ${result.error}`);
          if (result.updates && Object.keys(result.updates).length) {
            if (!ctx.current) throw new Error(`${where}: the script returned changes but there's no record to update`);
            const fields = (state.tables[ctx.current.tableId]?.fieldOrder ?? []).map((id) => state.fields[id]).filter(Boolean);
            const values: Record<string, string> = {};
            for (const [name, v] of Object.entries(result.updates)) {
              const f = fields.find((x) => x.name === name) ?? fields.find((x) => x.name.toLowerCase() === name.toLowerCase());
              if (!f) throw new Error(`${where}: the script set "${name}", but there's no such field`);
              if (isComputed(f.type)) throw new Error(`${where}: "${f.name}" is computed and can't be set`);
              values[f.id] = v === null || v === undefined ? "" : Array.isArray(v) ? v.join(", ") : String(v);
            }
            await applyRecordStep({ type: "updateRecord", values });
          }
          break;
        }
        case "slack":
        case "sheets":
        case "webhook": {
          const conn = await connectionUrl(baseId, step.connectionId);
          if (!conn) throw new Error(`${where}: its connection was deleted`);
          if (step.type !== "webhook" && conn.kind !== step.type) throw new Error(`${where}: that connection isn't a ${step.type === "slack" ? "Slack" : "Google Sheets"} connection`);
          if (!takeBudget(postBudget, baseId, 1, POSTS_PER_HOUR)) throw new Error(`${where}: more than ${POSTS_PER_HOUR} automation messages this hour`);
          let status = 0;
          try {
            status = (await safePost(conn.url, postPayload(state, step, ctx))).status;
          } catch (e) {
            throw new Error(`${where}: couldn't reach ${new URL(conn.url).hostname} (${e instanceof Error ? e.message : String(e)})`);
          }
          // Apps Script web apps answer a POST with a redirect to the result.
          if (status >= 400 || (status >= 300 && conn.kind !== "sheets")) throw new Error(`${where}: ${new URL(conn.url).hostname} answered ${status}`);
          run.posts++;
          break;
        }
      }
    }
  }

  /** Run a saved automation once now ("Run now" in the editor, or a button). Schedules without a view take no record. */
  async runNow(baseId: string, automationId: string, rowId: string | null): Promise<RunResult> {
    const state = await this.getState(baseId);
    const auto = state?.automations[automationId];
    if (!auto) throw new ValidationError("Save the automation first");
    const noRecord = auto.trigger.type === "schedule" && !auto.trigger.viewId;
    if (noRecord) return this.runOne(baseId, auto, null, state!.base.txn);
    const row = rowId ? state!.rows[rowId] : undefined;
    if (!row || row.tableId !== auto.trigger.tableId) throw new ValidationError("Pick a record from the trigger's table");
    return this.runOne(baseId, auto, rowId, state!.base.txn);
  }

  // ---- synced tables ----

  private syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private syncing = new Map<string, Promise<void>>();

  /** Copy a view from another base into a new synced table here. Needs editor access to the source base. */
  async createSyncedTable(targetBaseId: string, userId: string, sourceBaseId: unknown, sourceViewId: unknown): Promise<string> {
    if (typeof sourceBaseId !== "string" || typeof sourceViewId !== "string") throw new ValidationError("Pick a base and a view to sync");
    const role = await roleFor(userId, sourceBaseId);
    if (!role) throw new ValidationError("Base not found");
    if (role !== "owner" && role !== "editor") throw new ValidationError("You need editor access to a base to sync its data elsewhere");
    const source = await this.getState(sourceBaseId);
    const view = source?.views[sourceViewId];
    if (!source || !view) throw new ValidationError("That view no longer exists");
    if (view.type !== "grid") throw new ValidationError("Only grid views can be synced");
    const target = await this.getState(targetBaseId);
    if (!target) throw new ValidationError("Base not found");
    const base = source.tables[view.tableId].name;
    let name = base;
    for (let n = 2; Object.values(target.tables).some((t) => t.name.toLowerCase() === name.toLowerCase()); n++) name = `${base} (${n})`;
    const tableId = newId("tbl");
    await this.apply(targetBaseId, {
      clientId: null, requestId: null, userId, actor: "Sync",
      actions: [{ type: "table.create", tableId, name, primaryFieldId: newId("fld"), viewId: newId("viw"),
        sync: { sourceBaseId, sourceTableId: view.tableId, sourceViewId, sourceLabel: sourceLabel(source, view), createdBy: userId, lastSyncAt: null, error: null } }],
    }, "sync");
    await this.runSync(targetBaseId, tableId);
    return tableId;
  }

  /** Bring one synced table up to date (one run at a time per table; a request during a run runs once more after). */
  runSync(targetBaseId: string, tableId: string): Promise<void> {
    const key = `${targetBaseId}:${tableId}`;
    const prev = this.syncing.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.syncOnce(targetBaseId, tableId));
    this.syncing.set(key, next);
    void next.finally(() => { if (this.syncing.get(key) === next) this.syncing.delete(key); }).catch(() => {});
    return next;
  }

  private async syncOnce(targetBaseId: string, tableId: string) {
    const target = await this.getState(targetBaseId);
    const t = target?.tables[tableId];
    if (!target || !t?.sync) return;
    const cfg = t.sync;
    let error: string | null = null;
    const role = await roleFor(cfg.createdBy, cfg.sourceBaseId);
    const raw = role ? await this.getState(cfg.sourceBaseId) : null;
    const view = raw?.views[cfg.sourceViewId];
    if (!role) error = "The person who set up this sync can no longer open the source base";
    else if (role !== "owner" && role !== "editor") error = "The person who set up this sync no longer has editor access to the source base";
    else if (!raw) error = "The source base was deleted";
    else if (!view || view.tableId !== cfg.sourceTableId) error = "The source view was deleted";
    let action: Action | null;
    if (error) {
      if (t.sync.error === error) return;
      action = { type: "sync.apply", tableId, fields: [], removeFieldIds: [], upserts: [], deleteRowIds: [], sourceLabel: cfg.sourceLabel, error };
    } else {
      const source = { ...raw!, people: await this.people(cfg.sourceBaseId) };
      action = buildSync(source, view!, target, t);
    }
    if (!action) return;
    try {
      await this.apply(targetBaseId, { clientId: null, requestId: null, actions: [action], actor: "Sync" }, "sync");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.apply(targetBaseId, { clientId: null, requestId: null, actor: "Sync",
        actions: [{ type: "sync.apply", tableId, fields: [], removeFieldIds: [], upserts: [], deleteRowIds: [], sourceLabel: cfg.sourceLabel, error: `Couldn't sync: ${msg}` }] }, "sync").catch(() => {});
    }
  }

  /** After a change to a base, refresh the tables that sync from it (batched over a couple of seconds). */
  scheduleSyncsFrom(sourceBaseId: string) {
    if (this.syncTimers.has(sourceBaseId)) return;
    const timer = setTimeout(() => {
      this.syncTimers.delete(sourceBaseId);
      void this.syncTablesFrom(sourceBaseId).catch((e) => console.error("sync error", e));
    }, Number(process.env.GRIDBASE_SYNC_DELAY_MS ?? 2000));
    timer.unref?.();
    this.syncTimers.set(sourceBaseId, timer);
  }

  async syncTablesFrom(sourceBaseId: string | null): Promise<number> {
    const db = await getDb();
    const { rows } = await db.query<{ base_id: string; id: string }>(
      sourceBaseId
        ? "select base_id, id from tables_ where data->'sync'->>'sourceBaseId' = $1"
        : "select base_id, id from tables_ where data ? 'sync'",
      sourceBaseId ? [sourceBaseId] : [],
    );
    for (const r of rows) await this.runSync(r.base_id, r.id);
    return rows.length;
  }

  /** Bases (other than this one) the user can sync from, with their grid views. */
  async syncSources(userId: string, exceptBaseId: string) {
    const out = [];
    for (const b of await this.listBases(userId)) {
      if (b.id === exceptBaseId || (b.role !== "owner" && b.role !== "editor")) continue;
      const s = await this.getState(b.id);
      if (!s) continue;
      out.push({ id: b.id, name: s.base.name, tables: s.tableOrder.map((id) => s.tables[id]).filter((t) => !t.sync).map((t) => ({
        id: t.id, name: t.name, views: t.viewOrder.map((v) => s.views[v]).filter((v) => v?.type === "grid").map((v) => ({ id: v.id, name: v.name })),
      })) });
    }
    return out;
  }

  // ---- scheduled automations ----

  private scheduler: ReturnType<typeof setInterval> | null = null;

  /** Check scheduled automations every minute. */
  startScheduler() {
    if (this.scheduler) return;
    this.scheduler = setInterval(() => void this.runSchedules().catch((e) => console.error("schedule error", e)), 60_000);
    setTimeout(() => void this.runSchedules().catch((e) => console.error("schedule error", e)), 5_000);
    // Synced tables also refresh every 15 minutes, which catches lost access and missed changes.
    setInterval(() => void this.syncTablesFrom(null).catch((e) => console.error("sync error", e)), 15 * 60_000).unref?.();
  }

  /** Run schedules that came due since their last run. A new schedule waits for its first due time. */
  async runSchedules(now = new Date()): Promise<number> {
    const db = await getDb();
    const { rows } = await db.query<{ base_id: string; data: Automation }>(
      "select base_id, data from automations where data->'trigger'->>'type' = 'schedule' and (data->>'enabled')::boolean",
    );
    let ran = 0;
    for (const { base_id: baseId, data: auto } of rows) {
      if (auto.trigger.type !== "schedule") continue;
      const due = lastScheduledTime(auto.trigger, now);
      const { rows: seen } = await db.query<{ last_run: string }>("select last_run from automation_schedule where automation_id = $1", [auto.id]);
      if (!seen[0]) {
        await db.query("insert into automation_schedule (automation_id, base_id, last_run) values ($1, $2, $3) on conflict do nothing", [auto.id, baseId, now.toISOString()]);
        continue;
      }
      if (new Date(seen[0].last_run) >= due) continue;
      await db.query("update automation_schedule set last_run = $2 where automation_id = $1", [auto.id, now.toISOString()]);
      const state = await this.getState(baseId);
      const live = state?.automations[auto.id];
      if (!state || !live?.enabled || live.trigger.type !== "schedule") continue;
      ran++;
      if (live.trigger.viewId && state.views[live.trigger.viewId]) {
        const list = viewRows(new Computer(state, now), state, state.views[live.trigger.viewId]).slice(0, MAX_LOOP_ITEMS);
        for (const r of list) await this.runOne(baseId, live, r.id, state.base.txn);
      } else if (!live.trigger.viewId) {
        await this.runOne(baseId, live, null, state.base.txn);
      }
    }
    return ran;
  }
}

type RunState = { steps: number; records: number; emailed: number; posts: number; scripts: number; logs: string[]; txn: number };
const MAX_RUN_STEPS = 200;

export type RunResult = { status: "success" | "failed"; message: string };

/** AI field limits: answers at once, answers per base per hour, rows filled automatically when a prompt changes. */
const AI_CONCURRENCY = Number(process.env.GRIDBASE_AI_CONCURRENCY ?? 2);
const AI_PER_HOUR = Number(process.env.GRIDBASE_AI_PER_HOUR ?? 500);
const AI_AUTO_ROWS = 200;

/** How long deleted records can be restored (and keep their files). */
export const DELETED_DAYS = 30;

const isAttachmentList = (v: unknown): v is Attachment[] =>
  Array.isArray(v) && v.length > 0 && v.every((a) => a && typeof a === "object" && typeof (a as Attachment).id === "string" && typeof (a as Attachment).url === "string");

/** Automation emails per base per hour, so a busy or careless automation can't flood inboxes. */
export const EMAILS_PER_HOUR = Number(process.env.GRIDBASE_AUTOMATION_EMAILS_PER_HOUR ?? 100);
/** Slack, Sheets and webhook messages per base per hour. */
export const POSTS_PER_HOUR = Number(process.env.GRIDBASE_AUTOMATION_POSTS_PER_HOUR ?? 300);
type Budget = Map<string, { windowStart: number; used: number }>;
const emailBudget: Budget = new Map();
const postBudget: Budget = new Map();
function takeBudget(budget: Budget, baseId: string, count: number, perHour: number): boolean {
  const now = Date.now();
  let b = budget.get(baseId);
  if (!b || now - b.windowStart > 3600_000) budget.set(baseId, (b = { windowStart: now, used: 0 }));
  if (b.used + count > perHour) return false;
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
