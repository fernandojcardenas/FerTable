"use client";

import { useState } from "react";
import { isReadOnly } from "@/shared/fieldTypes";
import { formatDate } from "@/shared/compute";
import { CellContent, Dialog, FieldIcon, useBase } from "./common";
import { FieldInput } from "./inputs";
import { cellActions } from "./actions";
import { ActivityPanel } from "./Comments";
import { canAddRecords, canEditField } from "./permissions";

export function RecordDialog({ rowId, onClose }: { rowId: string; onClose: () => void }) {
  const { snap, client, openFieldDialog } = useBase();
  const [copied, setCopied] = useState(false);
  const row = snap.state.rows[rowId];
  if (!row) {
    return (
      <Dialog title="Record" onClose={onClose}>
        <p className="muted">This record was deleted.</p>
      </Dialog>
    );
  }
  const table = snap.state.tables[row.tableId];
  const fields = table.fieldOrder.map((id) => snap.state.fields[id]).filter(Boolean);
  const canEdit = snap.role === "owner" || snap.role === "editor";

  async function copyLink() {
    const url = `${location.origin}/base/${snap.state.base.id}?record=${row.id}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      prompt("Copy this link", url);
    }
  }

  return (
    <Dialog
      wide
      title={<span>{snap.computer.primaryName(row.id)} <span className="muted small" style={{ fontWeight: 400 }}>· {table.name}</span></span>}
      onClose={onClose}
      footer={
        <>
          <span className="muted small">Created {formatDate(row.createdAt, true)} · #{row.autoNumber}</span>
          <span className="spacer" />
          <button className="btn" onClick={() => void copyLink()}>{copied ? "Link copied" : "🔗 Copy link"}</button>
          {canEdit && canAddRecords(snap, table) && !table.sync && <button className="btn danger" onClick={() => { if (client.dispatch({ type: "row.delete", rowIds: [row.id] })) onClose(); }}>Delete record</button>}
          <button className="btn primary" onClick={onClose}>Done</button>
        </>
      }
    >
      <div className="record-layout">
        <div className="record-fields">
          {fields.map((f) => (
            <div key={f.id} className="record-field">
              <div className="name"><FieldIcon field={f} /> {f.name}{f.editableBy && <span className="muted small" title="Only some people can change this field"> 🔒</span>}</div>
              <div style={{ minWidth: 0 }}>
                {isReadOnly(f) || !canEdit || !canEditField(snap, f) ? (
                  <div style={{ padding: "6px 0", whiteSpace: "pre-wrap" }}>
                    <CellContent row={row} field={f} detailed />
                  </div>
                ) : (
                  <FieldInput field={f} value={row.cells[f.id]} onCommit={(v, ch) => client.dispatch(...cellActions(snap.state, row.id, f, v, ch))} />
                )}
              </div>
            </div>
          ))}
          {canEdit && <button className="btn ghost" style={{ marginTop: 10 }} onClick={() => openFieldDialog({ tableId: table.id })}>+ Add a field to {table.name}</button>}
        </div>
        <ActivityPanel rowId={row.id} />
      </div>
    </Dialog>
  );
}
