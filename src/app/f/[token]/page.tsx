"use client";

import { use, useEffect, useState } from "react";
import type { PublicFormDefinition, PublicQuestion } from "@/shared/publicForm";

type Answer = string | number | boolean | string[] | null;

/** A form anyone with the link can fill in. It only ever sees the form's own questions. */
export default function PublicFormPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [form, setForm] = useState<PublicFormDefinition | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [honeypot, setHoneypot] = useState("");
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    fetch(`/api/forms/${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "This form isn't available.");
        setForm(d);
        document.title = d.title;
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [token]);

  const answered = (v: Answer | undefined) => !(v === undefined || v === null || v === false || v === "" || (Array.isArray(v) && v.length === 0));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    const missing = form.questions.filter((q) => q.required && !answered(answers[q.fieldId]));
    if (missing.length) {
      setFlagged(new Set(missing.map((q) => q.fieldId)));
      setError("Please answer the required questions.");
      document.getElementById(`q-${missing[0].fieldId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/forms/${encodeURIComponent(token)}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers, website: honeypot }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Couldn't send your response. Please try again.");
      setSent(true);
      setAnswers({});
      setFlagged(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <Shell><h1 style={{ margin: 0, fontSize: 20 }}>Form unavailable</h1><p className="muted" style={{ margin: 0 }}>{loadError}</p></Shell>;
  if (!form) return <Shell><span className="muted">Loading…</span></Shell>;
  if (sent) {
    return (
      <Shell>
        <h2 style={{ margin: 0 }}>Thanks!</h2>
        <p className="muted" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{form.thankYou}</p>
        <button className="btn" style={{ alignSelf: "flex-start" }} onClick={() => setSent(false)}>Send another response</button>
      </Shell>
    );
  }

  return (
    <Shell>
      <form onSubmit={submit} noValidate className="stack" style={{ gap: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>{form.title}</h1>
          {form.description && <p className="muted" style={{ margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{form.description}</p>}
        </div>
        {form.questions.map((q) => {
          const bad = flagged.has(q.fieldId) && !answered(answers[q.fieldId]);
          return (
            <div key={q.fieldId} id={`q-${q.fieldId}`} className={bad ? "form-q missing" : "form-q"}>
              <label className="field-label" htmlFor={`in-${q.fieldId}`} style={{ fontSize: 13, color: "var(--text)" }}>
                {q.label}{q.required && <span className="req" aria-label="required"> *</span>}
              </label>
              {q.help && <p className="muted small" style={{ margin: "0 0 4px", whiteSpace: "pre-wrap" }}>{q.help}</p>}
              <PublicInput q={q} value={answers[q.fieldId] ?? null} onChange={(v) => setAnswers((a) => ({ ...a, [q.fieldId]: v }))} />
              {flagged.has(q.fieldId) && (
                <p className="small" role={bad ? "alert" : undefined} style={{ color: "var(--danger)", margin: "4px 0 0", visibility: bad ? "visible" : "hidden" }}>This question is required.</p>
              )}
            </div>
          );
        })}
        {/* Hidden from people; bots that fill in every field give themselves away. */}
        <div aria-hidden="true" style={{ position: "absolute", left: -10000, width: 1, height: 1, overflow: "hidden" }}>
          <label>Website <input tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} name="website" /></label>
        </div>
        {error && <p className="small" role="alert" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
        <button className="btn primary" style={{ alignSelf: "flex-start" }} disabled={busy}>{busy ? "Sending…" : form.submitLabel}</button>
        <p className="muted small" style={{ margin: 0 }}>Don't send passwords or payment details through this form.</p>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="form-wrap" style={{ minHeight: "100vh", alignItems: "flex-start" }}>
      <div className="form-card">{children}</div>
    </main>
  );
}

function PublicInput({ q, value, onChange }: { q: PublicQuestion; value: Answer; onChange: (v: Answer) => void }) {
  const id = `in-${q.fieldId}`;
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  switch (q.type) {
    case "longText":
      return <textarea id={id} className="textarea" rows={4} value={text} maxLength={10000} onChange={(e) => onChange(e.target.value)} />;
    case "number":
      return <input id={id} className="input" type="number" inputMode="decimal" value={text} onChange={(e) => onChange(e.target.value)} />;
    case "rating":
      return (
        <select id={id} className="select" value={text} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Choose…</option>
          {Array.from({ length: q.max ?? 5 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{"★".repeat(n)} ({n})</option>)}
        </select>
      );
    case "duration":
      return <input id={id} className="input" placeholder="h:mm, like 1:30" value={text} onChange={(e) => onChange(e.target.value)} />;
    case "checkbox":
      return <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} style={{ width: 18, height: 18 }} />;
    case "date":
      return <input id={id} className="input" type={q.includeTime ? "datetime-local" : "date"} value={text} onChange={(e) => onChange(e.target.value)} />;
    case "singleSelect":
      return (
        <select id={id} className="select" value={text} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">Choose…</option>
          {(q.choices ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      );
    case "multiSelect": {
      const picked = Array.isArray(value) ? value : [];
      return (
        <div id={id} className="row" role="group" style={{ flexWrap: "wrap", gap: 10 }}>
          {(q.choices ?? []).map((c) => (
            <label key={c.id} className="row small" style={{ gap: 4, cursor: "pointer" }}>
              <input type="checkbox" checked={picked.includes(c.id)}
                onChange={(e) => onChange(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />
              <span className={`chip c-${c.color}`}>{c.name}</span>
            </label>
          ))}
        </div>
      );
    }
    default:
      return <input id={id} className="input" type={q.type === "email" ? "email" : q.type === "url" ? "url" : q.type === "phone" ? "tel" : "text"}
        value={text} maxLength={10000} onChange={(e) => onChange(e.target.value)} />;
  }
}
