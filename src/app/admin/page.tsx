"use client";

// Server admin: the audit log and the list of accounts. Only admins can open it
// (the first account on a server is an admin; admins can make others admins).

import { useCallback, useEffect, useState } from "react";

type Entry = { id: number; at: string; userId: string | null; email: string | null; ip: string | null; action: string; baseId: string | null; detail: Record<string, unknown> };
type UserRow = { id: string; email: string; name: string; verified: boolean; admin: boolean; createdAt: string | null; lastLoginAt: string | null; disabled: boolean; bases: number };

const ACTIONS = [
  ["", "All events"], ["auth.", "Sign-ins and accounts"], ["share.", "Base sharing"], ["workspace.", "Workspaces"], ["link.", "Public links"],
  ["token.", "API tokens"], ["webhook.", "Webhooks"], ["base.", "Bases"], ["snapshot.", "Snapshots"], ["admin.", "Admin changes"],
] as const;

async function call<T = unknown>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  if (r.status === 401) { location.href = "/login?next=/admin"; throw new Error("Signing in…"); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 404 ? "Only the server's admins can open this page." : d.error ?? "Something went wrong");
  return d as T;
}

export default function AdminPage() {
  const [tab, setTab] = useState<"audit" | "users">("audit");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [action, setAction] = useState("");
  const [who, setWho] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(true);

  const loadAudit = useCallback(async (before?: number) => {
    const q = new URLSearchParams({ limit: "100", ...(action ? { action } : {}), ...(who.trim() ? { user: who.trim() } : {}), ...(before ? { before: String(before) } : {}) });
    try {
      const d = await call<{ entries: Entry[] }>(`/api/manage/audit?${q}`);
      setEntries((prev) => (before && prev ? [...prev, ...d.entries] : d.entries));
      setMore(d.entries.length === 100);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [action, who]);
  const loadUsers = useCallback(() => call<{ users: UserRow[] }>("/api/manage/users").then((d) => setUsers(d.users)).catch((e) => setError(e.message)), []);

  useEffect(() => { void loadAudit(); }, [loadAudit]);
  useEffect(() => { if (tab === "users") void loadUsers(); }, [tab, loadUsers]);

  const change = async (u: UserRow, patch: { admin?: boolean; disabled?: boolean }) => {
    try { await call(`/api/manage/users/${u.id}`, "PATCH", patch); await loadUsers(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "–");

  return (
    <main className="home" style={{ maxWidth: 1200 }}>
      <div className="row">
        <a href="/" className="btn ghost">← Bases</a>
        <h1 style={{ margin: 0 }}>Admin</h1>
        <span className="spacer" />
        <span className="mode-switch" role="tablist">
          <button role="tab" aria-selected={tab === "audit"} className={tab === "audit" ? "on" : ""} onClick={() => setTab("audit")}>Audit log</button>
          <button role="tab" aria-selected={tab === "users"} className={tab === "users" ? "on" : ""} onClick={() => setTab("users")}>Users</button>
        </span>
      </div>
      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      {tab === "audit" && !error && (
        <>
          <div className="row" style={{ margin: "14px 0", flexWrap: "wrap" }}>
            <select className="select" style={{ width: 220 }} value={action} onChange={(e) => setAction(e.target.value)} aria-label="Event type">
              {ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <input className="input" style={{ width: 240 }} placeholder="Filter by email" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Filter by email" />
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="admin-table">
              <thead><tr><th>When</th><th>Who</th><th>Event</th><th>Base</th><th>Details</th><th>IP</th></tr></thead>
              <tbody>
                {entries?.map((e) => (
                  <tr key={e.id}>
                    <td>{when(e.at)}</td>
                    <td>{e.email ?? <span className="muted">–</span>}</td>
                    <td><code>{e.action}</code></td>
                    <td>{e.baseId ? <a href={`/base/${e.baseId}`}>{e.baseId}</a> : ""}</td>
                    <td className="admin-detail">{Object.keys(e.detail ?? {}).length ? JSON.stringify(e.detail) : ""}</td>
                    <td className="muted">{e.ip}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {entries?.length === 0 && <p className="muted">No events yet.</p>}
          {more && entries && entries.length > 0 && <button className="btn" style={{ marginTop: 10 }} onClick={() => void loadAudit(entries[entries.length - 1].id)}>Load older</button>}
        </>
      )}
      {tab === "users" && !error && (
        <div style={{ overflowX: "auto", marginTop: 14 }}>
          <table className="admin-table">
            <thead><tr><th>Name</th><th>Email</th><th>Joined</th><th>Last sign-in</th><th>Bases</th><th>Admin</th><th>Status</th></tr></thead>
            <tbody>
              {users?.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td>{u.email}{!u.verified && <span className="muted small"> (unconfirmed)</span>}</td>
                  <td>{when(u.createdAt)}</td>
                  <td>{when(u.lastLoginAt)}</td>
                  <td>{u.bases}</td>
                  <td><input type="checkbox" checked={u.admin} onChange={(e) => void change(u, { admin: e.target.checked })} aria-label={`${u.name} is an admin`} /></td>
                  <td>
                    {u.disabled ? <span style={{ color: "var(--danger)" }}>Turned off</span> : "Active"}{" "}
                    <button className="btn ghost small" onClick={() => { if (u.disabled || confirm(`Turn off ${u.name}'s account? They're signed out everywhere and their API tokens stop working.`)) void change(u, { disabled: !u.disabled }); }}>{u.disabled ? "Turn on" : "Turn off"}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
