"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { BaseState, FieldType, Role, ViewType } from "@/shared/types";
import { newId } from "@/shared/ids";
import { starterTableActions } from "@/shared/starter";
import { BaseClient } from "../store";
import { BaseContext, Popover, useBase, type BaseUi } from "./common";
import { GridView } from "./GridView";
import { CalendarView, FormView, GalleryView, KanbanView } from "./views";
import { Toolbar } from "./Toolbar";
import { FieldDialog } from "./FieldDialog";
import { RecordDialog } from "./RecordDialog";
import { AutomationsDialog } from "./AutomationsDialog";
import { prefillFromFilters } from "./prefill";
import { ShareDialog } from "./ShareDialog";
import { AccountMenu, type Me } from "./AccountMenu";
import { ImportDialog } from "./ImportDialog";
import { DeletedDialog } from "./DeletedDialog";
import { downloadViewCsv } from "./csvExport";

const VIEW_TYPES: { type: ViewType; label: string; icon: string }[] = [
  { type: "grid", label: "Grid", icon: "▦" },
  { type: "kanban", label: "Kanban", icon: "▥" },
  { type: "calendar", label: "Calendar", icon: "📅" },
  { type: "gallery", label: "Gallery", icon: "▣" },
  { type: "form", label: "Form", icon: "☷" },
];
const viewIcon = (t: ViewType) => VIEW_TYPES.find((v) => v.type === t)?.icon ?? "▦";

function readLast(baseId: string): { tableId?: string; viewId?: string } {
  try { return JSON.parse(localStorage.getItem(`gridbase:last:${baseId}`) ?? "{}"); } catch { return {}; }
}
function writeLast(baseId: string, v: { tableId: string; viewId: string }) {
  try { localStorage.setItem(`gridbase:last:${baseId}`, JSON.stringify(v)); } catch { /* storage may be blocked */ }
}

export default function BaseApp({ baseId }: { baseId: string }) {
  const [client, setClient] = useState<BaseClient | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let c: BaseClient | null = null;
    let cancelled = false;
    const get = async <T,>(path: string): Promise<T> => {
      const r = await fetch(`/api/bases/${baseId}/${path}`, { cache: "no-store" });
      if (r.status === 401) {
        location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
        throw new Error("Signing in…");
      }
      if (r.status === 404) throw new Error("This base doesn't exist, or it hasn't been shared with you.");
      if (!r.ok) throw new Error("Could not load the base.");
      return r.json() as Promise<T>;
    };
    Promise.all([get<{ user: Me; role: Role }>("me"), get<BaseState>("snapshot")])
      .then(([access, snapshot]) => {
        if (cancelled) return;
        c = new BaseClient(baseId, snapshot, access.role, access.user.id);
        setMe(access.user);
        setClient(c);
      })
      .catch((e) => setLoadError(e.message));
    return () => { cancelled = true; c?.close(); };
  }, [baseId]);

  if (loadError) return <main className="home"><h1>gridbase</h1><p>{loadError}</p><a href="/">← All bases</a></main>;
  if (!client || !me) return <main className="home"><p className="muted">Loading base…</p></main>;
  return <LoadedBase client={client} me={me} />;
}

