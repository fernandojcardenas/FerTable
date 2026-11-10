"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Comment, Role } from "@/shared/types";
import { restoreActions, type FieldChange, type HistoryKind } from "@/shared/activity";
import { splitMentions } from "@/shared/comments";
import { useBase } from "./common";
import { initials } from "./AccountMenu";

type Member = { userId: string; name: string; email: string; role: Role };

// Members are needed for @mentions; fetched once per base while the page is open.
const memberCache = new Map<string, Promise<{ members: Member[]; me: string }>>();
function loadMembers(baseId: string) {
  let p = memberCache.get(baseId);
  if (!p) {
    p = fetch(`/api/bases/${baseId}/members`, { cache: "no-store" }).then((r) => r.json()).then((d) => ({ members: d.members ?? [], me: d.me }));
    memberCache.set(baseId, p);
    p.catch(() => memberCache.delete(baseId));
  }
  return p;
}

function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Typed text uses "@Name"; stored text uses "@[usrId]". Longest names first so "Ana Lee" wins over "Ana". */
function toStored(text: string, chosen: Member[]): string {
  let out = text;
  for (const m of [...chosen].sort((a, b) => b.name.length - a.name.length)) out = out.split(`@${m.name}`).join(`@[${m.userId}]`);
  return out;
}
function toTyped(body: string, members: Member[]): { text: string; chosen: Member[] } {
  const chosen: Member[] = [];
  const text = body.replace(/@\[(usr[A-Za-z0-9]{14})\]/g, (_, id: string) => {
    const m = members.find((x) => x.userId === id);
    if (m && !chosen.includes(m)) chosen.push(m);
    return m ? `@${m.name}` : "@someone";
  });
  return { text, chosen };
}

