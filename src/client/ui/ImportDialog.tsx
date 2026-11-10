"use client";

import { useMemo, useRef, useState } from "react";
import type { Action, CellValue, Field, FieldOptions, FieldType, SelectChoice } from "@/shared/types";
import { FIELD_TYPES, isComputed } from "@/shared/fieldTypes";
import { choiceColor, choiceNames, IMPORT_TYPES, importValue, inferColumn, parseCsv, type ImportType } from "@/shared/csv";
import { newId } from "@/shared/ids";
import { Dialog, useBase } from "./common";

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_ROWS = 100_000;
const CHUNK = 1000;

type Column = { name: string; type: ImportType | "skip"; options: FieldOptions; target: string | "skip" };

/**
 * Import a CSV file, either as a new table (types guessed per column, editable)
 * or into an existing table (columns matched to fields by name).
 */
export function ImportDialog({ tableId, onClose, onCreated }: { tableId?: string; onClose: () => void; onCreated?: (tableId: string) => void }) {
  const { snap, client } = useBase();
  const state = snap.state;
  const target = tableId ? state.tables[tableId] : undefined;
  const targetFields = useMemo(
    () => (target ? target.fieldOrder.map((id) => state.fields[id]).filter((f): f is Field => Boolean(f) && !isComputed(f.type) && f.type !== "attachment") : []),
    [target, state.fields],
  );

  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<string[][] | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [columns, setColumns] = useState<Column[]>([]);
  const [tableName, setTableName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const dataRows = useMemo(() => (rows ? (hasHeader ? rows.slice(1) : rows) : []), [rows, hasHeader]);

  function setup(all: string[][], header: boolean) {
    const width = Math.max(...all.map((r) => r.length));
    const head = header ? all[0] : [];
    const body = header ? all.slice(1) : all;
    const used = new Set<string>();
    setColumns(Array.from({ length: width }, (_, i) => {
      let name = (head[i] ?? "").trim() || `Column ${i + 1}`;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${(head[i] ?? "").trim() || `Column ${i + 1}`} ${n}`;
      used.add(name.toLowerCase());
      const guess = inferColumn(body.map((r) => r[i] ?? ""));
      const match = targetFields.find((f) => f.name.toLowerCase() === name.toLowerCase());
      return { name, type: guess.type, options: guess.options, target: match?.id ?? "skip" };
    }));
  }

  async function load(file: File) {
    setError(null);
    if (file.size > MAX_BYTES) return setError("That file is larger than 50 MB.");
    const text = await file.text();
    const parsed = parseCsv(text);
    if (parsed.length === 0) return setError("That file has no rows.");
    if (parsed.length > MAX_ROWS + 1) return setError(`That file has more than ${MAX_ROWS.toLocaleString()} rows.`);
    setFileName(file.name);
    setTableName(file.name.replace(/\.(csv|tsv|txt)$/i, "").slice(0, 100) || "Imported");
    setRows(parsed);
    setup(parsed, hasHeader);
  }

  const setCol = (i: number, patch: Partial<Column>) => setColumns((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  /** Build all actions: fields first, then rows in chunks. */
  function buildNewTable(): { first: Action[]; rows: Action[]; newTableId: string } {
    const used = columns.map((c, i) => ({ ...c, i })).filter((c) => c.type !== "skip");
    const newTableId = newId("tbl");
    const primaryId = newId("fld");
    const first: Action[] = [{ type: "table.create", tableId: newTableId, name: uniqueTableName(tableName.trim() || "Imported"), primaryFieldId: primaryId, viewId: newId("viw") }];
    const fieldFor = new Map<number, { id: string; type: FieldType; options: FieldOptions }>();
    used.forEach((c, k) => {
      const type = c.type as ImportType;
      const options: FieldOptions = { ...c.options };
      if (type === "singleSelect" || type === "multiSelect") {
        options.choices = choiceNames(dataRows.map((r) => r[c.i] ?? ""), type === "multiSelect").map((name, n): SelectChoice => ({ id: newId("opt"), name, color: choiceColor(n) }));
      }
      if (k === 0) {
        // The first column becomes the table's primary field.
        first.push({ type: "field.update", fieldId: primaryId, name: c.name, ...(type !== "text" ? { fieldType: type } : {}), options });
        fieldFor.set(c.i, { id: primaryId, type, options });
      } else {
        const id = newId("fld");
        first.push({ type: "field.create", fieldId: id, tableId: newTableId, name: c.name, fieldType: type, options });
        fieldFor.set(c.i, { id, type, options });
      }
    });
    const rowActions: Action[] = dataRows.map((r) => {
      const cells: Record<string, CellValue> = {};
      for (const [i, f] of fieldFor) {
        const v = importValue(r[i] ?? "", f.type, f.options);
        if (v !== null) cells[f.id] = v;
      }
      return { type: "row.create", rowId: newId("rec"), tableId: newTableId, cells };
    });
    return { first, rows: rowActions, newTableId };
  }

  function buildExisting(): { first: Action[]; rows: Action[] } {
    const first: Action[] = [];
    const mapped = columns.map((c, i) => ({ c, i, f: targetFields.find((f) => f.id === c.target) })).filter((m) => m.f);
    // Add any select options the file uses that the field doesn't have yet.
    const options = new Map<string, FieldOptions>();
    for (const { i, f } of mapped) {
      const field = f!;
      if (field.type !== "singleSelect" && field.type !== "multiSelect") { options.set(field.id, field.options); continue; }
      const choices = [...(field.options.choices ?? [])];
      for (const name of choiceNames(dataRows.map((r) => r[i] ?? ""), field.type === "multiSelect")) {
        if (!choices.some((ch) => ch.name.toLowerCase() === name.toLowerCase())) choices.push({ id: newId("opt"), name, color: choiceColor(choices.length) });
      }
      if (choices.length !== (field.options.choices ?? []).length) first.push({ type: "field.update", fieldId: field.id, options: { choices } });
      options.set(field.id, { ...field.options, choices });
    }
    const c = snap.computer;
    const lookups = new Map<string, Map<string, string>>();
    for (const { f } of mapped) {
      if (f!.type !== "link") continue;
      const linked = state.tables[f!.options.linkedTableId ?? ""];
      const byName = new Map<string, string>();
      for (const id of linked?.rowOrder ?? []) byName.set(c.primaryName(id).toLowerCase(), id);
      lookups.set(f!.id, byName);
    }
    const rowActions: Action[] = dataRows.map((r) => {
      const cells: Record<string, CellValue> = {};
      for (const { i, f } of mapped) {
        const field = f!;
        const v = importValue(r[i] ?? "", field.type, options.get(field.id) ?? field.options, (name) => lookups.get(field.id)?.get(name.toLowerCase()));
        if (v !== null) cells[field.id] = v;
      }
      return { type: "row.create", rowId: newId("rec"), tableId: target!.id, cells };
    });
    return { first, rows: rowActions };
  }

  function uniqueTableName(name: string) {
    const taken = new Set(Object.values(state.tables).map((t) => t.name.toLowerCase()));
    let out = name;
    for (let n = 2; taken.has(out.toLowerCase()); n++) out = `${name} ${n}`;
    return out;
  }

  async function run() {
    if (!client.ensureCanEdit()) return;
    const plan = target ? { ...buildExisting(), newTableId: undefined } : buildNewTable();
    if (target && !columns.some((c) => c.target !== "skip")) return setError("Choose at least one field to import into.");
    // One undo step for the whole import, however many requests it takes.
    const key = `import:${newId("req")}`;
    const send = (actions: Action[]) => client.dispatchWith({ coalesce: { key } }, ...actions);
    const chunks: Action[][] = [];
    for (let i = 0; i < plan.rows.length; i += CHUNK) chunks.push(plan.rows.slice(i, i + CHUNK));
    if (!send([...plan.first, ...(chunks.shift() ?? [])])) return;
    let done = Math.min(CHUNK, plan.rows.length);
    for (const chunk of chunks) {
      setProgress(`Importing… ${done.toLocaleString()} of ${plan.rows.length.toLocaleString()} rows`);
      await new Promise((r) => setTimeout(r, 0)); // let the screen update between chunks
      if (!send(chunk)) return;
      done += chunk.length;
    }
    if (plan.newTableId) onCreated?.(plan.newTableId);
    onClose();
  }

  const used = target ? columns.filter((c) => c.target !== "skip").length : columns.filter((c) => c.type !== "skip").length;
  return (
    <Dialog wide title={target ? `Import CSV into ${target.name}` : "Import CSV as a new table"} onClose={onClose}
      footer={<>
        {progress && <span className="muted small">{progress}</span>}
        <span className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!rows || used === 0 || Boolean(progress)} onClick={() => void run()}>
          Import {dataRows.length.toLocaleString()} row{dataRows.length === 1 ? "" : "s"}
        </button>
      </>}>
      {!rows ? (
        <div className={`att-editor ${over ? "drop" : ""}`} style={{ padding: 24, alignItems: "center", textAlign: "center", border: "1px dashed var(--line-strong)" }}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) void load(f); }}>
          <p style={{ margin: 0 }}>Drop a CSV file here, or</p>
          <button className="btn primary" onClick={() => inputRef.current?.click()}>Choose a file</button>
          <span className="muted small">Comma, semicolon or tab separated · up to 50 MB</span>
          <input ref={inputRef} type="file" hidden accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" aria-label="Choose a CSV file"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f); e.target.value = ""; }} />
          {error && <p role="alert" className="small" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
        </div>
      ) : (
        <div className="stack">
          <div className="row" style={{ flexWrap: "wrap" }}>
            <strong>{fileName}</strong>
            <span className="muted small">{dataRows.length.toLocaleString()} rows · {columns.length} columns</span>
            <span className="spacer" />
            <label className="row small"><input type="checkbox" checked={hasHeader} onChange={(e) => { setHasHeader(e.target.checked); setup(rows, e.target.checked); }} /> First row has column names</label>
          </div>
          {!target && (
            <div>
              <label className="field-label" htmlFor="import-name">Table name</label>
              <input id="import-name" className="input" value={tableName} onChange={(e) => setTableName(e.target.value)} />
            </div>
          )}
          <div style={{ overflowX: "auto" }}>
            <table className="import-table">
              <thead>
                <tr>
                  {columns.map((c, i) => (
                    <th key={i}>
                      {target ? (
                        <>
                          <div className="muted small">{c.name}</div>
                          <select className="select" value={c.target} aria-label={`Field for ${c.name}`} onChange={(e) => setCol(i, { target: e.target.value })}>
                            <option value="skip">Skip</option>
                            {targetFields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                          </select>
                        </>
                      ) : (
                        <>
                          <input className="input" value={c.name} aria-label={`Name for column ${i + 1}`} onChange={(e) => setCol(i, { name: e.target.value })} />
                          <select className="select" value={c.type} aria-label={`Type for ${c.name}`}
                            onChange={(e) => setCol(i, { type: e.target.value as Column["type"], options: e.target.value === c.type ? c.options : inferOptions(e.target.value as ImportType) })}>
                            {IMPORT_TYPES.map((t) => <option key={t} value={t}>{FIELD_TYPES[t].icon} {FIELD_TYPES[t].label}</option>)}
                            <option value="skip">Skip this column</option>
                          </select>
                        </>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dataRows.slice(0, 6).map((r, ri) => (
                  <tr key={ri}>{columns.map((c, i) => <td key={i} className={(target ? c.target : c.type) === "skip" ? "muted" : ""}>{r[i] ?? ""}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          {dataRows.length > 6 && <span className="muted small">Showing the first 6 rows.</span>}
          {!target && <span className="muted small">The first column you keep becomes the table's primary field. You can change types later too.</span>}
          {error && <p role="alert" className="small" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
        </div>
      )}
    </Dialog>
  );
}

function inferOptions(type: ImportType): FieldOptions {
  if (type === "number") return { format: "decimal", precision: 2 };
  if (type === "date") return { includeTime: false };
  return {};
}