function LoadedBase({ client, me }: { client: BaseClient; me: Me }) {
  const snap = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const state = snap.state;
  const baseId = state.base.id;
  const [sel, setSel] = useState(() => readLast(baseId));
  const [recordId, setRecordId] = useState<string | null>(() => {
    const id = new URLSearchParams(location.search).get("record");
    return id && state.rows[id] ? id : null;
  });

  // A link to a record opens its table, and the address follows the open record.
  useEffect(() => {
    const url = new URL(location.href);
    if (recordId) {
      const row = state.rows[recordId];
      if (row && sel.tableId !== row.tableId) setSel({ tableId: row.tableId, viewId: state.tables[row.tableId]?.viewOrder[0] });
      url.searchParams.set("record", recordId);
    } else url.searchParams.delete("record");
    if (url.href !== location.href) history.replaceState(null, "", url);
    // Only when the open record changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId]);
  const [fieldDialog, setFieldDialog] = useState<Parameters<BaseUi["openFieldDialog"]>[0] | null>(null);
  const [showAutomations, setShowAutomations] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [sidebar, setSidebar] = useState(true);

  // Fall back to the first table/view when the remembered one is gone.
  const tableId = sel.tableId && state.tables[sel.tableId] ? sel.tableId : state.tableOrder[0];
  const table = tableId ? state.tables[tableId] : undefined;
  const viewId = table && sel.viewId && table.viewOrder.includes(sel.viewId) ? sel.viewId : table?.viewOrder[0];
  const view = viewId ? state.views[viewId] : undefined;

  useEffect(() => { if (tableId && viewId) writeLast(baseId, { tableId, viewId }); }, [baseId, tableId, viewId]);
  useEffect(() => { document.title = `${state.base.name} · gridbase`; }, [state.base.name]);

  // Cmd/Ctrl+Z undoes, Shift+Cmd/Ctrl+Z or Ctrl+Y redoes. Text boxes keep their own undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) && !t.classList.contains("key-catcher");
      if (typing) return;
      e.preventDefault();
      if (key === "y" || e.shiftKey) client.redo();
      else client.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [client]);

  const ui: BaseUi = useMemo(() => ({
    client, snap,
    openRecord: (id: string) => setRecordId(id),
    openFieldDialog: (opts: { tableId: string; fieldId?: string; afterFieldId?: string | null; presetType?: FieldType }) => setFieldDialog(opts),
  }), [client, snap]);

  const addRecord = useCallback(() => {
    if (!table || !view) return;
    const rowId = newId("rec");
    if (client.dispatch({ type: "row.create", rowId, tableId: table.id, cells: prefillFromFilters(state, view) })) setRecordId(rowId);
  }, [client, table, view, state]);

  if (!table || !view) return <main className="home"><p>This base has no tables.</p></main>;

  return (
    <BaseContext.Provider value={ui}>
      <div className="base-app">
        <Header me={me} onAutomations={() => setShowAutomations(true)} onShare={() => setShowShare(true)} onToggleSidebar={() => setSidebar((s) => !s)} />
        <TableTabs activeId={table.id} onSelect={(id) => setSel({ tableId: id, viewId: state.tables[id]?.viewOrder[0] })} />
        <div className="workspace">
          <aside className={`sidebar ${sidebar ? "" : "collapsed"}`}>
            <ViewList tableId={table.id} activeId={view.id} onSelect={(id) => setSel({ tableId: table.id, viewId: id })} />
          </aside>
          <section className="main">
            <Toolbar view={view} onAddRecord={addRecord} />
            <div className="view-body">
              {view.type === "grid" && <GridView key={view.id} view={view} />}
              {view.type === "kanban" && <KanbanView view={view} />}
              {view.type === "calendar" && <CalendarView view={view} />}
              {view.type === "gallery" && <GalleryView view={view} />}
              {view.type === "form" && <FormView key={view.id} view={view} />}
            </div>
          </section>
        </div>
        {recordId && <RecordDialog rowId={recordId} onClose={() => setRecordId(null)} />}
        {fieldDialog && <FieldDialog {...fieldDialog} onClose={() => setFieldDialog(null)} />}
        {showAutomations && <AutomationsDialog onClose={() => setShowAutomations(false)} />}
        {showShare && <ShareDialog baseId={baseId} baseName={state.base.name} onClose={() => setShowShare(false)} />}
        {snap.error && <div className="toast" role="alert">{snap.error}</div>}
        {!snap.error && snap.notice && <div className="toast notice" role="status">{snap.notice}</div>}
      </div>
    </BaseContext.Provider>
  );
}

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

function Header({ me, onAutomations, onShare, onToggleSidebar }: { me: Me; onAutomations: () => void; onShare: () => void; onToggleSidebar: () => void }) {
  const { snap, client } = useBase();
  const [name, setName] = useState(snap.state.base.name);
  useEffect(() => setName(snap.state.base.name), [snap.state.base.name]);
  const readOnly = snap.role === "viewer" || snap.status === "revoked";
  const statusText =
    snap.status === "revoked" ? "You no longer have access" :
    snap.status === "live" ? (snap.saving ? "Saving…" : "All changes saved") :
    snap.status === "connecting" ? "Connecting…" : "Offline – changes will sync when back online";
  return (
    <header className="app-header">
      <a href="/" className="btn ghost" aria-label="All bases">◧</a>
      <button className="btn ghost" onClick={onToggleSidebar} aria-label="Toggle views sidebar">☰</button>
      <input className="base-name" value={name} aria-label="Base name" size={Math.max(8, name.length)} readOnly={readOnly}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== snap.state.base.name && client.dispatch({ type: "base.rename", name })}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
      <span className="row small muted" title={`Transaction ${snap.state.base.txn}`}>
        <span className={`status-dot ${snap.status}`} /> {statusText}
      </span>
      {snap.role === "viewer" && <span className="role-badge" title="You can look but not change anything">View only</span>}
      {snap.role === "commenter" && <span className="role-badge" title="You can read and comment, but not change records">Can comment</span>}
      <span className="spacer" />
      <button className="btn ghost" onClick={() => client.undo()} disabled={!snap.undoLabel} aria-label="Undo"
        title={snap.undoLabel ? `Undo ${snap.undoLabel} (${MOD}Z)` : "Nothing to undo"}>↶</button>
      <button className="btn ghost" onClick={() => client.redo()} disabled={!snap.redoLabel} aria-label="Redo"
        title={snap.redoLabel ? `Redo ${snap.redoLabel} (${MOD}⇧Z)` : "Nothing to redo"}>↷</button>
      <button className="btn" onClick={onAutomations}>⚡ Automations</button>
      <button className="btn primary" onClick={onShare}>Share</button>
      <AccountMenu me={me} />
    </header>
  );
}

