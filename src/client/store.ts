"use client";

// Browser side of sync. The screen shows `confirmed state + pending actions`:
// edits appear instantly, are sent to the server in order, and are dropped
// from the pending list once the server's broadcast of them arrives.

import type { Action, ActionBatch, BaseState, RestorePatch, Role, ServerMessage } from "@/shared/types";
import { applyAction, applyActions } from "@/shared/reducer";
import { describeActions, inversePatch, isEmptyPatch } from "@/shared/history";
import { Computer } from "@/shared/compute";
import { newId } from "@/shared/ids";

type Pending = { requestId: string; actions: Action[]; sent: boolean; ackTxn: number | null };

/** One undo step. Several patches when edits were grouped (e.g. one cell edit saved while typing). */
type HistoryEntry = { label: string; patches: RestorePatch[]; key?: string; at: number };

export type DispatchOptions = {
  /** Merge into the previous undo step when it has the same key (and is recent, if windowMs is set). */
  coalesce?: { key: string; windowMs?: number };
};

const MAX_HISTORY = 100;
const MAX_SAVED_HISTORY_BYTES = 2_000_000;

export type ConnectionStatus = "connecting" | "live" | "offline" | "revoked";

export type ClientSnapshot = {
  state: BaseState;
  computer: Computer;
  status: ConnectionStatus;
  saving: boolean;
  error: string | null;
  notice: string | null;
  undoLabel: string | null;
  redoLabel: string | null;
  role: Role;
  /** Number of comments per record, kept live. */
  commentCounts: Record<string, number>;
  version: number;
};

export type CommentEvent = Extract<ServerMessage, { type: "comment" }>;

export class BaseClient {
  readonly clientId = newId("cli");
  private confirmed: BaseState;
  private pending: Pending[] = [];
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = "connecting";
  private error: string | null = null;
  private snapshot: ClientSnapshot;
  private version = 0;
  private sending = false;
  private retryDelay = 500;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private errorTimer: ReturnType<typeof setTimeout> | null = null;
  private notice: string | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private historySaveTimer: ReturnType<typeof setTimeout> | null = null;
  private commentCounts: Record<string, number> = {};
  private commentListeners = new Set<(e: CommentEvent) => void>();

  private role: Role;

  /** `me` is the signed-in user, stamped as "last modified by" on our own edits right away. */
  constructor(private baseId: string, initial: BaseState, role: Role = "editor", private me: string | null = null) {
    this.role = role;
    this.confirmed = initial;
    this.loadHistory();
    this.snapshot = this.build();
    // Save history before the page goes away (e.g. a reload right after an edit).
    window.addEventListener("pagehide", this.flushHistory);
    this.connect(); // counts load when the socket says hello
  }

  // ---- React store API ----
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snapshot;

  private build(): ClientSnapshot {
    let state = this.confirmed;
    const at = new Date().toISOString();
    for (const p of this.pending) {
      try {
        state = applyActions(state, p.actions, at, this.me);
      } catch {
        // Something in this batch no longer applies: keep the parts that still do.
        for (const a of p.actions) {
          try {
            state = applyAction(state, a, at, this.me);
          } catch {
            /* skipped; the server will reject it */
          }
        }
      }
    }
    return {
      state,
      computer: new Computer(state),
      status: this.status,
      saving: this.pending.length > 0,
      error: this.error,
      notice: this.notice,
      undoLabel: this.undoStack.at(-1)?.label ?? null,
      redoLabel: this.redoStack.at(-1)?.label ?? null,
      role: this.role,
      commentCounts: this.commentCounts,
      version: ++this.version,
    };
  }

  private emit() {
    this.snapshot = this.build();
    for (const l of this.listeners) l();
  }

  private setError(message: string | null) {
    this.error = message;
    if (this.errorTimer) clearTimeout(this.errorTimer);
    if (message) this.errorTimer = setTimeout(() => this.setError(null), 6000);
    this.emit();
  }