/** A text box with @mention suggestions. */
function MentionInput({ value, onChange, members, onSubmit, placeholder, autoFocus }: {
  value: { text: string; chosen: Member[] }; onChange: (v: { text: string; chosen: Member[] }) => void;
  members: Member[]; onSubmit: () => void; placeholder: string; autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<{ start: number; text: string } | null>(null);
  const [active, setActive] = useState(0);
  const matches = useMemo(
    () => (query ? members.filter((m) => m.name.toLowerCase().includes(query.text.toLowerCase()) || m.email.toLowerCase().startsWith(query.text.toLowerCase())).slice(0, 6) : []),
    [query, members],
  );

  function update(text: string, caret: number) {
    onChange({ text, chosen: value.chosen.filter((m) => text.includes(`@${m.name}`)) });
    // An "@" at a word start, followed by the caret, opens suggestions.
    const m = /(^|\s)@([^\s@]{0,30})$/.exec(text.slice(0, caret));
    setQuery(m ? { start: caret - m[2].length - 1, text: m[2] } : null);
    setActive(0);
  }

  function pick(member: Member) {
    if (!query) return;
    const el = ref.current!;
    const before = value.text.slice(0, query.start);
    const after = value.text.slice(el.selectionStart);
    const text = `${before}@${member.name} ${after}`;
    onChange({ text, chosen: value.chosen.some((c) => c.userId === member.userId) ? value.chosen : [...value.chosen, member] });
    setQuery(null);
    requestAnimationFrame(() => {
      const pos = before.length + member.name.length + 2;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  return (
    <div style={{ position: "relative" }}>
      <textarea
        ref={ref} className="textarea" style={{ minHeight: 64 }} placeholder={placeholder} autoFocus={autoFocus} value={value.text} aria-label="Comment"
        onChange={(e) => update(e.target.value, e.target.selectionStart)}
        onKeyDown={(e) => {
          if (query && matches.length) {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % matches.length); return; }
            if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + matches.length) % matches.length); return; }
            if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(matches[active]); return; }
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setQuery(null); return; }
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(); }
        }}
      />
      {query && matches.length > 0 && (
        <div className="popover mention-list" role="listbox" aria-label="People to mention">
          {matches.map((m, i) => (
            <button key={m.userId} type="button" role="option" aria-selected={i === active} className={`picker-item ${i === active ? "on" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); pick(m); }}>
              <span className="avatar small-avatar">{initials(m.name)}</span>
              <span>{m.name} <span className="muted small">{m.email}</span></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CommentBody({ body, members }: { body: string; members: Member[] }) {
  return (
    <div className="comment-body">
      {splitMentions(body).map((p, i) =>
        p.kind === "text" ? <span key={i}>{p.text}</span> : (
          <span key={i} className="mention">@{members.find((m) => m.userId === p.userId)?.name ?? "someone"}</span>
        ),
      )}
    </div>
  );
}

type HistoryEntry = { txn: number; at: string; kind: HistoryKind; note: string | null; title: string; changes: FieldChange[]; who: string };
type Filter = "all" | "comments" | "changes";

/** One record's activity, live: comments (with replies by mention) and the history of changes. */
export function ActivityPanel({ rowId }: { rowId: string }) {
  const { client, snap } = useBase();
  const baseId = client.baseIdValue;
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [olderFrom, setOlderFrom] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>(() => {
    try { return (localStorage.getItem("gridbase:activity-filter") as Filter) || "all"; } catch { return "all"; }
  });
  const [members, setMembers] = useState<Member[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ text: string; chosen: Member[] }>({ text: "", chosen: [] });
  const [editing, setEditing] = useState<{ id: string; text: string; chosen: Member[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const canComment = client.canComment();
  const isOwner = snap.role === "owner";
  const row = snap.state.rows[rowId];

  const chooseFilter = (f: Filter) => {
    setFilter(f);
    try { localStorage.setItem("gridbase:activity-filter", f); } catch { /* storage may be blocked */ }
  };

  useEffect(() => {
    let alive = true;
    fetch(`/api/bases/${baseId}/rows/${rowId}/comments`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => alive && setComments(d.comments ?? []))
      .catch(() => alive && setError("Couldn't load comments"));
    loadMembers(baseId).then((d) => { if (alive) { setMembers(d.members); setMe(d.me); } }).catch(() => {});
    // Live: comments others add, edit or delete on this record.
    const off = client.onComment((e) => {
      if (e.comment.rowId !== rowId) return;
      setComments((list) => {
        const rest = (list ?? []).filter((c) => c.id !== e.comment.id);
        if (e.event === "deleted") return rest;
        return [...rest, e.comment].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      });
    });
    return () => { alive = false; off(); };
  }, [baseId, rowId, client]);

  // History: load now, then reload shortly after whenever this record changes, from anywhere.
  const historyLoaded = useRef(false);
  useEffect(() => {
    let alive = true;
    const delay = historyLoaded.current ? 700 : 0;
    historyLoaded.current = true;
    const t = setTimeout(() => {
      fetch(`/api/bases/${baseId}/rows/${rowId}/history`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          if (!alive) return;
          // Keep any older pages already loaded.
          setHistory((prev) => {
            const fresh: HistoryEntry[] = d.entries ?? [];
            const oldest = fresh.length ? fresh[fresh.length - 1].txn : Infinity;
            return [...fresh, ...(prev ?? []).filter((e) => e.txn < oldest)];
          });
          setOlderFrom((prev) => (prev === null ? d.nextBefore : prev));
        })
        .catch(() => {});
    }, delay);
    return () => { alive = false; clearTimeout(t); };
  }, [baseId, rowId, row]);

  async function loadOlder() {
    if (olderFrom === null) return;
    const d = await fetch(`/api/bases/${baseId}/rows/${rowId}/history?before=${olderFrom}`, { cache: "no-store" }).then((r) => r.json()).catch(() => null);
    if (!d) return;
    setHistory((prev) => [...(prev ?? []), ...(d.entries ?? []).filter((e: HistoryEntry) => !(prev ?? []).some((p) => p.txn === e.txn))]);
    setOlderFrom(d.nextBefore);
  }

  // One timeline, oldest first so the newest sits next to the comment box.
  const items = useMemo(() => {
    const list: ({ kind: "comment"; at: string; c: Comment } | { kind: "change"; at: string; h: HistoryEntry })[] = [];
    if (filter !== "changes") for (const c of comments ?? []) list.push({ kind: "comment", at: c.createdAt, c });
    if (filter !== "comments") for (const h of history ?? []) list.push({ kind: "change", at: h.at, h });
    return list.sort((a, b) => a.at.localeCompare(b.at));
  }, [comments, history, filter]);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [items.length]);

  async function call(method: string, path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/bases/${baseId}/${path}`, {
        method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "That didn't work");
      return json;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function post() {
    if (!draft.text.trim()) return;
    const r = await call("POST", `rows/${rowId}/comments`, { body: toStored(draft.text, draft.chosen) });
    if (r) {
      setDraft({ text: "", chosen: [] });
      setComments((list) => (list?.some((c) => c.id === r.comment.id) ? list : [...(list ?? []), r.comment]));
    }
  }

  async function saveEdit() {
    if (!editing) return;
    const r = await call("PATCH", `comments/${editing.id}`, { body: toStored(editing.text, editing.chosen) });
    if (r) {
      setEditing(null);
      setComments((list) => (list ?? []).map((c) => (c.id === r.comment.id ? r.comment : c)));
    }
  }

  const loading = (filter !== "changes" && comments === null) || (filter !== "comments" && history === null);
  return (
    <section className="comments" aria-label="Activity">
      <div className="row">
        <h3 className="comments-title">Activity</h3>
        <span className="spacer" />
        <div className="seg" role="tablist" aria-label="Show">
          {(["all", "comments", "changes"] as Filter[]).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => chooseFilter(f)}>
              {f === "all" ? "All" : f === "comments" ? `Comments${comments ? ` ${comments.length}` : ""}` : "Changes"}
            </button>
          ))}
        </div>
      </div>
      <div className="comment-list" ref={listRef}>
        {filter !== "comments" && olderFrom !== null && (
          <button className="link-btn small" style={{ alignSelf: "center" }} onClick={() => void loadOlder()}>Show older changes</button>
        )}
        {loading && !error && <span className="muted small">Loading…</span>}
        {!loading && items.length === 0 && (
          <span className="muted small">
            {filter === "changes" ? "No changes recorded yet." : `No comments yet.${canComment ? " Start the conversation below." : ""}`}
          </span>
        )}
        {items.map((it) => it.kind === "change" ? <ChangeItem key={`h${it.h.txn}`} h={it.h} rowId={rowId} /> : (
          <article key={it.c.id} className="comment">
            <span className="avatar small-avatar" aria-hidden="true">{initials(it.c.userName)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row small" style={{ gap: 6 }}>
                <strong>{it.c.userName}</strong>
                <span className="muted" title={new Date(it.c.createdAt).toLocaleString()}>{timeAgo(it.c.createdAt)}{it.c.editedAt ? " · edited" : ""}</span>
                <span className="spacer" />
                {it.c.userId === me && editing?.id !== it.c.id && (
                  <button className="link-btn small" onClick={() => setEditing({ id: it.c.id, ...toTyped(it.c.body, members) })}>Edit</button>
                )}
                {(it.c.userId === me || isOwner) && editing?.id !== it.c.id && (
                  <button className="link-btn small" style={{ color: "var(--danger)" }} disabled={busy}
                    onClick={() => { if (confirm("Delete this comment?")) void call("DELETE", `comments/${it.c.id}`).then((r) => r && setComments((l) => (l ?? []).filter((x) => x.id !== it.c.id))); }}>
                    Delete
                  </button>
                )}
              </div>
              {editing?.id === it.c.id ? (
                <div className="stack" style={{ gap: 6, marginTop: 4 }}>
                  <MentionInput value={editing} onChange={(v) => setEditing({ ...editing, ...v })} members={members} onSubmit={() => void saveEdit()} placeholder="Edit your comment" autoFocus />
                  <div className="row">
                    <span className="spacer" />
                    <button className="btn small" onClick={() => setEditing(null)}>Cancel</button>
                    <button className="btn primary small" disabled={busy || !editing.text.trim()} onClick={() => void saveEdit()}>Save</button>
                  </div>
                </div>
              ) : (
                <CommentBody body={it.c.body} members={members} />
              )}
            </div>
          </article>
        ))}
      </div>
      {error && <p role="alert" className="small" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
      {canComment ? (
        <div className="stack" style={{ gap: 6 }}>
          <MentionInput value={draft} onChange={setDraft} members={members} onSubmit={() => void post()} placeholder="Add a comment… type @ to mention someone" />
          <div className="row">
            <span className="muted small">⌘/Ctrl + Enter to send</span>
            <span className="spacer" />
            <button className="btn primary small" disabled={busy || !draft.text.trim()} onClick={() => void post()}>Comment</button>
          </div>
        </div>
      ) : (
        <p className="muted small" style={{ margin: 0 }}>You have view-only access, so you can read comments but not add them.</p>
      )}
    </section>
  );
}

const VERB: Record<HistoryKind, string> = { created: "created this record", updated: "changed", deleted: "deleted this record", restored: "restored this record" };

/** One saved change: who, when, and each field's old → new value. */
function ChangeItem({ h, rowId }: { h: HistoryEntry; rowId: string }) {
  const { snap, client } = useBase();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const shown = open ? h.changes : h.changes.slice(0, 4);
  const canEdit = snap.role === "owner" || snap.role === "editor";
  const restorable = h.kind === "updated" && h.changes.some((c) => c.before !== undefined);

  function restore() {
    const { actions, skipped, unchanged } = restoreActions(snap.state, rowId, h.changes);
    const skip = skipped.length ? ` Skipped ${skipped.join(", ")} (changed since, or too big to keep).` : "";
    if (actions.length === 0) return setNote(unchanged ? `Already like this.${skip}` : `Nothing could be restored.${skip}`);
    if (client.dispatch(...actions)) setNote(`Restored. Press ⌘Z to undo.${skip}`);
  }
  return (
    <article className="change">
      <span className="change-dot" aria-hidden="true">{h.kind === "created" ? "+" : h.kind === "restored" ? "↶" : "✎"}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="small">
          <strong>{h.who}</strong> {VERB[h.kind]}{h.note === "undo" ? " (undo/redo)" : ""}{" "}
          <span className="muted" title={new Date(h.at).toLocaleString()}>{timeAgo(h.at)}</span>
          {canEdit && restorable && (
            <button className="link-btn small" style={{ marginLeft: 6 }} onClick={restore} aria-label="Restore these values"
              title="Put these fields back the way they were before this change">↶ Restore</button>
          )}
        </div>
        {shown.length > 0 && (
          <ul className="change-list">
            {shown.map((c) => (
              <li key={c.fieldId}>
                <span className="muted">{c.name}:</span>{" "}
                {h.kind === "created" || h.kind === "restored" ? (
                  <span className="change-to">{c.to}</span>
                ) : c.from === "" ? (
                  <><span className="change-to">{c.to}</span> <span className="muted">(added)</span></>
                ) : c.to === "" ? (
                  <><span className="change-from">{c.from}</span> <span className="muted">(cleared)</span></>
                ) : (
                  <><span className="change-from">{c.from}</span> → <span className="change-to">{c.to}</span></>
                )}
              </li>
            ))}
          </ul>
        )}
        {h.changes.length > 4 && (
          <button className="link-btn small" onClick={() => setOpen((o) => !o)}>{open ? "Show less" : `Show ${h.changes.length - 4} more`}</button>
        )}
        {note && <div className="small muted" role="status">{note}</div>}
      </div>
    </article>
  );
}
