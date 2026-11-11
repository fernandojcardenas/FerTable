"use client";

// Timeline (Gantt) view: one bar per record from its start date to its end date.
// Drag a bar to move it, drag its edges to change the dates. With a dependency
// field (a link to records in the same table), arrows run from each record a bar
// depends on; an arrow turns red when the bar starts before that record ends.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Field, Row, View } from "@/shared/types";
import { groupRows } from "@/shared/query";
import { recordColor } from "@/shared/viewTools";
import { newId } from "@/shared/ids";
import { useBase } from "./common";
import { useViewData } from "./views";
import { canEditField } from "./permissions";

const DAY = 86_400_000;
const PX_PER_DAY = { day: 44, week: 18, month: 5 } as const;
const ROW_H = 36;
const HEAD_H = 44;
const LEFT_W = 240;

/** Midnight UTC of a stored date (date-only or full timestamp). */
function toDay(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(t)) return null;
  return Math.floor(t / DAY) * DAY;
}
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

function dateValue(field: Field, dayMs: number, previous: unknown): string {
  if (!field.options.includeTime) return iso(dayMs);
  // Keep the time of day when moving a date-and-time value.
  const prev = typeof previous === "string" ? Date.parse(previous) : NaN;
  const timeOfDay = Number.isNaN(prev) ? 9 * 3600_000 : prev - Math.floor(prev / DAY) * DAY;
  return new Date(dayMs + timeOfDay).toISOString();
}

type Bar = { row: Row; start: number; end: number };
type Line = { kind: "group"; label: string; count: number; depth: number } | { kind: "row"; row: Row; bar: Bar | null };

