"use client";

import { useCallback, useEffect, useState } from "react";
import { Dialog, useBase } from "./common";

type Token = { id: string; name: string; hint: string; baseIds: string[] | null; canWrite: boolean; createdAt: string; lastUsedAt: string | null };
type Hook = { id: string; url: string; tableId: string | null; enabled: boolean; failures: number; lastStatus: string | null; lastAt: string | null };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `Failed (${r.status})`);
  return d as T;
}

/** Personal access tokens, this base's webhooks, and a quick API reference. */
export function DeveloperDialog({ onClose }: { onClose: () => void }) {
  const { snap } = useBase();
  const [tab, setTab] = useState<"tokens" | "webhooks" | "reference">("tokens");
  const canEdit = snap.role === "owner" || snap.role === "editor";
  return (
    <Dialog wide title="API & webhooks" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Close</button>}>
      <div className="stack">
        <div className="row" role="tablist">
          {(["tokens", "webhooks", "reference"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`btn ${tab === t ? "primary" : "ghost"}`} onClick={() => setTab(t)}>
              {t === "tokens" ? "Access tokens" : t === "webhooks" ? "Webhooks" : "API reference"}
            </button>
          ))}
        </div>
        {tab === "tokens" && <Tokens />}
        {tab === "webhooks" && (canEdit ? <Webhooks /> : <p className="muted">Only editors can manage webhooks.</p>)}
        {tab === "reference" && <Reference />}
      </div>
    </Dialog>
  );
}

function Tokens() {
  const { snap } = useBase();
  const [list, setList] = useState<Token[]>([]);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"this" | "all">("this");
  const [canWrite, setCanWrite] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => { call<{ tokens: Token[] }>("/api/tokens").then((d) => setList(d.tokens)).catch((e) => setError(e.message)); }, []);
  useEffect(reload, [reload]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const d = await call<{ token: string }>("/api/tokens", { method: "POST", body: JSON.stringify({ name, baseIds: scope === "this" ? [snap.state.base.id] : null, canWrite }) });
      setFresh(d.token); setName(""); reload();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }
  async function revoke(t: Token) {
    if (!confirm(`Revoke "${t.name}"? Anything using it stops working.`)) return;
    await call(`/api/tokens/${t.id}`, { method: "DELETE" }).catch(() => {});
    reload();
  }
  return (
    <div className="stack" style={{ gap: 10 }}>
      <p className="muted small" style={{ margin: 0 }}>Tokens act as you: they can only reach bases you can open, at your access level. Treat them like passwords.</p>
      {fresh && (
        <div className="auto-preview" role="status">
          <strong>Copy your new token now. It won't be shown again.</strong>
          <div className="row" style={{ marginTop: 6 }}>
            <code style={{ flex: 1, wordBreak: "break-all" }}>{fresh}</code>
            <button className="btn small" onClick={() => void navigator.clipboard?.writeText(fresh)}>Copy</button>
            <button className="btn ghost small" onClick={() => setFresh(null)}>Done</button>
          </div>
        </div>
      )}
      {list.length === 0 && <span className="muted small">No tokens yet.</span>}
      {list.map((t) => (
        <div key={t.id} className="row small">
          <strong style={{ width: 160 }}>{t.name}</strong>
          <code className="muted">{t.hint}</code>
          <span>{t.canWrite ? "read & write" : "read only"}</span>
          <span className="muted" style={{ flex: 1 }}>{t.baseIds ? `${t.baseIds.length} base${t.baseIds.length === 1 ? "" : "s"}` : "all your bases"} · {t.lastUsedAt ? `used ${new Date(t.lastUsedAt).toLocaleString()}` : "never used"}</span>
          <button className="btn ghost small danger" onClick={() => void revoke(t)} aria-label={`Revoke ${t.name}`}>Revoke</button>
        </div>
      ))}
      <form className="row" style={{ flexWrap: "wrap" }} onSubmit={(e) => void create(e)}>
        <input className="input" style={{ width: 200 }} placeholder="Token name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Token name" />
        <select className="select" style={{ width: 170 }} value={scope} onChange={(e) => setScope(e.target.value as "this" | "all")} aria-label="Bases">
          <option value="this">Only this base</option>
          <option value="all">All my bases</option>
        </select>
        <label className="row small"><input type="checkbox" checked={canWrite} onChange={(e) => setCanWrite(e.target.checked)} /> Can change data</label>
        <button className="btn primary">Create token</button>
      </form>
      {error && <p className="small" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
    </div>
  );
}

