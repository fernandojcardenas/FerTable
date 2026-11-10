"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Automation, AutomationStep, AutomationTrigger, BaseState, ConnectionInfo, ConnectionKind, Field } from "@/shared/types";
import { isReadOnly } from "@/shared/fieldTypes";
import { newId } from "@/shared/ids";
import { idsToNames, namesToIds } from "@/shared/formula";
import { Dialog, useBase } from "./common";
import { FilterEditor } from "./Toolbar";
import { MAX_DEPTH, nextScheduledTime, planSteps, triggerMatches, type StepPreview } from "@/shared/automation";

type Run = { id: number; automation_id: string; txn: number | null; status: string; message: string; created_at: string };

const fieldsOf = (state: BaseState, tableId: string | null): Field[] =>
  tableId ? (state.tables[tableId]?.fieldOrder ?? []).map((id) => state.fields[id]).filter(Boolean) : [];

/** Connections (Slack, Sheets, webhooks) for this base. Only names and hosts reach the browser. */
function useConnections(baseId: string, enabled: boolean) {
  const [list, setList] = useState<ConnectionInfo[]>([]);
  const reload = useCallback(() => {
    if (!enabled) return;
    fetch(`/api/bases/${baseId}/connections`, { cache: "no-store" }).then((r) => r.json()).then((d) => setList(d.connections ?? [])).catch(() => {});
  }, [baseId, enabled]);
  useEffect(() => { reload(); }, [reload]);
  return { list, reload };
}

