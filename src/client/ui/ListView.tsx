"use client";

// List view: records as an outline. Groups fold open and closed, and with a
// "nest by" link field each record shows its linked records underneath it.

import { useMemo, useState } from "react";
import type { Row, View } from "@/shared/types";
import { groupRows, type RowGroup } from "@/shared/query";
import { recordColor } from "@/shared/viewTools";
import { newId } from "@/shared/ids";
import { CellContent, useBase } from "./common";
import { useViewData } from "./views";
import { prefillFromFilters } from "./prefill";
import { canAddRecords } from "./permissions";

const MAX_DEPTH = 4;

export function ListView({ view }: { view: View }) {
  const { snap, client, openRecord } = useBase();
  const { table, rows, fields } = useViewData(view);
  const c = snap.computer;
  const groups = useMemo(() => groupRows(c, rows, view.config.groupBy ?? []), [c, rows, view.config.groupBy]);
  const nestField = snap.state.fields[view.config.list?.nestFieldId ?? ""];
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    setter(next);
  };
  const shownFields = fields.filter((f) => f.id !== nestField?.id).slice(0, 6);

  const add = (cells: Record<string, unknown> = {}) => {
    const rowId = newId("rec");
    if (client.dispatch({ type: "row.create", rowId, tableId: table.id, cells: { ...prefillFromFilters(snap.state, view), ...(cells as Record<string, never>) } })) openRecord(rowId);
  };

  function Item({ row, depth, path }: { row: Row; depth: number; path: string }) {
    const key = `${path}/${row.id}`;
    const children = nestField ? (((row.cells[nestField.id] as string[] | undefined) ?? []).map((id) => snap.state.rows[id]).filter(Boolean) as Row[]) : [];
    const isOpen = open.has(key);
    const color = recordColor(c, row, view.config.colors);
    return (
      <>
        <div className="list-item" style={{ paddingLeft: 12 + depth * 22 }}>
          {color && <span className={`row-color s-${color}`} aria-hidden="true" />}
          {nestField && depth < MAX_DEPTH ? (
            <button className="btn ghost small list-toggle" disabled={!children.length} aria-label={isOpen ? "Hide linked records" : "Show linked records"}
              onClick={() => toggle(open, setOpen, key)}>{children.length ? (isOpen ? "▾" : "▸") : "·"}</button>
          ) : <span className="list-toggle" />}
          <button className="list-title" onClick={() => openRecord(row.id)}>{c.primaryName(row.id)}</button>
          {depth === 0 ? (
            <span className="list-fields">
              {shownFields.filter((f) => c.display(row, f) !== "").map((f) => (
                <span key={f.id} className="list-field"><span className="muted small">{f.name}</span> <CellContent row={row} field={f} /></span>
              ))}
            </span>
          ) : <span className="list-fields muted small">{snap.state.tables[row.tableId]?.name}</span>}
          {nestField && children.length > 0 && <span className="muted small">{children.length} {nestField.name.toLowerCase()}</span>}
        </div>
        {isOpen && children.map((ch) => <Item key={`${key}/${ch.id}`} row={ch} depth={depth + 1} path={key} />)}
      </>
    );
  }

  function Group({ g, depth, path }: { g: RowGroup; depth: number; path: string }) {
    const key = `${path}/${g.field.id}:${g.key}`;
    const isClosed = closed.has(key);
    return (
      <div className="list-group">
        <button className="list-group-head" style={{ paddingLeft: 10 + depth * 18 }} onClick={() => toggle(closed, setClosed, key)} aria-expanded={!isClosed}>
          <span>{isClosed ? "▸" : "▾"}</span> <span className="muted small">{g.field.name}</span> {g.label} <span className="muted small">· {g.rows.length}</span>
        </button>
        {!isClosed && (g.children
          ? g.children.map((ch) => <Group key={`${ch.field.id}:${ch.key}`} g={ch} depth={depth + 1} path={key} />)
          : g.rows.map((r) => <Item key={r.id} row={r} depth={0} path={key} />))}
      </div>
    );
  }

  const canAdd = !table.sync && canAddRecords(snap, table) && snap.role !== "viewer" && snap.role !== "commenter";
  return (
    <div className="list-view">
      {groups ? groups.map((g) => <Group key={`${g.field.id}:${g.key}`} g={g} depth={0} path="" />) : rows.map((r) => <Item key={r.id} row={r} depth={0} path="" />)}
      {rows.length === 0 && <p className="muted" style={{ padding: 16 }}>No records to show.</p>}
      {canAdd && <button className="btn ghost list-add" onClick={() => add()}>+ Add record</button>}
    </div>
  );
}