export function TimelineView({ view }: { view: View }) {
  const { snap, client, openRecord } = useBase();
  const { table, rows } = useViewData(view);
  const c = snap.computer;
  const cfg = view.config.timeline ?? { startFieldId: null, endFieldId: null, scale: "week" as const, dependencyFieldId: null };
  const startF = snap.state.fields[cfg.startFieldId ?? ""];
  const endF = snap.state.fields[cfg.endFieldId ?? ""];
  const depF = snap.state.fields[cfg.dependencyFieldId ?? ""];
  const px = PX_PER_DAY[cfg.scale] ?? PX_PER_DAY.week;
  const scroller = useRef<HTMLDivElement>(null);

  const barOf = (r: Row): Bar | null => {
    if (!startF) return null;
    const sv = c.value(r, startF);
    const start = toDay(sv);
    if (start === null) return null;
    const end = endF ? toDay(c.value(r, endF)) : null;
    return { row: r, start, end: end !== null && end >= start ? end : start };
  };

  const lines = useMemo(() => {
    const out: Line[] = [];
    const groups = groupRows(c, rows, view.config.groupBy ?? []);
    const walk = (gs: NonNullable<typeof groups>, depth: number) => {
      for (const g of gs) {
        out.push({ kind: "group", label: `${g.field.name}: ${g.label}`, count: g.rows.length, depth });
        if (g.children) walk(g.children, depth + 1);
        else for (const r of g.rows) out.push({ kind: "row", row: r, bar: barOf(r) });
      }
    };
    if (groups) walk(groups, 0);
    else for (const r of rows) out.push({ kind: "row", row: r, bar: barOf(r) });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, c, startF, endF, view.config.groupBy]);

  // The visible range: every bar, plus some room either side, and always today.
  const today = Math.floor(Date.now() / DAY) * DAY;
  const bars = lines.flatMap((l) => (l.kind === "row" && l.bar ? [l.bar] : []));
  const first = Math.min(today - 14 * DAY, ...bars.map((b) => b.start)) - 7 * DAY;
  const last = Math.max(today + 45 * DAY, ...bars.map((b) => b.end)) + 21 * DAY;
  const days = Math.round((last - first) / DAY);
  const width = days * px;
  const x = (t: number) => ((t - first) / DAY) * px;

  // Open with today a little in from the left (again when the scale changes).
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, x(today) - Math.min(240, el.clientWidth * 0.25));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.scale, Boolean(startF)]);

  // Dragging: which bar, what part, and how many days it has moved.
  const [drag, setDrag] = useState<{ rowId: string; part: "move" | "start" | "end"; startX: number; delta: number } | null>(null);
  const editable = (f: Field | undefined) => Boolean(f && f.type === "date" && !f.syncSourceFieldId && canEditField(snap, f)) && snap.role !== "viewer" && snap.role !== "commenter";
  const canMove = editable(startF) && (!endF || editable(endF));

  function begin(e: React.MouseEvent, row: Row, part: "move" | "start" | "end") {
    if (part === "start" && !editable(startF)) return;
    if (part === "end" && !editable(endF)) return;
    if (part === "move" && !canMove) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    let delta = 0;
    setDrag({ rowId: row.id, part, startX, delta: 0 });
    const onMove = (ev: MouseEvent) => {
      delta = Math.round((ev.clientX - startX) / px);
      setDrag({ rowId: row.id, part, startX, delta });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setDrag(null);
      const bar = barOf(snap.state.rows[row.id] ?? row);
      if (!bar) return;
      if (delta === 0) { if (part === "move") openRecord(row.id); return; }
      const cells: Record<string, string> = {};
      if (part === "move" || part === "start") cells[startF!.id] = dateValue(startF!, Math.min(bar.start + delta * DAY, part === "start" ? bar.end : Infinity), row.cells[startF!.id]);
      if (endF && (part === "move" || part === "end")) cells[endF.id] = dateValue(endF, Math.max(bar.end + delta * DAY, part === "end" ? bar.start : -Infinity), row.cells[endF.id]);
      client.dispatch({ type: "row.update", rowId: row.id, cells });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const shown = (b: Bar): { start: number; end: number } => {
    if (!drag || drag.rowId !== b.row.id) return b;
    const d = drag.delta * DAY;
    if (drag.part === "move") return { start: b.start + d, end: b.end + d };
    if (drag.part === "start") return { start: Math.min(b.start + d, b.end), end: b.end };
    return { start: b.start, end: Math.max(b.end + d, b.start) };
  };

  if (!startF) {
    const dates = table.fieldOrder.map((id) => snap.state.fields[id]).filter((f) => f?.type === "date");
    return (
      <div className="form-wrap">
        <div className="form-card">
          <h2>Pick the dates for the timeline</h2>
          <p className="muted">Each record becomes a bar from its start date to its end date. Choose them in the toolbar.</p>
          {dates.length === 0 && (
            <button className="btn primary" style={{ alignSelf: "flex-start" }} onClick={() => {
              const s = newId("fld"), e = newId("fld");
              client.dispatch(
                { type: "field.create", fieldId: s, tableId: table.id, name: "Start", fieldType: "date" },
                { type: "field.create", fieldId: e, tableId: table.id, name: "End", fieldType: "date" },
                { type: "view.update", viewId: view.id, config: { timeline: { ...cfg, startFieldId: s, endFieldId: e } } },
              );
            }}>Add “Start” and “End” date fields</button>
          )}
        </div>
      </div>
    );
  }

  // Ticks along the top: days, weeks (Mondays) or months.
  const ticks: { t: number; label: string; major: boolean }[] = [];
  for (let t = first; t <= last; t += DAY) {
    const d = new Date(t);
    if (cfg.scale === "day") ticks.push({ t, label: String(d.getUTCDate()), major: d.getUTCDate() === 1 || t === first });
    else if (cfg.scale === "week" && d.getUTCDay() === 1) ticks.push({ t, label: d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }), major: d.getUTCDate() <= 7 });
    else if (cfg.scale === "month" && d.getUTCDate() === 1) ticks.push({ t, label: d.toLocaleDateString(undefined, { month: "short", year: d.getUTCMonth() === 0 ? "numeric" : undefined, timeZone: "UTC" }), major: d.getUTCMonth() === 0 });
  }
  const months: { t: number; label: string }[] = [];
  if (cfg.scale !== "month") {
    for (let t = first; t <= last; t += DAY) {
      const d = new Date(t);
      // The first label only when its month has room before the next one starts.
      if (d.getUTCDate() === 1 || (t === first && d.getUTCDate() <= 20)) months.push({ t, label: d.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" }) });
    }
  }

  // Where each record's bar sits, for dependency arrows.
  const rowIndex = new Map<string, number>();
  lines.forEach((l, i) => { if (l.kind === "row") rowIndex.set(l.row.id, i); });
  const arrows: { from: Bar; to: Bar; late: boolean }[] = [];
  if (depF) {
    const barById = new Map(bars.map((b) => [b.row.id, b]));
    for (const b of bars) {
      for (const id of (b.row.cells[depF.id] as string[] | undefined) ?? []) {
        const from = barById.get(id);
        if (from && from.row.id !== b.row.id) arrows.push({ from, to: b, late: shown(b).start <= shown(from).end });
      }
    }
  }
  const height = lines.length * ROW_H;

  return (
    <div className="timeline" ref={scroller}>
      <div className="tl-inner" style={{ width: LEFT_W + width }}>
        <div className="tl-head" style={{ height: HEAD_H }}>
          <div className="tl-left tl-corner" style={{ width: LEFT_W }}>{table.name}</div>
          <div className="tl-scale" style={{ width }}>
            {months.map((m) => <span key={`m${m.t}`} className="tl-month" style={{ left: x(m.t) }}>{m.label}</span>)}
            {ticks.map((t) => <span key={t.t} className={`tl-tick ${t.major ? "major" : ""}`} style={{ left: x(t.t), width: cfg.scale === "day" ? px : undefined }}>{t.label}</span>)}
          </div>
        </div>
        <div className="tl-body" style={{ height }}>
          <div className="tl-grid" style={{ left: LEFT_W, width, height }}>
            {ticks.map((t) => <span key={t.t} className={`tl-gridline ${t.major ? "major" : ""}`} style={{ left: x(t.t) }} />)}
            <span className="tl-today" style={{ left: x(today) + px / 2 }} title="Today" />
          </div>
          {depF && (
            <svg className="tl-arrows" style={{ left: LEFT_W }} width={width} height={height} aria-hidden="true">
              <defs>
                <marker id="tl-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--muted)" /></marker>
                <marker id="tl-arrow-late" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--danger)" /></marker>
              </defs>
              {arrows.map(({ from, to, late }) => {
                const a = shown(from), b = shown(to);
                const x1 = x(a.end) + px, y1 = rowIndex.get(from.row.id)! * ROW_H + ROW_H / 2;
                const x2 = x(b.start), y2 = rowIndex.get(to.row.id)! * ROW_H + ROW_H / 2;
                const mid = Math.max(x1 + 8, Math.min(x2 - 8, (x1 + x2) / 2));
                return <path key={`${from.row.id}-${to.row.id}`} d={`M${x1},${y1} H${mid} V${y2} H${x2 - 2}`} fill="none"
                  stroke={late ? "var(--danger)" : "var(--muted)"} strokeWidth={1.5} markerEnd={`url(#${late ? "tl-arrow-late" : "tl-arrow"})`} />;
              })}
            </svg>
          )}
          {lines.map((l, i) => {
            if (l.kind === "group") {
              return (
                <div key={`g${i}`} className="tl-row tl-group" style={{ top: i * ROW_H, height: ROW_H }}>
                  <div className="tl-left" style={{ width: LEFT_W, paddingLeft: 10 + l.depth * 14 }}>{l.label} <span className="muted small">· {l.count}</span></div>
                </div>
              );
            }
            const b = l.bar ? shown(l.bar) : null;
            const color = recordColor(c, l.row, view.config.colors);
            return (
              <div key={l.row.id} className="tl-row" style={{ top: i * ROW_H, height: ROW_H }}>
                <button className="tl-left tl-name" style={{ width: LEFT_W }} onClick={() => openRecord(l.row.id)} title={c.primaryName(l.row.id)}>
                  {c.primaryName(l.row.id)}
                  {!b && <span className="muted small"> · no date</span>}
                </button>
                <div className="tl-track" style={{ left: LEFT_W, width }}
                  onDoubleClick={(e) => {
                    if (b || !editable(startF)) return;
                    // Double-click an empty track to put an undated record there.
                    const day = first + Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left) / px) * DAY;
                    client.dispatch({ type: "row.update", rowId: l.row.id, cells: { [startF.id]: dateValue(startF, day, null), ...(endF && editable(endF) ? { [endF.id]: dateValue(endF, day, null) } : {}) } });
                  }}>
                  {b && (
                    <div className={`tl-bar ${drag?.rowId === l.row.id ? "dragging" : ""} ${canMove ? "movable" : ""}`}
                      style={{ left: x(b.start), width: Math.max(px, x(b.end) - x(b.start) + px), background: color ? `var(--s-${color})` : undefined }}
                      onMouseDown={(e) => begin(e, l.row, "move")}
                      onClick={(e) => { if (!canMove) { e.stopPropagation(); openRecord(l.row.id); } }}
                      title={`${c.primaryName(l.row.id)}: ${iso(b.start)}${b.end !== b.start ? ` → ${iso(b.end)}` : ""}`}
                      role="button" aria-label={`${c.primaryName(l.row.id)} from ${iso(b.start)} to ${iso(b.end)}`}>
                      {editable(startF) && <span className="tl-handle left" onMouseDown={(e) => begin(e, l.row, "start")} />}
                      <span className="tl-bar-label">{c.primaryName(l.row.id)}</span>
                      {endF && editable(endF) && <span className="tl-handle right" onMouseDown={(e) => begin(e, l.row, "end")} />}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
