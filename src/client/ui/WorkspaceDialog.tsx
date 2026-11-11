"use client";

// Workspace members: everyone here gets their workspace role on every base in the workspace.

import { useEffect, useState } from "react";
import { Dialog } from "./common";

type Role = "owner" | "editor" | "commenter" | "viewer";
type Member = { userId: string; name: string; email: string; role: Role };

async function call<T = unknown>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "Something went wrong");
  return d as T;
}

export function WorkspaceMembersDialog({ workspace, onClose }: { workspace: { id: string; name: string }; onClose: () => void }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [myRole, setMyRole] = useState<Role>("viewer");
  const [me, setMe] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [error, setError] = useState<string | null>(null);
  const base = `/api/workspaces/${workspace.id}/members`;
  const load = () => call<{ members: Member[]; myRole: Role; me: string }>(base).then((d) => { setMembers(d.members); setMyRole(d.myRole); setMe(d.me); }).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const owner = myRole === "owner";
  return (
    <Dialog title={`${workspace.name} · members`} onClose={onClose} footer={<><span className="spacer" /><button className="btn primary" onClick={onClose}>Done</button></>}>
      <p className="muted" style={{ marginTop: 0 }}>Members get their workspace role on every base in this workspace (or their own role on a base, if it&apos;s higher).</p>
      {owner && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void act(async () => { await call(base, "POST", { email, role }); setEmail(""); }); }}>
          <input className="input" type="email" placeholder="Email of someone with an account" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
          <select className="select" style={{ width: 130 }} value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
            <option value="owner">Owner</option><option value="editor">Editor</option><option value="commenter">Commenter</option><option value="viewer">Viewer</option>
          </select>
          <button className="btn primary" disabled={!email.trim()}>Add</button>
        </form>
      )}
      {error && <p className="small" style={{ color: "var(--danger)" }}>{error}</p>}
      <div className="stack" style={{ gap: 4, marginTop: 10 }}>
        {members?.map((m) => (
          <div key={m.userId} className="row">
            <span className="stack" style={{ gap: 0 }}><span>{m.name}{m.userId === me ? " (you)" : ""}</span><span className="muted small">{m.email}</span></span>
            <span className="spacer" />
            {owner ? (
              <select className="select" style={{ width: 130 }} value={m.role} onChange={(e) => void act(() => call(`${base}/${m.userId}`, "PATCH", { role: e.target.value }))} aria-label={`${m.name}'s role`}>
                <option value="owner">Owner</option><option value="editor">Editor</option><option value="commenter">Commenter</option><option value="viewer">Viewer</option>
              </select>
            ) : <span className="muted small">{m.role}</span>}
            {(owner || m.userId === me) && (
              <button className="btn ghost small" onClick={() => { if (confirm(m.userId === me ? "Leave this workspace?" : `Remove ${m.name}?`)) void act(() => call(`${base}/${m.userId}`, "DELETE")); }}>{m.userId === me ? "Leave" : "Remove"}</button>
            )}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
