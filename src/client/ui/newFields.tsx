"use client";

// Widgets for rating, user, button and AI fields.

import { useState } from "react";
import type { Field, FieldOptions, Row } from "@/shared/types";
import { fillTemplate } from "@/shared/automation";
import { idsToNames, namesToIds } from "@/shared/formula";
import { useBase } from "./common";

/** Stars; clickable when `onChange` is given (click the current score again to clear it). */
export function RatingStars({ field, value, onChange }: { field: Field; value: number | null; onChange?: (v: number | null) => void }) {
  const max = Math.min(Math.max(field.options.max ?? 5, 1), 10);
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;
  return (
    <span className="rating" role={onChange ? "radiogroup" : "img"} aria-label={`${field.name}: ${value ?? 0} of ${max}`}
      onMouseLeave={() => setHover(null)}>
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => onChange ? (
        <button key={n} type="button" className={`star ${n <= shown ? "on" : ""}`} role="radio" aria-checked={value === n} aria-label={`${n} of ${max}`}
          onMouseEnter={() => setHover(n)} onClick={(e) => { e.stopPropagation(); onChange(value === n ? null : n); }}>★</button>
      ) : (
        <span key={n} className={`star ${n <= shown ? "on" : ""}`} aria-hidden="true">★</span>
      ))}
    </span>
  );
}

/** Names of the people in a user cell, as chips. */
export function UserChips({ ids }: { ids: string[] }) {
  const { snap } = useBase();
  return <>{ids.map((id) => <span key={id} className="chip user" title={snap.state.people?.[id]?.email ?? ""}>👤 {snap.computer.personName(id)}</span>)}</>;
}

