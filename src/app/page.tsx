"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AccountMenu, type Me } from "@/client/ui/AccountMenu";
import { VerifyBanner } from "@/client/ui/VerifyBanner";
import { NotificationsBell } from "@/client/ui/Notifications";
import { WorkspaceMembersDialog } from "@/client/ui/WorkspaceDialog";

type Role = "owner" | "editor" | "commenter" | "viewer";
type BaseSummary = { id: string; name: string; txn: number; role: Role; workspaceId: string | null };
type Workspace = { id: string; name: string; role: Role; members: number; bases: number };
type Template = { id: string; name: string; icon: string; description: string };

const ROLE_LABEL = { owner: "Owner", editor: "Editor", commenter: "Can comment", viewer: "View only" };

async function call<T = unknown>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  if (r.status === 401) { location.href = "/login"; throw new Error("Signing in…"); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "Something went wrong");
  return d as T;
}

export default function Home() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [bases, setBases] = useState<BaseSummary[] | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [name, setName] = useState("");
  const [where, setWhere] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<Workspace | null>(null);

  const load = useCallback(() => {
    call<{ bases: BaseSummary[] }>("/api/bases").then((d) => setBases(d.bases)).catch((e) => setError(e.message));
    call<{ workspaces: Workspace[] }>("/api/workspaces").then((d) => setWorkspaces(d.workspaces)).catch(() => {});
  }, []);

  useEffect(() => {
    call<{ user: Me }>("/api/auth/me").then((d) => setMe(d.user)).catch(() => {});
    call<{ templates: Template[] }>("/api/templates").then((d) => setTemplates(d.templates)).catch(() => {});
    load();
  }, [load]);

  async function create(templateId?: string, templateName?: string) {
    setBusy(true);
    try {
      const { id } = await call<{ id: string }>("/api/bases", "POST", { name: name || templateName || "Untitled base", templateId, workspaceId: where || null });
      router.push(`/base/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the base");
      setBusy(false);
    }
  }

  async function newWorkspace() {
    const n = prompt("Name the workspace", "My team");
    if (!n?.trim()) return;
    try { await call("/api/workspaces", "POST", { name: n }); load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  const editable = workspaces.filter((w) => w.role === "owner" || w.role === "editor");
  const groups: { ws: Workspace | null; bases: BaseSummary[] }[] = [
    ...workspaces.map((ws) => ({ ws, bases: (bases ?? []).filter((b) => b.workspaceId === ws.id) })),
    { ws: null, bases: (bases ?? []).filter((b) => !b.workspaceId || !workspaces.some((w) => w.id === b.workspaceId)) },
  ];

  return (
    <main className="home">
      <div className="row">
        <h1 style={{ margin: 0 }}>FerTable</h1>
        <span className="spacer" />
        {me?.admin && <a className="btn ghost" href="/admin">Admin</a>}
        {me && <NotificationsBell />}
        {me && <AccountMenu me={me} />}
      </div>
      {me && <VerifyBanner me={me} />}
      <p className="muted">Spreadsheet-style databases with linked records, formulas, views and live sync.</p>
      <form onSubmit={(e) => { e.preventDefault(); void create(); }} className="row" style={{ marginTop: 20, maxWidth: 640, flexWrap: "wrap" }}>
        <input className="input" style={{ flex: 1, minWidth: 180 }} placeholder="New base name" value={name} onChange={(e) => setName(e.target.value)} aria-label="New base name" />
        {editable.length > 0 && (
          <select className="select" style={{ width: 180 }} value={where} onChange={(e) => setWhere(e.target.value)} aria-label="Workspace">
            <option value="">No workspace</option>
            {editable.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
        <button className="btn primary" disabled={busy}>Create base</button>
      </form>
      {templates.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary className="muted" style={{ cursor: "pointer" }}>Or start from a template</summary>
          <div className="template-grid">
            {templates.map((t) => (
              <button key={t.id} className="template-card" disabled={busy} onClick={() => void create(t.id, t.name)}>
                <span style={{ fontSize: 22 }}>{t.icon}</span>
                <strong>{t.name}</strong>
                <span className="muted small">{t.description}</span>
              </button>
            ))}
          </div>
        </details>
      )}
      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      {bases === null && !error && <p className="muted">Loading…</p>}

      {groups.map(({ ws, bases: list }) => (ws || list.length > 0 || workspaces.length === 0) && (
        <section key={ws?.id ?? "none"}>
          <div className="workspace-head">
            <h2>{ws ? `🗂 ${ws.name}` : workspaces.length ? "Other bases" : "Your bases"}</h2>
            {ws && <span className="muted small">{ws.members} member{ws.members === 1 ? "" : "s"} · {ROLE_LABEL[ws.role]}</span>}
            <span className="spacer" />
            {ws && <button className="btn ghost small" onClick={() => setMembers(ws)}>{ws.role === "owner" ? "Share" : "Members"}</button>}
            {ws?.role === "owner" && (
              <>
                <button className="btn ghost small" onClick={async () => { const n = prompt("Rename workspace", ws.name); if (n?.trim()) { await call(`/api/workspaces/${ws.id}`, "PATCH", { name: n }).catch((e) => setError(e.message)); load(); } }}>Rename</button>
                <button className="btn ghost small danger" onClick={async () => { if (confirm(`Delete the workspace “${ws.name}”? Its bases are kept; members lose the access the workspace gave them.`)) { await call(`/api/workspaces/${ws.id}`, "DELETE").catch((e) => setError(e.message)); load(); } }}>Delete</button>
              </>
            )}
          </div>
          {list.length === 0 && <p className="muted small">{ws ? "No bases in this workspace yet. Move one here from its ⋯ menu, or pick this workspace when creating a base." : "No bases yet. Create one above, or ask someone to share theirs with you."}</p>}
          <div className="base-grid">
            {list.map((b) => (
              <a key={b.id} className="base-card" href={`/base/${b.id}`}>
                <span className="base-icon">{b.name.slice(0, 2)}</span>
                <span>
                  <strong>{b.name}</strong>
                  <br />
                  <span className="muted small">{ROLE_LABEL[b.role]} · {b.txn} changes</span>
                </span>
              </a>
            ))}
          </div>
        </section>
      ))}
      <div style={{ marginTop: 24 }}><button className="btn" onClick={() => void newWorkspace()}>＋ New workspace</button></div>
      {members && <WorkspaceMembersDialog workspace={members} onClose={() => { setMembers(null); load(); }} />}
    </main>
  );
}
