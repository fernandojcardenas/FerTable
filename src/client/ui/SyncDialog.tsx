"use client";

import { useEffect, useState } from "react";
import type { Table } from "@/shared/types";
import { Dialog, useBase } from "./common";

type Source = { id: string; name: string; tables: { id: string; name: string; views: { id: string; name: string }[] }[] };

/** Pick a grid view in another base to copy here as a read-only, auto-updating table. */
export function SyncDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (tableId: string) => void }) {
  const { snap } = useBase();
  const [sources, setSources] = useState<Source[] | null>(null);
  const [baseId, setBaseId] = useState("");
  const [tableId, setTableId] = useState("");
  const [viewId, setViewId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/bases/${snap.state.base.id}/sync-sources`, { cache: "no-store" })
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error ?? "Failed"); setSources(d.bases); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [snap.state.base.id]);

  const base = sources?.find((b) => b.id === baseId);
  const table = base?.tables.find((t) => t.id === tableId);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/bases/${snap.state.base.id}/syncs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceBaseId: baseId, sourceViewId: viewId }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Couldn't set up the sync");
      onCreated(d.tableId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Sync a table from another base" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!viewId || busy} onClick={() => void create()}>{busy ? "Syncing…" : "Create synced table"}</button></>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>
          The records and visible fields of a grid view are copied here and kept up to date. The copy is read-only, but you can add your own fields
          to it. Everyone in this base will see the synced data, so you need editor access to the source base.
        </p>
        {!sources && !error && <span className="muted small">Loading…</span>}
        {sources?.length === 0 && <span className="muted">No other bases you can edit.</span>}
        {sources && sources.length > 0 && (
          <>
            <label className="field-label">Base
              <select className="select" value={baseId} onChange={(e) => { setBaseId(e.target.value); setTableId(""); setViewId(""); }}>
                <option value="">Choose a base…</option>
                {sources.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
            {base && (
              <label className="field-label">Table
                <select className="select" value={tableId} onChange={(e) => { setTableId(e.target.value); setViewId(base.tables.find((t) => t.id === e.target.value)?.views[0]?.id ?? ""); }}>
                  <option value="">Choose a table…</option>
                  {base.tables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            )}
            {table && (
              <label className="field-label">View (its filters and hidden fields decide what's shared)
                <select className="select" value={viewId} onChange={(e) => setViewId(e.target.value)}>
                  {table.views.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </label>
            )}
          </>
        )}
        {error && <p className="small" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
      </div>
    </Dialog>
  );
}

/** Shown above a synced table: where it comes from, when it last synced, and Sync now. */
export function SyncBanner({ table }: { table: Table }) {
  const { snap } = useBase();
  const [busy, setBusy] = useState(false);
  const sync = table.sync!;
  const canEdit = snap.role === "owner" || snap.role === "editor";
  async function now() {
    setBusy(true);
    await fetch(`/api/bases/${snap.state.base.id}/syncs/${table.id}/run`, { method: "POST" }).catch(() => {});
    setBusy(false);
  }
  return (
    <div className={`sync-banner ${sync.error ? "error" : ""}`} role="status">
      <span>⇄ Synced from <strong>{sync.sourceLabel}</strong></span>
      <span className="muted">{sync.lastSyncAt ? `· last synced ${new Date(sync.lastSyncAt).toLocaleString()}` : "· waiting for the first sync"}</span>
      {sync.error && <span style={{ color: "var(--danger)" }}>· {sync.error}</span>}
      <span className="spacer" />
      <span className="muted small">Synced fields are read-only here.</span>
      {canEdit && <button className="btn small" disabled={busy} onClick={() => void now()}>{busy ? "Syncing…" : "Sync now"}</button>}
    </div>
  );
}
