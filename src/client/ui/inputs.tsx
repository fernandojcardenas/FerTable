"use client";

import { RichTextEditor } from "./richText";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Attachment, CellValue, Field, SelectChoice } from "@/shared/types";
import { formatBytes, formatDuration, makeChoice } from "@/shared/fieldTypes";
import { newId } from "@/shared/ids";
import { AttachmentPreview, ChoiceChip, Dialog, useBase } from "./common";
import { RatingStars, UserChips, UserPicker } from "./newFields";

/** Pick (and create) options for a select field. Returns chosen ids through onChange. */
export function SelectPicker({ field, value, onChange, onClose }: {
  field: Field; value: string[]; onChange: (ids: string[], newChoice?: SelectChoice) => void; onClose?: () => void;
}) {
  const [q, setQ] = useState("");
  const multi = field.type === "multiSelect";
  const choices = field.options.choices ?? [];
  const shown = choices.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
  const exact = choices.some((c) => c.name.toLowerCase() === q.trim().toLowerCase());
  const toggle = (id: string) => {
    if (multi) onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
    else {
      onChange(value[0] === id ? [] : [id]);
      onClose?.();
    }
  };
  const create = () => {
    const ch = makeChoice(q.trim(), choices.length);
    onChange(multi ? [...value, ch.id] : [ch.id], ch);
    setQ("");
    if (!multi) onClose?.();
  };
  return (
    <div style={{ minWidth: 240 }}>
      <input
        className="input" autoFocus placeholder="Find or add an option" value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (shown[0] && (exact || !q.trim())) toggle(shown[0].id);
            else if (q.trim()) create();
          }
          if (e.key === "Escape") onClose?.();
        }}
      />
      <div className="picker-list">
        {shown.map((c) => (
          <button key={c.id} className={`picker-item ${value.includes(c.id) ? "on" : ""}`} onClick={() => toggle(c.id)}>
            <ChoiceChip name={c.name} color={c.color} />
            {value.includes(c.id) && <span className="spacer" />}
            {value.includes(c.id) && "✓"}
          </button>
        ))}
        {q.trim() && !exact && (
          <button className="picker-item" onClick={create}>+ Add option “{q.trim()}”</button>
        )}
        {!shown.length && !q.trim() && <span className="muted small">No options yet. Type to add one.</span>}
      </div>
    </div>
  );
}

/** Choose linked records in another table. */
export function LinkPicker({ field, value, onChange, onClose }: {
  field: Field; value: string[]; onChange: (ids: string[]) => void; onClose: () => void;
}) {
  const { snap, client } = useBase();
  const [q, setQ] = useState("");
  const table = snap.state.tables[field.options.linkedTableId ?? ""];
  const c = snap.computer;
  const rows = useMemo(() => {
    if (!table) return [];
    return table.rowOrder.filter((id) => snap.state.rows[id] && c.primaryName(id).toLowerCase().includes(q.toLowerCase()));
  }, [table, snap, q, c]);
  if (!table) return null;
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const createNew = () => {
    const rowId = newId("rec");
    const ok = client.dispatch({ type: "row.create", rowId, tableId: table.id, cells: q.trim() ? { [table.primaryFieldId]: q.trim() } : {} });
    if (ok) onChange([...value, rowId]);
    setQ("");
  };
  return (
    <Dialog title={`Link records from ${table.name}`} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <input className="input" autoFocus placeholder={`Search ${table.name}`} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="picker-list" style={{ maxHeight: 360 }}>
        {rows.map((id) => (
          <button key={id} className={`picker-item ${value.includes(id) ? "on" : ""}`} onClick={() => toggle(id)}>
            <span className={`check ${value.includes(id) ? "on" : ""}`}>{value.includes(id) ? "✓" : ""}</span>
            {c.primaryName(id)}
          </button>
        ))}
        {rows.length === 0 && <span className="muted small">No matching records.</span>}
        <button className="picker-item" onClick={createNew}>+ New record{q.trim() ? ` “${q.trim()}”` : ""} in {table.name}</button>
      </div>
    </Dialog>
  );
}

/**
 * An editor for one field value, used in the record dialog and in forms.
 * Text-like inputs call onCommit on blur/Enter; everything else commits immediately.
 */
