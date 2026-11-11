"use client";

// Interface pages: dashboards made of numbers, charts, record lists, maps, text and buttons
// on a 12-column grid. Editors switch on "Edit page" to drag, resize and set up elements.

import { useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { Aggregate, BaseState, ElementSource, Field, InterfacePage, PageElement } from "@/shared/types";
import { Computer } from "@/shared/compute";
import { aggregate, chartData, controlChoices, formatTotal, mapPoints, narrowBy, newElement, sourceRows, type ChartPoint, type Narrow } from "@/shared/interfaces";
import { newPublicToken } from "@/shared/publicForm";
import { RecordPageView } from "./RecordPage";
import { PrintPageView } from "./PrintLayout";
import { newId } from "@/shared/ids";
import { Dialog, Popover, useBase } from "./common";
import { Chart, ChartTable } from "./charts";

const MapElement = dynamic(() => import("./MapElement").then((m) => m.MapElement), { ssr: false, loading: () => <div className="muted small chart-empty">Loading map…</div> });

const ROW_H = 40;
const GAP = 12;
const FN_LABEL: Record<Aggregate, string> = { count: "Count of records", sum: "Sum", avg: "Average", min: "Smallest", max: "Largest" };
const KIND_LABEL: Record<PageElement["kind"], string> = { number: "Number", chart: "Chart", list: "Record list", map: "Map", text: "Text", button: "Button" };

export function InterfacesView({ onOpenView, sidebar = true, onPicked }: { onOpenView: (viewId: string) => void; sidebar?: boolean; onPicked?: () => void }) {
  const { snap, client } = useBase();
  const state = snap.state;
  const pages = Object.values(state.pages ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  const [pageId, setPageId] = useState<string | null>(null);
  const page = (pageId && state.pages?.[pageId]) || pages[0];
  const [editing, setEditing] = useState(false);
  const canEdit = snap.role === "owner" || snap.role === "editor";

  const [newMenu, setNewMenu] = useState(false);
  const addPage = (kind: "dashboard" | "record" | "print" = "dashboard") => {
    setNewMenu(false);
    const taken = new Set(pages.map((p) => p.name.toLowerCase()));
    const label = kind === "record" ? "Record review" : kind === "print" ? "Print layout" : "Dashboard";
    let name = label;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${label} ${i}`;
    const blank: InterfacePage = { id: newId("pag"), name, elements: [] };
    const t = state.tables[state.tableOrder[0]];
    if (kind === "dashboard") {
      // Each starter element is placed after the ones before it.
      if (state.tableOrder.length) for (const k of ["number", "chart", "list"] as const) blank.elements.push(newElement(state, k, blank));
    } else if (t) {
      blank.kind = kind;
      blank.tableId = t.id;
      blank.viewId = null;
      if (kind === "record") blank.fieldIds = t.fieldOrder.slice(0, 12);
      else {
        blank.paper = "a4";
        blank.items = [
          { id: newId("prt"), kind: "field", fieldId: t.primaryFieldId, x: 20, y: 20, w: 170, h: 14, size: 20, bold: true, label: false, align: "left" },
          ...t.fieldOrder.slice(1, 7).map((fid, i) => ({ id: newId("prt"), kind: "field" as const, fieldId: fid, x: 20, y: 44 + i * 16, w: 170, h: 12, size: 11, bold: false, label: true, align: "left" as const })),
        ];
      }
    } else return;
    if (client.dispatch({ type: "page.upsert", page: blank })) { setPageId(blank.id); setEditing(kind !== "record"); }
  };

  return (
    <div className="workspace">
      <aside className={`sidebar ${sidebar ? "" : "collapsed"}`}>
        <div className="stack" style={{ gap: 2 }}>
          <span className="muted small" style={{ padding: "0 8px 4px" }}>Pages</span>
          {pages.map((p) => (
            <button key={p.id} className={`view-item ${page?.id === p.id ? "active" : ""}`} onClick={() => { setPageId(p.id); onPicked?.(); }}>
              {p.kind === "record" ? "▤" : p.kind === "print" ? "🖨" : "▦"} {p.name}{p.shareToken ? " 🌐" : ""}
            </button>
          ))}
          {pages.length === 0 && <span className="muted small" style={{ padding: "0 8px" }}>No pages yet.</span>}
          {canEdit && (
            <Popover open={newMenu} onClose={() => setNewMenu(false)} anchor={<button className="view-item" onClick={() => setNewMenu(!newMenu)}>＋ New page</button>}>
              <div className="menu">
                <button onClick={() => addPage("dashboard")}>▦ Dashboard <span className="muted small">numbers, charts, lists, maps</span></button>
                <button disabled={!state.tableOrder.length} onClick={() => addPage("record")}>▤ Record review <span className="muted small">pick a record, see its details</span></button>
                <button disabled={!state.tableOrder.length} onClick={() => addPage("print")}>🖨 Print layout <span className="muted small">invoices, labels, one-pagers</span></button>
              </div>
            </Popover>
          )}
        </div>
      </aside>
      <section className="main">
        {!page ? (
          <div className="interface-empty">
            <h2>Interfaces</h2>
            <p className="muted">Build dashboards from your data: totals, charts, record lists, maps, text and buttons. Everyone in the base can view them.</p>
            {canEdit && <button className="btn primary" onClick={() => addPage()}>Create a page</button>}
          </div>
        ) : page.kind === "record" ? (
          <RecordPageView key={page.id} page={page} editing={editing && canEdit} setEditing={setEditing} canEdit={canEdit} onDeleted={() => { setPageId(null); setEditing(false); }} />
        ) : page.kind === "print" ? (
          <PrintPageView key={page.id} page={page} editing={editing && canEdit} setEditing={setEditing} canEdit={canEdit} onDeleted={() => { setPageId(null); setEditing(false); }} />
        ) : (
          <PageView key={page.id} page={page} editing={editing && canEdit} setEditing={setEditing} canEdit={canEdit} onOpenView={onOpenView}
            onDeleted={() => { setPageId(null); setEditing(false); }} />
        )}
      </section>
    </div>
  );
}

function PageView({ page, editing, setEditing, canEdit, onDeleted, onOpenView }: {
  page: InterfacePage; editing: boolean; setEditing: (v: boolean) => void; canEdit: boolean; onDeleted: () => void; onOpenView: (viewId: string) => void;
}) {
  const { snap, client } = useBase();
  const state = snap.state;
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; w: number; h: number } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const canvas = useRef<HTMLDivElement>(null);
  const computer = useMemo(() => new Computer(state), [state]);
  const controls = page.controls ?? [];
  const narrow = useMemo(() => narrowBy(computer, state, controls, values), [computer, state, controls, values]);
  const save = (next: InterfacePage) => client.dispatch({ type: "page.upsert", page: next });
  const update = (el: PageElement) => save({ ...page, elements: page.elements.map((e) => (e.id === el.id ? el : e)) });
  const sel = page.elements.find((e) => e.id === selected);

  /** Drag to move (mode "move") or resize ("size"), snapping to grid cells. */
  function startDrag(e: React.PointerEvent, el: PageElement, mode: "move" | "size") {
    if (!editing || !canvas.current) return;
    e.preventDefault();
    e.stopPropagation();
    setSelected(el.id);
    const colW = (canvas.current.clientWidth + GAP) / 12;
    const rowH = ROW_H + GAP;
    const sx = e.clientX, sy = e.clientY;
    let cur = { id: el.id, x: el.x, y: el.y, w: el.w, h: el.h };
    const move = (ev: PointerEvent) => {
      const dx = Math.round((ev.clientX - sx) / colW), dy = Math.round((ev.clientY - sy) / rowH);
      cur = mode === "move"
        ? { ...cur, x: Math.min(12 - el.w, Math.max(0, el.x + dx)), y: Math.max(0, Math.min(500, el.y + dy)) }
        : { ...cur, w: Math.min(12 - el.x, Math.max(1, el.w + dx)), h: Math.min(40, Math.max(1, el.h + dy)) };
      setDrag(cur);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (cur.x !== el.x || cur.y !== el.y || cur.w !== el.w || cur.h !== el.h) update({ ...el, x: cur.x, y: cur.y, w: cur.w, h: cur.h });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const add = (kind: PageElement["kind"]) => {
    const el = newElement(state, kind, page);
    if (save({ ...page, elements: [...page.elements, el] })) setSelected(el.id);
    setAddOpen(false);
  };

  return (
    <div className={`page-shell ${editing ? "editing" : ""}`}>
      <div className="toolbar">
        {editing ? (
          <input className="input" style={{ width: 240 }} defaultValue={page.name} aria-label="Page name" key={page.name}
            onBlur={(e) => e.target.value.trim() && e.target.value !== page.name && save({ ...page, name: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        ) : <strong>{page.name}</strong>}
        <span className="spacer" />
        {editing && (
          <Popover open={addOpen} onClose={() => setAddOpen(false)} align="right" anchor={<button className="btn" onClick={() => setAddOpen(!addOpen)}>＋ Add element</button>}>
            <div className="menu">
              {(Object.keys(KIND_LABEL) as PageElement["kind"][]).map((k) => (
                <button key={k} disabled={k !== "text" && k !== "button" && state.tableOrder.length === 0} onClick={() => add(k)}>{KIND_LABEL[k]}</button>
              ))}
            </div>
          </Popover>
        )}
        {editing && (
          <Popover open={filtersOpen} onClose={() => setFiltersOpen(false)} align="right" anchor={<button className="btn" onClick={() => setFiltersOpen(!filtersOpen)}>⏚ Viewer filters{controls.length ? ` (${controls.length})` : ""}</button>}>
            <ControlsEditor page={page} onSave={save} />
          </Popover>
        )}
        {editing && <button className="btn ghost danger" onClick={() => { if (confirm(`Delete the page "${page.name}"?`) && client.dispatch({ type: "page.delete", pageId: page.id })) onDeleted(); }}>Delete page</button>}
        {canEdit && !editing && <button className="btn ghost" onClick={() => setPublishing(true)}>🌐 {page.shareToken ? "Published" : "Publish"}</button>}
        {canEdit && <button className={`btn ${editing ? "primary" : ""}`} onClick={() => { setEditing(!editing); setSelected(null); }}>{editing ? "Done" : "✎ Edit page"}</button>}
      </div>
      {publishing && <PublishDialog page={page} onClose={() => setPublishing(false)} />}
      {controls.length > 0 && (
        <div className="page-controls">
          {controls.map((ctl) => {
            const f = state.fields[ctl.fieldId];
            if (!f) return null;
            const choices = controlChoices(computer, state, ctl);
            return (
              <label key={ctl.id} className="row small">{f.name}
                {choices ? (
                  <select className="select" style={{ width: 160 }} value={values[ctl.id] ?? ""} onChange={(e) => setValues({ ...values, [ctl.id]: e.target.value })}>
                    <option value="">Any</option>
                    {choices.map((ch) => <option key={ch.value} value={ch.value}>{ch.label}</option>)}
                  </select>
                ) : (
                  <input className="input" style={{ width: 160 }} placeholder="Contains…" value={values[ctl.id] ?? ""} onChange={(e) => setValues({ ...values, [ctl.id]: e.target.value })} />
                )}
              </label>
            );
          })}
          {Object.values(values).some(Boolean) && <button className="btn ghost small" onClick={() => setValues({})}>Clear</button>}
        </div>
      )}
      <div className="page-body">
        <div className="page-scroll" onPointerDown={() => editing && setSelected(null)}>
          {page.elements.length === 0 && (
            <div className="interface-empty"><p className="muted">This page is empty.{canEdit ? " Choose Edit page, then Add element." : ""}</p></div>
          )}
          <div ref={canvas} className="page-canvas" style={{ gridAutoRows: ROW_H, gap: GAP }}>
            {page.elements.map((el) => {
              const box = drag?.id === el.id ? { ...el, ...drag } : el;
              return (
                <div key={el.id} className={`page-el kind-${el.kind} ${selected === el.id ? "selected" : ""}`}
                  style={{ gridColumn: `${box.x + 1} / span ${box.w}`, gridRow: `${box.y + 1} / span ${box.h}`, ["--h" as string]: `${box.h * ROW_H + (box.h - 1) * GAP}px` }}
                  onPointerDown={(e) => { if (editing) { e.stopPropagation(); setSelected(el.id); } }}>
                  {editing && <div className="el-handle" onPointerDown={(e) => startDrag(e, el, "move")} title="Drag to move">⋮⋮ {el.title || KIND_LABEL[el.kind]}</div>}
                  <ElementView el={el} state={state} c={computer} onOpenView={onOpenView} narrow={narrow} />
                  {editing && <div className="el-resize" onPointerDown={(e) => startDrag(e, el, "size")} title="Drag to resize" />}
                </div>
              );
            })}
          </div>
        </div>
        {editing && sel && (
          <ElementSettings key={sel.id} el={sel} onChange={update} onClose={() => setSelected(null)}
            onDelete={() => { save({ ...page, elements: page.elements.filter((e) => e.id !== sel.id) }); setSelected(null); }}
            onDuplicate={() => { const copy = { ...structuredClone(sel), id: newId("elm"), y: page.elements.reduce((m, e) => Math.max(m, e.y + e.h), 0) }; save({ ...page, elements: [...page.elements, copy] }); setSelected(copy.id); }} />
        )}
      </div>
    </div>
  );
}

// ---- elements ----

function ElementView({ el, state, c, onOpenView, narrow }: { el: PageElement; state: BaseState; c: Computer; onOpenView: (viewId: string) => void; narrow?: Narrow }) {
  const { openRecord, snap } = useBase();
  const [asTable, setAsTable] = useState(false);
  const [picked, setPicked] = useState<ChartPoint | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const missing = "source" in el && !state.tables[el.source.tableId];
  if (missing) return <div className="el-body muted small">This element's table was deleted.</div>;

  switch (el.kind) {
    case "number": {
      const field = el.fieldId ? state.fields[el.fieldId] : undefined;
      const rows = sourceRows(c, state, el.source, narrow);
      const v = aggregate(c, rows, field, el.fn);
      return (
        <div className="el-body number-tile">
          <span className="muted small">{el.title || FN_LABEL[el.fn]}</span>
          <span className="big">{formatTotal(v, field, el.fn)}</span>
          <span className="muted small">{el.fn === "count" ? "records" : `${FN_LABEL[el.fn].toLowerCase()} of ${field?.name ?? "?"}`} · {sourceName(state, el.source)}</span>
        </div>
      );
    }
    case "chart": {
      const data = chartData(c, state, el, narrow);
      const field = el.fieldId ? state.fields[el.fieldId] : undefined;
      const fmt = (n: number) => formatTotal(n, field, el.fn);
      const valueLabel = el.fn === "count" ? "Records" : `${FN_LABEL[el.fn]} of ${field?.name ?? "?"}`;
      return (
        <div className="el-body">
          <div className="el-title-row">
            <strong className="small">{el.title || "Chart"}</strong>
            <span className="muted small">{valueLabel}</span>
            <span className="spacer" />
            <button className="btn ghost small" onClick={() => setAsTable(!asTable)} aria-pressed={asTable}>{asTable ? "Chart" : "Table"}</button>
          </div>
          <div className="el-fill">{asTable ? <ChartTable data={data} format={fmt} valueLabel={valueLabel} /> : <Chart type={el.chartType} data={data} format={fmt} onPick={setPicked} />}</div>
          {picked && <RecordsDialog title={`${picked.label}: ${picked.rowIds.length} record${picked.rowIds.length === 1 ? "" : "s"}`} rowIds={picked.rowIds} onClose={() => setPicked(null)} />}
        </div>
      );
    }
    case "list": {
      const rows = sourceRows(c, state, el.source, narrow).slice(0, el.limit);
      const fields = el.fieldIds.map((id) => state.fields[id]).filter(Boolean) as Field[];
      return (
        <div className="el-body">
          <div className="el-title-row"><strong className="small">{el.title || "Records"}</strong><span className="muted small">{sourceName(state, el.source)}</span></div>
          <div className="el-fill chart-table">
            <table>
              <thead><tr>{fields.map((f) => <th key={f.id}>{f.name}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => openRecord(r.id)}>{fields.map((f) => <td key={f.id}>{c.display(r, f)}</td>)}</tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <span className="muted small">No records.</span>}
          </div>
        </div>
      );
    }
    case "map": {
      const { points, skipped } = mapPoints(c, state, el, narrow);
      return (
        <div className="el-body">
          <div className="el-title-row"><strong className="small">{el.title || "Map"}</strong><span className="muted small">{points.length} place{points.length === 1 ? "" : "s"}{skipped ? ` · ${skipped} without a readable location` : ""}</span></div>
          <div className="el-fill"><MapElement points={points} onOpen={openRecord} /></div>
        </div>
      );
    }
    case "text":
      return <div className="el-body text-el">{el.text.split("\n").map((line, i) => line.startsWith("# ") ? <h2 key={i}>{line.slice(2)}</h2> : line.startsWith("## ") ? <h3 key={i}>{line.slice(3)}</h3> : <p key={i}>{line || " "}</p>)}</div>;
    case "button": {
      async function click() {
        if (el.kind !== "button") return;
        const a = el.action;
        if (a.type === "url") return void window.open(a.url, "_blank", "noopener,noreferrer");
        if (a.type === "view") return onOpenView(a.viewId);
        setMsg("Running…");
        const r = await fetch(`/api/bases/${state.base.id}/automations/${a.automationId}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }).catch(() => null);
        const d = await r?.json().catch(() => ({}));
        setMsg(r?.ok ? (d.status === "success" ? "Done ✓" : d.message) : d?.error ?? "Failed");
        setTimeout(() => setMsg(null), 4000);
      }
      const disabled = el.action.type === "automation" && !(snap.role === "owner" || snap.role === "editor");
      return (
        <div className="el-body button-el">
          {el.title && <span className="muted small">{el.title}</span>}
          <button className="btn primary" disabled={disabled} title={disabled ? "Only editors can run automations" : undefined} onClick={() => void click()}>{el.label}</button>
          {msg && <span className="muted small" role="status">{msg}</span>}
        </div>
      );
    }
  }
}