function TableTabs({ activeId, onSelect }: { activeId: string; onSelect: (id: string) => void }) {
  const { snap, client, openRecord } = useBase();
  const [menu, setMenu] = useState<string | null>(null);
  const [deletedFor, setDeletedFor] = useState<string | null>(null);
  // Import as a new table (tableId undefined) or into an existing one.
  const [importing, setImporting] = useState<{ tableId?: string } | null>(null);
  const state = snap.state;

  const addTable = () => {
    let n = state.tableOrder.length + 1;
    const names = new Set(Object.values(state.tables).map((t) => t.name.toLowerCase()));
    while (names.has(`table ${n}`)) n++;
    const { tableId, actions } = starterTableActions(`Table ${n}`);
    if (client.dispatch(...actions)) onSelect(tableId);
  };

  return (
    <nav className="table-tabs" aria-label="Tables">
      {state.tableOrder.map((id) => {
        const t = state.tables[id];
        return (
          <Popover key={id} open={menu === id} onClose={() => setMenu(null)} anchor={
            <button className={`table-tab ${id === activeId ? "active" : ""}`} onClick={() => (id === activeId ? setMenu(id) : onSelect(id))}>
              {t.name} {id === activeId && <span className="muted small">▾</span>}
            </button>
          }>
            <div className="menu">
              <button onClick={() => { setMenu(null); const n = prompt("Rename table", t.name); if (n?.trim()) client.dispatch({ type: "table.rename", tableId: id, name: n }); }}>✎ Rename table</button>
              <button onClick={() => { setMenu(null); if (client.ensureCanEdit()) setImporting({ tableId: id }); }}>⤒ Import CSV into this table…</button>
              <button onClick={() => { setMenu(null); setDeletedFor(id); }}>↶ Recently deleted records…</button>
              <button style={{ color: "var(--danger)" }} onClick={() => {
                setMenu(null);
                if (confirm(`Delete the table "${t.name}" and all its records? Links to it from other tables are removed too.`)) client.dispatch({ type: "table.delete", tableId: id });
              }}>🗑 Delete table</button>
            </div>
          </Popover>
        );
      })}
      <Popover open={menu === "__add"} onClose={() => setMenu(null)} anchor={
        <button className="table-tab" onClick={() => setMenu(menu === "__add" ? null : "__add")}>+ Add table</button>
      }>
        <div className="menu">
          <button onClick={() => { setMenu(null); addTable(); }}>▦ Blank table</button>
          <button onClick={() => { setMenu(null); if (client.ensureCanEdit()) setImporting({}); }}>⤒ Import a CSV file…</button>
        </div>
      </Popover>
      {deletedFor && <DeletedDialog tableId={deletedFor} onClose={() => setDeletedFor(null)} onOpen={(rowId) => { setDeletedFor(null); openRecord(rowId); }} />}
      {importing && <ImportDialog tableId={importing.tableId} onClose={() => setImporting(null)} onCreated={(id) => onSelect(id)} />}
    </nav>
  );
}

