"use client";

// An interface page published with a public link: the numbers, charts, lists, maps and
// text the page shows, worked out on the server. Read-only; no account needed.

import { use, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import type { SharedElement, SharedPage } from "@/shared/publicPage";
import { Chart, ChartTable } from "@/client/ui/charts";

const MapElement = dynamic(() => import("@/client/ui/MapElement").then((m) => m.MapElement), { ssr: false });
const ROW_H = 40, GAP = 12;

function Element({ el }: { el: SharedElement }) {
  const [asTable, setAsTable] = useState(false);
  switch (el.kind) {
    case "number":
      return <div className="el-body number-tile"><span className="muted small">{el.title}</span><span className="big">{el.text}</span><span className="muted small">{el.caption}</span></div>;
    case "chart": {
      const data = el.points.map((p) => ({ key: p.key, label: p.label, value: p.value, rowIds: [] }));
      const text = new Map(el.points.map((p) => [p.value, p.text]));
      const fmt = (n: number) => text.get(n) ?? n.toLocaleString();
      return (
        <div className="el-body">
          <div className="el-title-row"><strong className="small">{el.title || "Chart"}</strong><span className="muted small">{el.valueLabel}</span><span className="spacer" />
            <button className="btn ghost small" onClick={() => setAsTable(!asTable)}>{asTable ? "Chart" : "Table"}</button></div>
          <div className="el-fill">{asTable ? <ChartTable data={data} format={fmt} valueLabel={el.valueLabel} /> : <Chart type={el.chartType} data={data} format={fmt} />}</div>
        </div>
      );
    }
    case "list":
      return (
        <div className="el-body">
          <div className="el-title-row"><strong className="small">{el.title || "Records"}</strong></div>
          <div className="el-fill chart-table">
            <table><thead><tr>{el.fields.map((f, i) => <th key={i}>{f}</th>)}</tr></thead>
              <tbody>{el.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v}</td>)}</tr>)}</tbody></table>
          </div>
        </div>
      );
    case "map":
      return (
        <div className="el-body">
          <div className="el-title-row"><strong className="small">{el.title || "Map"}</strong></div>
          <div className="el-fill"><MapElement points={el.points.map((p, i) => ({ ...p, rowId: String(i) }))} onOpen={() => {}} /></div>
        </div>
      );
    case "text":
      return <div className="el-body text-el">{el.text.split("\n").map((line, i) => line.startsWith("# ") ? <h2 key={i}>{line.slice(2)}</h2> : line.startsWith("## ") ? <h3 key={i}>{line.slice(3)}</h3> : <p key={i}>{line || " "}</p>)}</div>;
    case "button":
      return <div className="el-body button-el">{el.title && <span className="muted small">{el.title}</span>}<a className="btn primary" href={el.url} target="_blank" rel="noreferrer noopener">{el.label}</a></div>;
  }
}

export default function SharedInterfacePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [data, setData] = useState<SharedPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState(0);
  const [q, setQ] = useState("");

  useEffect(() => {
    fetch(`/api/shared/pages/${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "This page isn't available.");
        setData(d);
        document.title = `${d.name} · ${d.baseName}`;
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [token]);

  if (error) return <main className="home"><h1>gridbase</h1><p>{error}</p></main>;
  if (!data) return <main className="home"><p className="muted">Loading…</p></main>;
  const records = (data.records ?? []).map((r, i) => ({ ...r, i })).filter((r) => r.name.toLowerCase().includes(q.trim().toLowerCase()));
  const rec = data.records?.[picked];
  return (
    <div className="shared-page">
      <header className="shared-head">
        <div><div className="muted small">{data.baseName}</div><h1 style={{ margin: 0, fontSize: 20 }}>{data.name}</h1></div>
      </header>
      {data.kind === "record" ? (
        <div className="record-page" style={{ flex: 1, minHeight: 0 }}>
          <div className="record-page-list">
            <input className="input" placeholder="Find a record" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a record" />
            <div className="record-page-items">
              {records.map((r) => <button key={r.i} className={`view-item ${r.i === picked ? "active" : ""}`} onClick={() => setPicked(r.i)}>{r.name}</button>)}
            </div>
          </div>
          <div className="record-page-detail">
            {rec ? (
              <>
                <h2 style={{ margin: 0 }}>{rec.name}</h2>
                {rec.fields.map((f, i) => <div key={i} className="record-field"><div className="name">{f.name}</div><div style={{ padding: "6px 0", whiteSpace: "pre-wrap" }}>{f.text}</div></div>)}
              </>
            ) : <p className="muted">No records.</p>}
          </div>
        </div>
      ) : (
        <div className="page-scroll" style={{ flex: 1 }}>
          <div className="page-canvas" style={{ gridAutoRows: ROW_H, gap: GAP }}>
            {data.elements.map((el) => (
              <div key={el.id} className={`page-el kind-${el.kind}`}
                style={{ gridColumn: `${el.x + 1} / span ${el.w}`, gridRow: `${el.y + 1} / span ${el.h}`, ["--h" as string]: `${el.h * ROW_H + (el.h - 1) * GAP}px` }}>
                <Element el={el} />
              </div>
            ))}
          </div>
        </div>
      )}
      <footer className="shared-foot muted small">Read-only page published from gridbase</footer>
    </div>
  );
}