function Webhooks() {
  const { snap } = useBase();
  const base = `/api/bases/${snap.state.base.id}/webhooks`;
  const [list, setList] = useState<Hook[]>([]);
  const [url, setUrl] = useState("");
  const [tableId, setTableId] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => { call<{ webhooks: Hook[] }>(base).then((d) => setList(d.webhooks)).catch((e) => setError(e.message)); }, [base]);
  useEffect(reload, [reload]);
  useEffect(() => { const t = setInterval(reload, 10_000); return () => clearInterval(t); }, [reload]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const d = await call<{ secret: string }>(base, { method: "POST", body: JSON.stringify({ url, tableId: tableId || null }) });
      setSecret(d.secret); setUrl(""); reload();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }
  return (
    <div className="stack" style={{ gap: 10 }}>
      <p className="muted small" style={{ margin: 0 }}>
        After every change, FerTable POSTs the created, updated and deleted records (as JSON) to each address. Check the
        {" "}<code>X-FerTable-Signature</code> header: it's <code>sha256=</code> + HMAC-SHA256 of <code>{"<X-FerTable-Timestamp>.<body>"}</code> with the webhook's secret.
        A webhook that fails 20 times in a row is switched off.
      </p>
      {secret && (
        <div className="auto-preview" role="status">
          <strong>Signing secret (shown once):</strong>
          <div className="row" style={{ marginTop: 6 }}><code style={{ flex: 1, wordBreak: "break-all" }}>{secret}</code><button className="btn ghost small" onClick={() => setSecret(null)}>Done</button></div>
        </div>
      )}
      {list.length === 0 && <span className="muted small">No webhooks yet.</span>}
      {list.map((h) => (
        <div key={h.id} className="row small">
          <span className={h.enabled ? "ok" : "bad"}>{h.enabled ? "●" : "○"}</span>
          <span style={{ flex: 1, wordBreak: "break-all" }}>{h.url}</span>
          <span className="muted">{h.tableId ? snap.state.tables[h.tableId]?.name ?? "deleted table" : "all tables"}</span>
          <span className="muted" title={h.lastAt ?? ""}>{h.lastStatus ?? "not sent yet"}{h.failures ? ` · ${h.failures} failed` : ""}</span>
          {!h.enabled && <button className="btn small" onClick={() => void call(`${base}/${h.id}/enable`, { method: "POST" }).then(reload)}>Turn on</button>}
          <button className="btn ghost small danger" aria-label="Delete webhook" onClick={() => confirm("Delete this webhook?") && void call(`${base}/${h.id}`, { method: "DELETE" }).then(reload)}>🗑</button>
        </div>
      ))}
      <form className="row" style={{ flexWrap: "wrap" }} onSubmit={(e) => void add(e)}>
        <input className="input" style={{ flex: 1, minWidth: 240 }} placeholder="https://example.com/hooks/fertable" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Webhook URL" />
        <select className="select" style={{ width: 180 }} value={tableId} onChange={(e) => setTableId(e.target.value)} aria-label="Table">
          <option value="">All tables</option>
          {snap.state.tableOrder.map((id) => <option key={id} value={id}>{snap.state.tables[id].name}</option>)}
        </select>
        <button className="btn primary">Add webhook</button>
      </form>
      {error && <p className="small" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
    </div>
  );
}

function Reference() {
  const { snap } = useBase();
  const s = snap.state;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const first = s.tables[s.tableOrder[0]];
  const ex = first ? encodeURIComponent(first.name) : "Table";
  const primary = first ? s.fields[first.primaryFieldId]?.name ?? "Name" : "Name";
  return (
    <div className="stack" style={{ gap: 10 }}>
      <p className="muted small" style={{ margin: 0 }}>
        The API follows Airtable's shape: records have <code>id</code>, <code>createdTime</code> and <code>fields</code> keyed by field name. Send
        {" "}<code>Authorization: Bearer YOUR_TOKEN</code>. Tables and fields can be named or given by id. Up to 100 records per page and 10 per write; 10 requests a second per token.
      </p>
      <pre className="auto-preview-body">{`# List records (add ?view=…, filterByFormula=…, sort[0][field]=…, pageSize=…, offset=…)
curl "${origin}/v1/${s.base.id}/${ex}" -H "Authorization: Bearer $TOKEN"

# Create records (typecast creates missing select options)
curl -X POST "${origin}/v1/${s.base.id}/${ex}" -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" -d '{"records":[{"fields":{"${primary}":"Hello"}}],"typecast":true}'

# Update / delete
curl -X PATCH "${origin}/v1/${s.base.id}/${ex}/recXXXXXXXXXXXXXX" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"fields":{"${primary}":"Hi"}}'
curl -X DELETE "${origin}/v1/${s.base.id}/${ex}/recXXXXXXXXXXXXXX" -H "Authorization: Bearer $TOKEN"

# Schema
curl "${origin}/v1/meta/bases/${s.base.id}/tables" -H "Authorization: Bearer $TOKEN"`}</pre>
      <div>
        <strong className="small">This base: <code>{s.base.id}</code></strong>
        {s.tableOrder.map((id) => {
          const t = s.tables[id];
          return (
            <details key={id} style={{ marginTop: 6 }}>
              <summary className="small"><strong>{t.name}</strong> <code className="muted">{t.id}</code>{t.sync ? " (synced, read-only)" : ""}</summary>
              <table className="small" style={{ marginTop: 4, borderSpacing: "12px 2px" }}>
                <tbody>{t.fieldOrder.map((fid) => s.fields[fid]).filter(Boolean).map((f) => (
                  <tr key={f.id}><td>{f.name}</td><td className="muted">{f.type}</td><td><code className="muted">{f.id}</code></td></tr>
                ))}</tbody>
              </table>
            </details>
          );
        })}
      </div>
    </div>
  );
}