function ViewList({ tableId, activeId, onSelect }: { tableId: string; activeId: string; onSelect: (id: string) => void }) {
  const { snap, client } = useBase();
  const table = snap.state.tables[tableId];
  const [menu, setMenu] = useState<string | null>(null);

  const create = (type: ViewType, label: string) => {
    const viewId = newId("viw");
    const taken = new Set(table.viewOrder.map((id) => snap.state.views[id]?.name));
    let name = label;
    for (let i = 2; taken.has(name); i++) name = `${label} ${i}`;
    // New views start as a copy of the current one, like the original app.
    if (client.dispatch({ type: "view.create", viewId, tableId, name, viewType: type, copyFromViewId: type === "form" ? null : activeId })) onSelect(viewId);
  };

  return (
    <div className="stack" style={{ gap: 2 }}>
      <span className="muted small" style={{ padding: "0 8px 4px" }}>Views</span>
      {table.viewOrder.map((id) => {
        const v = snap.state.views[id];
        if (!v) return null;
        return (
          <div key={id} className="row" style={{ gap: 0 }}>
            <button className={`view-item ${id === activeId ? "active" : ""}`} onClick={() => onSelect(id)}>
              <span>{viewIcon(v.type)}</span> <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{v.name}</span>
            </button>
            <Popover open={menu === id} onClose={() => setMenu(null)} align="right" anchor={
              <button className="btn ghost small" onClick={() => setMenu(id)} aria-label={`${v.name} options`}>⋯</button>
            }>
              <div className="menu">
                <button onClick={() => { setMenu(null); const n = prompt("Rename view", v.name); if (n?.trim()) client.dispatch({ type: "view.update", viewId: id, name: n }); }}>✎ Rename</button>
                <button onClick={() => { setMenu(null); downloadViewCsv(snap.state, v); }}>⤓ Download CSV</button>
                <button onClick={() => {
                  setMenu(null);
                  const newViewId = newId("viw");
                  if (client.dispatch({ type: "view.create", viewId: newViewId, tableId, name: `${v.name} copy`, viewType: v.type, copyFromViewId: id })) onSelect(newViewId);
                }}>⧉ Duplicate</button>
                <button style={{ color: "var(--danger)" }} onClick={() => { setMenu(null); if (confirm(`Delete the view "${v.name}"? Records are not affected.`)) client.dispatch({ type: "view.delete", viewId: id }); }}>🗑 Delete</button>
              </div>
            </Popover>
          </div>
        );
      })}
      <span className="muted small" style={{ padding: "14px 8px 4px" }}>Create a view</span>
      {VIEW_TYPES.map((t) => (
        <button key={t.type} className="view-item" onClick={() => create(t.type, t.label)}>
          <span>{t.icon}</span> {t.label}
        </button>
      ))}
    </div>
  );
}
