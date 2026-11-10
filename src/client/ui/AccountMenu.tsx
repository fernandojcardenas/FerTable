"use client";

import { useState } from "react";
import { Dialog, Popover } from "./common";

export type Me = { id: string; email: string; name: string; verified?: boolean };

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

/** Avatar button with the signed-in account and a sign-out option. */
export function AccountMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/login";
  }
  return (
    <>
      <Popover open={open} onClose={() => setOpen(false)} align="right" anchor={
        <button className="avatar" onClick={() => setOpen((o) => !o)} aria-label={`Account: ${me.name}`} title={me.email}>{initials(me.name)}</button>
      }>
        <div className="stack" style={{ gap: 8, minWidth: 220 }}>
          <div>
            <strong>{me.name}</strong>
            <div className="muted small">{me.email}</div>
          </div>
          <div className="menu" style={{ padding: 0 }}>
            <button onClick={() => { setOpen(false); setChanging(true); }}>🔑 Change password</button>
            <button onClick={signOut}>⎋ Sign out</button>
          </div>
        </div>
      </Popover>
      {/* Outside the popover, which unmounts its content when it closes. */}
      {changing && <ChangePasswordDialog onClose={() => setChanging(false)} />}
    </>
  );
}

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) return setError("The new passwords don't match");
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current, password: next }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) setDone(true);
    else setError((await res?.json().catch(() => ({})))?.error ?? "That didn't work");
  }

  return (
    <Dialog title="Change password" onClose={onClose}>
      {done ? (
        <div className="stack">
          <p style={{ margin: 0 }}>Your password was changed. Other devices were signed out; this one stays signed in.</p>
          <button className="btn primary" style={{ alignSelf: "flex-start" }} onClick={onClose}>Done</button>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <div>
            <label className="field-label" htmlFor="pw-current">Current password</label>
            <input id="pw-current" className="input" type="password" required autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div>
            <label className="field-label" htmlFor="pw-new">New password</label>
            <input id="pw-new" className="input" type="password" required minLength={8} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
          <div>
            <label className="field-label" htmlFor="pw-confirm">Type the new password again</label>
            <input id="pw-confirm" className="input" type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
          {error && <p role="alert" className="small" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
          <div className="row">
            <span className="spacer" />
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={busy}>{busy ? "Saving…" : "Change password"}</button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
