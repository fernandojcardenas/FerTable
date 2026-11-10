"use client";

import { useMemo, useState } from "react";
import type { Field, FieldOptions, FieldType, RollupFn, SelectChoice } from "@/shared/types";
import { CHOICE_COLORS, defaultOptions, FIELD_TYPE_ORDER, FIELD_TYPES, makeChoice } from "@/shared/fieldTypes";
import { FUNCTION_NAMES, idsToNames, namesToIds, FormulaError, ROLLUP_PRESET_FORMULAS } from "@/shared/formula";
import { Computer } from "@/shared/compute";
import { applyAction } from "@/shared/reducer";
import { newId } from "@/shared/ids";
import { Dialog, useBase } from "./common";
import { NewFieldOptions } from "./newFields";

const ROLLUP_FNS: { id: RollupFn; label: string }[] = [
  { id: "sum", label: "Sum" }, { id: "avg", label: "Average" }, { id: "min", label: "Minimum" }, { id: "max", label: "Maximum" },
  { id: "count", label: "Count all" }, { id: "counta", label: "Count non-empty" }, { id: "concat", label: "Join as text" },
  { id: "and", label: "All true" }, { id: "or", label: "Any true" }, { id: "formula", label: "Custom formula…" },
];

const ROLLUP_HINTS = ["SUM(values)", "MAX(values) - MIN(values)", "ARRAYJOIN(ARRAYUNIQUE(values), \" · \")", "COUNTA(values) & \" done\""];

