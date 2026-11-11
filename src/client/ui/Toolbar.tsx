"use client";

import { useState } from "react";
import type { Field, Filters, RecordColoring, RowHeight, SortSpec, View, ViewConfig } from "@/shared/types";
import { CHOICE_COLORS } from "@/shared/fieldTypes";
import { MAX_FROZEN, ROW_HEIGHT_LABELS } from "@/shared/viewTools";
import { canAddRecords } from "./permissions";
import { filterKind, OPERATORS } from "@/shared/query";
import { FIELD_TYPES } from "@/shared/fieldTypes";
import { newId } from "@/shared/ids";
import { ChoiceChip, Popover, useBase } from "./common";

function useViewUpdate(view: View) {
  const { client } = useBase();
  // Rapid changes to the same setting (like typing a filter value) undo together.
  return (config: Partial<ViewConfig>) =>
    client.dispatchWith({ coalesce: { key: `view:${view.id}:${Object.keys(config).sort().join(",")}`, windowMs: 1500 } }, { type: "view.update", viewId: view.id, config });
}

/** Editable list of filter conditions. Also used by automations. */
export function FilterEditor({ fields, filters, onChange }: { fields: Field[]; filters: Filters; onChange: (f: Filters) => void }) {
  const conds = filters.conditions;
  const set = (i: number, patch: Partial<Filters["conditions"][number]>) =>
    onChange({ ...filters, conditions: conds.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <div className="stack" style={{ gap: 8, minWidth: 420 }}>
      {conds.length === 0 && <span className="muted">No filters. Add a condition to show only matching records.</span>}
      {conds.map((cond, i) => {
        const field = fields.find((f) => f.id === cond.fieldId);
        const kind = field ? filterKind(field) : "text";
        const ops = OPERATORS[kind];
        const op = ops.find((o) => o.id === cond.operator) ?? ops[0];
        return (
          <div key={cond.id} className="row" style={{ flexWrap: "wrap" }}>
            <span className="small muted" style={{ width: 44 }}>
              {i === 0 ? "Where" : i === 1 ? (
                <select className="select small" style={{ padding: 2 }} value={filters.conjunction} onChange={(e) => onChange({ ...filters, conjunction: e.target.value as "and" | "or" })}>
                  <option value="and">and</option><option value="or">or</option>
                </select>
              ) : filters.conjunction}
            </span>
            <select className="select" style={{ width: 140 }} value={cond.fieldId} aria-label="Field"
              onChange={(e) => {
                const f = fields.find((x) => x.id === e.target.value)!;
                set(i, { fieldId: f.id, operator: OPERATORS[filterKind(f)][0].id, value: null });
              }}>
              {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <select className="select" style={{ width: 130 }} value={op.id} aria-label="Condition" onChange={(e) => set(i, { operator: e.target.value })}>
              {ops.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
            {op.needsValue && field && <FilterValue field={field} value={cond.value} onChange={(value) => set(i, { value })} />}
            <button className="btn ghost" onClick={() => onChange({ ...filters, conditions: conds.filter((_, j) => j !== i) })} aria-label="Remove condition">✕</button>
          </div>
        );
      })}
      <div>
        <button className="btn" disabled={!fields.length} onClick={() => {
          const f = fields[0];
          onChange({ ...filters, conditions: [...conds, { id: newId("flt"), fieldId: f.id, operator: OPERATORS[filterKind(f)][0].id, value: null }] });
        }}>+ Add condition</button>
      </div>
    </div>
  );
}

function FilterValue({ field, value, onChange }: { field: Field; value: unknown; onChange: (v: unknown) => void }) {
  const kind = filterKind(field);
  if (kind === "select" || kind === "multi") {
    const ids = Array.isArray(value) ? (value as string[]) : value ? [String(value)] : [];
    if (kind === "select") {
      return (
        <select className="select" style={{ width: 140 }} value={ids[0] ?? ""} onChange={(e) => onChange(e.target.value || null)} aria-label="Value">
          <option value="">Choose…</option>
          {field.options.choices?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      );
    }
    return (
      <span className="row" style={{ flexWrap: "wrap", gap: 2 }}>
        {field.options.choices?.map((c) => (
          <button key={c.id} className="btn ghost small" style={{ padding: 2, opacity: ids.includes(c.id) ? 1 : 0.45 }}
            onClick={() => onChange(ids.includes(c.id) ? ids.filter((x) => x !== c.id) : [...ids, c.id])}>
            <ChoiceChip name={c.name} color={c.color} />
          </button>
        ))}
      </span>
    );
  }
  if (kind === "date") return <input className="input" style={{ width: 150 }} type="date" value={String(value ?? "")} onChange={(e) => onChange(e.target.value || null)} aria-label="Value" />;
  return (
    <input className="input" style={{ width: 140 }} value={String(value ?? "")} placeholder="Value" aria-label="Value"
      inputMode={kind === "number" ? "decimal" : undefined} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)} />
  );
}

function SortList({ fields, specs, onChange, noun }: { fields: Field[]; specs: SortSpec[]; onChange: (s: SortSpec[]) => void; noun: string }) {
  const unused = fields.filter((f) => !specs.some((s) => s.fieldId === f.id));
  return (
    <div className="stack" style={{ gap: 8, minWidth: 320 }}>
      {specs.length === 0 && <span className="muted">No {noun}s yet.</span>}
      {specs.map((s, i) => (
        <div key={s.fieldId} className="row">
          <select className="select" value={s.fieldId} aria-label="Field" onChange={(e) => onChange(specs.map((x, j) => (j === i ? { ...x, fieldId: e.target.value } : x)))}>
            {fields.filter((f) => f.id === s.fieldId || !specs.some((x) => x.fieldId === f.id)).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <select className="select" style={{ width: 110 }} value={s.direction} aria-label="Direction" onChange={(e) => onChange(specs.map((x, j) => (j === i ? { ...x, direction: e.target.value as "asc" | "desc" } : x)))}>
            <option value="asc">A → Z</option>
            <option value="desc">Z → A</option>
          </select>
          <button className="btn ghost" onClick={() => onChange(specs.filter((_, j) => j !== i))} aria-label={`Remove ${noun}`}>✕</button>
        </div>
      ))}
      {unused.length > 0 && (
        <div><button className="btn" onClick={() => onChange([...specs, { fieldId: unused[0].id, direction: "asc" }])}>+ Add {noun}</button></div>
      )}
    </div>
  );
}

/** Search box for the open view (Cmd/Ctrl+F). */
function SearchBox() {
  const { search, setSearch } = useBase();
  const [open, setOpen] = useState(false);
  if (!open && !search) {
    return <button className="btn ghost view-search-btn" onClick={() => setOpen(true)} aria-label="Search this view" title="Search (⌘F)">🔍</button>;
  }
  return (
    <span className="view-search">
      <input className="input" autoFocus placeholder="Find in view" value={search} aria-label="Find in view"
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { setSearch(""); setOpen(false); } }}
        onBlur={() => { if (!search) setOpen(false); }} />
      <button className="btn ghost small" onClick={() => { setSearch(""); setOpen(false); }} aria-label="Close search">✕</button>
    </span>
  );
}

/** Color records by a single select field, or by rules. */
function ColoringEditor({ fields, coloring, onChange }: { fields: Field[]; coloring: RecordColoring | null | undefined; onChange: (c: RecordColoring | null) => void }) {
  const selects = fields.filter((f) => f.type === "singleSelect");
  const mode = coloring?.mode ?? "none";
  return (
    <div className="stack" style={{ gap: 8, minWidth: 360 }}>
      <label className="row small">Color records
        <select className="select" value={mode} onChange={(e) => {
          const m = e.target.value;
          if (m === "none") onChange(null);
          else if (m === "select") selects[0] ? onChange({ mode: "select", fieldId: selects[0].id }) : undefined;
          else onChange({ mode: "conditions", rules: [] });
        }}>
          <option value="none">None</option>
          <option value="select" disabled={!selects.length}>By a single select field</option>
          <option value="conditions">By conditions</option>
        </select>
      </label>
      {coloring?.mode === "select" && (
        <label className="row small">Field
          <select className="select" value={coloring.fieldId} onChange={(e) => onChange({ mode: "select", fieldId: e.target.value })}>
            {selects.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
      )}
      {coloring?.mode === "conditions" && (
        <>
          <span className="muted small">The first rule a record matches decides its color.</span>
          {coloring.rules.map((r, i) => (
            <div key={r.id} className="color-rule">
              <div className="row">
                <span className="row" style={{ gap: 2 }}>
                  {CHOICE_COLORS.map((col) => (
                    <button key={col} className={`swatch-btn s-${col} ${r.color === col ? "on" : ""}`} aria-label={col} title={col}
                      onClick={() => onChange({ ...coloring, rules: coloring.rules.map((x, j) => (j === i ? { ...x, color: col } : x)) })} />
                  ))}
                </span>
                <span className="spacer" />
                <button className="btn ghost small" onClick={() => onChange({ ...coloring, rules: coloring.rules.filter((_, j) => j !== i) })} aria-label="Remove rule">✕</button>
              </div>
              <FilterEditor fields={fields} filters={r.filters} onChange={(filters) => onChange({ ...coloring, rules: coloring.rules.map((x, j) => (j === i ? { ...x, filters } : x)) })} />
            </div>
          ))}
          <div><button className="btn" disabled={coloring.rules.length >= 20} onClick={() => onChange({ ...coloring, rules: [...coloring.rules, { id: newId("flt"), color: CHOICE_COLORS[coloring.rules.length % CHOICE_COLORS.length], filters: { conjunction: "and", conditions: [] } }] })}>+ Add color rule</button></div>
        </>
      )}
    </div>
  );
}

export function Toolbar({ view, onAddRecord }: { view: View; onAddRecord: () => void }) {
  const { snap, client } = useBase();
  const update = useViewUpdate(view);
  const [open, setOpen] = useState<null | "hide" | "filter" | "group" | "sort" | "settings" | "height" | "color">(null);
  const close = () => setOpen(null);
  const toggle = (k: typeof open) => setOpen((o) => (o === k ? null : k));
  const table = snap.state.tables[view.tableId];
  const fields = table.fieldOrder.map((id) => snap.state.fields[id]).filter(Boolean);
  const c = view.config;
  const hiddenCount = c.hiddenFieldIds.length;
  const filterCount = c.filters.conditions.length;

  const locked = Boolean(c.locked);
  const tl = c.timeline ?? { startFieldId: null, endFieldId: null, scale: "week" as const, dependencyFieldId: null };
  const dateFields = fields.filter((f) => f.type === "date" || f.type === "createdTime" || f.type === "lastModifiedTime");
  return (
    <div className="toolbar">
      {locked && (
        <button className="btn ghost lock-badge" title={snap.role === "owner" ? "Click to unlock this view" : "Only owners can unlock this view"}
          onClick={() => { if (snap.role === "owner" && confirm("Unlock this view so editors can change its settings?")) client.dispatch({ type: "view.update", viewId: view.id, config: { locked: false } }); }}>
          🔒 Locked
        </button>
      )}
      {view.personalFor && <span className="role-badge" title="Only you see this view">Personal</span>}
      {view.type !== "form" && (
        <>
          <Popover open={open === "hide"} onClose={close} anchor={
            <button className={`btn ghost ${hiddenCount ? "active" : ""}`} onClick={() => toggle("hide")}>👁 {hiddenCount ? `${hiddenCount} hidden` : "Hide fields"}</button>
          }>
            <div className="stack" style={{ gap: 4 }}>
              {fields.filter((f) => f.id !== table.primaryFieldId).map((f) => (
                <label key={f.id} className="row" style={{ cursor: "pointer" }}>
                  <input type="checkbox" checked={!c.hiddenFieldIds.includes(f.id)}
                    onChange={(e) => update({ hiddenFieldIds: e.target.checked ? c.hiddenFieldIds.filter((x) => x !== f.id) : [...c.hiddenFieldIds, f.id] })} />
                  <span className="field-type-icon">{FIELD_TYPES[f.type].icon}</span>{f.name}
                </label>
              ))}
              <div className="row" style={{ marginTop: 6 }}>
                <button className="btn small" onClick={() => update({ hiddenFieldIds: [] })}>Show all</button>
                <button className="btn small" onClick={() => update({ hiddenFieldIds: fields.filter((f) => f.id !== table.primaryFieldId).map((f) => f.id) })}>Hide all</button>
              </div>
            </div>
          </Popover>
          <Popover open={open === "filter"} onClose={close} anchor={
            <button className={`btn ghost ${filterCount ? "active" : ""}`} onClick={() => toggle("filter")}>⏚ {filterCount ? `Filtered by ${filterCount}` : "Filter"}</button>
          }>
            <FilterEditor fields={fields} filters={c.filters} onChange={(filters) => update({ filters })} />
          </Popover>
          {(view.type === "grid" || view.type === "timeline" || view.type === "list") && (
            <Popover open={open === "group"} onClose={close} anchor={
              <button className={`btn ghost ${c.groupBy.length ? "active" : ""}`} onClick={() => toggle("group")}>▤ {c.groupBy.length ? `Grouped by ${c.groupBy.length}` : "Group"}</button>
            }>
              <SortList fields={fields} specs={c.groupBy} noun="group" onChange={(groupBy) => update({ groupBy: groupBy.slice(0, 3) })} />
            </Popover>
          )}
          {view.type !== "calendar" && view.type !== "timeline" && (
            <Popover open={open === "sort"} onClose={close} anchor={
              <button className={`btn ghost ${c.sorts.length ? "active" : ""}`} onClick={() => toggle("sort")}>⇅ {c.sorts.length ? `Sorted by ${c.sorts.length}` : "Sort"}</button>
            }>
              <SortList fields={fields} specs={c.sorts} noun="sort" onChange={(sorts) => update({ sorts })} />
            </Popover>
          )}
        </>
      )}
      {view.type !== "form" && (
        <Popover open={open === "color"} onClose={close} anchor={
          <button className={`btn ghost ${c.colors ? "active" : ""}`} onClick={() => toggle("color")}>🎨 Color</button>
        }>
          <ColoringEditor fields={fields} coloring={c.colors} onChange={(colors) => update({ colors })} />
        </Popover>
      )}
      {view.type === "grid" && (
        <Popover open={open === "height"} onClose={close} anchor={
          <button className="btn ghost" onClick={() => toggle("height")} aria-label="Row height and frozen columns">↕ Rows</button>
        }>
          <div className="stack" style={{ gap: 6, minWidth: 220 }}>
            <span className="muted small">Row height</span>
            {(Object.keys(ROW_HEIGHT_LABELS) as RowHeight[]).map((h) => (
              <label key={h} className="row" style={{ cursor: "pointer" }}>
                <input type="radio" name="row-height" checked={(c.rowHeight ?? "short") === h} onChange={() => update({ rowHeight: h })} /> {ROW_HEIGHT_LABELS[h]}
              </label>
            ))}
            <label className="row small" style={{ marginTop: 8 }}>Frozen columns
              <select className="select" style={{ width: 70 }} value={c.frozenCount ?? 1} onChange={(e) => update({ frozenCount: Number(e.target.value) })}>
                {Array.from({ length: MAX_FROZEN }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
        </Popover>
      )}
      {view.type === "timeline" && (
        <>
          <label className="row small">Start
            <select className="select" style={{ width: 130 }} value={c.timeline?.startFieldId ?? ""} onChange={(e) => update({ timeline: { ...tl, startFieldId: e.target.value || null } })}>
              <option value="">Choose…</option>
              {dateFields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
          <label className="row small">End
            <select className="select" style={{ width: 130 }} value={c.timeline?.endFieldId ?? ""} onChange={(e) => update({ timeline: { ...tl, endFieldId: e.target.value || null } })}>
              <option value="">Same day</option>
              {dateFields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
          <select className="select" style={{ width: 90 }} aria-label="Scale" value={tl.scale} onChange={(e) => update({ timeline: { ...tl, scale: e.target.value as "day" | "week" | "month" } })}>
            <option value="day">Days</option><option value="week">Weeks</option><option value="month">Months</option>
          </select>
          <label className="row small" title="A link field to records in this table that each record depends on">Depends on
            <select className="select" style={{ width: 130 }} value={c.timeline?.dependencyFieldId ?? ""} onChange={(e) => update({ timeline: { ...tl, dependencyFieldId: e.target.value || null } })}>
              <option value="">None</option>
              {fields.filter((f) => f.type === "link" && f.options.linkedTableId === table.id).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
        </>
      )}
      {view.type === "list" && (
        <label className="row small" title="Show each record's linked records under it">Nest by
          <select className="select" style={{ width: 140 }} value={c.list?.nestFieldId ?? ""} onChange={(e) => update({ list: { nestFieldId: e.target.value || null } })}>
            <option value="">Nothing</option>
            {fields.filter((f) => f.type === "link").map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
      )}
      {view.type === "kanban" && (
        <label className="row small">Stack by
          <select className="select" style={{ width: 150 }} value={c.kanban?.stackFieldId ?? ""} onChange={(e) => update({ kanban: { ...c.kanban, stackFieldId: e.target.value || null } })}>
            <option value="">Choose…</option>
            {fields.filter((f) => f.type === "singleSelect").map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
      )}
      {(view.type === "kanban" || view.type === "gallery") && fields.some((f) => f.type === "attachment") && (
        <label className="row small">Cover
          <select className="select" style={{ width: 140 }}
            value={(view.type === "kanban" ? c.kanban?.coverFieldId : c.gallery?.coverFieldId) ?? ""}
            onChange={(e) => {
              const coverFieldId = e.target.value || null;
              if (view.type === "kanban") update({ kanban: { stackFieldId: c.kanban?.stackFieldId ?? null, coverFieldId } });
              else update({ gallery: { coverFieldId } });
            }}>
            <option value="">None</option>
            {fields.filter((f) => f.type === "attachment").map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
      )}
      {view.type === "calendar" && (
        <label className="row small">Date field
          <select className="select" style={{ width: 150 }} value={c.calendar?.dateFieldId ?? ""} onChange={(e) => update({ calendar: { dateFieldId: e.target.value || null } })}>
            <option value="">Choose…</option>
            {fields.filter((f) => f.type === "date" || f.type === "createdTime").map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
      )}
      <span className="spacer" />
      {view.type !== "form" && <SearchBox />}
      {view.type !== "form" && !table?.sync && canAddRecords(snap, table) && <button className="btn primary" onClick={onAddRecord}>+ Add record</button>}
    </div>
  );
}