  private setNotice(message: string) {
    this.notice = message;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => { this.notice = null; this.emit(); }, 2500);
  }

  // ---- making changes ----

  /** Apply actions locally right away and queue them for the server. Returns false if they're invalid. */
  dispatch(...actions: Action[]): boolean {
    return this.dispatchWith({}, ...actions);
  }

  /** Viewers (and people whose access was removed) can look but not change anything. Shows why when not. */
  ensureCanEdit(): boolean {
    if (this.status === "revoked") { this.setError("You no longer have access to this base"); return false; }
    if (this.role === "viewer") { this.setError("You have view-only access to this base"); return false; }
    if (this.role === "commenter") { this.setError("You can comment on this base but not change it"); return false; }
    return true;
  }

  dispatchWith(opts: DispatchOptions, ...actions: Action[]): boolean {
    if (!this.ensureCanEdit()) return false;
    const result = this.tryApply(actions);
    if (!result) return false;
    this.record(result.before, result.after, actions, opts);
    this.redoStack = [];
    this.send(actions);
    return true;
  }

  /** Check actions against what's on screen so obvious mistakes never leave the browser. */
  private tryApply(actions: Action[]): { before: BaseState; after: BaseState } | null {
    if (actions.length === 0) return null;
    const before = this.snapshot.state;
    try {
      const after = applyActions(before, actions, new Date().toISOString(), this.me);
      return { before, after };
    } catch (e) {
      this.setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  private send(actions: Action[]) {
    this.pending.push({ requestId: newId("req"), actions, sent: false, ackTxn: null });
    this.emit();
    void this.flush();
  }

  private record(before: BaseState, after: BaseState, actions: Action[], opts: DispatchOptions) {
    const patch = inversePatch(before, after);
    if (isEmptyPatch(patch)) return;
    const top = this.undoStack.at(-1);
    const c = opts.coalesce;
    const now = Date.now();
    if (c && top?.key === c.key && (c.windowMs === undefined || now - top.at < c.windowMs)) {
      top.patches.push(patch);
      top.at = now;
      this.saveHistorySoon();
      return;
    }
    this.undoStack.push({ label: describeActions(actions), patches: [patch], key: c?.key, at: now });
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.saveHistorySoon();
  }

  /**
   * Undo your last change. Only your own edits are undone, cell by cell, so
   * other people's changes made since then are kept.
   */
  undo(): boolean {
    return this.step(this.undoStack, this.redoStack, "Undid");
  }

  redo(): boolean {
    return this.step(this.redoStack, this.undoStack, "Redid");
  }

  private step(from: HistoryEntry[], to: HistoryEntry[], verb: string): boolean {
    if (!from.length || !this.ensureCanEdit()) return false;
    const entry = from.pop();
    if (!entry) return false;
    // Grouped patches are undone newest first, in one request.
    const actions: Action[] = [...entry.patches].reverse().map((patch) => ({ type: "restore", patch }));
    const result = this.tryApply(actions);
    if (!result) {
      this.emit();
      return false;
    }
    const back = inversePatch(result.before, result.after);
    if (!isEmptyPatch(back)) to.push({ label: entry.label, patches: [back], at: Date.now() });
    this.saveHistorySoon();
    this.setNotice(`${verb} ${entry.label}`);
    this.send(actions);
    return true;
  }

  /** Send queued batches one at a time so the server sees them in order. */
  private async flush() {
    if (this.sending) return;
    const next = this.pending.find((p) => !p.sent);
    if (!next) return;
    this.sending = true;
    try {
      const res = await fetch(`/api/bases/${this.baseId}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: this.clientId, requestId: next.requestId, actions: next.actions }),
      });
      if (res.status === 401) {
        location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
        return;
      }
      if (res.status === 403 || res.status === 404) {
        // No longer allowed to edit: drop everything waiting to be sent.
        const { error } = await res.json().catch(() => ({ error: null }));
        this.pending = [];
        this.sending = false;
        this.setError(error ?? "You can't edit this base");
        return;
      }
      if (res.status === 422) {
        const { error } = await res.json();
        this.pending = this.pending.filter((p) => p !== next);
        this.setError(error ?? "That change was rejected");
      } else if (!res.ok) {
        throw new Error(`Server error ${res.status}`);
      } else {
        const { txn } = await res.json();
        next.sent = true;
        next.ackTxn = txn;
        if (this.confirmed.base.txn >= txn) this.dropPending(next.requestId);
        this.retryDelay = 500;
      }
    } catch {
      // Network trouble: keep the edit and try again shortly.
      this.sending = false;
      setTimeout(() => void this.flush(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 10_000);
      return;
    }
    this.sending = false;
    void this.flush();
  }

  private dropPending(requestId: string | null) {
    const before = this.pending.length;
    this.pending = this.pending.filter((p) => p.requestId !== requestId);
    if (this.pending.length !== before) this.emit();
  }

  // ---- receiving changes ----

  private connect() {
    if (this.closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/realtime?baseId=${this.baseId}&since=${this.confirmed.base.txn}`);
    this.ws = ws;
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data) as ServerMessage);
    ws.onopen = () => {
      this.retryDelay = 500;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: "ping" })), 15_000);
    };
    ws.onclose = () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.closed) return;
      this.status = "offline";
      this.emit();
      setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 10_000);
    };
  }

  private onMessage(msg: ServerMessage) {
    switch (msg.type) {
      case "hello":
        this.status = "live";
        this.emit();
        void this.loadCommentCounts();
        return;
      case "batch":
        this.receive(msg.batch);
        return;
      case "resync":
        void this.resync();
        return;
      case "comment": {
        const id = msg.comment.rowId;
        const delta = msg.event === "created" ? 1 : msg.event === "deleted" ? -1 : 0;
        if (delta) {
          const n = Math.max(0, (this.commentCounts[id] ?? 0) + delta);
          this.commentCounts = { ...this.commentCounts, [id]: n };
          this.emit();
        }
        for (const l of this.commentListeners) l(msg);
        return;
      }
      case "access":
        if (msg.role === null) {
          this.status = "revoked";
          this.closed = true;
          this.pending = [];
          this.ws?.close();
          this.setError("You no longer have access to this base");
        } else {
          this.role = msg.role;
          this.emit();
        }
        return;
    }
  }

  private receive(batch: ActionBatch) {
    const txn = this.confirmed.base.txn;
    if (batch.txn <= txn) return; // already have it
    if (batch.txn !== txn + 1) {
      void this.resync(); // missed something
      return;
    }
    let s = this.confirmed;
    try {
      s = applyActions(s, batch.actions, batch.at, batch.userId ?? null);
    } catch {
      void this.resync();
      return;
    }
    this.confirmed = { ...s, base: { ...s.base, txn: batch.txn } };
    // Our own edit came back: it's now part of confirmed state.
    if (batch.clientId === this.clientId) this.pending = this.pending.filter((p) => p.requestId !== batch.requestId);
    this.pending = this.pending.filter((p) => !(p.ackTxn !== null && p.ackTxn <= batch.txn));
    this.emit();
  }

  private async resync() {
    try {
      const res = await fetch(`/api/bases/${this.baseId}/snapshot`, { cache: "no-store" });
      if (!res.ok) throw new Error("Could not reload the base");
      this.confirmed = (await res.json()) as BaseState;
      this.pending = this.pending.filter((p) => !(p.ackTxn !== null && p.ackTxn <= this.confirmed.base.txn));
      this.emit();
      this.ws?.close(); // reconnect from the new txn
    } catch (e) {
      this.setError(e instanceof Error ? e.message : "Could not reload the base");
    }
  }

  // ---- comments ----

  get baseIdValue() {
    return this.baseId;
  }

  /** Can this person write comments (commenters and up)? */
  canComment(): boolean {
    return this.status !== "revoked" && this.role !== "viewer";
  }

  /** Listen for comments being added, edited or deleted anywhere in the base. */
  onComment(fn: (e: CommentEvent) => void): () => void {
    this.commentListeners.add(fn);
    return () => this.commentListeners.delete(fn);
  }

  private async loadCommentCounts() {
    try {
      const res = await fetch(`/api/bases/${this.baseId}/comment-counts`, { cache: "no-store" });
      if (!res.ok) return;
      this.commentCounts = (await res.json()).counts ?? {};
      this.emit();
    } catch {
      /* counts are a nicety; ignore failures */
    }
  }

  /** Comments made while the socket was down are picked up after reconnecting. */
  refreshCommentCounts() {
    void this.loadCommentCounts();
  }

  // ---- undo history that survives a reload (per tab: sessionStorage) ----

  private get historyKey() {
    return `gridbase:history:${this.baseId}`;
  }

  private loadHistory() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(this.historyKey) ?? "null");
      if (saved && Array.isArray(saved.undo) && Array.isArray(saved.redo)) {
        const valid = (e: HistoryEntry) => e && typeof e.label === "string" && Array.isArray(e.patches);
        this.undoStack = saved.undo.filter(valid);
        this.redoStack = saved.redo.filter(valid);
      }
    } catch {
      /* storage blocked or bad data: start with an empty history */
    }
  }

  private saveHistorySoon() {
    if (this.historySaveTimer) clearTimeout(this.historySaveTimer);
    this.historySaveTimer = setTimeout(() => this.saveHistory(), 300);
  }

  private saveHistory() {
    this.historySaveTimer = null;
    try {
      const undo = [...this.undoStack];
      const redo = [...this.redoStack];
      // Keep it small: drop the oldest steps until it fits.
      let json = JSON.stringify({ undo, redo });
      while (json.length > MAX_SAVED_HISTORY_BYTES && (undo.length || redo.length)) {
        if (undo.length) undo.shift();
        else redo.shift();
        json = JSON.stringify({ undo, redo });
      }
      sessionStorage.setItem(this.historyKey, json);
    } catch {
      /* storage full or blocked: history still works until the page reloads */
    }
  }

  private flushHistory = () => {
    if (!this.historySaveTimer) return;
    clearTimeout(this.historySaveTimer);
    this.saveHistory();
  };

  close() {
    this.flushHistory();
    window.removeEventListener("pagehide", this.flushHistory);
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
  }
}
