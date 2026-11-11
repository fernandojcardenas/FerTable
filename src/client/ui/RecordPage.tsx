"use client";

// Record review pages: a list of records on the left, the chosen record's fields
// on the right. Editors pick the table, the view the records come from and the fields.

import { useMemo, useState } from "react";
import type { Field, InterfacePage, Row } from "@/shared/types";
import { viewRows } from "@/shared/query";
import { isReadOnly } from "@/shared/fieldTypes";
import { CellContent, FieldIcon, useBase } from "./common";
import { FieldInput } from "./inputs";
import { cellActions } from "./actions";
import { canEditField } from "./permissions";
import { PublishDialog } from "./InterfacesView";

export function RecordPageView({ page, editing, setEditing, canEdit, onDeleted }: {
  page: InterfacePage; editing: boolean; setEditing: (v: boolean) => void; canEdit: boolean; onDeleted: () => void;
}) {
  const { snap, client, openRecord } = useBase();
  const state = snap.state;
  const c = snap.computer;
  const table = page.tableId ? state.tables[page.tableId] : undefined;
  const view = page.viewId ? state.views[page.viewId] : undefined;
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const save = (next: InterfacePage) => client.dispatch({ type: "page.upsert", page: next });

  const rows = useMemo(() => {
    if (!table) return [] as Row[];
    const all = view ? viewRows(c, state, view) : table.rowOrder.map((id) => state.rows[id]).filter(Boolean);
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((r) => c.primaryName(r.id).toLowerCase().includes(needle)) : all;
  }, [table, view, c, state, q]);
  const row = (picked && state.rows[picked]?.tableId === table?.id ? state.rows[picked] : undefined) ?? rows[0];
  const fields = (page.fieldIds ?? []).map((id) => state.fields[id]).filter((f): f is Field => Boolean(f));
  const allFields = table ? table.fieldOrder.map((id) => state.fields[id]).filter(Boolean) : [];
  const writable = snap.role === "owner" || snap.role === "editor";

  return (
    <div className="page-shell">
      <div className="toolbar">
        {editing ? (
          <input className="input" style={{ width: 240 }} defaultValue={page.name} aria-label="Page name" key={page.name}
            onBlur={(e) => e.target.value.trim() && e.target.value !== page.name && save({ ...page, name: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        ) : <strong>{page.name}</strong>}
        <span className="muted small">{table?.name}{view ? ` · ${view.name}` : ""}</span>
        <span className="spacer" />
        {editing && <button className="btn ghost danger" onClick={() => { if (confirm(`Delete the page "${page.name}"?`) && client.dispatch({ type: "page.delete", pageId: page.id })) onDeleted(); }}>Delete page</button>}
        {canEdit && !editing && <button className="btn ghost" onClick={() => setPublishing(true)}>🌐 {page.shareToken ? "Published" : "Publish"}</button>}
        {canEdit && <button className={`btn ${editing ? "primary" : ""}`} onClick={() => setEditing(!editing)}>{editing ? "Done" : "✎ Edit page"}</button>}
      </div>
      {publishing && <PublishDialog page={page} onClose={() => setPublishing(false)} />}
      <div className="page-body">
        <div className="record-page">
          <div className="record-page-list">
            <input className="input" placeholder={`Find in ${table?.name ?? "records"}`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a record" />
            <div className="record-page-items">
              {rows.slice(0, 1000).map((r) => (
                <button key={r.id} className={`view-item ${row?.id === r.id ? "active" : ""}`} onClick={() => setPicked(r.id)}>{c.primaryName(r.id)}</button>
              ))}
              {rows.length === 0 && <span className="muted small" style={{ padding: 8 }}>No records.</span>}
            </div>
          </div>
          <div className="record-page-detail">
            {!row ? <p className="muted">Pick a record.</p> : (
              <>
                <div className="row"><h2 style={{ margin: 0 }}>{c.primaryName(row.id)}</h2><span className="spacer" /><button className="btn small" onClick={() => openRecord(row.id)}>⤢ Open record</button></div>
                {fields.length === 0 && <p className="muted">No fields chosen yet.{canEdit ? " Choose Edit page to pick some." : ""}</p>}
                {fields.map((f) => (
                  <div key={f.id} className="record-field">
                    <div className="name"><FieldIcon field={f} /> {f.name}</div>
                    <div style={{ minWidth: 0 }}>
                      {isReadOnly(f) || !writable || !canEditField(snap, f)
                        ? <div style={{ padding: "6px 0", whiteSpace: "pre-wrap" }}><CellContent row={row} field={f} detailed /></div>
                        : <FieldInput field={f} value={row.cells[f.id]} onCommit={(v, ch) => client.dispatch(...cellActions(state, row.id, f, v, ch))} />}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
        {editing && (
          <aside className="el-settings">
            <strong>Page settings</strong>
            <label className="field-label">Table
              <select className="select" value={page.tableId ?? ""} onChange={(e) => {
                const t = state.tables[e.target.value];
                if (t) save({ ...page, tableId: t.id, viewId: null, fieldIds: t.fieldOrder.slice(0, 12) });
              }}>
                {state.tableOrder.map((id) => <option key={id} value={id}>{state.tables[id].name}</option>)}
              </select>
            </label>
            <label className="field-label">Records from
              <select className="select" value={page.viewId ?? ""} onChange={(e) => save({ ...page, viewId: e.target.value || null })}>
                <option value="">All records</option>
                {(table?.viewOrder ?? []).map((id) => state.views[id]).filter((v) => v && v.type !== "form" && !v.personalFor).map((v) => <option key={v.id} value={v.id}>View: {v.name}</option>)}
              </select>
            </label>
            <div className="field-label">Fields shown</div>
            <div className="stack" style={{ gap: 2, maxHeight: 320, overflow: "auto" }}>
              {allFields.map((f) => (
                <label key={f.id} className="row small"><input type="checkbox" checked={(page.fieldIds ?? []).includes(f.id)}
                  onChange={(e) => save({ ...page, fieldIds: e.target.checked ? allFields.filter((x) => x.id === f.id || (page.fieldIds ?? []).includes(x.id)).map((x) => x.id) : (page.fieldIds ?? []).filter((x) => x !== f.id) })} /> {f.name}</label>
              ))}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
