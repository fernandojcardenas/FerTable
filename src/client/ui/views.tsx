"use client";

import { useMemo, useState } from "react";
import type { Attachment, CellValue, Field, FormConfig, Row, SelectChoice, View } from "@/shared/types";
import { isAnswered, missingAnswers, questionHelp, questionLabel, requiredIds } from "@/shared/forms";
import { PUBLIC_TYPES } from "@/shared/publicForm";
import { isReadOnly, isImage } from "@/shared/fieldTypes";
import { viewRows, visibleFields } from "@/shared/query";
import { newId } from "@/shared/ids";
import { CellContent, ChoiceChip, FieldIcon, useBase } from "./common";
import { FieldInput } from "./inputs";
import { prefillFromFilters } from "./prefill";

/** A record card showing the primary field and a few others. */
function RecordCard({ row, fields, coverFieldId, onDragStart }: { row: Row; fields: Field[]; coverFieldId?: string | null; onDragStart?: (e: React.DragEvent) => void }) {
  const { snap, openRecord } = useBase();
  const c = snap.computer;
  const shown = fields.filter((f) => f.id !== coverFieldId && c.display(row, f) !== "").slice(0, 4);
  const cover = coverFieldId ? ((row.cells[coverFieldId] as Attachment[] | undefined) ?? []).find(isImage) : undefined;
  return (
    <div className="card" draggable={Boolean(onDragStart)} onDragStart={onDragStart} onClick={() => openRecord(row.id)}
      role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && openRecord(row.id)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {cover && <img className="card-cover" src={cover.url} alt={cover.name} loading="lazy" draggable={false} />}
      <div className="card-title">{c.primaryName(row.id)}</div>
      {shown.map((f) => (
        <div key={f.id} className="card-field">
          <span>{f.name}: </span>
          <b><CellContent row={row} field={f} /></b>
        </div>
      ))}
    </div>
  );
}

function useViewData(view: View) {
  const { snap } = useBase();
  const table = snap.state.tables[view.tableId];
  const rows = useMemo(() => viewRows(snap.computer, snap.state, view), [snap, view]);
  const fields = useMemo(() => visibleFields(snap.state, view).filter((f) => f.id !== table.primaryFieldId), [snap.state, view, table]);
  return { table, rows, fields };
}

// ---- Kanban ----

