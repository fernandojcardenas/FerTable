"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Automation, AutomationStep, AutomationTrigger, Field } from "@/shared/types";
import { isComputed } from "@/shared/fieldTypes";
import { newId } from "@/shared/ids";
import { idsToNames, namesToIds } from "@/shared/formula";
import { Dialog, useBase } from "./common";
import { FilterEditor } from "./Toolbar";
import { planSteps, triggerMatches, type StepPreview } from "@/shared/automation";

type Run = { id: number; automation_id: string; txn: number | null; status: string; message: string; created_at: string };

export function AutomationsDialog({ onClose }: { onClose: () => void }) {
  const { snap, client } = useBase();
  const autos = Object.values(snap.state.automations);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);

  const loadRuns = useCallback(() => {
    fetch(`/api/bases/${snap.state.base.id}/automation-runs`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setRuns(d.runs ?? []))
      .catch(() => {});
  }, [snap.state.base.id]);
  useEffect(() => { loadRuns(); }, [loadRuns, snap.state.base.txn]);

  if (editing) return <AutomationEditor initial={editing} onClose={() => setEditing(null)} />;

  const firstTable = snap.state.tableOrder[0];
  return (
    <Dialog wide title="Automations" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Close</button>}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>When something happens to a record, update it, create other records or send an email. Automations run on the server.</p>
        <div className="auto-list">
          {autos.length === 0 && <span className="muted">No automations yet.</span>}
          {autos.map((a) => (
            <div key={a.id} className="auto-item">
              <button className={`switch ${a.enabled ? "on" : ""}`} aria-label={a.enabled ? "Turn off" : "Turn on"}
                onClick={() => client.dispatch({ type: "automation.upsert", automation: { ...a, enabled: !a.enabled } })} />
              <div style={{ flex: 1 }}>
                <strong>{a.name}</strong>
                <div className="muted small">{describeTrigger(a.trigger, snap.state.tables[a.trigger.tableId]?.name)} → {a.steps.length} step{a.steps.length === 1 ? "" : "s"}</div>
              </div>
              <button className="btn" onClick={() => setEditing(a)}>Edit</button>
              <button className="btn ghost danger" aria-label="Delete automation" onClick={() => confirm(`Delete "${a.name}"?`) && client.dispatch({ type: "automation.delete", automationId: a.id })}>🗑</button>
            </div>
          ))}
        </div>
        <div>
          <button className="btn primary" disabled={!firstTable} onClick={() => setEditing({
            id: newId("aut"), name: "New automation", enabled: true,
            trigger: { type: "recordCreated", tableId: firstTable }, steps: [],
          })}>+ New automation</button>
        </div>
        <div>
          <div className="row"><strong>Recent runs</strong><span className="spacer" /><button className="btn ghost small" onClick={loadRuns}>Refresh</button></div>
          {runs.length === 0 && <span className="muted small">Nothing has run yet.</span>}
          {runs.map((r) => (
            <div key={r.id} className="run-row">
              <span className={r.status === "success" ? "ok" : "bad"}>{r.status === "success" ? "✓" : "✕"}</span>
              <span style={{ width: 160 }}>{snap.state.automations[r.automation_id]?.name ?? "(deleted)"}</span>
              <span className="muted" style={{ flex: 1 }}>{r.message}</span>
              <span className="muted">{new Date(r.created_at).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

function describeTrigger(t: AutomationTrigger, tableName = "?"): string {
  if (t.type === "recordCreated") return `When a record is created in ${tableName}`;
  if (t.type === "recordUpdated") return `When a record is updated in ${tableName}`;
  return `When a record matches conditions in ${tableName}`;
}

function AutomationEditor({ initial, onClose }: { initial: Automation; onClose: () => void }) {
  const { snap, client } = useBase();
  const state = snap.state;
  const [auto, setAuto] = useState<Automation>(() => structuredClone(initial));
  const fieldsOf = (tableId: string): Field[] => (state.tables[tableId]?.fieldOrder ?? []).map((id) => state.fields[id]).filter(Boolean);
  const triggerFields = fieldsOf(auto.trigger.tableId);

  const setTrigger = (t: AutomationTrigger) => setAuto({ ...auto, trigger: t });
  const changeTriggerType = (type: AutomationTrigger["type"]) => {
    const tableId = auto.trigger.tableId;
    if (type === "recordCreated") setTrigger({ type, tableId });
    else if (type === "recordUpdated") setTrigger({ type, tableId, watchFieldIds: [] });
    else setTrigger({ type, tableId, filters: { conjunction: "and", conditions: [] } });
  };
  const setStep = (i: number, s: AutomationStep) => setAuto({ ...auto, steps: auto.steps.map((x, j) => (j === i ? s : x)) });

  // Saving keeps the editor open, so you can test the saved version right away.
  const upToDate = JSON.stringify(state.automations[auto.id]) === JSON.stringify(auto);
  function save() {
    client.dispatch({ type: "automation.upsert", automation: auto });
  }

  return (
    <Dialog wide title={initial.name === auto.name ? "Edit automation" : auto.name} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>{upToDate ? "Back" : "Back without saving"}</button><button className="btn primary" disabled={upToDate} onClick={save}>{upToDate ? "Saved ✓" : "Save automation"}</button></>}>
      <div className="stack">
        <div>
          <label className="field-label">Name</label>
          <input className="input" value={auto.name} onChange={(e) => setAuto({ ...auto, name: e.target.value })} />
        </div>
        <fieldset style={{ border: "1px solid var(--line)", borderRadius: 8 }}>
          <legend><strong>When</strong></legend>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <select className="select" style={{ width: 240 }} value={auto.trigger.type} onChange={(e) => changeTriggerType(e.target.value as AutomationTrigger["type"])}>
              <option value="recordCreated">A record is created</option>
              <option value="recordUpdated">A record is updated</option>
              <option value="recordMatches">A record starts matching conditions</option>
            </select>
            <span>in</span>
            <select className="select" style={{ width: 200 }} value={auto.trigger.tableId}
              onChange={(e) => setAuto({ ...auto, trigger: { ...auto.trigger, tableId: e.target.value, ...(auto.trigger.type === "recordUpdated" ? { watchFieldIds: [] } : {}), ...(auto.trigger.type === "recordMatches" ? { filters: { conjunction: "and", conditions: [] } } : {}) } as AutomationTrigger, steps: [] })}>
              {state.tableOrder.map((id) => <option key={id} value={id}>{state.tables[id].name}</option>)}
            </select>
          </div>
          {auto.trigger.type === "recordUpdated" && (
            <div style={{ marginTop: 8 }}>
              <span className="muted small">Only when these fields change (none = any field):</span>
              <div className="row" style={{ flexWrap: "wrap", gap: 10, marginTop: 4 }}>
                {triggerFields.filter((f) => !isComputed(f.type)).map((f) => {
                  const t = auto.trigger as Extract<AutomationTrigger, { type: "recordUpdated" }>;
                  return (
                    <label key={f.id} className="row small">
                      <input type="checkbox" checked={t.watchFieldIds.includes(f.id)}
                        onChange={(e) => setTrigger({ ...t, watchFieldIds: e.target.checked ? [...t.watchFieldIds, f.id] : t.watchFieldIds.filter((x) => x !== f.id) })} />
                      {f.name}
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          {auto.trigger.type === "recordMatches" && (
            <div style={{ marginTop: 8 }}>
              <FilterEditor fields={triggerFields} filters={auto.trigger.filters}
                onChange={(filters) => setTrigger({ ...(auto.trigger as Extract<AutomationTrigger, { type: "recordMatches" }>), filters })} />
            </div>
          )}
        </fieldset>

        {auto.steps.map((step, i) => {
          const remove = () => setAuto({ ...auto, steps: auto.steps.filter((_, j) => j !== i) });
          return step.type === "sendEmail"
            ? <EmailStepEditor key={i} index={i} step={step} triggerFields={triggerFields} onChange={(s) => setStep(i, s)} onRemove={remove} />
            : <StepEditor key={i} index={i} step={step} triggerTableId={auto.trigger.tableId} triggerFields={triggerFields} fieldsOf={fieldsOf}
                onChange={(s) => setStep(i, s)} onRemove={remove} />;
        })}
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button className="btn" onClick={() => setAuto({ ...auto, steps: [...auto.steps, { type: "updateRecord", values: {} }] })}>+ Update the record</button>
          <button className="btn" onClick={() => setAuto({ ...auto, steps: [...auto.steps, { type: "createRecord", tableId: auto.trigger.tableId, values: {} }] })}>+ Create a record</button>
          <button className="btn" onClick={() => setAuto({ ...auto, steps: [...auto.steps, { type: "sendEmail", to: "", subject: "", body: "" }] })}>+ Send an email</button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          In values, write <code>{"{Field name}"}</code> to copy a value from the record that triggered the automation.
        </p>
        <TestPanel auto={auto} saved={upToDate} />
      </div>
    </Dialog>
  );
}

type RecordStep = Exclude<AutomationStep, { type: "sendEmail" }>;
type EmailStep = Extract<AutomationStep, { type: "sendEmail" }>;

function StepEditor({ index, step, triggerTableId, triggerFields, fieldsOf, onChange, onRemove }: {
  index: number; step: RecordStep; triggerTableId: string; triggerFields: Field[]; fieldsOf: (t: string) => Field[];
  onChange: (s: AutomationStep) => void; onRemove: () => void;
}) {
  const { snap } = useBase();
  const tableId = step.type === "createRecord" ? step.tableId : triggerTableId;
  const targetFields = fieldsOf(tableId).filter((f) => !isComputed(f.type) && f.type !== "attachment");
  const unused = targetFields.filter((f) => !(f.id in step.values));
  const show = (template: string) => idsToNames(template, triggerFields);
  const store = (text: string) => {
    try { return namesToIds(text, triggerFields); } catch { return text; }
  };
  return (
    <fieldset style={{ border: "1px solid var(--line)", borderRadius: 8 }}>
      <legend><strong>Then {index + 1}.</strong> {step.type === "updateRecord" ? "Update the triggering record" : "Create a record"}</legend>
      {step.type === "createRecord" && (
        <div className="row" style={{ marginBottom: 8 }}>
          <span>in</span>
          <select className="select" style={{ width: 200 }} value={step.tableId} onChange={(e) => onChange({ ...step, tableId: e.target.value, values: {} })}>
            {snap.state.tableOrder.map((id) => <option key={id} value={id}>{snap.state.tables[id].name}</option>)}
          </select>
        </div>
      )}
      <div className="stack" style={{ gap: 6 }}>
        {Object.entries(step.values).map(([fieldId, template]) => {
          const f = snap.state.fields[fieldId];
          if (!f) return null;
          return (
            <div key={fieldId} className="row">
              <span style={{ width: 150 }}>{f.name}</span>
              <input className="input" value={show(template)} placeholder="Value or {Field name}"
                onChange={(e) => onChange({ ...step, values: { ...step.values, [fieldId]: store(e.target.value) } })} />
              <button className="btn ghost" aria-label="Remove value" onClick={() => { const { [fieldId]: _, ...rest } = step.values; onChange({ ...step, values: rest }); }}>✕</button>
            </div>
          );
        })}
        <div className="row">
          {unused.length > 0 && (
            <select className="select" style={{ width: 220 }} value="" onChange={(e) => e.target.value && onChange({ ...step, values: { ...step.values, [e.target.value]: "" } })}>
              <option value="">+ Set a field…</option>
              {unused.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          )}
          <span className="spacer" />
          <button className="btn ghost danger" onClick={onRemove}>Remove step</button>
        </div>
      </div>
    </fieldset>
  );
}

/** Names ↔ ids for {Field name} placeholders in a text template. */
function templateText(fields: Field[]) {
  return {
    show: (template: string) => idsToNames(template, fields),
    store: (text: string) => { try { return namesToIds(text, fields); } catch { return text; } },
  };
}

function EmailStepEditor({ index, step, triggerFields, onChange, onRemove }: {
  index: number; step: EmailStep; triggerFields: Field[]; onChange: (s: AutomationStep) => void; onRemove: () => void;
}) {
  const { show, store } = templateText(triggerFields);
  const emailFields = triggerFields.filter((f) => f.type === "email");
  return (
    <fieldset style={{ border: "1px solid var(--line)", borderRadius: 8 }}>
      <legend><strong>Then {index + 1}.</strong> Send an email</legend>
      <div className="stack" style={{ gap: 6 }}>
        <div className="row">
          <span style={{ width: 70 }}>To</span>
          <input className="input" value={show(step.to)} aria-label="Send to"
            placeholder={emailFields.length ? `someone@example.com, {${emailFields[0].name}}` : "someone@example.com"}
            onChange={(e) => onChange({ ...step, to: store(e.target.value) })} />
        </div>
        <div className="row">
          <span style={{ width: 70 }}>Subject</span>
          <input className="input" value={show(step.subject)} aria-label="Subject" placeholder="New request: {Name}"
            onChange={(e) => onChange({ ...step, subject: store(e.target.value) })} />
        </div>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <span style={{ width: 70, paddingTop: 6 }}>Message</span>
          <textarea className="textarea" value={show(step.body)} aria-label="Message" rows={4} placeholder="Plain text. {Field name} works here too."
            onChange={(e) => onChange({ ...step, body: store(e.target.value) })} />
        </div>
        <div className="row">
          <span className="muted small">Up to 10 addresses, separated by commas.</span>
          <span className="spacer" />
          <button className="btn ghost danger" onClick={onRemove}>Remove step</button>
        </div>
      </div>
    </fieldset>
  );
}

/** Try the automation on one record: see what each step would do, then run it for real if you like. */
function TestPanel({ auto, saved }: { auto: Automation; saved: boolean }) {
  const { snap } = useBase();
  const state = snap.state;
  const table = state.tables[auto.trigger.tableId];
  const rowIds = (table?.rowOrder ?? []).filter((id) => state.rows[id]);
  const [rowId, setRowId] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const current = rowIds.includes(rowId) ? rowId : rowIds[0] ?? "";
  const row = state.rows[current];
  const plan = useMemo(() => (row ? planSteps(state, auto, row) : null), [state, auto, row]);
  useEffect(() => setResult(null), [current, auto]);

  async function runNow() {
    if (!plan || !row) return;
    const people = plan.emails.reduce((n, m) => n + m.to.length, 0);
    const what = [plan.actions.length && `change ${plan.actions.length} record${plan.actions.length === 1 ? "" : "s"}`, people > 0 && `email ${people} ${people === 1 ? "person" : "people"}`].filter(Boolean).join(" and ");
    if (!confirm(`This really runs the automation on “${snap.computer.primaryName(row.id)}”: it will ${what}. Continue?`)) return;
    setRunning(true);
    try {
      const r = await fetch(`/api/bases/${state.base.id}/automations/${auto.id}/run`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rowId: row.id }),
      });
      const d = await r.json().catch(() => ({}));
      setResult(r.ok ? { ok: d.status === "success", message: d.message } : { ok: false, message: d.error ?? `Failed (${r.status})` });
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(false);
    }
  }

  return (
    <fieldset className="auto-test" style={{ border: "1px dashed var(--line)", borderRadius: 8 }}>
      <legend><strong>Test</strong></legend>
      {!row ? <span className="muted small">Add a record to {table?.name ?? "the table"} to test with.</span> : (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <span>Try it on</span>
            <select className="select" style={{ width: 240 }} value={current} onChange={(e) => setRowId(e.target.value)} aria-label="Record to test with">
              {rowIds.map((id) => <option key={id} value={id}>{snap.computer.primaryName(id) || "(unnamed record)"}</option>)}
            </select>
          </div>
          {auto.trigger.type === "recordMatches" && (
            <span className="muted small">{triggerMatches(state, auto, row) ? "This record matches the conditions now." : "This record doesn't match the conditions right now; on its own it wouldn't start the automation."}</span>
          )}
          {plan && plan.preview.length === 0 && <span className="muted small">Add a step to see what it would do.</span>}
          {plan?.preview.map((p, i) => <PreviewStep key={i} index={i} p={p} />)}
          {plan?.problems.map((m) => <span key={m} className="small" style={{ color: "var(--danger)" }}>{m}</span>)}
          <div className="row" style={{ flexWrap: "wrap" }}>
            <span className="muted small">Nothing changes until you run it.</span>
            <span className="spacer" />
            {!saved && <span className="muted small">Save the automation to run it for real.</span>}
            <button className="btn" disabled={!saved || running || !plan || plan.problems.length > 0 || plan.preview.length === 0} onClick={() => void runNow()}>
              {running ? "Running…" : "▶ Run now on this record"}
            </button>
          </div>
          {result && <span className="small" role="status" style={{ color: result.ok ? "var(--ok, #2e9d5b)" : "var(--danger)" }}>{result.ok ? "✓ " : "✕ "}{result.message}</span>}
        </div>
      )}
    </fieldset>
  );
}

function PreviewStep({ index, p }: { index: number; p: StepPreview }) {
  if (p.kind === "email") {
    return (
      <div className="auto-preview">
        <strong>{index + 1}. Email</strong> to {p.to.length ? p.to.join(", ") : <em>nobody</em>}
        {p.invalid.length > 0 && <span className="small" style={{ color: "var(--danger)" }}> (skipped, not addresses: {p.invalid.join(", ")})</span>}
        <div className="muted small">Subject: {p.subject}</div>
        {p.text && <pre className="auto-preview-body">{p.text}</pre>}
      </div>
    );
  }
  return (
    <div className="auto-preview">
      <strong>{index + 1}. {p.kind === "update" ? "Update this record" : `Create a record in ${p.tableName}`}</strong>
      {p.cells.length === 0 ? <div className="muted small">No fields set.</div> : (
        <ul className="small" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          {p.cells.map((c) => <li key={c.field}>{c.field} → {c.value}</li>)}
        </ul>
      )}
    </div>
  );
}
