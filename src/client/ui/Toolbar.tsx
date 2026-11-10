"use client";

import { useState } from "react";
import type { Field, Filters, SortSpec, View, ViewConfig } from "@/shared/types";
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

export function Toolbar({ view, onAddRecord }: { view: View; onAddRecord: () => void }) {
  const { snap } = useBase();
  const update = useViewUpdate(view);
  const [open, setOpen] = useState<null | "hide" | "filter" | "group" | "sort" | "settings">(null);
  const close = () => setOpen(null);
  const toggle = (k: typeof open) => setOpen((o) => (o === k ? null : k));
  const table = snap.state.tables[view.tableId];
  const fields = table.fieldOrder.map((id) => snap.state.fields[id]).filter(Boolean);
  const c = view.config;
  const hiddenCount = c.hiddenFieldIds.length;
  const filterCount = c.filters.conditions.length;

  return (
    <div className="toolbar">
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
          {view.type === "grid" && (
            <Popover open={open === "group"} onClose={close} anchor={
              <button className={`btn ghost ${c.groupBy.length ? "active" : ""}`} onClick={() => toggle("group")}>▤ {c.groupBy.length ? `Grouped by ${c.groupBy.length}` : "Group"}</button>
            }>
              <SortList fields={fields} specs={c.groupBy} noun="group" onChange={(groupBy) => update({ groupBy: groupBy.slice(0, 3) })} />
            </Popover>
          )}
          {view.type !== "calendar" && (
            <Popover open={open === "sort"} onClose={close} anchor={
              <button className={`btn ghost ${c.sorts.length ? "active" : ""}`} onClick={() => toggle("sort")}>⇅ {c.sorts.length ? `Sorted by ${c.sorts.length}` : "Sort"}</button>
            }>
              <SortList fields={fields} specs={c.sorts} noun="sort" onChange={(sorts) => update({ sorts })} />
            </Popover>
          )}
        </>
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
      {view.type !== "form" && <button className="btn primary" onClick={onAddRecord}>+ Add record</button>}
    </div>
  );
}