export function FieldDialog({ tableId, fieldId, afterFieldId, presetType, onClose }: {
  tableId: string; fieldId?: string; afterFieldId?: string | null; presetType?: FieldType; onClose: () => void;
}) {
  const { snap, client } = useBase();
  const state = snap.state;
  const table = state.tables[tableId];
  const existing = fieldId ? state.fields[fieldId] : undefined;
  const isPrimary = existing && table?.primaryFieldId === existing.id;
  const tableFields = (table?.fieldOrder ?? []).map((id) => state.fields[id]).filter(Boolean);

  const [name, setName] = useState(existing?.name ?? "");
  const [type, setType] = useState<FieldType>(existing?.type ?? presetType ?? "text");
  const [opts, setOpts] = useState<FieldOptions>(() => structuredClone(existing?.options ?? defaultOptions(presetType ?? "text")));
  const [formulaText, setFormulaText] = useState(() =>
    existing?.type === "formula" ? idsToNames(existing.options.expression ?? "", tableFields) : "",
  );
  const [description, setDescription] = useState(existing?.description ?? "");

  const changeType = (t: FieldType) => {
    setType(t);
    if (t !== existing?.type) {
      const base = defaultOptions(t);
      // Keep options when switching between the two select types.
      if ((t === "singleSelect" || t === "multiSelect") && opts.choices) base.choices = opts.choices;
      setOpts(base);
    } else setOpts(structuredClone(existing.options));
  };

  const linkFields = tableFields.filter((f) => f.type === "link" && f.id !== existing?.id);
  const linkField = state.fields[opts.linkFieldId ?? ""];
  const targetFields = linkField ? (state.tables[linkField.options.linkedTableId ?? ""]?.fieldOrder ?? []).map((id) => state.fields[id]).filter(Boolean) : [];

  // Turn the editor's formula ({Field name}) into stored form ({fldId}) and preview it.
  const formula = useMemo(() => {
    if (type !== "formula") return { expression: "", error: null as string | null, preview: "" };
    try {
      const expression = namesToIds(formulaText, tableFields.filter((f) => f.id !== existing?.id));
      const probeId = existing?.id ?? newId("fld");
      const probe: Field = { id: probeId, tableId, name: name || "Preview", type: "formula", options: { expression } };
      const s2 = { ...state, fields: { ...state.fields, [probeId]: probe } };
      const firstRow = table?.rowOrder.map((id) => state.rows[id]).find(Boolean);
      const c = new Computer(s2);
      const err = firstRow ? c.isError(firstRow, probe) : null;
      return { expression, error: err, preview: firstRow && !err ? c.display(firstRow, probe) : "" };
    } catch (e) {
      return { expression: "", error: e instanceof FormulaError ? e.message : String(e), preview: "" };
    }
  }, [type, formulaText, tableFields, existing, tableId, name, state, table]);

  // Live result of a custom rollup formula on this table's first record.
  const rollupPreview = useMemo(() => {
    if (type !== "rollup" || opts.fn !== "formula" || !linkField || !opts.targetFieldId) return null;
    const firstRow = table?.rowOrder.map((id) => state.rows[id]).find(Boolean);
    if (!firstRow) return null;
    const probeId = existing?.id ?? newId("fld");
    const probe: Field = { id: probeId, tableId, name: name || "Preview", type: "rollup", options: { ...opts } };
    const c = new Computer({ ...state, fields: { ...state.fields, [probeId]: probe } });
    const err = c.isError(firstRow, probe);
    return { label: c.primaryName(firstRow.id) || "First record", value: err ? null : c.display(firstRow, probe), error: err };
  }, [type, opts, linkField, table, state, existing, tableId, name]);

  function save() {
    const finalName = name.trim() || FIELD_TYPES[type].label;
    let options: FieldOptions = { ...opts };
    if (type === "formula") options = { expression: formula.expression };
    if (type === "singleSelect" || type === "multiSelect") options = { choices: (opts.choices ?? []).filter((c) => c.name.trim()) };
    const needsInverse = type === "link" && existing?.type !== "link" && options.linkedTableId !== tableId;
    const inverseFieldId = needsInverse ? newId("fld") : undefined;
    const ok = existing
      ? client.dispatch({
          type: "field.update", fieldId: existing.id, name: finalName, description,
          ...(type !== existing.type ? { fieldType: type, inverseFieldId } : {}),
          options,
        })
      : client.dispatch({
          type: "field.create", fieldId: newId("fld"), tableId, name: finalName, fieldType: type, options, inverseFieldId, afterFieldId,
        });
    if (ok) onClose();
  }

  function remove() {
    if (!existing) return;
    if (!confirm(`Delete the field "${existing.name}"? Its data will be removed from every record.`)) return;
    if (client.dispatch({ type: "field.delete", fieldId: existing.id })) onClose();
  }

  // Check the change locally so the Save button can explain what's wrong.
  const problem = useMemo(() => {
    if (type === "formula" && formula.error && !formula.expression) return formula.error;
    try {
      const options = type === "formula" ? { expression: formula.expression } : opts;
      if (existing) applyAction(state, { type: "field.update", fieldId: existing.id, name: name.trim() || existing.name, fieldType: type, options, inverseFieldId: type === "link" && existing.type !== "link" ? newId("fld") : undefined });
      else applyAction(state, { type: "field.create", fieldId: newId("fld"), tableId, name: name.trim() || FIELD_TYPES[type].label, fieldType: type, options, inverseFieldId: type === "link" ? newId("fld") : undefined });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [type, formula, opts, existing, state, name, tableId]);

  return (
    <Dialog
      title={existing ? `Edit field` : "New field"}
      onClose={onClose}
      footer={
        <>
          {existing && !isPrimary && <button className="btn danger" onClick={remove}>Delete field</button>}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={Boolean(problem)} title={problem ?? ""}>{existing ? "Save" : "Create field"}</button>
        </>
      }
    >
      <div className="stack">
        <div>
          <label className="field-label" htmlFor="field-name">Name</label>
          <input id="field-name" className="input" autoFocus value={name} placeholder={FIELD_TYPES[type].label} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !problem && save()} />
        </div>
        <div>
          <label className="field-label" htmlFor="field-type">Type</label>
          <select id="field-type" className="select" value={type} onChange={(e) => changeType(e.target.value as FieldType)}>
            {FIELD_TYPE_ORDER.filter((t) => !(isPrimary && t === "link")).map((t) => (
              <option key={t} value={t}>{FIELD_TYPES[t].icon}  {FIELD_TYPES[t].label}</option>
            ))}
          </select>
          <p className="muted small" style={{ margin: "4px 0 0" }}>{FIELD_TYPES[type].description}</p>
          {existing && type !== existing.type && (
            <p className="small" style={{ color: "var(--danger)", margin: "4px 0 0" }}>
              Changing the type converts existing values where possible. Some data may be lost.
            </p>
          )}
        </div>

        {type === "number" && (
          <div className="row">
            <div style={{ flex: 1 }}>
              <label className="field-label">Format</label>
              <select className="select" value={opts.format ?? "decimal"} onChange={(e) => setOpts({ ...opts, format: e.target.value as FieldOptions["format"] })}>
                <option value="decimal">Decimal</option>
                <option value="integer">Integer</option>
                <option value="currency">Currency</option>
                <option value="percent">Percent</option>
              </select>
            </div>
            {opts.format !== "integer" && (
              <div style={{ width: 120 }}>
                <label className="field-label">Decimals</label>
                <input className="input" type="number" min={0} max={8} value={opts.precision ?? 0} onChange={(e) => setOpts({ ...opts, precision: Number(e.target.value) })} />
              </div>
            )}
            {opts.format === "currency" && (
              <div style={{ width: 90 }}>
                <label className="field-label">Symbol</label>
                <input className="input" value={opts.symbol ?? "$"} onChange={(e) => setOpts({ ...opts, symbol: e.target.value })} />
              </div>
            )}
          </div>
        )}

        {(type === "singleSelect" || type === "multiSelect") && (
          <ChoicesEditor choices={opts.choices ?? []} onChange={(choices) => setOpts({ ...opts, choices })} />
        )}

        {type === "date" && (
          <label className="row"><input type="checkbox" checked={Boolean(opts.includeTime)} onChange={(e) => setOpts({ ...opts, includeTime: e.target.checked })} /> Include a time</label>
        )}
        <NewFieldOptions type={type} opts={opts} setOpts={setOpts} tableFields={tableFields} existing={existing} />

        {type === "link" && (
          <div>
            <label className="field-label">Link to table</label>
            <select className="select" value={opts.linkedTableId ?? ""} disabled={existing?.type === "link"}
              onChange={(e) => setOpts({ ...opts, linkedTableId: e.target.value })}>
              <option value="">Choose a table…</option>
              {state.tableOrder.map((id) => <option key={id} value={id}>{state.tables[id].name}{id === tableId ? " (this table)" : ""}</option>)}
            </select>
            {opts.linkedTableId && opts.linkedTableId !== tableId && existing?.type !== "link" && (
              <p className="muted small">A matching field will be added to {state.tables[opts.linkedTableId]?.name} so links show on both sides.</p>
            )}
          </div>
        )}

        {(type === "lookup" || type === "rollup" || type === "count") && (
          <>
            {linkFields.length === 0 ? (
              <p className="small" style={{ color: "var(--danger)" }}>Add a “Link to another record” field to this table first.</p>
            ) : (
              <div>
                <label className="field-label">Linked records from</label>
                <select className="select" value={opts.linkFieldId ?? ""} onChange={(e) => setOpts({ ...opts, linkFieldId: e.target.value, targetFieldId: undefined })}>
                  <option value="">Choose a link field…</option>
                  {linkFields.map((f) => <option key={f.id} value={f.id}>{f.name} → {state.tables[f.options.linkedTableId ?? ""]?.name}</option>)}
                </select>
              </div>
            )}
            {type !== "count" && linkField && (
              <div>
                <label className="field-label">Field to {type === "lookup" ? "show" : "summarize"}</label>
                <select className="select" value={opts.targetFieldId ?? ""} onChange={(e) => setOpts({ ...opts, targetFieldId: e.target.value })}>
                  <option value="">Choose a field…</option>
                  {targetFields.map((f) => <option key={f.id} value={f.id}>{FIELD_TYPES[f.type].icon} {f.name}</option>)}
                </select>
              </div>
            )}
            {type === "rollup" && (
              <div>
                <label className="field-label">Summary</label>
                <select className="select" value={opts.fn ?? "sum"} onChange={(e) => {
                  const fn = e.target.value as RollupFn;
                  // A custom formula starts from the summary that was picked, so it's easy to tweak.
                  setOpts(fn === "formula"
                    ? { ...opts, fn, expression: opts.expression || ROLLUP_PRESET_FORMULAS[opts.fn ?? "sum"] || "SUM(values)" }
                    : { ...opts, fn, expression: undefined });
                }} aria-label="Summary">
                  {ROLLUP_FNS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                </select>
              </div>
            )}
            {type === "rollup" && opts.fn === "formula" && (
              <div>
                <label className="field-label" htmlFor="rollup-formula">Formula</label>
                <textarea id="rollup-formula" className="textarea" style={{ fontFamily: "ui-monospace, Menlo, monospace" }} value={opts.expression ?? ""}
                  placeholder="SUM(values)" onChange={(e) => setOpts({ ...opts, expression: e.target.value })} />
                <p className="small muted" style={{ margin: "4px 0" }}>
                  <code>values</code> is the list of {targetFields.find((f) => f.id === opts.targetFieldId)?.name ?? "field"} values from the linked records. Try:{" "}
                  {ROLLUP_HINTS.map((h, i) => (
                    <span key={h}>{i > 0 && " · "}<button type="button" className="btn ghost small" style={{ padding: "0 4px" }} aria-label={`Use ${h}`} onClick={() => setOpts({ ...opts, expression: h })}><code>{h}</code></button></span>
                  ))}
                </p>
                {rollupPreview && (
                  rollupPreview.error
                    ? <p className="small" style={{ color: "var(--danger)", margin: 0 }}>{rollupPreview.error}</p>
                    : <p className="small muted" style={{ margin: 0 }}>{rollupPreview.label}: <b style={{ color: "var(--text)" }}>{rollupPreview.value || "(empty)"}</b></p>
                )}
              </div>
            )}
          </>
        )}

        {type === "formula" && (
          <div>
            <label className="field-label" htmlFor="formula">Formula</label>
            <textarea id="formula" className="textarea" style={{ fontFamily: "ui-monospace, Menlo, monospace" }} value={formulaText}
              placeholder={'{Name} & " – " & {Status}'} onChange={(e) => setFormulaText(e.target.value)} />
            <div className="row small" style={{ flexWrap: "wrap", gap: 4, marginTop: 6 }}>
              <span className="muted">Insert field:</span>
              {tableFields.filter((f) => f.id !== existing?.id).map((f) => (
                <button key={f.id} className="btn ghost small" onClick={() => setFormulaText((t) => `${t}{${f.name}}`)}>{f.name}</button>
              ))}
            </div>
            {formula.error ? (
              <p className="small" style={{ color: "var(--danger)" }}>{formula.error}</p>
            ) : formulaText.trim() ? (
              <p className="small muted">First record: <b style={{ color: "var(--text)" }}>{formula.preview || "(empty)"}</b></p>
            ) : null}
            <details className="small muted">
              <summary>Functions</summary>
              <p>{FUNCTION_NAMES.join(", ")}</p>
              <p>Operators: + - * / &amp; (join text) = != &lt; &gt; &lt;= &gt;=</p>
            </details>
          </div>
        )}

        {existing && (
          <div>
            <label className="field-label">Description</label>
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
          </div>
        )}
        {problem && <p className="small" style={{ color: "var(--danger)", margin: 0 }}>{problem}</p>}
      </div>
    </Dialog>
  );
}

function ChoicesEditor({ choices, onChange }: { choices: SelectChoice[]; onChange: (c: SelectChoice[]) => void }) {
  const update = (i: number, patch: Partial<SelectChoice>) => onChange(choices.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div>
      <label className="field-label">Options</label>
      <div className="stack" style={{ gap: 6 }}>
        {choices.map((c, i) => (
          <div className="choice-row" key={c.id}>
            <button
              className={`color-swatch c-${c.color}`} title="Change color" aria-label="Change color"
              onClick={() => update(i, { color: CHOICE_COLORS[(CHOICE_COLORS.indexOf(c.color) + 1) % CHOICE_COLORS.length] })}
            />
            <input className="input" value={c.name} onChange={(e) => update(i, { name: e.target.value })} />
            <button className="btn ghost" disabled={i === 0} onClick={() => { const n = [...choices]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; onChange(n); }} aria-label="Move up">↑</button>
            <button className="btn ghost" onClick={() => onChange(choices.filter((_, j) => j !== i))} aria-label="Remove option">✕</button>
          </div>
        ))}
        <button className="btn" style={{ alignSelf: "flex-start" }} onClick={() => onChange([...choices, makeChoice(`Option ${choices.length + 1}`, choices.length)])}>+ Add option</button>
      </div>
    </div>
  );
}