export function FieldInput({ field, value, onCommit }: { field: Field; value: CellValue | undefined; onCommit: (v: CellValue, newChoice?: SelectChoice) => void }) {
  const { snap } = useBase();
  const [text, setText] = useState(() => toEditText(field, value));
  const [picker, setPicker] = useState(false);
  const lastValue = useRef(value);
  useEffect(() => {
    if (lastValue.current !== value) {
      lastValue.current = value;
      setText(toEditText(field, value));
    }
  }, [value, field]);

  switch (field.type) {
    case "checkbox":
      return (
        <button className={`check ${value ? "on" : ""}`} style={{ width: 22, height: 22 }} onClick={() => onCommit(!value)} aria-label={field.name}>
          {value ? "✓" : ""}
        </button>
      );
    case "singleSelect":
    case "multiSelect": {
      const ids = Array.isArray(value) ? (value as string[]) : typeof value === "string" ? [value] : [];
      return (
        <div>
          <div className="row" style={{ flexWrap: "wrap", gap: 4, minHeight: 28 }}>
            {ids.map((id) => {
              const ch = field.options.choices?.find((x) => x.id === id);
              return ch ? <ChoiceChip key={id} name={ch.name} color={ch.color} onRemove={() => {
                const next = ids.filter((x) => x !== id);
                onCommit(field.type === "multiSelect" ? next : null);
              }} /> : null;
            })}
            <button className="btn ghost small" onClick={() => setPicker((p) => !p)}>{picker ? "Close" : ids.length ? "Change" : "+ Choose"}</button>
          </div>
          {picker && (
            <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 8, marginTop: 6 }}>
              <SelectPicker
                field={field} value={ids}
                onChange={(next, ch) => onCommit(field.type === "multiSelect" ? next : next[0] ?? null, ch)}
                onClose={() => setPicker(false)}
              />
            </div>
          )}
        </div>
      );
    }
    case "attachment":
      return <AttachmentEditor value={(value as Attachment[] | null) ?? []} onChange={(next) => onCommit(next.length ? next : null)} />;
    case "rating":
      return <RatingStars field={field} value={typeof value === "number" ? value : null} onChange={(v) => onCommit(v)} />;
    case "user": {
      const ids = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div>
          <div className="row" style={{ flexWrap: "wrap", gap: 4, minHeight: 28 }}>
            <UserChips ids={ids} />
            <button className="btn ghost small" onClick={() => setPicker((p) => !p)}>{picker ? "Close" : ids.length ? "Change" : "+ Choose"}</button>
          </div>
          {picker && (
            <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 8, marginTop: 6 }}>
              <UserPicker field={field} value={ids} onChange={(next) => onCommit(next.length ? next : null)} onClose={() => setPicker(false)} />
            </div>
          )}
        </div>
      );
    }
    case "link": {
      const ids = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
          {ids.filter((id) => snap.state.rows[id]).map((id) => (
            <span key={id} className="chip link">
              {snap.computer.primaryName(id)}
              <button className="chip-x" onClick={() => onCommit(ids.filter((x) => x !== id))} aria-label="Unlink">✕</button>
            </span>
          ))}
          <button className="btn ghost small" onClick={() => setPicker(true)}>+ Link record</button>
          {picker && <LinkPicker field={field} value={ids} onChange={(next) => onCommit(next)} onClose={() => setPicker(false)} />}
        </div>
      );
    }
    case "date":
      return (
        <input
          className="input" type={field.options.includeTime ? "datetime-local" : "date"} value={text}
          onChange={(e) => {
            setText(e.target.value);
            onCommit(e.target.value ? (field.options.includeTime ? new Date(e.target.value).toISOString() : e.target.value) : null);
          }}
        />
      );
    case "longText":
      if (field.options.richText) {
        return (
          <div onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null) && text !== toEditText(field, value)) onCommit(text); }}>
            <RichTextEditor value={text} onChange={setText} />
          </div>
        );
      }
      return <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onCommit(text)} />;
    default:
      return (
        <input
          className="input" value={text}
          type={field.type === "number" ? "text" : field.type === "email" ? "email" : "text"}
          inputMode={field.type === "number" ? "decimal" : undefined}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => onCommit(text)}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      );
  }
}

export function toEditText(field: Field, value: CellValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (field.type === "date" && typeof value === "string") {
    if (!field.options.includeTime) return value.slice(0, 10);
    const d = new Date(value);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (field.type === "duration" && typeof value === "number") return formatDuration(value, field.options.durationFormat);
  return String(value);
}

// ---- attachments ----

const MAX_UPLOAD = 25 * 1024 * 1024;

/** Upload files to the base. Returns the stored attachments (files that failed are reported, not thrown). */
export async function uploadFiles(baseId: string, files: File[]): Promise<{ ok: Attachment[]; failed: string[] }> {
  const ok: Attachment[] = [];
  const failed: string[] = [];
  for (const file of files) {
    if (file.size > MAX_UPLOAD) { failed.push(`${file.name} is larger than 25 MB`); continue; }
    try {
      const res = await fetch(`/api/bases/${baseId}/files?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Upload failed (${res.status})`);
      ok.push(await res.json());
    } catch (e) {
      failed.push(`${file.name}: ${e instanceof Error ? e.message : "upload failed"}`);
    }
  }
  return { ok, failed };
}

/** List, open, remove and upload attachments. Uploading happens right away; onChange gets the full new list. */
export function AttachmentEditor({ value, onChange }: { value: Attachment[]; onChange: (next: Attachment[]) => void }) {
  const { snap } = useBase();
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const latest = useRef(value);
  latest.current = value;

  const add = async (files: File[]) => {
    if (!files.length) return;
    setBusy(files.length);
    setError(null);
    const { ok, failed } = await uploadFiles(snap.state.base.id, files);
    setBusy(0);
    if (ok.length) onChange([...latest.current, ...ok]);
    if (failed.length) setError(failed.join("; "));
  };

  return (
    <div
      className={`att-editor ${over ? "drop" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); void add([...e.dataTransfer.files]); }}
    >
      {value.length > 0 && (
        <div className="att-list">
          {value.map((a) => (
            <div key={a.id} className="att-item">
              <a href={a.url} target="_blank" rel="noreferrer"><AttachmentPreview a={a} size={44} /></a>
              <div style={{ minWidth: 0, flex: 1 }}>
                <a href={a.url} target="_blank" rel="noreferrer" className="att-name">{a.name}</a>
                <div className="muted small">{formatBytes(a.size)}</div>
              </div>
              <button className="btn ghost small" aria-label={`Remove ${a.name}`} onClick={() => onChange(value.filter((x) => x.id !== a.id))}>✕</button>
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button className="btn small" disabled={busy > 0} onClick={() => inputRef.current?.click()}>
          {busy ? `Uploading ${busy} file${busy === 1 ? "" : "s"}…` : "📎 Upload files"}
        </button>
        <span className="muted small">or drop files here</span>
      </div>
      <input ref={inputRef} type="file" multiple hidden aria-label="Choose files to upload"
        onChange={(e) => { void add([...(e.target.files ?? [])]); e.target.value = ""; }} />
      {error && <p className="small" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
    </div>
  );
}
