"use client";

import { useEffect, useState } from "react";
import { restoreDeletedActions, type DeletedSnapshot, type FieldChange } from "@/shared/activity";
import { Dialog, useBase } from "./common";

type Deleted = { rowId: string; txn: number; at: string; title: string; changes: FieldChange[]; snapshot: DeletedSnapshot; who: string };

/** Records deleted from one table in the last 30 days, with a way to bring each back. */
export function DeletedDialog({ tableId, onClose, onOpen }: { tableId: string; onClose: () => void; onOpen: (rowId: string) => void }) {
  const { snap, client } = useBase();
  const table = snap.state.tables[tableId];
  const [list, setList] = useState<Deleted[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});
  const canEdit = snap.role === "owner" || snap.role === "editor";

  useEffect(() => {
    fetch(`/api/bases/${snap.state.base.id}/deleted?tableId=${encodeURIComponent(tableId)}`, { cache: "no-store" })
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error ?? `Failed (${r.status})`); setList(d.records ?? []); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [snap.state.base.id, tableId]);

  function restore(d: Deleted) {
    const { actions, skipped } = restoreDeletedActions(snap.state, d.snapshot);
    if (actions.length === 0) return setDone((x) => ({ ...x, [d.rowId]: skipped[0] ? `Can't restore: ${skipped[0]}.` : "Already restored." }));
    if (client.dispatch(...actions)) {
      setDone((x) => ({ ...x, [d.rowId]: `Restored.${skipped.length ? ` Left empty: ${skipped.join(", ")} (changed since).` : ""}` }));
    }
  }

  return (
    <Dialog wide title={`Recently deleted from ${table?.name ?? "this table"}`} onClose={onClose}
      footer={<button className="btn primary" onClick={onClose}>Close</button>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>Records deleted in the last 30 days. Restoring brings a record back with its values, links and files.</p>
        {error && <p className="small" style={{ color: "var(--danger)" }}>{error}</p>}
        {!list && !error && <span className="muted small">Loading…</span>}
        {list?.length === 0 && <span className="muted">Nothing deleted recently.</span>}
        {list?.map((d) => {
          const restored = Boolean(snap.state.rows[d.rowId]);
          return (
            <div key={d.rowId} className="deleted-item">
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>{d.title || "(unnamed record)"}</strong>
                <div className="muted small">Deleted by {d.who} · {new Date(d.at).toLocaleString()}</div>
                {d.changes.length > 0 && (
                  <div className="muted small deleted-preview">
                    {d.changes.slice(0, 4).map((c) => `${c.name}: ${c.to}`).join(" · ")}{d.changes.length > 4 ? " …" : ""}
                  </div>
                )}
                {done[d.rowId] && <div className="small" role="status">{done[d.rowId]}</div>}
              </div>
              {restored
                ? <button className="btn" onClick={() => onOpen(d.rowId)} aria-label={`Open ${d.title || "record"}`}>Open</button>
                : canEdit && <button className="btn" onClick={() => restore(d)} aria-label={`Restore ${d.title || "record"}`}>↶ Restore</button>}
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