export function AutomationsDialog({ onClose }: { onClose: () => void }) {
  const { snap, client } = useBase();
  const autos = Object.values(snap.state.automations);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const canEdit = snap.role === "owner" || snap.role === "editor";
  const connections = useConnections(snap.state.base.id, canEdit);

  const loadRuns = useCallback(() => {
    fetch(`/api/bases/${snap.state.base.id}/automation-runs`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setRuns(d.runs ?? []))
      .catch(() => {});
  }, [snap.state.base.id]);
  useEffect(() => { loadRuns(); }, [loadRuns, snap.state.base.txn]);

  if (editing) return <AutomationEditor initial={editing} connections={connections.list} onClose={() => { setEditing(null); connections.reload(); }} />;

  const firstTable = snap.state.tableOrder[0];
  return (
    <Dialog wide title="Automations" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Close</button>}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>When something happens (or on a schedule), update records, send email, post to Slack or Google Sheets, call a webhook, or run a script. Automations run on the server.</p>
        <div className="auto-list">
          {autos.length === 0 && <span className="muted">No automations yet.</span>}
          {autos.map((a) => (
            <div key={a.id} className="auto-item">
              <button className={`switch ${a.enabled ? "on" : ""}`} aria-label={a.enabled ? `Turn off ${a.name}` : `Turn on ${a.name}`} disabled={!canEdit}
                onClick={() => client.dispatch({ type: "automation.upsert", automation: { ...a, enabled: !a.enabled } })} />
              <div style={{ flex: 1 }}>
                <strong>{a.name}</strong>
                <div className="muted small">{describeTrigger(snap.state, a.trigger)} → {a.steps.length} step{a.steps.length === 1 ? "" : "s"}</div>
              </div>
              {canEdit && <button className="btn" onClick={() => setEditing(a)}>Edit</button>}
              {canEdit && <button className="btn ghost danger" aria-label={`Delete ${a.name}`} onClick={() => confirm(`Delete "${a.name}"?`) && client.dispatch({ type: "automation.delete", automationId: a.id })}>🗑</button>}
            </div>
          ))}
        </div>
        {canEdit && (
          <div>
            <button className="btn primary" disabled={!firstTable} onClick={() => setEditing({
              id: newId("aut"), name: "New automation", enabled: true,
              trigger: { type: "recordCreated", tableId: firstTable }, steps: [],
            })}>+ New automation</button>
          </div>
        )}
        {canEdit && <ConnectionsManager connections={connections.list} reload={connections.reload} />}
        <div>
          <div className="row"><strong>Recent runs</strong><span className="spacer" /><button className="btn ghost small" onClick={loadRuns}>Refresh</button></div>
          {runs.length === 0 && <span className="muted small">Nothing has run yet.</span>}
          {runs.map((r) => (
            <div key={r.id} className="run-row">
              <span className={r.status === "success" ? "ok" : "bad"}>{r.status === "success" ? "✓" : "✕"}</span>
              <span style={{ width: 160 }}>{snap.state.automations[r.automation_id]?.name ?? "(deleted)"}</span>
              <span className="muted" style={{ flex: 1, whiteSpace: "pre-wrap" }}>{r.message}</span>
              <span className="muted">{new Date(r.created_at).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

const KIND_LABEL: Record<ConnectionKind, string> = { slack: "Slack", sheets: "Google Sheets", webhook: "Webhook" };
const KIND_HELP: Record<ConnectionKind, string> = {
  slack: "In Slack, add an Incoming Webhook to a channel and paste its URL (https://hooks.slack.com/…).",
  sheets: "In your sheet: Extensions → Apps Script, add a doPost(e) that appends JSON.parse(e.postData.contents).values as a row, deploy it as a web app, and paste the /exec URL.",
  webhook: "Any public https address that accepts a JSON POST (Zapier, Make, your own service…).",
};

function ConnectionsManager({ connections, reload }: { connections: ConnectionInfo[]; reload: () => void }) {
  const { snap } = useBase();
  const [kind, setKind] = useState<ConnectionKind>("slack");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const base = `/api/bases/${snap.state.base.id}/connections`;
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, name, url }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setError(d.error ?? "Couldn't save the connection");
    setName(""); setUrl(""); reload();
  }
  async function remove(c: ConnectionInfo) {
    if (!confirm(`Delete the connection "${c.name}"? Steps that use it will stop working.`)) return;
    await fetch(`${base}/${c.id}`, { method: "DELETE" });
    reload();
  }
  return (
    <details className="connections">
      <summary><strong>Connections</strong> <span className="muted small">({connections.length}) Slack, Google Sheets and webhooks</span></summary>
      <div className="stack" style={{ gap: 8, marginTop: 8 }}>
        <p className="muted small" style={{ margin: 0 }}>Connection addresses are kept on the server; steps only refer to them by name. For Gmail, set the server's <code>SMTP_URL</code> to Gmail's SMTP with an app password and use “Send an email”.</p>
        {connections.map((c) => (
          <div key={c.id} className="row small">
            <span style={{ width: 110 }}>{KIND_LABEL[c.kind]}</span><strong style={{ flex: 1 }}>{c.name}</strong><span className="muted">{c.host}</span>
            <button className="btn ghost small danger" onClick={() => void remove(c)} aria-label={`Delete connection ${c.name}`}>🗑</button>
          </div>
        ))}
        <form className="row" style={{ flexWrap: "wrap" }} onSubmit={(e) => void add(e)}>
          <select className="select" style={{ width: 150 }} value={kind} onChange={(e) => setKind(e.target.value as ConnectionKind)} aria-label="Connection type">
            {(Object.keys(KIND_LABEL) as ConnectionKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          <input className="input" style={{ width: 160 }} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Connection name" />
          <input className="input" style={{ flex: 1, minWidth: 220 }} placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Connection URL" />
          <button className="btn">Add</button>
        </form>
        <p className="muted small" style={{ margin: 0 }}>{KIND_HELP[kind]}</p>
        {error && <p className="small" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
      </div>
    </details>
  );
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function describeTrigger(state: BaseState, t: AutomationTrigger): string {
  const tableName = state.tables[t.tableId]?.name ?? "?";
  const viewName = (id: string | null) => (id ? state.views[id]?.name ?? "a deleted view" : null);
  switch (t.type) {
    case "recordCreated": return `When a record is created in ${tableName}`;
    case "recordUpdated": return `When a record is updated in ${tableName}`;
    case "recordMatches": return `When a record matches conditions in ${tableName}`;
    case "formSubmitted": return t.viewId ? `When the form “${viewName(t.viewId)}” is submitted` : `When any form in ${tableName} is submitted`;
    case "enteredView": return `When a record enters “${viewName(t.viewId)}”`;
    case "schedule": {
      const next = nextScheduledTime(t, new Date());
      const when = t.every === "hour" ? `Every hour at :${String(t.minute).padStart(2, "0")}` : t.every === "day"
        ? `Every day at ${next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
        : `Every ${DAYS[next.getDay()]} at ${next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
      return `${when}${t.viewId ? `, for each record in “${viewName(t.viewId)}”` : ""}`;
    }
  }
}

/** Local time-of-day + weekday ↔ the UTC values a schedule stores. */
function localToUtc(hour: number, minute: number, weekday: number) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  d.setDate(d.getDate() + ((weekday - d.getDay() + 7) % 7));
  return { hourUtc: d.getUTCHours(), minute: d.getUTCMinutes(), weekdayUtc: d.getUTCDay() };
}
function utcToLocal(t: Extract<AutomationTrigger, { type: "schedule" }>) {
  const d = new Date();
  d.setUTCHours(t.hourUtc, t.minute, 0, 0);
  d.setUTCDate(d.getUTCDate() + ((t.weekdayUtc - d.getUTCDay() + 7) % 7));
  return { hour: d.getHours(), minute: d.getMinutes(), weekday: d.getDay() };
}

function AutomationEditor({ initial, connections, onClose }: { initial: Automation; connections: ConnectionInfo[]; onClose: () => void }) {
  const { snap, client } = useBase();
  const state = snap.state;
  const [auto, setAuto] = useState<Automation>(() => structuredClone(initial));
  const triggerTable = auto.trigger.tableId;
  const triggerFields = fieldsOf(state, triggerTable);
  const noRecord = auto.trigger.type === "schedule" && !auto.trigger.viewId;
  const tableViews = (state.tables[triggerTable]?.viewOrder ?? []).map((id) => state.views[id]).filter(Boolean);

  const setTrigger = (t: AutomationTrigger) => setAuto({ ...auto, trigger: t });
  const changeTriggerType = (type: AutomationTrigger["type"]) => {
    const tableId = triggerTable;
    if (type === "recordCreated") setTrigger({ type, tableId });
    else if (type === "recordUpdated") setTrigger({ type, tableId, watchFieldIds: [] });
    else if (type === "recordMatches") setTrigger({ type, tableId, filters: { conjunction: "and", conditions: [] } });
    else if (type === "formSubmitted") setTrigger({ type, tableId, viewId: null });
    else if (type === "enteredView") setTrigger({ type, tableId, viewId: tableViews[0]?.id ?? "" });
    else setTrigger({ type, tableId, every: "day", ...localToUtc(9, 0, 1), viewId: null });
  };
  const changeTable = (tableId: string) => {
    const t = auto.trigger;
    const next: AutomationTrigger = t.type === "recordUpdated" ? { ...t, tableId, watchFieldIds: [] }
      : t.type === "recordMatches" ? { ...t, tableId, filters: { conjunction: "and", conditions: [] } }
      : t.type === "formSubmitted" ? { ...t, tableId, viewId: null }
      : t.type === "enteredView" ? { ...t, tableId, viewId: state.tables[tableId]?.viewOrder[0] ?? "" }
      : t.type === "schedule" ? { ...t, tableId, viewId: null } : { ...t, tableId };
    setAuto({ ...auto, trigger: next, steps: [] });
  };

  const upToDate = JSON.stringify(state.automations[auto.id]) === JSON.stringify(auto);
  const save = () => { client.dispatch({ type: "automation.upsert", automation: auto }); };

  return (
    <Dialog wide title={initial.name === auto.name ? "Edit automation" : auto.name} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>{upToDate ? "Back" : "Back without saving"}</button><button className="btn primary" disabled={upToDate} onClick={save}>{upToDate ? "Saved ✓" : "Save automation"}</button></>}>
      <div className="stack">
        <div>
          <label className="field-label">Name</label>
          <input className="input" value={auto.name} onChange={(e) => setAuto({ ...auto, name: e.target.value })} aria-label="Automation name" />
        </div>
        <fieldset style={{ border: "1px solid var(--line)", borderRadius: 8 }}>
          <legend><strong>When</strong></legend>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <select className="select" style={{ width: 260 }} value={auto.trigger.type} onChange={(e) => changeTriggerType(e.target.value as AutomationTrigger["type"])} aria-label="Trigger">
              <option value="recordCreated">A record is created</option>
              <option value="recordUpdated">A record is updated</option>
              <option value="recordMatches">A record starts matching conditions</option>
              <option value="enteredView">A record enters a view</option>
              <option value="formSubmitted">A form is submitted</option>
              <option value="schedule">On a schedule</option>
            </select>
            <span>in</span>
            <select className="select" style={{ width: 200 }} value={triggerTable} onChange={(e) => changeTable(e.target.value)} aria-label="Trigger table">
              {state.tableOrder.map((id) => <option key={id} value={id}>{state.tables[id].name}</option>)}
            </select>
          </div>
          <TriggerSettings trigger={auto.trigger} setTrigger={setTrigger} fields={triggerFields} />
        </fieldset>

        <StepList steps={auto.steps} onChange={(steps) => setAuto({ ...auto, steps })} tableId={noRecord ? null : triggerTable}
          triggerTable={triggerTable} depth={0} connections={connections} label="" />
        <p className="muted small" style={{ margin: 0 }}>
          In values, write <code>{"{Field name}"}</code> to use a value from the record (inside “repeat”, the linked record; the trigger record's fields still work too).
        </p>
        <TestPanel auto={auto} saved={upToDate} connections={connections} />
      </div>
    </Dialog>
  );
}

function TriggerSettings({ trigger, setTrigger, fields }: { trigger: AutomationTrigger; setTrigger: (t: AutomationTrigger) => void; fields: Field[] }) {
  const { snap } = useBase();
  const views = (snap.state.tables[trigger.tableId]?.viewOrder ?? []).map((id) => snap.state.views[id]).filter(Boolean);
  if (trigger.type === "recordUpdated") {
    const t = trigger;
    return (
      <div style={{ marginTop: 8 }}>
        <span className="muted small">Only when these fields change (none = any field):</span>
        <div className="row" style={{ flexWrap: "wrap", gap: 10, marginTop: 4 }}>
          {fields.filter((f) => !isReadOnly(f)).map((f) => (
            <label key={f.id} className="row small">
              <input type="checkbox" checked={t.watchFieldIds.includes(f.id)}
                onChange={(e) => setTrigger({ ...t, watchFieldIds: e.target.checked ? [...t.watchFieldIds, f.id] : t.watchFieldIds.filter((x) => x !== f.id) })} />
              {f.name}
            </label>
          ))}
        </div>
      </div>
    );
  }
  if (trigger.type === "recordMatches") {
    return <div style={{ marginTop: 8 }}><FilterEditor fields={fields} filters={trigger.filters} onChange={(filters) => setTrigger({ ...trigger, filters })} /></div>;
  }
  if (trigger.type === "formSubmitted") {
    const forms = views.filter((v) => v.type === "form");
    return (
      <div className="row" style={{ marginTop: 8 }}>
        <span>Form</span>
        <select className="select" style={{ width: 240 }} value={trigger.viewId ?? ""} onChange={(e) => setTrigger({ ...trigger, viewId: e.target.value || null })} aria-label="Which form">
          <option value="">Any form in this table</option>
          {forms.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <span className="muted small">Includes responses from public form links.</span>
      </div>
    );
  }
  if (trigger.type === "enteredView") {
    return (
      <div className="row" style={{ marginTop: 8 }}>
        <span>View</span>
        <select className="select" style={{ width: 240 }} value={trigger.viewId} onChange={(e) => setTrigger({ ...trigger, viewId: e.target.value })} aria-label="Which view">
          {views.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <span className="muted small">Runs when a record starts matching the view's filters.</span>
      </div>
    );
  }
  if (trigger.type === "schedule") {
    const local = utcToLocal(trigger);
    const set = (patch: Partial<{ hour: number; minute: number; weekday: number }>) => {
      const l = { ...local, ...patch };
      setTrigger({ ...trigger, ...localToUtc(l.hour, l.minute, l.weekday) });
    };
    const time = `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
    return (
      <div className="stack" style={{ gap: 8, marginTop: 8 }}>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <span>Every</span>
          <select className="select" style={{ width: 110 }} value={trigger.every} onChange={(e) => setTrigger({ ...trigger, every: e.target.value as "hour" | "day" | "week" })} aria-label="How often">
            <option value="hour">hour</option><option value="day">day</option><option value="week">week</option>
          </select>
          {trigger.every === "week" && (
            <select className="select" style={{ width: 140 }} value={local.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })} aria-label="Day of the week">
              {DAYS.map((d, i) => <option key={d} value={i}>on {d}</option>)}
            </select>
          )}
          {trigger.every === "hour" ? (
            <label className="row">at minute <input className="input" type="number" min={0} max={59} style={{ width: 70 }} value={local.minute} onChange={(e) => set({ minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })} aria-label="Minute of the hour" /></label>
          ) : (
            <label className="row">at <input className="input" type="time" style={{ width: 120 }} value={time}
              onChange={(e) => { const [h, m] = e.target.value.split(":").map(Number); if (Number.isFinite(h) && Number.isFinite(m)) set({ hour: h, minute: m }); }} aria-label="Time" /></label>
          )}
        </div>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <span>Run</span>
          <select className="select" style={{ width: 300 }} value={trigger.viewId ?? ""} onChange={(e) => setTrigger({ ...trigger, viewId: e.target.value || null })} aria-label="Records to run for">
            <option value="">once (no record)</option>
            {views.map((v) => <option key={v.id} value={v.id}>for each record in “{v.name}” (up to 100)</option>)}
          </select>
        </div>
        <span className="muted small">Next run: {nextScheduledTime(trigger, new Date()).toLocaleString()} (your time). The first run is the next due time after saving.</span>
      </div>
    );
  }
  return null;
}

/** Names ↔ ids for {Field name} placeholders, preferring the current record's fields. */
function templateText(fields: Field[]) {
  return {
    show: (template: string) => idsToNames(template, fields),
    store: (text: string) => { try { return namesToIds(text, fields); } catch { return text; } },
  };
}

const STEP_LABEL: Record<AutomationStep["type"], string> = {
  updateRecord: "Update the record", createRecord: "Create a record", sendEmail: "Send an email", condition: "If / otherwise",
  forEach: "Repeat for each linked record", script: "Run a script", slack: "Post to Slack", sheets: "Add a row to Google Sheets", webhook: "Call a webhook",
};

function newStep(type: AutomationStep["type"], tableId: string | null, triggerTable: string, connections: ConnectionInfo[]): AutomationStep {
  const conn = (k: ConnectionKind) => connections.find((c) => c.kind === k)?.id ?? "";
  switch (type) {
    case "updateRecord": return { type, values: {} };
    case "createRecord": return { type, tableId: tableId ?? triggerTable, values: {} };
    case "sendEmail": return { type, to: "", subject: "", body: "" };
    case "condition": return { type, filters: { conjunction: "and", conditions: [] }, then: [], otherwise: [] };
    case "forEach": return { type, linkFieldId: "", steps: [] };
    case "script": return { type, code: "// `record` has the current record's fields by name.\n// Return an object to update fields, e.g.:\n// return { \"Status\": \"Done\" };\nconsole.log(record);\n" };
    case "slack": return { type, connectionId: conn("slack"), text: "" };
    case "sheets": return { type, connectionId: conn("sheets"), columns: [""] };
    case "webhook": return { type, connectionId: conn("webhook"), body: "{\n  \"record\": \"{Name}\"\n}" };
  }
}

/** A list of steps; branches and loops contain their own lists. `tableId` is the current record's table, or null with no record. */
function StepList({ steps, onChange, tableId, triggerTable, depth, connections, label }: {
  steps: AutomationStep[]; onChange: (s: AutomationStep[]) => void; tableId: string | null; triggerTable: string; depth: number; connections: ConnectionInfo[]; label: string;
}) {
  const [adding, setAdding] = useState("");
  const set = (i: number, s: AutomationStep) => onChange(steps.map((x, j) => (j === i ? s : x)));
  const move = (i: number, d: -1 | 1) => { const next = [...steps]; [next[i], next[i + d]] = [next[i + d], next[i]]; onChange(next); };
  const types = (Object.keys(STEP_LABEL) as AutomationStep["type"][]).filter((t) =>
    tableId !== null || !["updateRecord", "condition", "forEach"].includes(t)).filter((t) => depth < MAX_DEPTH || !["condition", "forEach"].includes(t));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {steps.map((step, i) => (
        <fieldset key={i} className="step-card" style={{ border: "1px solid var(--line)", borderRadius: 8 }}>
          <legend className="row" style={{ gap: 6 }}>
            <strong>{label}{i + 1}.</strong> {STEP_LABEL[step.type]}
            <button type="button" className="btn ghost small" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move step up">↑</button>
            <button type="button" className="btn ghost small" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label="Move step down">↓</button>
            <button type="button" className="btn ghost small danger" onClick={() => onChange(steps.filter((_, j) => j !== i))} aria-label={`Remove step ${label}${i + 1}`}>✕</button>
          </legend>
          <StepBody step={step} onChange={(s) => set(i, s)} tableId={tableId} triggerTable={triggerTable} depth={depth} connections={connections} label={`${label}${i + 1}.`} />
        </fieldset>
      ))}
      <div className="row">
        <select className="select" style={{ width: 280 }} value={adding} aria-label={depth ? "Add a step here" : "Add a step"}
          onChange={(e) => { const t = e.target.value as AutomationStep["type"]; if (t) onChange([...steps, newStep(t, tableId, triggerTable, connections)]); setAdding(""); }}>
          <option value="">+ Add a step{depth ? " here" : ""}…</option>
          {types.map((t) => <option key={t} value={t}>{STEP_LABEL[t]}</option>)}
        </select>
      </div>
    </div>
  );
}

function StepBody({ step, onChange, tableId, triggerTable, depth, connections, label }: {
  step: AutomationStep; onChange: (s: AutomationStep) => void; tableId: string | null; triggerTable: string; depth: number; connections: ConnectionInfo[]; label: string;
}) {
  const { snap } = useBase();
  const state = snap.state;
  const currentFields = fieldsOf(state, tableId);
  const placeholderFields = [...currentFields, ...(tableId === triggerTable ? [] : fieldsOf(state, triggerTable))];
  const { show, store } = templateText(placeholderFields);
  const ConnPick = ({ kind, value, set }: { kind: ConnectionKind | null; value: string; set: (id: string) => void }) => {
    const options = connections.filter((c) => !kind || c.kind === kind);
    return (
      <select className="select" style={{ width: 260 }} value={value} onChange={(e) => set(e.target.value)} aria-label="Connection">
        <option value="">Choose a connection…</option>
        {options.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.host})</option>)}
      </select>
    );
  };
  switch (step.type) {
    case "updateRecord":
    case "createRecord":
      return <ValuesEditor step={step} onChange={onChange} tableId={tableId} show={show} store={store} />;
    case "sendEmail":
      return (
        <div className="stack" style={{ gap: 6 }}>
          <div className="row"><span style={{ width: 70 }}>To</span><input className="input" value={show(step.to)} aria-label="Send to" placeholder="someone@example.com, {Email}" onChange={(e) => onChange({ ...step, to: store(e.target.value) })} /></div>
          <div className="row"><span style={{ width: 70 }}>Subject</span><input className="input" value={show(step.subject)} aria-label="Subject" onChange={(e) => onChange({ ...step, subject: store(e.target.value) })} /></div>
          <div className="row" style={{ alignItems: "flex-start" }}><span style={{ width: 70, paddingTop: 6 }}>Message</span><textarea className="textarea" rows={3} value={show(step.body)} aria-label="Message" onChange={(e) => onChange({ ...step, body: store(e.target.value) })} /></div>
          <span className="muted small">Up to 10 addresses, separated by commas.</span>
        </div>
      );
    case "condition":
      return (
        <div className="stack" style={{ gap: 8 }}>
          <span className="muted small">If the {depth ? "current" : "trigger"} record matches:</span>
          <FilterEditor fields={currentFields} filters={step.filters} onChange={(filters) => onChange({ ...step, filters })} />
          <div className="branch"><strong className="small">Then</strong>
            <StepList steps={step.then} onChange={(then) => onChange({ ...step, then })} tableId={tableId} triggerTable={triggerTable} depth={depth + 1} connections={connections} label={`${label}then.`} />
          </div>
          <div className="branch"><strong className="small">Otherwise</strong>
            <StepList steps={step.otherwise} onChange={(otherwise) => onChange({ ...step, otherwise })} tableId={tableId} triggerTable={triggerTable} depth={depth + 1} connections={connections} label={`${label}else.`} />
          </div>
        </div>
      );
    case "forEach": {
      const links = currentFields.filter((f) => f.type === "link");
      const linked = state.fields[step.linkFieldId];
      return (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row">
            <span>For each record in</span>
            <select className="select" style={{ width: 240 }} value={step.linkFieldId} onChange={(e) => onChange({ ...step, linkFieldId: e.target.value, steps: [] })} aria-label="Link field to repeat over">
              <option value="">Choose a link field…</option>
              {links.map((f) => <option key={f.id} value={f.id}>{f.name} → {state.tables[f.options.linkedTableId ?? ""]?.name}</option>)}
            </select>
            <span className="muted small">(up to 100)</span>
          </div>
          {linked && (
            <div className="branch">
              <StepList steps={step.steps} onChange={(steps) => onChange({ ...step, steps })} tableId={linked.options.linkedTableId ?? null} triggerTable={triggerTable}
                depth={depth + 1} connections={connections} label={`${label}`} />
            </div>
          )}
        </div>
      );
    }
    case "script":
      return (
        <div className="stack" style={{ gap: 6 }}>
          <textarea className="textarea code" rows={8} spellCheck={false} value={step.code} onChange={(e) => onChange({ ...step, code: e.target.value })} aria-label="Script" />
          <span className="muted small">JavaScript in a sandbox (no network or files; 1 second, 16 MB). <code>record</code> and <code>trigger</code> hold field values by name; <code>console.log</code> goes to the run log; return an object like <code>{"{ \"Status\": \"Done\" }"}</code> to update the record.</span>
        </div>
      );
    case "slack":
      return (
        <div className="stack" style={{ gap: 6 }}>
          <div className="row"><span style={{ width: 90 }}>Connection</span><ConnPick kind="slack" value={step.connectionId} set={(connectionId) => onChange({ ...step, connectionId })} /></div>
          <div className="row" style={{ alignItems: "flex-start" }}><span style={{ width: 90, paddingTop: 6 }}>Message</span><textarea className="textarea" rows={3} value={show(step.text)} aria-label="Slack message" placeholder="New request from {Name}" onChange={(e) => onChange({ ...step, text: store(e.target.value) })} /></div>
          {!connections.some((c) => c.kind === "slack") && <span className="muted small">Add a Slack connection under Connections first.</span>}
        </div>
      );
    case "sheets":
      return (
        <div className="stack" style={{ gap: 6 }}>
          <div className="row"><span style={{ width: 90 }}>Connection</span><ConnPick kind="sheets" value={step.connectionId} set={(connectionId) => onChange({ ...step, connectionId })} /></div>
          {step.columns.map((c, i) => (
            <div key={i} className="row">
              <span style={{ width: 90 }}>Column {String.fromCharCode(65 + (i % 26))}</span>
              <input className="input" value={show(c)} aria-label={`Column ${i + 1}`} onChange={(e) => onChange({ ...step, columns: step.columns.map((x, j) => (j === i ? store(e.target.value) : x)) })} />
              <button type="button" className="btn ghost small" onClick={() => onChange({ ...step, columns: step.columns.filter((_, j) => j !== i) })} aria-label={`Remove column ${i + 1}`}>✕</button>
            </div>
          ))}
          <button type="button" className="btn ghost small" style={{ alignSelf: "flex-start" }} disabled={step.columns.length >= 50} onClick={() => onChange({ ...step, columns: [...step.columns, ""] })}>+ Column</button>
        </div>
      );
    case "webhook":
      return (
        <div className="stack" style={{ gap: 6 }}>
          <div className="row"><span style={{ width: 90 }}>Connection</span><ConnPick kind="webhook" value={step.connectionId} set={(connectionId) => onChange({ ...step, connectionId })} /></div>
          <textarea className="textarea code" rows={5} spellCheck={false} value={show(step.body)} aria-label="Webhook JSON body" onChange={(e) => onChange({ ...step, body: store(e.target.value) })} />
          <span className="muted small">Sent as a JSON POST. If the text isn't valid JSON it's sent as {"{ \"text\": … }"}.</span>
        </div>
      );
  }
}

function ValuesEditor({ step, onChange, tableId, show, store }: {
  step: Extract<AutomationStep, { type: "updateRecord" | "createRecord" }>; onChange: (s: AutomationStep) => void; tableId: string | null;
  show: (t: string) => string; store: (t: string) => string;
}) {
  const { snap } = useBase();
  const target = step.type === "createRecord" ? step.tableId : tableId;
  const targetFields = fieldsOf(snap.state, target).filter((f) => !isReadOnly(f) && f.type !== "attachment");
  const unused = targetFields.filter((f) => !(f.id in step.values));
  return (
    <div className="stack" style={{ gap: 6 }}>
      {step.type === "createRecord" && (
        <div className="row">
          <span>in</span>
          <select className="select" style={{ width: 200 }} value={step.tableId} onChange={(e) => onChange({ ...step, tableId: e.target.value, values: {} })} aria-label="Table to create in">
            {snap.state.tableOrder.map((id) => <option key={id} value={id}>{snap.state.tables[id].name}</option>)}
          </select>
        </div>
      )}
      {Object.entries(step.values).map(([fieldId, template]) => {
        const f = snap.state.fields[fieldId];
        if (!f) return null;
        return (
          <div key={fieldId} className="row">
            <span style={{ width: 150 }}>{f.name}</span>
            <input className="input" value={show(template)} placeholder="Value or {Field name}" aria-label={`Value for ${f.name}`}
              onChange={(e) => onChange({ ...step, values: { ...step.values, [fieldId]: store(e.target.value) } })} />
            <button className="btn ghost" aria-label={`Remove ${f.name}`} onClick={() => { const { [fieldId]: _, ...rest } = step.values; onChange({ ...step, values: rest }); }}>✕</button>
          </div>
        );
      })}
      {unused.length > 0 && (
        <select className="select" style={{ width: 220 }} value="" aria-label="Set a field" onChange={(e) => e.target.value && onChange({ ...step, values: { ...step.values, [e.target.value]: "" } })}>
          <option value="">+ Set a field…</option>
          {unused.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      )}
    </div>
  );
}

/** Try the automation on one record: see what each step would do, then run it for real if you like. */
function TestPanel({ auto, saved, connections }: { auto: Automation; saved: boolean; connections: ConnectionInfo[] }) {
  const { snap } = useBase();
  const state = snap.state;
  const table = state.tables[auto.trigger.tableId];
  const noRecord = auto.trigger.type === "schedule" && !auto.trigger.viewId;
  const rowIds = (table?.rowOrder ?? []).filter((id) => state.rows[id]);
  const [rowId, setRowId] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const current = rowIds.includes(rowId) ? rowId : rowIds[0] ?? "";
  const row = noRecord ? null : state.rows[current] ?? null;
  const plan = useMemo(() => (noRecord || row ? planSteps(state, auto, row) : null), [state, auto, row, noRecord]);
  useEffect(() => setResult(null), [current, auto]);

  async function runNow() {
    if (!plan) return;
    const people = plan.emails.reduce((n, m) => n + m.to.length, 0);
    const what = [plan.actions.length && `change records`, people > 0 && `email ${people} ${people === 1 ? "person" : "people"}`,
      JSON.stringify(plan.preview).includes('"kind":"post"') && "send messages", JSON.stringify(plan.preview).includes('"kind":"script"') && "run scripts"].filter(Boolean).join(", ");
    if (!confirm(`This really runs the automation${row ? ` on “${snap.computer.primaryName(row.id)}”` : ""}${what ? `: it may ${what}` : ""}. Continue?`)) return;
    setRunning(true);
    try {
      const r = await fetch(`/api/bases/${state.base.id}/automations/${auto.id}/run`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rowId: row?.id ?? null }),
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
      {!noRecord && !row ? <span className="muted small">Add a record to {table?.name ?? "the table"} to test with.</span> : (
        <div className="stack" style={{ gap: 8 }}>
          {!noRecord && (
            <div className="row" style={{ flexWrap: "wrap" }}>
              <span>Try it on</span>
              <select className="select" style={{ width: 240 }} value={current} onChange={(e) => setRowId(e.target.value)} aria-label="Record to test with">
                {rowIds.map((id) => <option key={id} value={id}>{snap.computer.primaryName(id) || "(unnamed record)"}</option>)}
              </select>
            </div>
          )}
          {row && (auto.trigger.type === "recordMatches" || auto.trigger.type === "enteredView") && (
            <span className="muted small">{triggerMatches(state, auto, row) ? "This record matches now." : "This record doesn't match right now; on its own it wouldn't start the automation."}</span>
          )}
          {plan && plan.preview.length === 0 && <span className="muted small">Add a step to see what it would do.</span>}
          {plan && <PreviewList items={plan.preview} connections={connections} label="" />}
          {plan?.problems.map((m) => <span key={m} className="small" style={{ color: "var(--danger)" }}>{m}</span>)}
          <div className="row" style={{ flexWrap: "wrap" }}>
            <span className="muted small">Nothing changes until you run it. Scripts and messages only run for real.</span>
            <span className="spacer" />
            {!saved && <span className="muted small">Save the automation to run it for real.</span>}
            <button className="btn" disabled={!saved || running || !plan || plan.problems.length > 0 || plan.preview.length === 0} onClick={() => void runNow()}>
              {running ? "Running…" : row ? "▶ Run now on this record" : "▶ Run now"}
            </button>
          </div>
          {result && <span className="small" role="status" style={{ color: result.ok ? "var(--ok, #2e9d5b)" : "var(--danger)", whiteSpace: "pre-wrap" }}>{result.ok ? "✓ " : "✕ "}{result.message}</span>}
        </div>
      )}
    </fieldset>
  );
}

function PreviewList({ items, connections, label }: { items: StepPreview[]; connections: ConnectionInfo[]; label: string }) {
  return <>{items.map((p, i) => <PreviewStep key={i} label={`${label}${i + 1}`} p={p} connections={connections} />)}</>;
}

function PreviewStep({ label, p, connections }: { label: string; p: StepPreview; connections: ConnectionInfo[] }) {
  switch (p.kind) {
    case "email":
      return (
        <div className="auto-preview">
          <strong>{label}. Email</strong> to {p.to.length ? p.to.join(", ") : <em>nobody</em>}
          {p.invalid.length > 0 && <span className="small" style={{ color: "var(--danger)" }}> (skipped, not addresses: {p.invalid.join(", ")})</span>}
          <div className="muted small">Subject: {p.subject}</div>
          {p.text && <pre className="auto-preview-body">{p.text}</pre>}
        </div>
      );
    case "update":
    case "create":
      return (
        <div className="auto-preview">
          <strong>{label}. {p.kind === "update" ? `Update ${p.recordName ? `“${p.recordName}”` : "this record"}` : `Create a record in ${p.tableName}`}</strong>
          {p.cells.length === 0 ? <div className="muted small">No fields set.</div> : (
            <ul className="small" style={{ margin: "4px 0 0", paddingLeft: 18 }}>{p.cells.map((c) => <li key={c.field}>{c.field} → {c.value}</li>)}</ul>
          )}
        </div>
      );
    case "condition":
      return (
        <div className="auto-preview">
          <strong>{label}. If</strong> <span className="small">{p.matched === null ? "(no record to check)" : p.matched ? "matches → runs “Then”" : "doesn't match → runs “Otherwise”"}</span>
          <div className="branch"><PreviewList items={p.matched ? p.then : p.otherwise} connections={connections} label={`${label}.`} /></div>
        </div>
      );
    case "forEach":
      return (
        <div className="auto-preview">
          <strong>{label}. Repeat</strong> <span className="small">for {p.count} linked record{p.count === 1 ? "" : "s"} in {p.field}</span>
          {p.items.slice(0, 3).map((it, i) => (
            <div key={i} className="branch"><span className="muted small">{it.name}</span><PreviewList items={it.steps} connections={connections} label={`${label}.`} /></div>
          ))}
          {p.items.length > 3 && <div className="muted small">…and {p.items.length - 3} more</div>}
        </div>
      );
    case "script":
      return <div className="auto-preview"><strong>{label}. Run script</strong> <span className="muted small">({p.lines} lines; runs only for real)</span></div>;
    case "post": {
      const c = connections.find((x) => x.id === p.connectionId);
      return (
        <div className="auto-preview">
          <strong>{label}. {p.to === "slack" ? "Post to Slack" : p.to === "sheets" ? "Add a sheet row" : "Call webhook"}</strong>{" "}
          <span className="small">{c ? `via “${c.name}” (${c.host})` : <span style={{ color: "var(--danger)" }}>no connection chosen</span>}</span>
          <pre className="auto-preview-body">{p.payload}</pre>
        </div>
      );
    }
  }
}
