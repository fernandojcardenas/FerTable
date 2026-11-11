"use client";

// A view someone shared with a public link: read-only records, with search and a CSV download.

import { use, useEffect, useMemo, useState } from "react";
import type { SharedView } from "@/shared/publicView";

const csvCell = (s: string) => {
  // Text a spreadsheet would run as a formula is written as plain text.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export default function SharedViewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [data, setData] = useState<SharedView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    fetch(`/api/shared/views/${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "This view isn't available.");
        setData(d);
        document.title = `${d.name} · ${d.baseName}`;
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [token]);

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return data.rows;
    return data.rows.filter((r) => Object.values(r.cells).some((c) => c.text.toLowerCase().includes(needle)));
  }, [data, q]);

  function download() {
    if (!data) return;
    const lines = [data.fields.map((f) => csvCell(f.name)).join(","), ...rows.map((r) => data.fields.map((f) => csvCell(r.cells[f.id]?.text ?? "")).join(","))];
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${data.name}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (error) return <main className="home"><h1>gridbase</h1><p>{error}</p></main>;
  if (!data) return <main className="home"><p className="muted">Loading…</p></main>;
  const fileUrl = (id: string) => `/api/shared/views/${encodeURIComponent(token)}/files/${id}`;
  return (
    <div className="shared-page">
      <header className="shared-head">
        <div>
          <div className="muted small">{data.baseName}</div>
          <h1 style={{ margin: 0, fontSize: 20 }}>{data.name}</h1>
        </div>
        <span className="spacer" />
        <input className="input" style={{ width: 220 }} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search records" />
        <button className="btn" onClick={download}>⤓ CSV</button>
      </header>
      <div className="shared-scroll">
        <table className="shared-table">
          <thead><tr><th className="rownum">#</th>{data.fields.map((f) => <th key={f.id}>{f.name}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id}>
                <td className="rownum" style={r.color ? { boxShadow: `inset 5px 0 0 var(--s-${r.color})` } : undefined}>{i + 1}</td>
                {data.fields.map((f) => {
                  const cell = r.cells[f.id];
                  if (!cell) return <td key={f.id} />;
                  if (cell.chips) return <td key={f.id}>{cell.chips.map((ch, j) => <span key={j} className={`chip c-${ch.color}`}>{ch.name}</span>)}</td>;
                  if (cell.files) return (
                    <td key={f.id}>{cell.files.map((file) => file.image
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <a key={file.id} href={fileUrl(file.id)} target="_blank" rel="noreferrer"><img src={fileUrl(file.id)} alt={file.name} className="att-thumb" style={{ height: 24 }} loading="lazy" /></a>
                      : <a key={file.id} href={fileUrl(file.id)} className="chip">{file.name}</a>)}</td>
                  );
                  return <td key={f.id} className={["number", "count", "autoNumber", "rollup", "duration"].includes(f.type) ? "num" : ""}>{cell.text}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="muted" style={{ padding: 16 }}>No records{q ? " match your search" : ""}.</p>}
      </div>
      <footer className="shared-foot muted small">
        {rows.length.toLocaleString()} record{rows.length === 1 ? "" : "s"}{data.truncated ? " (showing the first 5,000)" : ""} · Read-only view shared from gridbase
      </footer>
    </div>
  );
}
