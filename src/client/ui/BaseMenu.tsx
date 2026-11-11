"use client";

// The base's ⋯ menu: duplicate the base, snapshots (save and restore the whole base),
// and moving it into a workspace.

import { useEffect, useState } from "react";
import { Dialog, Popover, useBase } from "./common";

type Snapshot = { id: string; name: string; auto: boolean; txn: number; createdAt: string; createdBy: string | null; records: number };
type Workspace = { id: string; name: string; role: string };

async function call<T = unknown>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "Something went wrong");
  return d as T;
}

export function BaseMenu() {
  const { snap } = useBase();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<null | "duplicate" | "snapshots" | "move">(null);
  const canEdit = snap.role === "owner" || snap.role === "editor";
  const pick = (d: typeof dialog) => { setOpen(false); setDialog(d); };
  return (
    <>
      <Popover open={open} onClose={() => setOpen(false)} align="right" anchor={<button className="btn ghost" onClick={() => setOpen(!open)} aria-label="Base menu">⋯</button>}>
        <div className="menu">
          <button disabled={!canEdit} onClick={() => pick("duplicate")}>⧉ Duplicate base…</button>
          <button disabled={!canEdit} onClick={() => pick("snapshots")}>🕘 Snapshots…</button>
          <button disabled={snap.role !== "owner"} onClick={() => pick("move")}>🗂 Move to a workspace…</button>
        </div>
      </Popover>
      {dialog === "duplicate" && <DuplicateBaseDialog onClose={() => setDialog(null)} />}
      {dialog === "snapshots" && <SnapshotsDialog onClose={() => setDialog(null)} />}
      {dialog === "move" && <MoveBaseDialog onClose={() => setDialog(null)} />}
    </>
  );
}

function DuplicateBaseDialog({ onClose }: { onClose: () => void }) {
  const { snap } = useBase();
  const [name, setName] = useState(`${snap.state.base.name} copy`);
  const [withRecords, setWithRecords] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    try {
      const { id } = await call<{ id: string }>(`/api/bases/${snap.state.base.id}/duplicate`, "POST", { name, withRecords });
      location.href = `/base/${id}`;
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }
  return (
    <Dialog title="Duplicate base" onClose={onClose} footer={<><span className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => void go()}>{busy ? "Copying…" : "Duplicate"}</button></>}>
      <label className="field-label">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="row" style={{ marginTop: 8 }}><input type="checkbox" checked={withRecords} onChange={(e) => setWithRecords(e.target.checked)} /> Copy records and their files</label>
      <p className="muted small">Tables, fields, views, interfaces and automations are copied. You&apos;ll be the only member of the copy, its automations start switched off, and public links aren&apos;t copied.</p>
      {error && <p className="small" style={{ color: "var(--danger)" }}>{error}</p>}
    </Dialog>
  );
}

function SnapshotsDialog({ onClose }: { onClose: () => void }) {
  const { snap } = useBase();
  const baseId = snap.state.base.id;
  const [list, setList] = useState<Snapshot[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => call<{ snapshots: Snapshot[] }>(`/api/bases/${baseId}/snapshots`).then((d) => setList(d.snapshots)).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await fn(); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  };
  return (
    <Dialog wide title="Snapshots" onClose={onClose} footer={<><span className="spacer" /><button className="btn primary" onClick={onClose}>Done</button></>}>
      <p className="muted" style={{ marginTop: 0 }}>A snapshot saves the whole base: tables, fields, records, views, interfaces and automations. One is also taken automatically each day the base changes. Restoring puts everything back the way it was (comments and files stay), and takes a snapshot of the current state first.</p>
      <div className="row">
        <input className="input" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Snapshot name" />
        <button className="btn primary" disabled={busy !== null} onClick={() => void run("new", async () => { await call(`/api/bases/${baseId}/snapshots`, "POST", { name }); setName(""); })}>{busy === "new" ? "Saving…" : "Take snapshot"}</button>
      </div>
      {error && <p className="small" style={{ color: "var(--danger)" }}>{error}</p>}
      {!list && !error && <p className="muted small">Loading…</p>}
      {list?.length === 0 && <p className="muted small">No snapshots yet.</p>}
      <div className="stack" style={{ gap: 4, marginTop: 10, maxHeight: 360, overflow: "auto" }}>
        {list?.map((s) => (
          <div key={s.id} className="snapshot-row">
            <span className="stack" style={{ gap: 0 }}>
              <span>{s.auto ? "🕘 " : ""}{s.name}</span>
              <span className="muted small">{new Date(s.createdAt).toLocaleString()} · {s.createdBy ?? "Automatic"} · {s.records.toLocaleString()} records</span>
            </span>
            <span className="spacer" />
            {snap.role === "owner" && (
              <>
                <button className="btn small" disabled={busy !== null} onClick={() => {
                  if (confirm(`Restore “${s.name}”? Everything in the base goes back to how it was then. A snapshot of how it is now is taken first.`)) void run(s.id, () => call(`/api/bases/${baseId}/snapshots/${s.id}/restore`, "POST", {}));
                }}>{busy === s.id ? "Restoring…" : "Restore"}</button>
                <button className="btn ghost small" disabled={busy !== null} onClick={() => { if (confirm("Delete this snapshot?")) void run(`d${s.id}`, () => call(`/api/bases/${baseId}/snapshots/${s.id}`, "DELETE")); }} aria-label="Delete snapshot">🗑</button>
              </>
            )}
          </div>
        ))}
      </div>
      {snap.role !== "owner" && <p className="muted small">Only owners can restore or delete snapshots.</p>}
    </Dialog>
  );
}

function MoveBaseDialog({ onClose }: { onClose: () => void }) {
  const { snap } = useBase();
  const [list, setList] = useState<Workspace[] | null>(null);
  const [pick, setPick] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { call<{ workspaces: Workspace[] }>("/api/workspaces").then((d) => setList(d.workspaces)).catch((e) => setError(e.message)); }, []);
  async function go() {
    try { await call(`/api/bases/${snap.state.base.id}/move`, "POST", { workspaceId: pick || null }); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  const usable = list?.filter((w) => w.role === "owner" || w.role === "editor") ?? [];
  return (
    <Dialog title="Move to a workspace" onClose={onClose} footer={<><span className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => void go()}>Move</button></>}>
      <p className="muted" style={{ marginTop: 0 }}>Everyone in the workspace gets their workspace role on this base. You stay an owner.</p>
      <select className="select" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Workspace">
        <option value="">No workspace</option>
        {usable.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
      </select>
      {list && usable.length === 0 && <p className="muted small">You aren&apos;t an editor of any workspace yet. Create one from the home page.</p>}
      {error && <p className="small" style={{ color: "var(--danger)" }}>{error}</p>}
    </Dialog>
  );
}