/** Pick base members for a user field. */
export function UserPicker({ field, value, onChange, onClose }: { field: Field; value: string[]; onChange: (ids: string[]) => void; onClose?: () => void }) {
  const { snap } = useBase();
  const [q, setQ] = useState("");
  const people = Object.entries(snap.state.people ?? {})
    .filter(([, p]) => `${p.name} ${p.email}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a[1].name.localeCompare(b[1].name));
  const toggle = (id: string) => {
    if (field.options.multiple) onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
    else { onChange(value.includes(id) ? [] : [id]); onClose?.(); }
  };
  return (
    <div className="stack" style={{ gap: 6, minWidth: 220 }}>
      <input className="input" autoFocus placeholder="Find a person" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a person" />
      <div className="picker-list" style={{ maxHeight: 240 }}>
        {people.map(([id, p]) => (
          <button key={id} type="button" className={`picker-item ${value.includes(id) ? "on" : ""}`} onClick={() => toggle(id)}>
            <span className={`check ${value.includes(id) ? "on" : ""}`}>{value.includes(id) ? "✓" : ""}</span>
            {p.name} <span className="muted small">{p.email}</span>
          </button>
        ))}
        {people.length === 0 && <span className="muted small">Only people in this base can be picked. Share the base to add someone.</span>}
      </div>
      {onClose && <button className="btn small" style={{ alignSelf: "flex-end" }} onClick={onClose}>Done</button>}
    </div>
  );
}

/** Where a URL button goes for this record, or null when the result isn't a safe link. */
export function buttonUrl(snapState: Parameters<typeof fillTemplate>[0], row: Row, field: Field): string | null {
  const raw = fillTemplate(snapState, row, (field.options.button?.url ?? "").trim(), new Date(), true);
  return /^(https?:\/\/|mailto:|tel:)/i.test(raw) ? raw : null;
}

/** A button cell: opens its link or runs its automation for this record. */
export function ButtonCell({ row, field }: { row: Row; field: Field }) {
  const { snap } = useBase();
  const [state, setState] = useState<string | null>(null);
  const b = field.options.button;
  if (!b) return null;
  const canEdit = snap.role === "owner" || snap.role === "editor";

  async function click(e: React.MouseEvent) {
    e.stopPropagation();
    if (b!.kind === "url") {
      const url = buttonUrl(snap.state, row, field);
      if (!url) return setState("No valid link for this record");
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    if (!b!.automationId || !snap.state.automations[b!.automationId]) return setState("The button's automation is missing");
    setState("Running…");
    try {
      const r = await fetch(`/api/bases/${snap.state.base.id}/automations/${b!.automationId}/run`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rowId: row.id }),
      });
      const d = await r.json().catch(() => ({}));
      setState(r.ok ? (d.status === "success" ? "Done" : d.message) : d.error ?? "Failed");
    } catch {
      setState("Failed");
    }
    setTimeout(() => setState(null), 2500);
  }

  const disabled = b.kind === "automation" && !canEdit;
  return (
    <span className="row" style={{ gap: 6 }}>
      <button type="button" className="btn small cell-button" disabled={disabled} onClick={(e) => void click(e)}
        title={disabled ? "Only editors can run automations" : b.kind === "url" ? "Open link" : "Run automation"}>{b.label}</button>
      {state && <span className="muted small">{state}</span>}
    </span>
  );
}

/** "Regenerate" for an AI cell (or the whole field when rowIds is omitted). */
export function RegenerateButton({ field, rowIds, label = "✦ Regenerate" }: { field: Field; rowIds?: string[]; label?: string }) {
  const { snap } = useBase();
  const [msg, setMsg] = useState<string | null>(null);
  if (!(snap.role === "owner" || snap.role === "editor")) return null;
  async function go() {
    setMsg("Asking the AI…");
    const r = await fetch(`/api/bases/${snap.state.base.id}/ai/${field.id}/generate`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rowIds }),
    }).catch(() => null);
    const d = await r?.json().catch(() => ({}));
    setMsg(r?.ok ? (rowIds ? "Working on it…" : `Filling ${d.queued} record${d.queued === 1 ? "" : "s"}…`) : d?.error ?? "Failed");
    setTimeout(() => setMsg(null), 4000);
  }
  return (
    <span className="row" style={{ gap: 6 }}>
      <button type="button" className="btn ghost small" onClick={() => void go()}>{label}</button>
      {msg && <span className="muted small" role="status">{msg}</span>}
    </span>
  );
}

/** Field dialog settings for the new field types. */
export function NewFieldOptions({ type, opts, setOpts, tableFields, existing }: {
  type: Field["type"]; opts: FieldOptions; setOpts: (o: FieldOptions) => void; tableFields: Field[]; existing?: Field;
}) {
  const { snap } = useBase();
  const others = tableFields.filter((f) => f.id !== existing?.id);
  const show = (t: string) => idsToNames(t, others);
  const store = (t: string) => { try { return namesToIds(t, others); } catch { return t; } };
  const firstRow = tableFields[0] ? Object.values(snap.state.rows).find((r) => r.tableId === tableFields[0].tableId) : undefined;

  if (type === "rating") {
    return (
      <div style={{ width: 160 }}>
        <label className="field-label">Highest score</label>
        <select className="select" value={opts.max ?? 5} onChange={(e) => setOpts({ ...opts, max: Number(e.target.value) })} aria-label="Highest score">
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n} {n === 1 ? "star" : "stars"}</option>)}
        </select>
      </div>
    );
  }
  if (type === "duration") {
    return (
      <div style={{ width: 200 }}>
        <label className="field-label">Show as</label>
        <select className="select" value={opts.durationFormat ?? "h:mm"} onChange={(e) => setOpts({ ...opts, durationFormat: e.target.value as "h:mm" | "h:mm:ss" })} aria-label="Duration format">
          <option value="h:mm">h:mm (1:30)</option>
          <option value="h:mm:ss">h:mm:ss (1:30:00)</option>
        </select>
      </div>
    );
  }
  if (type === "user") {
    return <label className="row"><input type="checkbox" checked={Boolean(opts.multiple)} onChange={(e) => setOpts({ ...opts, multiple: e.target.checked })} /> Allow several people</label>;
  }
  if (type === "button") {
    const b = opts.button ?? { label: "Open", kind: "url" as const, url: "" };
    const set = (patch: Partial<typeof b>) => setOpts({ ...opts, button: { ...b, ...patch } });
    const autos = Object.values(snap.state.automations);
    return (
      <div className="stack" style={{ gap: 8 }}>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <div style={{ width: 180 }}>
            <label className="field-label">Button label</label>
            <input className="input" value={b.label} maxLength={60} onChange={(e) => set({ label: e.target.value })} aria-label="Button label" />
          </div>
          <div style={{ width: 200 }}>
            <label className="field-label">When clicked</label>
            <select className="select" value={b.kind} onChange={(e) => set({ kind: e.target.value as "url" | "automation" })} aria-label="Button action">
              <option value="url">Open a link</option>
              <option value="automation">Run an automation</option>
            </select>
          </div>
        </div>
        {b.kind === "url" ? (
          <div>
            <label className="field-label">Link</label>
            <input className="input" value={show(b.url ?? "")} placeholder="https://maps.google.com/?q={Address}" onChange={(e) => set({ url: store(e.target.value) })} aria-label="Button link" />
            <p className="small muted" style={{ margin: "4px 0 0" }}>Use {"{Field name}"} to put the record's values in the link.</p>
          </div>
        ) : (
          <div>
            <label className="field-label">Automation</label>
            <select className="select" value={b.automationId ?? ""} onChange={(e) => set({ automationId: e.target.value || undefined })} aria-label="Automation to run">
              <option value="">Choose…</option>
              {autos.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <p className="small muted" style={{ margin: "4px 0 0" }}>Runs the automation's steps on the clicked record (editors only).</p>
          </div>
        )}
      </div>
    );
  }
  if (type === "ai") {
    const prompt = opts.prompt ?? "";
    const preview = firstRow && prompt ? fillTemplate(snap.state, firstRow, prompt) : "";
    return (
      <div>
        <label className="field-label" htmlFor="ai-prompt">Prompt</label>
        <textarea id="ai-prompt" className="textarea" rows={4} value={show(prompt)} placeholder={"Write a one-line summary of {Notes}"}
          onChange={(e) => setOpts({ ...opts, prompt: store(e.target.value) })} />
        <p className="small muted" style={{ margin: "4px 0" }}>
          Use {"{Field name}"} for the record's values. The answer updates when those fields change. AI answers need
          {" "}<code>ANTHROPIC_API_KEY</code> and <code>FERTABLE_AI_MODEL</code> on the server.
        </p>
        {preview && <p className="small muted" style={{ margin: 0 }}>First record's prompt: <b style={{ color: "var(--text)" }}>{preview.slice(0, 300)}</b></p>}
        {existing?.type === "ai" && <div style={{ marginTop: 6 }}><RegenerateButton field={existing} label="✦ Refill every record" /></div>}
      </div>
    );
  }
  return null;
}
