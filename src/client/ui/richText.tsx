"use client";

// Rich text for long text fields, stored as Markdown: **bold**, *italic*, ~~strike~~,
// `code`, [links](https://…), # headings, - lists, 1. numbered lists and > quotes.
// Rendered as React elements (never raw HTML), and links only go to http(s) or mailto.

import { useRef, useState, type ReactNode } from "react";

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

/** Inline Markdown → React nodes. */
export function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  // Order matters: code first so its content isn't formatted.
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(~~[^~]+~~)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0, m: RegExpExecArray | null, n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${n++}`;
    if (m[1]) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (m[2] || m[3]) out.push(<strong key={k}>{inline(t.slice(2, -2), k)}</strong>);
    else if (m[4]) out.push(<s key={k}>{inline(t.slice(2, -2), k)}</s>);
    else if (m[5] || m[6]) out.push(<em key={k}>{inline(t.slice(1, -1), k)}</em>);
    else {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t)!;
      out.push(SAFE_LINK.test(lm[2])
        ? <a key={k} href={lm[2]} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{inline(lm[1], k)}</a>
        : lm[1]);
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Markdown blocks → React. `inline` mode squeezes everything onto one line (grid cells). */
export function RichText({ text, inline: oneLine = false }: { text: string; inline?: boolean }) {
  if (!text) return null;
  if (oneLine) {
    const plain = text.split("\n").map((l) => l.replace(/^\s*(#{1,3}\s+|[-*]\s+|\d+\.\s+|>\s?)/, "")).filter(Boolean).join(" · ");
    return <span className="rich-inline">{inline(plain)}</span>;
  }
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0, b = 0;
  while (i < lines.length) {
    const line = lines[i];
    const k = `b${b++}`;
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const Tag = (["h3", "h4", "h5"] as const)[level - 1];
      blocks.push(<Tag key={k}>{inline(h[2], k)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/).test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
        i++;
      }
      const lis = items.map((t, j) => <li key={j}>{inline(t, `${k}-${j}`)}</li>);
      blocks.push(ordered ? <ol key={k}>{lis}</ol> : <ul key={k}>{lis}</ul>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { quoted.push(lines[i].replace(/^>\s?/, "")); i++; }
      blocks.push(<blockquote key={k}>{inline(quoted.join(" "), k)}</blockquote>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|\s*[-*]\s|\s*\d+\.\s|>)/.test(lines[i])) { para.push(lines[i]); i++; }
    blocks.push(<p key={k}>{para.flatMap((p, j) => (j ? [<br key={`br${j}`} />, ...inline(p, `${k}-${j}`)] : inline(p, `${k}-${j}`)))}</p>);
  }
  return <div className="rich-text">{blocks}</div>;
}

/** A text box with formatting buttons and a preview. */
export function RichTextEditor({ value, onChange, readOnly }: { value: string; onChange: (v: string) => void; readOnly?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);
  const wrap = (before: string, after = before, placeholder = "text") => {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b } = el;
    const sel = value.slice(a, b) || placeholder;
    const next = value.slice(0, a) + before + sel + after + value.slice(b);
    onChange(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + before.length, a + before.length + sel.length); });
  };
  const prefix = (p: string) => {
    const el = ref.current;
    if (!el) return;
    const a = el.selectionStart;
    const start = value.lastIndexOf("\n", a - 1) + 1;
    onChange(value.slice(0, start) + p + value.slice(start));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + p.length, a + p.length); });
  };
  if (readOnly) return <RichText text={value} />;
  return (
    <div className="rich-editor">
      <div className="rich-tools" role="toolbar" aria-label="Formatting">
        <button type="button" className="btn ghost small" onClick={() => wrap("**")} title="Bold" aria-label="Bold"><b>B</b></button>
        <button type="button" className="btn ghost small" onClick={() => wrap("*")} title="Italic" aria-label="Italic"><i>I</i></button>
        <button type="button" className="btn ghost small" onClick={() => wrap("~~")} title="Strikethrough" aria-label="Strikethrough"><s>S</s></button>
        <button type="button" className="btn ghost small" onClick={() => wrap("`")} title="Code" aria-label="Code">{"</>"}</button>
        <button type="button" className="btn ghost small" onClick={() => {
          const url = prompt("Link address (https://…)", "https://");
          if (url && SAFE_LINK.test(url)) wrap("[", `](${url})`, "link text");
        }} title="Link" aria-label="Link">🔗</button>
        <button type="button" className="btn ghost small" onClick={() => prefix("## ")} title="Heading" aria-label="Heading">H</button>
        <button type="button" className="btn ghost small" onClick={() => prefix("- ")} title="Bulleted list" aria-label="Bulleted list">•</button>
        <button type="button" className="btn ghost small" onClick={() => prefix("1. ")} title="Numbered list" aria-label="Numbered list">1.</button>
        <button type="button" className="btn ghost small" onClick={() => prefix("> ")} title="Quote" aria-label="Quote">❝</button>
        <span className="spacer" />
        <button type="button" className={`btn ghost small ${preview ? "active" : ""}`} onClick={() => setPreview((p) => !p)}>{preview ? "Edit" : "Preview"}</button>
      </div>
      {preview
        ? <div className="rich-preview"><RichText text={value} /></div>
        : <textarea ref={ref} className="textarea" rows={6} value={value} onChange={(e) => onChange(e.target.value)} />}
    </div>
  );
}
