"use client";

// Print layouts (page designer): place a record's fields, fixed text, images and lines
// on a sheet of paper, then print one record or every record in a view. Positions
// are in millimetres so what you see is what comes out of the printer.

import { useMemo, useRef, useState } from "react";
import type { Attachment, Field, InterfacePage, PrintItem, Row } from "@/shared/types";
import { viewRows } from "@/shared/query";
import { isImage } from "@/shared/fieldTypes";
import { newId } from "@/shared/ids";
import { useBase } from "./common";
import { RichText } from "./richText";

const PAPER = { a4: { w: 210, h: 297, label: "A4" }, letter: { w: 215.9, h: 279.4, label: "US Letter" } } as const;
const MAX_PRINT_ALL = 200;

export function PrintPageView({ page, editing, setEditing, canEdit, onDeleted }: {
  page: InterfacePage; editing: boolean; setEditing: (v: boolean) => void; canEdit: boolean; onDeleted: () => void;
}) {
  const { snap, client } = useBase();
  const state = snap.state;
  const c = snap.computer;
  const table = page.tableId ? state.tables[page.tableId] : undefined;
  const view = page.viewId ? state.views[page.viewId] : undefined;
  const paper = PAPER[page.paper ?? "a4"];
  const items = page.items ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [printAll, setPrintAll] = useState(false);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; w: number; h: number } | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const save = (next: InterfacePage) => client.dispatch({ type: "page.upsert", page: next });
  const setItem = (it: PrintItem) => save({ ...page, items: items.map((x) => (x.id === it.id ? it : x)) });

  const rows = useMemo(() => {
    if (!table) return [] as Row[];
    return view ? viewRows(c, state, view) : table.rowOrder.map((id) => state.rows[id]).filter(Boolean);
  }, [table, view, c, state]);
  const row = (picked && state.rows[picked]?.tableId === table?.id ? state.rows[picked] : undefined) ?? rows[0];
  const fields = table ? table.fieldOrder.map((id) => state.fields[id]).filter(Boolean) as Field[] : [];
  const sel = items.find((x) => x.id === selected);

  function startDrag(e: React.PointerEvent, it: PrintItem, mode: "move" | "size") {
    if (!editing || !sheetRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    setSelected(it.id);
    const mm = paper.w / sheetRef.current.getBoundingClientRect().width;
    const sx = e.clientX, sy = e.clientY;
    let cur = { id: it.id, x: it.x, y: it.y, w: it.w, h: it.h };
    const round = (n: number) => Math.round(n * 2) / 2;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) * mm, dy = (ev.clientY - sy) * mm;
      cur = mode === "move"
        ? { ...cur, x: round(Math.min(paper.w - it.w, Math.max(0, it.x + dx))), y: round(Math.min(paper.h - it.h, Math.max(0, it.y + dy))) }
        : { ...cur, w: round(Math.min(paper.w - it.x, Math.max(2, it.w + dx))), h: round(Math.min(paper.h - it.y, Math.max(1, it.h + dy))) };
      setDrag(cur);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (cur.x !== it.x || cur.y !== it.y || cur.w !== it.w || cur.h !== it.h) setItem({ ...it, ...cur });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const add = (kind: PrintItem["kind"]) => {
    const bottom = items.reduce((m, x) => Math.max(m, x.y + x.h), 10);
    const y = Math.min(paper.h - 20, bottom + 4);
    const base = { id: newId("prt"), x: 20, y, size: 11, bold: false, label: false, align: "left" as const };
    const it: PrintItem = kind === "line" ? { ...base, kind, w: 170, h: 1 }
      : kind === "text" ? { ...base, kind, w: 170, h: 12, text: "Text with {Field name} placeholders" }
      : kind === "image" ? { ...base, kind, w: 60, h: 40, fieldId: fields.find((f) => f.type === "attachment")?.id ?? null }
      : { ...base, kind, w: 170, h: 12, label: true, fieldId: fields[0]?.id ?? null };
    if ((kind === "image" && !it.fieldId)) return alert("This table has no attachment field for images.");
    if (save({ ...page, items: [...items, it] })) setSelected(it.id);
  };

  const print = () => {
    // The paper size goes to the printer through an @page rule.
    const style = document.createElement("style");
    style.textContent = `@page { size: ${page.paper === "letter" ? "letter" : "A4"}; margin: 0; }`;
    document.head.appendChild(style);
    document.body.classList.add("printing-layout");
    setTimeout(() => {
      window.print();
      document.body.classList.remove("printing-layout");
      style.remove();
    }, 50);
  };

  const sheets = printAll ? rows.slice(0, MAX_PRINT_ALL) : row ? [row] : [];
  return (
    <div className="page-shell">
      <div className="toolbar">
        {editing ? (
          <input className="input" style={{ width: 220 }} defaultValue={page.name} aria-label="Page name" key={page.name}
            onBlur={(e) => e.target.value.trim() && e.target.value !== page.name && save({ ...page, name: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        ) : <strong>{page.name}</strong>}
        <label className="row small">Record
          <select className="select" style={{ width: 200 }} value={row?.id ?? ""} onChange={(e) => setPicked(e.target.value)} disabled={printAll}>
            {rows.slice(0, 1000).map((r) => <option key={r.id} value={r.id}>{c.primaryName(r.id)}</option>)}
          </select>
        </label>
        <label className="row small" title={`Prints one sheet per record (up to ${MAX_PRINT_ALL})`}><input type="checkbox" checked={printAll} onChange={(e) => setPrintAll(e.target.checked)} /> All {rows.length > MAX_PRINT_ALL ? `(first ${MAX_PRINT_ALL})` : `(${rows.length})`}</label>
        <span className="spacer" />
        {editing && (
          <>
            <button className="btn small" onClick={() => add("field")}>＋ Field</button>
            <button className="btn small" onClick={() => add("text")}>＋ Text</button>
            <button className="btn small" onClick={() => add("image")}>＋ Image</button>
            <button className="btn small" onClick={() => add("line")}>＋ Line</button>
            <button className="btn ghost danger" onClick={() => { if (confirm(`Delete the page "${page.name}"?`) && client.dispatch({ type: "page.delete", pageId: page.id })) onDeleted(); }}>Delete page</button>
          </>
        )}
        <button className="btn primary" onClick={print} disabled={!sheets.length}>🖨 Print</button>
        {canEdit && <button className={`btn ${editing ? "primary" : ""}`} onClick={() => { setEditing(!editing); setSelected(null); }}>{editing ? "Done" : "✎ Edit layout"}</button>}
      </div>
      <div className="page-body">
        <div className="print-scroll" onPointerDown={() => editing && setSelected(null)}>
          <div className="print-area">
            {sheets.length === 0 && <p className="muted">No records to print.</p>}
            {sheets.map((r, i) => (
              <div key={r.id} ref={i === 0 ? sheetRef : undefined} className={`print-sheet ${editing ? "editing" : ""}`} style={{ width: `${paper.w}mm`, height: `${paper.h}mm` }}>
                {items.map((raw) => {
                  const it = drag?.id === raw.id ? { ...raw, ...drag } : raw;
                  return (
                    <div key={it.id} className={`print-item kind-${it.kind} ${selected === it.id && i === 0 ? "selected" : ""}`}
                      style={{ left: `${it.x}mm`, top: `${it.y}mm`, width: `${it.w}mm`, height: it.kind === "line" ? 0 : `${it.h}mm`, fontSize: `${it.size}pt`, fontWeight: it.bold ? 700 : 400, textAlign: it.align }}
                      onPointerDown={(e) => i === 0 && startDrag(e, raw, "move")}>
                      <PrintItemContent it={it} row={r} />
                      {editing && i === 0 && it.kind !== "line" && <span className="print-resize" onPointerDown={(e) => startDrag(e, raw, "size")} />}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        {editing && (
          <aside className="el-settings">
            <strong>{sel ? "Item" : "Layout"}</strong>
            {!sel && (
              <>
                <label className="field-label">Table
                  <select className="select" value={page.tableId ?? ""} onChange={(e) => {
                    const t = state.tables[e.target.value];
                    if (t) save({ ...page, tableId: t.id, viewId: null, items: [] });
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
                <label className="field-label">Paper
                  <select className="select" value={page.paper ?? "a4"} onChange={(e) => save({ ...page, paper: e.target.value as "a4" | "letter" })}>
                    {Object.entries(PAPER).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
                  </select>
                </label>
                <p className="muted small">Click an item on the sheet to change it. Drag to move, drag the corner to resize.</p>
              </>
            )}
            {sel && (
              <>
                {(sel.kind === "field" || sel.kind === "image") && (
                  <label className="field-label">Field
                    <select className="select" value={sel.fieldId ?? ""} onChange={(e) => setItem({ ...sel, fieldId: e.target.value })}>
                      {fields.filter((f) => sel.kind === "field" || f.type === "attachment").map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                  </label>
                )}
                {sel.kind === "text" && (
                  <label className="field-label">Text ({"{Field name}"} is replaced by the record&apos;s value)
                    <textarea className="textarea" rows={4} value={sel.text ?? ""} onChange={(e) => setItem({ ...sel, text: e.target.value })} />
                  </label>
                )}
                {sel.kind !== "line" && sel.kind !== "image" && (
                  <>
                    <label className="field-label">Size (pt)<input className="input" type="number" min={6} max={72} value={sel.size} onChange={(e) => setItem({ ...sel, size: Number(e.target.value) || 11 })} /></label>
                    <label className="row small"><input type="checkbox" checked={sel.bold} onChange={(e) => setItem({ ...sel, bold: e.target.checked })} /> Bold</label>
                    {sel.kind === "field" && <label className="row small"><input type="checkbox" checked={sel.label} onChange={(e) => setItem({ ...sel, label: e.target.checked })} /> Show the field name</label>}
                    <label className="field-label">Align
                      <select className="select" value={sel.align} onChange={(e) => setItem({ ...sel, align: e.target.value as PrintItem["align"] })}>
                        <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
                      </select>
                    </label>
                  </>
                )}
                <div className="row small" style={{ gap: 4, flexWrap: "wrap" }}>
                  {(["x", "y", "w", "h"] as const).filter((k) => sel.kind !== "line" || k !== "h").map((k) => (
                    <label key={k} className="row small">{k}<input className="input" style={{ width: 60 }} type="number" step={0.5} value={sel[k]}
                      onChange={(e) => setItem({ ...sel, [k]: Math.max(0, Number(e.target.value) || 0) })} /></label>
                  ))}
                  <span className="muted small">mm</span>
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn small" onClick={() => setSelected(null)}>Back</button>
                  <span className="spacer" />
                  <button className="btn ghost small danger" onClick={() => { save({ ...page, items: items.filter((x) => x.id !== sel.id) }); setSelected(null); }}>Remove</button>
                </div>
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function PrintItemContent({ it, row }: { it: PrintItem; row: Row }) {
  const { snap } = useBase();
  const c = snap.computer;
  const field = it.fieldId ? snap.state.fields[it.fieldId] : undefined;
  switch (it.kind) {
    case "line":
      return <hr className="print-line" />;
    case "image": {
      const img = field ? ((row.cells[field.id] as Attachment[] | undefined) ?? []).find(isImage) : undefined;
      // eslint-disable-next-line @next/next/no-img-element
      return img ? <img src={img.url} alt={img.name} className="print-img" /> : <span className="print-empty">No image</span>;
    }
    case "text": {
      const fields = snap.state.tables[row.tableId]?.fieldOrder.map((id) => snap.state.fields[id]).filter(Boolean) ?? [];
      const text = (it.text ?? "").replace(/\{([^}]+)\}/g, (m, name: string) => {
        const f = fields.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
        return f ? c.display(row, f) : m;
      });
      return <div className="print-text">{text}</div>;
    }
    default:
      if (!field) return <span className="print-empty">Missing field</span>;
      return (
        <div>
          {it.label && <div className="print-label">{field.name}</div>}
          {field.type === "longText" && field.options.richText
            ? <RichText text={typeof row.cells[field.id] === "string" ? (row.cells[field.id] as string) : ""} />
            : <div className="print-text">{c.display(row, field)}</div>}
        </div>
      );
  }
}
