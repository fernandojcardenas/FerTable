"use client";

// Small SVG charts for interface pages: bar, line and pie (donut). One series per chart,
// value labels where they fit, a hover tooltip on every mark, and a table view.

import { useEffect, useRef, useState } from "react";
import type { ChartPoint } from "@/shared/interfaces";

const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)", "var(--s7)", "var(--s8)"];

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, ...size };
}

/** Round axis ticks (0 and 3–5 steps up to just past the max). */
function ticks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}
const short = (n: number) => Math.abs(n) >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `${+(n / 1e3).toFixed(1)}k` : `${+n.toFixed(2)}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

type Tip = { x: number; y: number; label: string; value: string } | null;

function Tooltip({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return (
    <div className="chart-tip" style={{ left: tip.x, top: tip.y }} role="status">
      <div className="muted small">{tip.label}</div>
      <strong>{tip.value}</strong>
    </div>
  );
}

export function Chart({ type, data, format, onPick }: { type: "bar" | "line" | "pie"; data: ChartPoint[]; format: (n: number) => string; onPick?: (p: ChartPoint) => void }) {
  if (data.length === 0) return <div className="muted small chart-empty">No records to chart.</div>;
  if (type === "pie") return <Pie data={data} format={format} onPick={onPick} />;
  return <XY type={type} data={data} format={format} onPick={onPick} />;
}

function XY({ type, data, format, onPick }: { type: "bar" | "line"; data: ChartPoint[]; format: (n: number) => string; onPick?: (p: ChartPoint) => void }) {
  const { ref, w, h } = useSize<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...data.map((d) => d.value));
  const min = Math.min(0, ...data.map((d) => d.value));
  const tk = ticks(max - min);
  const top = tk[tk.length - 1] + min;
  const padL = 40, padR = 8, padT = 18, padB = 34;
  const iw = Math.max(0, w - padL - padR), ih = Math.max(0, h - padT - padB);
  const y = (v: number) => padT + ih - ((v - min) / (top - min || 1)) * ih;
  const band = iw / data.length;
  const x = (i: number) => padL + band * i + band / 2;
  const barW = Math.max(2, Math.min(48, band - 2));
  const labelEvery = Math.ceil(data.length / Math.max(1, Math.floor(iw / 64)));
  const showValues = type === "bar" ? band >= 28 : data.length <= 12;

  const show = (i: number, cx: number, cy: number) => { setHover(i); setTip({ x: cx, y: cy, label: data[i].label, value: format(data[i].value) }); };
  return (
    <div ref={ref} className="chart-box" onMouseLeave={() => { setTip(null); setHover(null); }}>
      {w > 0 && h > 0 && (
        <svg width={w} height={h} role="img" aria-label={`${type} chart`}>
          {tk.map((t) => (
            <g key={t}>
              <line x1={padL} x2={w - padR} y1={y(t + min)} y2={y(t + min)} className="chart-grid" />
              <text x={padL - 6} y={y(t + min)} className="chart-axis" textAnchor="end" dominantBaseline="middle">{short(t + min)}</text>
            </g>
          ))}
          {data.map((d, i) => i % labelEvery === 0 && (
            <text key={d.key} x={x(i)} y={h - padB + 16} className="chart-axis" textAnchor="middle">{clip(d.label, Math.max(4, Math.floor((band * labelEvery) / 7)))}</text>
          ))}
          {type === "bar" && data.map((d, i) => {
            const y0 = y(0), y1 = y(d.value);
            const hgt = Math.abs(y0 - y1);
            const r = Math.min(4, hgt / 2, barW / 2);
            const left = x(i) - barW / 2;
            const up = d.value >= 0;
            // Rounded at the data end, square at the baseline.
            const path = up
              ? `M${left},${y0} V${y1 + r} Q${left},${y1} ${left + r},${y1} H${left + barW - r} Q${left + barW},${y1} ${left + barW},${y1 + r} V${y0} Z`
              : `M${left},${y0} V${y1 - r} Q${left},${y1} ${left + r},${y1} H${left + barW - r} Q${left + barW},${y1} ${left + barW},${y1 - r} V${y0} Z`;
            return (
              <g key={d.key}>
                <path d={path} fill="var(--s1)" opacity={hover === null || hover === i ? 1 : 0.55} />
                {showValues && <text x={x(i)} y={up ? y1 - 5 : y1 + 12} className="chart-value" textAnchor="middle">{short(d.value)}</text>}
                <rect x={x(i) - band / 2} y={padT} width={band} height={ih} fill="transparent" style={{ cursor: onPick ? "pointer" : "default" }}
                  onMouseMove={() => show(i, x(i), Math.min(y1, y0) - 8)} onClick={() => onPick?.(d)} />
              </g>
            );
          })}
          {type === "line" && (
            <>
              <polyline points={data.map((d, i) => `${x(i)},${y(d.value)}`).join(" ")} fill="none" stroke="var(--s1)" strokeWidth={2} strokeLinejoin="round" />
              {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + ih} className="chart-cross" />}
              {data.map((d, i) => (
                <g key={d.key}>
                  {(hover === i || data.length <= 24) && <circle cx={x(i)} cy={y(d.value)} r={hover === i ? 5 : 3} fill="var(--s1)" stroke="var(--panel)" strokeWidth={2} />}
                  {showValues && <text x={x(i)} y={y(d.value) - 9} className="chart-value" textAnchor="middle">{short(d.value)}</text>}
                  <rect x={x(i) - band / 2} y={padT} width={band} height={ih} fill="transparent" onMouseMove={() => show(i, x(i), y(d.value) - 10)} onClick={() => onPick?.(d)} />
                </g>
              ))}
            </>
          )}
          <line x1={padL} x2={w - padR} y1={y(0)} y2={y(0)} className="chart-base" />
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}

function Pie({ data, format, onPick }: { data: ChartPoint[]; format: (n: number) => string; onPick?: (p: ChartPoint) => void }) {
  const { ref, w, h } = useSize<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  const [hover, setHover] = useState<string | null>(null);
  const positive = data.filter((d) => d.value > 0);
  const total = positive.reduce((a, d) => a + d.value, 0);
  // Colors follow the group (its place in the field's own order), not its size.
  const colorOf = new Map<string, string>();
  [...data].filter((d) => d.key !== "__other").sort((a, b) => a.label.localeCompare(b.label)).forEach((d, i) => colorOf.set(d.key, SERIES[i % SERIES.length]));
  colorOf.set("__other", "var(--s-other)");
  const narrow = w <= 360;
  const legendW = narrow ? 0 : Math.min(220, w * 0.45);
  const ph = narrow ? Math.max(0, h - Math.min(data.length, 4) * 22 - 8) : h;
  const size = Math.max(0, Math.min(w - legendW - 16, ph - 8));
  const R = size / 2, r = R * 0.58, cx = narrow ? w / 2 : R + 4, cy = ph / 2;
  let a0 = -Math.PI / 2;
  const arcs = positive.map((d) => {
    const a1 = a0 + (d.value / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, ang: number) => `${cx + rad * Math.cos(ang)},${cy + rad * Math.sin(ang)}`;
    const full = positive.length === 1;
    const path = full
      ? `M${cx - R},${cy} A${R},${R} 0 1 1 ${cx + R},${cy} A${R},${R} 0 1 1 ${cx - R},${cy} M${cx - r},${cy} A${r},${r} 0 1 0 ${cx + r},${cy} A${r},${r} 0 1 0 ${cx - r},${cy} Z`
      : `M${p(R, a0)} A${R},${R} 0 ${large} 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 ${large} 0 ${p(r, a0)} Z`;
    const mid = (a0 + a1) / 2;
    a0 = a1;
    return { d, path, tx: cx + (R + 6) * Math.cos(mid), ty: cy + R * Math.sin(mid) };
  });
  return (
    <div ref={ref} className={`chart-box pie ${narrow ? "narrow" : ""}`} onMouseLeave={() => { setTip(null); setHover(null); }}>
      {w > 0 && h > 0 && total > 0 && (
        <svg width={w - legendW} height={ph} role="img" aria-label="Pie chart">
          {arcs.map(({ d, path, tx, ty }) => (
            <path key={d.key} d={path} fill={colorOf.get(d.key)} stroke="var(--panel)" strokeWidth={2} fillRule="evenodd"
              opacity={hover === null || hover === d.key ? 1 : 0.5} style={{ cursor: onPick ? "pointer" : "default" }}
              onMouseMove={() => { setHover(d.key); setTip({ x: tx, y: ty, label: d.label, value: `${format(d.value)} · ${Math.round((d.value / total) * 100)}%` }); }}
              onClick={() => onPick?.(d)} />
          ))}
          <text x={cx} y={cy - 4} textAnchor="middle" className="chart-total">{short(total)}</text>
          <text x={cx} y={cy + 14} textAnchor="middle" className="chart-axis">total</text>
        </svg>
      )}
      {total <= 0 && <div className="muted small chart-empty">Nothing to show: every group is zero.</div>}
      {w > 0 && (
        <ul className="chart-legend" style={{ width: narrow ? "100%" : legendW }}>
          {data.map((d) => (
            <li key={d.key} onMouseEnter={() => setHover(d.key)} onMouseLeave={() => setHover(null)} onClick={() => onPick?.(d)}>
              <span className="swatch" style={{ background: colorOf.get(d.key) }} />
              <span className="lbl">{d.label}</span>
              <span className="val">{format(d.value)}</span>
            </li>
          ))}
        </ul>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}

/** The same numbers as a table (for screen readers, printing, and colors that are hard to tell apart). */
export function ChartTable({ data, format, valueLabel }: { data: ChartPoint[]; format: (n: number) => string; valueLabel: string }) {
  return (
    <div className="chart-table">
      <table>
        <thead><tr><th>Group</th><th className="num">{valueLabel}</th></tr></thead>
        <tbody>{data.map((d) => <tr key={d.key}><td>{d.label}</td><td className="num">{format(d.value)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