const sourceName = (state: BaseState, s: ElementSource) => `${state.tables[s.tableId]?.name ?? "?"}${s.viewId && state.views[s.viewId] ? ` · ${state.views[s.viewId].name}` : ""}`;

function RecordsDialog({ title, rowIds, onClose }: { title: string; rowIds: string[]; onClose: () => void }) {
  const { snap, openRecord } = useBase();
  const c = useMemo(() => new Computer(snap.state), [snap.state]);
  return (
    <Dialog title={title} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Close</button>}>
      <div className="stack" style={{ gap: 2, maxHeight: 420, overflow: "auto" }}>
        {rowIds.filter((id) => snap.state.rows[id]).slice(0, 500).map((id) => (
          <button key={id} className="view-item" onClick={() => { onClose(); openRecord(id); }}>{c.primaryName(id) || "(unnamed record)"}</button>
        ))}
      </div>
    </Dialog>
  );
}

// ---- settings panel ----

function ElementSettings({ el, onChange, onClose, onDelete, onDuplicate }: { el: PageElement; onChange: (el: PageElement) => void; onClose: () => void; onDelete: () => void; onDuplicate: () => void }) {
  const { snap } = useBase();
  const state = snap.state;
  const set = (patch: Partial<PageElement>) => onChange({ ...el, ...patch } as PageElement);
  const src = "source" in el ? el.source : null;
  const fields = src ? (state.tables[src.tableId]?.fieldOrder ?? []).map((id) => state.fields[id]).filter(Boolean) as Field[] : [];
  const numeric = fields.filter((f) => ["number", "rating", "duration", "count", "rollup", "formula", "autoNumber", "checkbox", "lookup"].includes(f.type));
  const FieldPick = ({ value, onPick, list, label, allowNone }: { value: string | null; onPick: (id: string | null) => void; list: Field[]; label: string; allowNone?: string }) => (
    <label className="field-label">{label}
      <select className="select" value={value ?? ""} onChange={(e) => onPick(e.target.value || null)}>
        {allowNone !== undefined ? <option value="">{allowNone}</option> : !value && <option value="">Choose…</option>}
        {list.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
    </label>
  );
  const setSource = (s: ElementSource) => {
    const tableChanged = src && s.tableId !== src.tableId;
    if (!tableChanged) return set({ source: s } as Partial<PageElement>);
    // A new table: start the element over so its field choices belong to that table.
    const fresh = newElement(state, el.kind, { id: "pag00000000000000", name: "", elements: [] }, s.tableId);
    onChange({ ...fresh, id: el.id, x: el.x, y: el.y, w: el.w, h: el.h, title: el.title } as PageElement);
  };

  return (
    <aside className="el-settings">
      <div className="row"><strong>{KIND_LABEL[el.kind]}</strong><span className="spacer" /><button className="btn ghost small" onClick={onClose} aria-label="Close settings">✕</button></div>
      <label className="field-label">Title<input className="input" value={el.title} onChange={(e) => set({ title: e.target.value })} /></label>
      {src && (
        <>
          <label className="field-label">Table
            <select className="select" value={src.tableId} onChange={(e) => setSource({ tableId: e.target.value, viewId: null })}>
              {state.tableOrder.map((id) => <option key={id} value={id}>{state.tables[id].name}</option>)}
            </select>
          </label>
          <label className="field-label">Records from
            <select className="select" value={src.viewId ?? ""} onChange={(e) => setSource({ ...src, viewId: e.target.value || null })}>
              <option value="">All records</option>
              {(state.tables[src.tableId]?.viewOrder ?? []).map((id) => state.views[id]).filter((v) => v && v.type !== "form").map((v) => <option key={v.id} value={v.id}>View: {v.name}</option>)}
            </select>
          </label>
        </>
      )}
      {(el.kind === "number" || el.kind === "chart") && (
        <>
          {el.kind === "chart" && (
            <>
              <label className="field-label">Chart type
                <select className="select" value={el.chartType} onChange={(e) => set({ chartType: e.target.value as "bar" | "line" | "pie" })}>
                  <option value="bar">Bar</option><option value="line">Line (for dates and ordered values)</option><option value="pie">Pie (parts of a whole)</option>
                </select>
              </label>
              <FieldPick label="Group by" value={el.groupFieldId} list={fields.filter((f) => f.type !== "attachment" && f.type !== "button")} onPick={(id) => id && set({ groupFieldId: id })} />
            </>
          )}
          <label className="field-label">Value
            <select className="select" value={el.fn} onChange={(e) => { const fn = e.target.value as Aggregate; set({ fn, fieldId: fn === "count" ? el.fieldId : el.fieldId ?? numeric[0]?.id ?? null }); }}>
              {(Object.keys(FN_LABEL) as Aggregate[]).map((k) => <option key={k} value={k}>{FN_LABEL[k]}</option>)}
            </select>
          </label>
          {el.fn !== "count" && <FieldPick label="Of field" value={el.fieldId} list={numeric} onPick={(id) => set({ fieldId: id })} />}
        </>
      )}
      {el.kind === "list" && (
        <>
          <div className="field-label">Fields</div>
          <div className="stack" style={{ gap: 2, maxHeight: 200, overflow: "auto" }}>
            {fields.map((f) => (
              <label key={f.id} className="row small"><input type="checkbox" checked={el.fieldIds.includes(f.id)}
                onChange={(e) => set({ fieldIds: e.target.checked ? fields.filter((x) => x.id === f.id || el.fieldIds.includes(x.id)).map((x) => x.id) : el.fieldIds.filter((x) => x !== f.id) })} /> {f.name}</label>
            ))}
          </div>
          <label className="field-label">Show up to
            <input className="input" type="number" min={1} max={500} value={el.limit} onChange={(e) => set({ limit: Math.min(500, Math.max(1, Number(e.target.value) || 1)) })} />
          </label>
        </>
      )}
      {el.kind === "map" && (
        <>
          <FieldPick label={el.lngFieldId ? "Latitude field" : "Location field (text like “40.7, -74.0”)"} value={el.locationFieldId} list={fields} onPick={(id) => id && set({ locationFieldId: id })} />
          <FieldPick label="Longitude field" value={el.lngFieldId} list={numeric} allowNone="(in the location field)" onPick={(id) => set({ lngFieldId: id })} />
          <FieldPick label="Label" value={el.labelFieldId} list={fields} allowNone="Record name" onPick={(id) => set({ labelFieldId: id })} />
          <p className="muted small" style={{ margin: 0 }}>Map tiles load from OpenStreetMap in the viewer's browser.</p>
        </>
      )}
      {el.kind === "text" && (
        <label className="field-label">Text (lines starting with # are headings)
          <textarea className="textarea" rows={8} value={el.text} onChange={(e) => set({ text: e.target.value })} />
        </label>
      )}
      {el.kind === "button" && (
        <>
          <label className="field-label">Label<input className="input" value={el.label} maxLength={80} onChange={(e) => set({ label: e.target.value })} /></label>
          <label className="field-label">When clicked
            <select className="select" value={el.action.type} onChange={(e) => {
              const t = e.target.value;
              const firstView = Object.values(state.views)[0]?.id ?? "";
              const once = Object.values(state.automations).find((a) => a.trigger.type === "schedule" && !a.trigger.viewId)?.id ?? "";
              set({ action: t === "url" ? { type: "url", url: "https://" } : t === "view" ? { type: "view", viewId: firstView } : { type: "automation", automationId: once } });
            }}>
              <option value="url">Open a link</option><option value="view">Open a table view</option><option value="automation">Run an automation</option>
            </select>
          </label>
          {el.action.type === "url" && <label className="field-label">Link<input className="input" value={el.action.url} onChange={(e) => set({ action: { type: "url", url: e.target.value } })} /></label>}
          {el.action.type === "view" && (
            <label className="field-label">View
              <select className="select" value={el.action.viewId} onChange={(e) => set({ action: { type: "view", viewId: e.target.value } })}>
                {state.tableOrder.flatMap((tid) => state.tables[tid].viewOrder.map((vid) => state.views[vid]).filter(Boolean).map((v) => <option key={v.id} value={v.id}>{state.tables[tid].name} · {v.name}</option>))}
              </select>
            </label>
          )}
          {el.action.type === "automation" && (
            <label className="field-label">Automation (ones that run without a record: “On a schedule”, run once)
              <select className="select" value={el.action.automationId} onChange={(e) => set({ action: { type: "automation", automationId: e.target.value } })}>
                <option value="">Choose…</option>
                {Object.values(state.automations).filter((a) => a.trigger.type === "schedule" && !a.trigger.viewId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          )}
        </>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn small" onClick={onDuplicate}>Duplicate</button>
        <span className="spacer" />
        <button className="btn ghost small danger" onClick={onDelete}>Delete element</button>
      </div>
      <p className="muted small" style={{ margin: 0 }}>Drag an element's top bar to move it and its bottom-right corner to resize.</p>
    </aside>
  );
}

/** Filters people viewing the page can change; each narrows the elements that read its table. */
function ControlsEditor({ page, onSave }: { page: InterfacePage; onSave: (p: InterfacePage) => boolean }) {
  const { snap } = useBase();
  const state = snap.state;
  const controls = page.controls ?? [];
  const [tableId, setTableId] = useState(state.tableOrder[0] ?? "");
  const fields = (state.tables[tableId]?.fieldOrder ?? []).map((id) => state.fields[id]).filter((f) => f && !["attachment", "button"].includes(f.type));
  const [fieldId, setFieldId] = useState("");
  return (
    <div className="stack" style={{ gap: 8, minWidth: 340 }}>
      <span className="muted small">Viewers pick a value to narrow every element that shows records from that table.</span>
      {controls.map((ctl) => (
        <div key={ctl.id} className="row small">
          <span>{state.tables[ctl.tableId]?.name} · <b>{state.fields[ctl.fieldId]?.name ?? "?"}</b></span>
          <span className="spacer" />
          <button className="btn ghost small" onClick={() => onSave({ ...page, controls: controls.filter((x) => x.id !== ctl.id) })} aria-label="Remove filter">✕</button>
        </div>
      ))}
      <div className="row">
        <select className="select" value={tableId} onChange={(e) => { setTableId(e.target.value); setFieldId(""); }} aria-label="Table">
          {state.tableOrder.map((id) => <option key={id} value={id}>{state.tables[id].name}</option>)}
        </select>
        <select className="select" value={fieldId} onChange={(e) => setFieldId(e.target.value)} aria-label="Field">
          <option value="">Field…</option>
          {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <button className="btn" disabled={!fieldId || controls.length >= 8} onClick={() => { if (onSave({ ...page, controls: [...controls, { id: newId("ctl"), tableId, fieldId }] })) setFieldId(""); }}>Add</button>
      </div>
    </div>
  );
}

/** Publish a page with a read-only public link. */
export function PublishDialog({ page, onClose }: { page: InterfacePage; onClose: () => void }) {
  const { client } = useBase();
  const [copied, setCopied] = useState(false);
  const url = page.shareToken ? `${location.origin}/i/${page.shareToken}` : "";
  const set = (shareToken: string | null) => client.dispatch({ type: "page.upsert", page: { ...page, shareToken } });
  return (
    <Dialog title={`Publish “${page.name}”`} onClose={onClose} footer={<><span className="spacer" /><button className="btn primary" onClick={onClose}>Done</button></>}>
      <p className="muted" style={{ marginTop: 0 }}>Anyone with the link can see this page without an account, including people who aren&apos;t members of the base. They see what the page shows and nothing else; buttons that run automations are hidden.</p>
      {page.shareToken ? (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row">
            <input className="input" readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Public link" />
            <button className="btn" onClick={() => { void navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <div className="row">
            <a className="btn ghost small" href={url} target="_blank" rel="noreferrer">Open ↗</a>
            <button className="btn ghost small" onClick={() => confirm("Make a new link? The current one will stop working.") && set(newPublicToken())}>New link</button>
            <button className="btn ghost small danger" onClick={() => set(null)}>Unpublish</button>
          </div>
        </div>
      ) : <button className="btn primary" onClick={() => set(newPublicToken())}>Publish with a link</button>}
    </Dialog>
  );
}