export function KanbanView({ view }: { view: View }) {
  const { snap, client, openRecord } = useBase();
  const { table, rows, fields } = useViewData(view);
  const stackField = snap.state.fields[view.config.kanban?.stackFieldId ?? ""];
  const [dropOn, setDropOn] = useState<string | null>(null);

  if (!stackField) {
    const selects = table.fieldOrder.map((id) => snap.state.fields[id]).filter((f) => f?.type === "singleSelect");
    return (
      <div className="form-wrap">
        <div className="form-card">
          <h2>Pick a field to stack by</h2>
          <p className="muted">Kanban groups records into columns by a single select field.</p>
          {selects.length ? selects.map((f) => (
            <button key={f.id} className="btn" onClick={() => client.dispatch({ type: "view.update", viewId: view.id, config: { kanban: { stackFieldId: f.id } } })}>Stack by {f.name}</button>
          )) : <p>This table has no single select field yet. Add one from a grid view.</p>}
        </div>
      </div>
    );
  }

  const columns: { id: string | null; choice?: SelectChoice }[] = [
    { id: null },
    ...(stackField.options.choices ?? []).map((ch) => ({ id: ch.id, choice: ch })),
  ];
  const cardFields = fields.filter((f) => f.id !== stackField.id);

  const add = (stackId: string | null) => {
    const rowId = newId("rec");
    const cells: Record<string, CellValue> = { ...prefillFromFilters(snap.state, view) };
    if (stackId) cells[stackField.id] = stackId;
    if (client.dispatch({ type: "row.create", rowId, tableId: table.id, cells })) openRecord(rowId);
  };

  return (
    <div className="kanban">
      {columns.map((col) => {
        const colRows = rows.filter((r) => (r.cells[stackField.id] ?? null) === col.id);
        if (col.id === null && colRows.length === 0) return null;
        const key = col.id ?? "none";
        return (
          <div key={key} className={`kanban-col ${dropOn === key ? "drop" : ""}`}
            onDragEnter={(e) => e.preventDefault()}
            onDragOver={(e) => { e.preventDefault(); setDropOn(key); }}
            onDragLeave={() => setDropOn((d) => (d === key ? null : d))}
            onDrop={(e) => {
              e.preventDefault();
              setDropOn(null);
              const rowId = e.dataTransfer.getData("text/gridbase-row");
              if (rowId && snap.state.rows[rowId]) client.dispatch({ type: "row.update", rowId, cells: { [stackField.id]: col.id } });
            }}>
            <div className="kanban-col-head">
              {col.choice ? <ChoiceChip name={col.choice.name} color={col.choice.color} /> : <span className="muted">Uncategorized</span>}
              <span className="muted small">{colRows.length}</span>
              <span className="spacer" />
              <button className="btn ghost small" onClick={() => add(col.id)} aria-label={`Add record to ${col.choice?.name ?? "Uncategorized"}`}>＋</button>
            </div>
            {colRows.map((r) => (
              <RecordCard key={r.id} row={r} fields={cardFields} coverFieldId={view.config.kanban?.coverFieldId}
                onDragStart={(e) => { e.dataTransfer.setData("text/gridbase-row", r.id); e.dataTransfer.effectAllowed = "move"; }} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ---- Gallery ----

export function GalleryView({ view }: { view: View }) {
  const { rows, fields } = useViewData(view);
  if (rows.length === 0) return <p className="muted" style={{ padding: 16 }}>No records to show.</p>;
  return (
    <div className="gallery">
      {rows.map((r) => <RecordCard key={r.id} row={r} fields={fields} coverFieldId={view.config.gallery?.coverFieldId} />)}
    </div>
  );
}

// ---- Calendar ----

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The calendar day (local) a stored date value falls on. */
function dayKey(field: Field, value: string): string {
  if (field.type === "date" && !field.options.includeTime) return value.slice(0, 10);
  return ymd(new Date(value));
}

export function CalendarView({ view }: { view: View }) {
  const { snap, client, openRecord } = useBase();
  const { table, rows } = useViewData(view);
  const dateField = snap.state.fields[view.config.calendar?.dateFieldId ?? ""];
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [dropOn, setDropOn] = useState<string | null>(null);

  const byDay = useMemo(() => {
    const m = new Map<string, Row[]>();
    if (!dateField) return m;
    for (const r of rows) {
      const v = dateField.type === "createdTime" ? r.createdAt : r.cells[dateField.id];
      if (typeof v !== "string") continue;
      const k = dayKey(dateField, v);
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return m;
  }, [rows, dateField]);

  if (!dateField) {
    return (
      <div className="form-wrap">
        <div className="form-card">
          <h2>Pick a date field</h2>
          <p className="muted">Choose which date places records on the calendar, using the menu in the toolbar.</p>
          <button className="btn primary" style={{ alignSelf: "flex-start" }} onClick={() => {
            const fieldId = newId("fld");
            client.dispatch(
              { type: "field.create", fieldId, tableId: table.id, name: "Date", fieldType: "date" },
              { type: "view.update", viewId: view.id, config: { calendar: { dateFieldId: fieldId } } },
            );
          }}>Add a “Date” field</button>
        </div>
      </div>
    );
  }

  const start = new Date(month);
  start.setDate(1 - start.getDay());
  const days = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const today = ymd(new Date());
  const editable = dateField.type === "date";

  const toValue = (day: string, previous?: string): string => {
    if (!dateField.options.includeTime) return day;
    const base = previous ? new Date(previous) : new Date(`${day}T09:00:00`);
    const [y, m, d] = day.split("-").map(Number);
    base.setFullYear(y, m - 1, d);
    return base.toISOString();
  };

  return (
    <div className="calendar">
      <div className="row">
        <button className="btn" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month">‹</button>
        <button className="btn" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Today</button>
        <button className="btn" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month">›</button>
        <strong style={{ fontSize: 16 }}>{MONTHS[month.getMonth()]} {month.getFullYear()}</strong>
      </div>
      <div className="cal-grid">
        {DOW.map((d) => <div key={d} className="cal-dow">{d}</div>)}
        {days.map((d) => {
          const k = ymd(d);
          const list = byDay.get(k) ?? [];
          return (
            <div key={k} className={`cal-day ${d.getMonth() !== month.getMonth() ? "other" : ""} ${k === today ? "today" : ""} ${dropOn === k ? "drop" : ""}`}
              onDragEnter={(e) => { if (editable) e.preventDefault(); }}
              onDragOver={(e) => { if (editable) { e.preventDefault(); setDropOn(k); } }}
              onDragLeave={() => setDropOn((x) => (x === k ? null : x))}
              onDrop={(e) => {
                e.preventDefault();
                setDropOn(null);
                const rowId = e.dataTransfer.getData("text/gridbase-row");
                const row = snap.state.rows[rowId];
                if (row) client.dispatch({ type: "row.update", rowId, cells: { [dateField.id]: toValue(k, row.cells[dateField.id] as string | undefined) } });
              }}>
              <div className="cal-num">
                <span>{d.getDate()}</span>
                {editable && (
                  <button className="cal-add" aria-label={`Add record on ${k}`} onClick={() => {
                    const rowId = newId("rec");
                    if (client.dispatch({ type: "row.create", rowId, tableId: table.id, cells: { ...prefillFromFilters(snap.state, view), [dateField.id]: toValue(k) } })) openRecord(rowId);
                  }}>＋</button>
                )}
              </div>
              {list.slice(0, 4).map((r) => (
                <button key={r.id} className="cal-event" draggable={editable}
                  onDragStart={(e) => e.dataTransfer.setData("text/gridbase-row", r.id)}
                  onClick={() => openRecord(r.id)}>{snap.computer.primaryName(r.id)}</button>
              ))}
              {list.length > 4 && <span className="muted small">+{list.length - 4} more</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Form ----

export function FormView({ view }: { view: View }) {
  const { snap, client } = useBase();
  const table = snap.state.tables[view.tableId];
  const form: FormConfig = view.config.form ?? { title: table.name, description: "", fieldIds: [], submitLabel: "Submit" };
  const [editMode, setEditMode] = useState(false);
  const [values, setValues] = useState<Record<string, CellValue>>({});
  const [extraChoices, setExtraChoices] = useState<Record<string, SelectChoice[]>>({});
  const [done, setDone] = useState(false);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const allFields = table.fieldOrder.map((id) => snap.state.fields[id]).filter((f): f is Field => Boolean(f) && !isReadOnly(f));
  const fields = form.fieldIds.map((id) => snap.state.fields[id]).filter((f): f is Field => Boolean(f) && !isReadOnly(f));
  const required = new Set(requiredIds(form, table.primaryFieldId));
  const updateForm = (patch: Partial<FormConfig>, key = Object.keys(patch).join(",")) =>
    client.dispatchWith({ coalesce: { key: `form:${view.id}:${key}`, windowMs: 1500 } }, { type: "view.update", viewId: view.id, config: { form: { ...form, ...patch } } });
  const setText = (map: "labels" | "help", fieldId: string, text: string) => {
    const next = { ...(form[map] ?? {}) };
    if (text) next[fieldId] = text;
    else delete next[fieldId];
    updateForm({ [map]: next }, `${map}:${fieldId}`);
  };
  const toggleRequired = (fieldId: string, on: boolean) =>
    updateForm({ requiredFieldIds: on ? [...required, fieldId] : [...required].filter((x) => x !== fieldId) });

  // Options typed into a form exist only locally until it's submitted.
  const withChoices = (f: Field): Field => extraChoices[f.id] ? { ...f, options: { ...f.options, choices: [...(f.options.choices ?? []), ...extraChoices[f.id]] } } : f;

  function submit() {
    const gaps = missingAnswers(form, fields, values, table.primaryFieldId);
    if (gaps.length) {
      setMissing(new Set(gaps.map((f) => f.id)));
      document.getElementById(`q-${gaps[0].id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    const pre = Object.entries(extraChoices).map(([fieldId, chs]) => ({
      type: "field.update" as const, fieldId, options: { choices: [...(snap.state.fields[fieldId].options.choices ?? []), ...chs] },
    }));
    if (client.dispatch(...pre, { type: "row.create", rowId: newId("rec"), tableId: table.id, cells: values, formViewId: view.id })) {
      setDone(true);
      setValues({});
      setExtraChoices({});
      setMissing(new Set());
    }
  }

  return (
    <div className="form-wrap">
      <div className="form-card">
        <div className="row">
          <span className="spacer" />
          <button className={`btn ${editMode ? "active" : ""}`} onClick={() => setEditMode((m) => !m)}>{editMode ? "Done editing" : "✎ Edit form"}</button>
        </div>
        {editMode ? (
          <>
            <input className="input" style={{ fontSize: 20, fontWeight: 700 }} value={form.title} onChange={(e) => updateForm({ title: e.target.value })} aria-label="Form title" />
            <textarea className="textarea" placeholder="Description (optional)" value={form.description} onChange={(e) => updateForm({ description: e.target.value })} aria-label="Form description" />
            <label className="field-label">Questions</label>
            {allFields.map((f) => {
              const on = form.fieldIds.includes(f.id);
              return (
                <div key={f.id} className={`form-q-edit ${on ? "on" : ""}`}>
                  <div className="row">
                    <label className="row" style={{ cursor: "pointer", flex: 1, minWidth: 0 }}>
                      <input type="checkbox" checked={on}
                        onChange={(e) => updateForm({ fieldIds: e.target.checked ? [...form.fieldIds, f.id] : form.fieldIds.filter((x) => x !== f.id) })} />
                      <FieldIcon field={f} /> {f.name}
                    </label>
                    {on && (
                      <label className="row small" style={{ cursor: "pointer", gap: 4 }}>
                        <input type="checkbox" checked={required.has(f.id)} onChange={(e) => toggleRequired(f.id, e.target.checked)} aria-label={`${f.name} is required`} />
                        Required
                      </label>
                    )}
                  </div>
                  {on && (
                    <div className="form-q-extra">
                      <input className="input" placeholder={`Question (default: ${f.name})`} value={form.labels?.[f.id] ?? ""}
                        onChange={(e) => setText("labels", f.id, e.target.value)} aria-label={`Question text for ${f.name}`} />
                      <input className="input" placeholder={f.description ? `Help text (default: ${f.description})` : "Help text (optional)"} value={form.help?.[f.id] ?? ""}
                        onChange={(e) => setText("help", f.id, e.target.value)} aria-label={`Help text for ${f.name}`} />
                    </div>
                  )}
                </div>
              );
            })}
            <div>
              <label className="field-label">Button text</label>
              <input className="input" value={form.submitLabel} onChange={(e) => updateForm({ submitLabel: e.target.value })} aria-label="Button text" />
            </div>
            <div>
              <label className="field-label">Message after submitting</label>
              <textarea className="textarea" placeholder={`Thanks! Your response was added to ${table.name}.`} value={form.thankYou ?? ""}
                onChange={(e) => updateForm({ thankYou: e.target.value })} aria-label="Message after submitting" />
            </div>
            <PublicLinkSettings form={form} fields={fields} onChange={(publicToken) => updateForm({ publicToken })} />
          </>
        ) : done ? (
          <>
            <h2>Thanks!</h2>
            <p className="muted" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{form.thankYou?.trim() || `Your response was added to ${table.name}.`}</p>
            <button className="btn primary" style={{ alignSelf: "flex-start" }} onClick={() => setDone(false)}>Submit another</button>
          </>
        ) : (
          <>
            <h2>{form.title}</h2>
            {form.description && <p className="muted" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{form.description}</p>}
            {fields.length === 0 && <p className="muted">This form has no questions yet. Click “Edit form” to add some.</p>}
            {fields.map((f) => {
              const help = questionHelp(form, f);
              // Questions flagged on the last submit keep the space for their message, so the
              // form doesn't jump under the pointer when an answer is filled in.
              const flagged = missing.has(f.id);
              const bad = flagged && !isAnswered(values[f.id]);
              return (
                <div key={f.id} id={`q-${f.id}`} className={bad ? "form-q missing" : "form-q"}>
                  <label className="field-label" style={{ fontSize: 13, color: "var(--text)" }}>
                    {questionLabel(form, f)}{required.has(f.id) && <span className="req" aria-label="required"> *</span>}
                  </label>
                  {help && <p className="muted small" style={{ margin: "0 0 4px", whiteSpace: "pre-wrap" }}>{help}</p>}
                  <FieldInput field={withChoices(f)} value={values[f.id]} onCommit={(v, ch) => {
                    if (ch) setExtraChoices((x) => ({ ...x, [f.id]: [...(x[f.id] ?? []), ch] }));
                    setValues((x) => ({ ...x, [f.id]: v }));
                  }} />
                  {flagged && <p className="small" role={bad ? "alert" : undefined} style={{ color: "var(--danger)", margin: "4px 0 0", visibility: bad ? "visible" : "hidden" }}>This question is required.</p>}
                </div>
              );
            })}
            {missing.size > 0 && (
              <p className="small" style={{ color: "var(--danger)", margin: 0, visibility: [...missing].some((id) => !isAnswered(values[id])) ? "visible" : "hidden" }}>
                Please answer the required questions.
              </p>
            )}
            {fields.length > 0 && <button className="btn primary" style={{ alignSelf: "flex-start" }} onClick={submit}>{form.submitLabel || "Submit"}</button>}
          </>
        )}
      </div>
    </div>
  );
}

/** A long random code for a public link (about 190 bits). */
function newPublicToken(): string {
  const A = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => A[b % 62]).join("");
}

/** Turn the public link on or off, or replace it so the old one stops working. */
function PublicLinkSettings({ form, fields, onChange }: { form: FormConfig; fields: Field[]; onChange: (token: string | null) => void }) {
  const [copied, setCopied] = useState(false);
  const url = form.publicToken ? `${location.origin}/f/${form.publicToken}` : "";
  const left = fields.filter((f) => !PUBLIC_TYPES.has(f.type));
  async function copy() {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { prompt("Copy this link", url); }
  }
  return (
    <div className="public-link">
      <label className="field-label">Public link</label>
      {form.publicToken ? (
        <>
          <p className="small muted" style={{ margin: "0 0 6px" }}>Anyone with this link can send a response, no account needed. They can't see any records.</p>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <input className="input" readOnly value={url} aria-label="Public form link" onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 220 }} />
            <button className="btn" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
            <a className="btn" href={url} target="_blank" rel="noreferrer">Open</a>
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn ghost small" onClick={() => confirm("Make a new link? The current one will stop working.") && onChange(newPublicToken())}>New link</button>
            <button className="btn ghost small danger" onClick={() => onChange(null)}>Turn off</button>
          </div>
        </>
      ) : (
        <div className="row">
          <span className="small muted" style={{ flex: 1 }}>Only people in this base can use this form.</span>
          <button className="btn" onClick={() => onChange(newPublicToken())}>Create public link</button>
        </div>
      )}
      {left.length > 0 && (
        <p className="small muted" style={{ margin: "6px 0 0" }}>
          Left off the public form: {left.map((f) => f.name).join(", ")} (link and attachment questions are only for people in the base).
        </p>
      )}
    </div>
  );
}
