"use client";

import { useCallback, useEffect, useState } from "react";
import type { Role } from "@/shared/types";
import { Dialog } from "./common";
import { initials } from "./AccountMenu";

type Member = { userId: string; email: string; name: string; role: Role };
type Invite = { email: string; role: Role };
type MembersResponse = { members: Member[]; invites: Invite[]; myRole: Role; me: string };

const ROLES: { id: Role; label: string; help: string }[] = [
  { id: "owner", label: "Owner", help: "Can edit, share and delete the base" },
  { id: "editor", label: "Editor", help: "Can change records, fields, views and automations" },
  { id: "commenter", label: "Commenter", help: "Can read everything and comment on records" },
  { id: "viewer", label: "Viewer", help: "Can look but not change anything" },
];

export function ShareDialog({ baseId, baseName, onClose }: { baseId: string; baseName: string; onClose: () => void }) {
  const [data, setData] = useState<MembersResponse | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/bases/${baseId}/members`, { cache: "no-store" });
    if (res.ok) setData(await res.json());
  }, [baseId]);
  useEffect(() => { void load(); }, [load]);

  async function call(method: string, path: string, body?: unknown) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/bases/${baseId}/${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "That didn't work");
      await load();
      return json;
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "That didn't work" });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    const result = await call("POST", "members", { email, role });
    if (result) {
      const emailed = result.emailed && result.delivery === "smtp" ? " We emailed them." : "";
      setMessage({
        ok: true,
        text: result.added
          ? `${email} can now open ${baseName}.${emailed}`
          : result.unconfirmed
            ? `${email} hasn't confirmed their email yet. They'll get access as soon as they do.${emailed}`
            : `${email} doesn't have an account yet. They'll get access as soon as they sign up with that email.${emailed}`,
      });
      setEmail("");
    }
  }

  const isOwner = data?.myRole === "owner";
  return (
    <Dialog title={`Share “${baseName}”`} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <div className="stack">
        {isOwner && (
          <form className="row" onSubmit={invite} style={{ flexWrap: "wrap" }}>
            <input className="input" style={{ flex: 1, minWidth: 200 }} type="email" required placeholder="Email address" aria-label="Email address to share with"
              value={email} onChange={(e) => setEmail(e.target.value)} />
            <select className="select" style={{ width: 110 }} value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
              {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
            <button className="btn primary" disabled={busy}>Share</button>
          </form>
        )}
        {message && <p className="small" role="status" style={{ margin: 0, color: message.ok ? "var(--ok)" : "var(--danger)" }}>{message.text}</p>}
        {!data && <span className="muted">Loading…</span>}
        {data && (
          <div>
            {data.members.map((m) => (
              <div key={m.userId} className="member-row">
                <span className="avatar" aria-hidden="true">{initials(m.name)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{m.name}{m.userId === data.me ? " (you)" : ""}</strong>
                  <div className="muted small">{m.email}</div>
                </div>
                {isOwner ? (
                  <select className="select" style={{ width: 110 }} value={m.role} disabled={busy} aria-label={`Role for ${m.name}`}
                    onChange={(e) => void call("PATCH", `members/${m.userId}`, { role: e.target.value })}>
                    {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                ) : (
                  <span className="muted small">{ROLES.find((r) => r.id === m.role)?.label}</span>
                )}
                {(isOwner || m.userId === data.me) && (
                  <button className="btn ghost small" disabled={busy} aria-label={m.userId === data.me ? "Leave this base" : `Remove ${m.name}`}
                    onClick={() => {
                      const self = m.userId === data.me;
                      if (!confirm(self ? `Leave “${baseName}”? You'll lose access.` : `Remove ${m.name} from this base?`)) return;
                      void call("DELETE", `members/${m.userId}`).then((r) => { if (r && self) location.href = "/"; });
                    }}>
                    {m.userId === data.me ? "Leave" : "Remove"}
                  </button>
                )}
              </div>
            ))}
            {data.invites.map((i) => (
              <div key={i.email} className="member-row">
                <span className="avatar" aria-hidden="true" style={{ background: "var(--c-gray)", color: "var(--muted)" }}>✉</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{i.email}</strong>
                  <div className="muted small">Invited as {ROLES.find((r) => r.id === i.role)?.label.toLowerCase()} · waiting for them to sign up</div>
                </div>
                {isOwner && (
                  <button className="btn ghost small" disabled={busy} onClick={() => void call("DELETE", `invites/${encodeURIComponent(i.email)}`)}>Cancel</button>
                )}
              </div>
            ))}
          </div>
        )}
        <details className="small muted">
          <summary>What can each role do?</summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {ROLES.map((r) => <li key={r.id}><b>{r.label}:</b> {r.help}</li>)}
          </ul>
        </details>
      </div>
    </Dialog>
  );
}
