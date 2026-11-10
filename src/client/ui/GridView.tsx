"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { CellValue, Field, Row, View } from "@/shared/types";
import { isComputed } from "@/shared/fieldTypes";
import { groupRows, viewRows, visibleFields, type RowGroup } from "@/shared/query";
import { newId } from "@/shared/ids";
import type { Attachment } from "@/shared/types";
import { CellContent, Dialog, FieldIcon, isNumeric, Popover, useBase } from "./common";
import { AttachmentEditor, LinkPicker, SelectPicker, toEditText } from "./inputs";
import { cellActions } from "./actions";
import { prefillFromFilters } from "./prefill";

type Pos = { rowId: string; fieldId: string };
type Item = { kind: "group"; group: RowGroup; depth: number } | { kind: "row"; row: Row; index: number };

const TEXTY = new Set(["text", "longText", "number", "email", "url", "phone"]);

// Fixed heights let us work out where every row sits without rendering it.
const ROW_H = 34;
const GROUP_H = 36;
const HEAD_H = 34;
const ROWNUM_W = 56;
const OVERSCAN = 600;

/** First index whose offset is >= value. */
function lowerBound(offsets: number[], value: number): number {
  let lo = 0, hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function GridView({ view }: { view: View }) {
  const { snap, client, openRecord, openFieldDialog } = useBase();
  const { state, computer: c } = snap;
  const table = state.tables[view.tableId];
  const fields = useMemo(() => visibleFields(state, view), [state, view]);
  const rows = useMemo(() => viewRows(c, state, view), [c, state, view]);
  const groups = useMemo(() => groupRows(c, rows, view.config.groupBy ?? []), [c, rows, view.config.groupBy]);

  const items = useMemo(() => {
    const out: Item[] = [];
    let index = 0;
    const walk = (gs: RowGroup[], depth: number) => {
      for (const g of gs) {
        out.push({ kind: "group", group: g, depth });
        if (g.children) walk(g.children, depth + 1);
        else for (const row of g.rows) out.push({ kind: "row", row, index: index++ });
      }
    };
    if (groups) walk(groups, 0);
    else for (const row of rows) out.push({ kind: "row", row, index: index++ });
    return out;
  }, [groups, rows]);
  const rowIds = useMemo(() => items.filter((i): i is Extract<Item, { kind: "row" }> => i.kind === "row").map((i) => i.row.id), [items]);
  const offsets = useMemo(() => {
    const o = [0];
    for (const it of items) o.push(o[o.length - 1] + (it.kind === "group" ? GROUP_H : ROW_H));
    return o;
  }, [items]);

  // Only rows near the visible part of the scroll area are rendered.
  const gridRef = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState({ top: 0, height: 1000 });
  useEffect(() => {
    const el = gridRef.current?.closest(".view-body") as HTMLElement | null;
    if (!el) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setWin({ top: el.scrollTop, height: el.clientHeight }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { cancelAnimationFrame(raf); el.removeEventListener("scroll", update); ro.disconnect(); };
  }, []);
  const start = Math.max(0, lowerBound(offsets, win.top - HEAD_H - OVERSCAN) - 1);
  const end = Math.min(items.length, lowerBound(offsets, win.top + win.height + OVERSCAN));

  // Latest layout for callbacks that run after a re-render (e.g. right after adding a row).
  const layout = useRef({ items, offsets, cols: [] as { id: string; w: number }[] });

  /**
   * Scroll so a cell is on screen. The row may not be rendered yet, so this works
   * from known row heights and column widths rather than from DOM elements.
   */
  const ensureVisible = useCallback((rowId: string, fieldId: string) => {
    const el = gridRef.current?.closest(".view-body") as HTMLElement | null;
    const { items: its, offsets: offs, cols } = layout.current;
    const idx = its.findIndex((it) => it.kind === "row" && it.row.id === rowId);
    if (!el || idx < 0) return;
    // Up/down: the sticky header covers the top HEAD_H pixels.
    const top = offs[idx];
    const bottom = HEAD_H + offs[idx] + ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    // Left/right: the row number and primary columns stay pinned on the left.
    const ci = cols.findIndex((c) => c.id === fieldId);
    if (ci <= 0) return;
    const pinned = ROWNUM_W + cols[0].w;
    const left = ROWNUM_W + cols.slice(0, ci).reduce((s, c) => s + c.w, 0);
    const right = left + cols[ci].w;
    if (left < el.scrollLeft + pinned) el.scrollLeft = left - pinned;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
  }, []);

  const [sel, setSel] = useState<Pos | null>(null);
  const [editing, setEditing] = useState<(Pos & { seed?: string }) | null>(null);
  const [menu, setMenu] = useState<{ kind: "field"; fieldId: string } | { kind: "row"; rowId: string } | null>(null);
  // Dragging rows to reorder them. Off while sorted or grouped (the sort decides the order then).
  const [drag, setDrag] = useState<{ rowId: string; over: string | null; place: "before" | "after" } | null>(null);
  const sortedOrGrouped = (view.config.sorts?.length ?? 0) > 0 || (view.config.groupBy?.length ?? 0) > 0;
  const canDrag = !sortedOrGrouped && (snap.role === "owner" || snap.role === "editor");

  function dropRow(rowId: string, targetId: string, place: "before" | "after") {
    if (!rowId || rowId === targetId || !state.rows[rowId]) return;
    // Rows move within the table's order; "before X" means after whatever precedes X there.
    const order = table.rowOrder.filter((id) => id !== rowId);
    const i = order.indexOf(targetId);
    const afterRowId = place === "after" ? targetId : i > 0 ? order[i - 1] : null;
    client.dispatch({ type: "row.move", rowIds: [rowId], afterRowId });
  }
  const placeFor = (e: React.DragEvent): "before" | "after" => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? "before" : "after";
  };
  const isRowDrag = (e: React.DragEvent) => e.dataTransfer.types.includes("text/gridbase-row");
  const [widths, setWidths] = useState<Record<string, number>>({});
  // A hidden text box holds keyboard focus for the grid, so typed keys *and*
  // inserted text (dictation, IME, autofill) both reach the selected cell.
  const catcherRef = useRef<HTMLTextAreaElement>(null);

  const width = (f: Field) => widths[f.id] ?? view.config.fieldWidths?.[f.id] ?? (f.id === table.primaryFieldId ? 240 : 180);
  layout.current = { items, offsets, cols: fields.map((f) => ({ id: f.id, w: width(f) })) };
  const focusGrid = () => catcherRef.current?.focus({ preventScroll: true });

  // Drop the selection if its row or field disappears.
  useEffect(() => {
    if (sel && (!state.rows[sel.rowId] || !fields.some((f) => f.id === sel.fieldId))) setSel(null);
  }, [sel, state.rows, fields]);

  const move = useCallback((dr: number, dc: number) => {
    if (!sel) return;
    const r = rowIds.indexOf(sel.rowId);
    const ci = fields.findIndex((f) => f.id === sel.fieldId);
    const nr = Math.max(0, Math.min(rowIds.length - 1, r + dr));
    const nc = Math.max(0, Math.min(fields.length - 1, ci + dc));
    if (rowIds[nr] && fields[nc]) {
      setSel({ rowId: rowIds[nr], fieldId: fields[nc].id });
      ensureVisible(rowIds[nr], fields[nc].id);
    }
  }, [sel, rowIds, fields, ensureVisible]);

  const setCell = useCallback((rowId: string, field: Field, value: CellValue, newChoice?: Parameters<typeof cellActions>[4], undoKey?: string) => {
    const actions = cellActions(client.getSnapshot().state, rowId, field, value, newChoice);
    // Saves made during one editing session undo as a single step.
    if (undoKey) client.dispatchWith({ coalesce: { key: undoKey } }, ...actions);
    else client.dispatch(...actions);
  }, [client]);

  const addRow = (afterRowId?: string) => {
    const rowId = newId("rec");
    const ok = client.dispatch({ type: "row.create", rowId, tableId: table.id, afterRowId: afterRowId ?? null, cells: prefillFromFilters(state, view) });
    if (ok) {
      setSel({ rowId, fieldId: table.primaryFieldId });
      setTimeout(() => ensureVisible(rowId, table.primaryFieldId), 30);
      focusGrid();
    }
  };

  function startEdit(pos: Pos, seed?: string) {
    const field = state.fields[pos.fieldId];
    const row = state.rows[pos.rowId];
    if (!field || !row || isComputed(field.type)) return;
    if (!client.ensureCanEdit()) return; // viewers get a message instead of an editor
    if (field.type === "checkbox") return setCell(row.id, field, !row.cells[field.id]);
    // Render the editor right away so the next keystroke lands in it, not in the grid.
    flushSync(() => setEditing({ ...pos, seed: TEXTY.has(field.type) ? seed : undefined }));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (editing || !sel) return;
    const field = state.fields[sel.fieldId];
    const row = state.rows[sel.rowId];
    if (!field || !row) return;
    const k = e.key;
    if (k === "ArrowDown") { e.preventDefault(); move(1, 0); }
    else if (k === "ArrowUp") { e.preventDefault(); move(-1, 0); }
    else if (k === "ArrowRight" || (k === "Tab" && !e.shiftKey)) { e.preventDefault(); move(0, 1); }
    else if (k === "ArrowLeft" || (k === "Tab" && e.shiftKey)) { e.preventDefault(); move(0, -1); }
    else if (k === "Enter") { e.preventDefault(); if (e.shiftKey) openRecord(row.id); else startEdit(sel); }
    else if (k === "Escape") setSel(null);
    else if (k === " " && field.type === "checkbox") { e.preventDefault(); startEdit(sel); }
    else if ((k === "Backspace" || k === "Delete") && !isComputed(field.type)) { e.preventDefault(); setCell(row.id, field, null); }
    else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && TEXTY.has(field.type)) { e.preventDefault(); startEdit(sel, k); }
  }

  function onCopy(e: React.ClipboardEvent) {
    if (editing || !sel) return;
    const row = state.rows[sel.rowId], field = state.fields[sel.fieldId];
    if (!row || !field) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", c.display(row, field));
  }

  function onPaste(e: React.ClipboardEvent) {
    if (editing || !sel) return;
    const row = state.rows[sel.rowId], field = state.fields[sel.fieldId];
    if (!row || !field || isComputed(field.type) || field.type === "attachment") return;
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain").trim();
    if (field.type === "singleSelect" || field.type === "multiSelect") {
      const names = field.type === "multiSelect" ? text.split(",").map((s) => s.trim()) : [text];
      const ids = names.map((n) => field.options.choices?.find((ch) => ch.name.toLowerCase() === n.toLowerCase())?.id).filter((x): x is string => Boolean(x));
      setCell(row.id, field, field.type === "multiSelect" ? ids : ids[0] ?? null);
    } else if (field.type === "link") {
      const t = state.tables[field.options.linkedTableId ?? ""];
      const names = text.split(",").map((s) => s.trim().toLowerCase());
      setCell(row.id, field, t ? t.rowOrder.filter((id) => names.includes(c.primaryName(id).toLowerCase())) : []);
    } else {
      setCell(row.id, field, text);
    }
  }

  function startResize(e: React.MouseEvent, f: Field) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startW = width(f);
    let latest = startW;
    const onMove = (ev: MouseEvent) => {
      latest = Math.max(80, Math.min(800, startW + ev.clientX - startX));
      setWidths((w) => ({ ...w, [f.id]: latest }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      client.dispatch({ type: "view.update", viewId: view.id, config: { fieldWidths: { ...view.config.fieldWidths, [f.id]: latest } } });
      setWidths((w) => { const { [f.id]: _, ...rest } = w; return rest; });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const totalWidth = 56 + fields.reduce((s, f) => s + width(f), 0) + 120;

  return (
    <div
      className="grid" ref={gridRef} onKeyDown={onKeyDown} onCopy={onCopy} onPaste={onPaste}
      style={{ width: totalWidth, outline: "none" }} aria-label={`${table.name} grid`} role="grid" aria-rowcount={rowIds.length + 1}
    >
      <textarea
        ref={catcherRef} className="key-catcher" aria-label="Type to edit the selected cell" tabIndex={0}
        onInput={(e) => {
          const text = e.currentTarget.value;
          e.currentTarget.value = "";
          if (!text || editing || !sel) return;
          const f = state.fields[sel.fieldId];
          if (f && TEXTY.has(f.type)) startEdit(sel, text);
        }}
      />
      <div className="grid-row grid-head" role="row">
        <div className="cell rownum">#</div>
        {fields.map((f) => (
          <div key={f.id} className={`cell ${f.id === table.primaryFieldId ? "primary" : ""}`} style={{ width: width(f) }} role="columnheader"
            onDoubleClick={() => openFieldDialog({ tableId: table.id, fieldId: f.id })}>
            <FieldIcon field={f} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }} title={f.description || f.name}>{f.name}</span>
            <Popover open={menu?.kind === "field" && menu.fieldId === f.id} onClose={() => setMenu(null)} anchor={
              <button className="head-menu-btn" onClick={() => setMenu({ kind: "field", fieldId: f.id })} aria-label={`${f.name} menu`}>▾</button>
            }>
              <FieldMenu view={view} field={f} isPrimary={f.id === table.primaryFieldId} onDone={() => setMenu(null)} />
            </Popover>
            <span onMouseDown={(e) => startResize(e, f)} style={{ position: "absolute", right: -3, top: 0, bottom: 0, width: 6, cursor: "col-resize", zIndex: 2 }} />
          </div>
        ))}
        <div className="cell" style={{ width: 120, justifyContent: "center" }}>
          <button className="btn ghost" onClick={() => openFieldDialog({ tableId: table.id, afterFieldId: fields[fields.length - 1]?.id ?? null })} aria-label="Add field">+ Field</button>
        </div>
      </div>

      <div style={{ height: offsets[start] }} aria-hidden="true" />
      {items.slice(start, end).map((item) => {
        if (item.kind === "group") {
          return (
            <div key={`g-${item.group.field.id}-${item.group.key}-${item.depth}`} className="group-head" style={{ paddingLeft: 12 + item.depth * 18 }}>
              <span className="muted small">{item.group.field.name}</span> {item.group.label}
              <span className="muted small">· {item.group.rows.length}</span>
            </div>
          );
        }
        const row = item.row;
        return (
          <div
            key={row.id} role="row" aria-rowindex={item.index + 2}
            className={`grid-row ${drag?.over === row.id ? `drop-${drag.place}` : ""} ${drag?.rowId === row.id ? "dragging" : ""}`}
            // Accept on enter too: a quick drop right after entering a row has no dragover first.
            onDragEnter={(e) => { if (isRowDrag(e)) e.preventDefault(); }}
            onDragOver={(e) => {
              if (!isRowDrag(e)) return;
              e.preventDefault();
              const place = placeFor(e);
              if (drag && (drag.over !== row.id || drag.place !== place)) setDrag({ ...drag, over: row.id, place });
            }}
            onDrop={(e) => {
              if (!isRowDrag(e)) return;
              e.preventDefault();
              // Everything comes from the drop itself, so even a very quick drag lands right.
              dropRow(e.dataTransfer.getData("text/gridbase-row"), row.id, placeFor(e));
              setDrag(null);
            }}
          >
            <div className="cell rownum">
              <span
                className={`drag-handle ${canDrag ? "" : "off"}`} draggable={canDrag} aria-hidden="true"
                title={canDrag ? "Drag to reorder" : snap.role === "viewer" || snap.role === "commenter" ? "You can't change this base" : "Turn off sorting and grouping to drag records"}
                onDragStart={(e) => { e.dataTransfer.setData("text/gridbase-row", row.id); e.dataTransfer.effectAllowed = "move"; setDrag({ rowId: row.id, over: null, place: "after" }); }}
                onDragEnd={() => setDrag(null)}
              >⠿</span>
              <Popover open={menu?.kind === "row" && menu.rowId === row.id} onClose={() => setMenu(null)} anchor={
                <button className="btn ghost small" style={{ padding: "0 4px" }} onClick={() => setMenu({ kind: "row", rowId: row.id })} aria-label={`Row ${item.index + 1} menu`}>{item.index + 1}</button>
              }>
                <div className="menu">
                  <button onClick={() => { setMenu(null); openRecord(row.id); }}>⤢ Expand record</button>
                  <button onClick={() => { setMenu(null); addRow(row.id); }}>＋ Insert record below</button>
                  <button onClick={() => {
                    setMenu(null);
                    const cells: Record<string, CellValue> = {};
                    for (const f of table.fieldOrder.map((id) => state.fields[id])) if (f && !isComputed(f.type) && row.cells[f.id] !== undefined) cells[f.id] = row.cells[f.id];
                    client.dispatch({ type: "row.create", rowId: newId("rec"), tableId: table.id, afterRowId: row.id, cells });
                  }}>⧉ Duplicate record</button>
                  <hr />
                  <button style={{ color: "var(--danger)" }} onClick={() => { setMenu(null); client.dispatch({ type: "row.delete", rowIds: [row.id] }); }}>🗑 Delete record</button>
                </div>
              </Popover>
              {(snap.commentCounts[row.id] ?? 0) > 0 ? (
                <button className="comment-badge" onClick={() => openRecord(row.id)} aria-label={`${snap.commentCounts[row.id]} comments`} title="Open comments">
                  💬{snap.commentCounts[row.id]}
                </button>
              ) : (
                <button className="expand-btn" onClick={() => openRecord(row.id)} aria-label="Expand record">⤢</button>
              )}
            </div>
            {fields.map((f) => {
              const isSel = sel?.rowId === row.id && sel.fieldId === f.id;
              const isEdit = editing?.rowId === row.id && editing.fieldId === f.id;
              const err = c.isError(row, f);
              return (
                <div
                  key={f.id} id={`cell-${row.id}-${f.id}`} role="gridcell"
                  className={`cell ${f.id === table.primaryFieldId ? "primary" : ""} ${isSel ? "selected" : ""} ${isComputed(f.type) ? "computed" : ""} ${isNumeric(f) ? "num" : ""} ${f.type === "checkbox" ? "checkbox-cell" : ""} ${err ? "error" : ""}`}
                  style={{ width: width(f), overflow: isEdit ? "visible" : undefined, zIndex: isEdit ? 6 : undefined }}
                  onMouseDown={(e) => {
                    if (isEdit) return;
                    e.preventDefault(); // keep focus on the grid's key catcher
                    setSel({ rowId: row.id, fieldId: f.id });
                    if (editing) setEditing(null);
                    focusGrid();
                  }}
                  onClick={() => { if (f.type === "checkbox" && isSel) startEdit({ rowId: row.id, fieldId: f.id }); }}
                  onDoubleClick={() => startEdit({ rowId: row.id, fieldId: f.id })}
                  title={err ?? undefined}
                >
                  {isEdit ? (
                    <CellEditor
                      row={row} field={f} seed={editing?.seed}
                      onSet={(v, ch, key) => setCell(row.id, f, v, ch, key)}
                      onDone={(dr = 0, dc = 0) => { setEditing(null); focusGrid(); if (dr || dc) move(dr, dc); }}
                    />
                  ) : (
                    <CellContent row={row} field={f} />
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      <div style={{ height: offsets[items.length] - offsets[end] }} aria-hidden="true" />

      <div className="grid-row add-row">
        <div className="cell rownum" onClick={() => addRow(rowIds[rowIds.length - 1])}>+</div>
        <div className="cell primary" style={{ width: width(fields[0]) }} onClick={() => addRow(rowIds[rowIds.length - 1])}>Add record</div>
      </div>
      <div className="summary-bar">{rowIds.length} record{rowIds.length === 1 ? "" : "s"}</div>
    </div>
  );
}

/** In-cell editors. Text saves while you type (debounced), like the original app. */
function CellEditor({ row, field, seed, onSet: rawSet, onDone }: {
  row: Row; field: Field; seed?: string;
  onSet: (v: CellValue, newChoice?: Parameters<typeof cellActions>[4], undoKey?: string) => void;
  onDone: (dr?: number, dc?: number) => void;
}) {
  const session = useRef(`edit:${row.id}:${field.id}:${Math.random().toString(36).slice(2)}`);
  const onSet = (v: CellValue, ch?: Parameters<typeof cellActions>[4]) => rawSet(v, ch, session.current);
  const original = useRef(row.cells[field.id] ?? null);
  const [text, setText] = useState(() => seed ?? toEditText(field, row.cells[field.id]));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSent = useRef(toEditText(field, row.cells[field.id]));
  const finished = useRef(false);
  const finish = (dr?: number, dc?: number) => {
    finished.current = true;
    onDone(dr, dc);
  };

  const send = (t: string) => {
    if (timer.current) clearTimeout(timer.current);
    if (t !== lastSent.current) {
      lastSent.current = t;
      onSet(t === "" ? null : t);
    }
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onChangeText = (t: string) => {
    setText(t);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => send(t), 600);
  };

  if (field.type === "singleSelect" || field.type === "multiSelect") {
    const raw = row.cells[field.id];
    const ids = Array.isArray(raw) ? (raw as string[]) : typeof raw === "string" ? [raw] : [];
    return (
      <div className="popover" style={{ top: "100%", left: 0 }} onMouseDown={(e) => e.stopPropagation()}>
        <SelectPicker field={field} value={ids} onClose={() => onDone()}
          onChange={(next, ch) => onSet(field.type === "multiSelect" ? next : next[0] ?? null, ch)} />
      </div>
    );
  }
  if (field.type === "attachment") {
    return (
      <Dialog title={`${field.name}`} onClose={() => onDone()} footer={<button className="btn primary" onClick={() => onDone()}>Done</button>}>
        <AttachmentEditor value={(row.cells[field.id] as Attachment[] | undefined) ?? []} onChange={(next) => onSet(next.length ? next : null)} />
      </Dialog>
    );
  }
  if (field.type === "link") {
    const ids = (row.cells[field.id] as string[] | undefined) ?? [];
    return <LinkPicker field={field} value={ids} onChange={(next) => onSet(next)} onClose={() => onDone()} />;
  }
  if (field.type === "date") {
    return (
      <input
        className="cell-editor" autoFocus type={field.options.includeTime ? "datetime-local" : "date"} value={text}
        onChange={(e) => { setText(e.target.value); onSet(e.target.value ? (field.options.includeTime ? new Date(e.target.value).toISOString() : e.target.value) : null); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); finish(e.key === "Enter" ? 1 : 0); } }}
        onBlur={() => { if (!finished.current) onDone(); }}
      />
    );
  }
  if (field.type === "longText") {
    return (
      <textarea
        className="cell-editor" autoFocus value={text}
        onChange={(e) => onChangeText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) { e.preventDefault(); send(text); finish(); } }}
        onBlur={() => { if (finished.current) return; send(text); onDone(); }}
        onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
      />
    );
  }
  return (
    <input
      className="cell-editor" autoFocus value={text} inputMode={field.type === "number" ? "decimal" : undefined}
      aria-label={field.name}
      onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
      onChange={(e) => onChangeText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); send(text); finish(1); }
        else if (e.key === "Tab") { e.preventDefault(); send(text); finish(0, e.shiftKey ? -1 : 1); }
        else if (e.key === "Escape") {
          e.preventDefault();
          if (timer.current) clearTimeout(timer.current);
          // Put back what was there before editing started.
          if (lastSent.current !== toEditText(field, original.current)) onSet(original.current);
          finish();
        }
      }}
      onBlur={() => { if (finished.current) return; send(text); onDone(); }}
    />
  );
}

function FieldMenu({ view, field, isPrimary, onDone }: { view: View; field: Field; isPrimary: boolean; onDone: () => void }) {
  const { client, openFieldDialog } = useBase();
  const up = (config: Partial<View["config"]>) => { client.dispatch({ type: "view.update", viewId: view.id, config }); onDone(); };
  return (
    <div className="menu">
      <button onClick={() => { onDone(); openFieldDialog({ tableId: view.tableId, fieldId: field.id }); }}>✎ Edit field</button>
      <button onClick={() => { onDone(); openFieldDialog({ tableId: view.tableId, afterFieldId: field.id }); }}>＋ Insert field right</button>
      <hr />
      <button onClick={() => up({ sorts: [{ fieldId: field.id, direction: "asc" }] })}>↑ Sort A → Z</button>
      <button onClick={() => up({ sorts: [{ fieldId: field.id, direction: "desc" }] })}>↓ Sort Z → A</button>
      {view.type === "grid" && <button onClick={() => up({ groupBy: [{ fieldId: field.id, direction: "asc" }] })}>▤ Group by this field</button>}
      {!isPrimary && <button onClick={() => up({ hiddenFieldIds: [...view.config.hiddenFieldIds, field.id] })}>👁 Hide field</button>}
      {!isPrimary && (
        <>
          <hr />
          <button style={{ color: "var(--danger)" }} onClick={() => {
            onDone();
            if (confirm(`Delete the field "${field.name}"? Its data will be removed from every record.`)) client.dispatch({ type: "field.delete", fieldId: field.id });
          }}>🗑 Delete field</button>
        </>
      )}
    </div>
  );
}
