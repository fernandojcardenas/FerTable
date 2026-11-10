"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

function ResetForm() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("The two passwords don't match");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Something went wrong");
      location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <main className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20 }}>Choose a new password</h1>
          <span className="muted small">You'll be signed out everywhere else.</span>
        </div>
        {!token && <p role="alert" className="small" style={{ color: "var(--danger)", margin: 0 }}>This link is missing its reset code. Ask for a new link.</p>}
        <div>
          <label className="field-label" htmlFor="password">New password</label>
          <input id="password" className="input" type="password" required minLength={8} autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          <span className="muted small">At least 8 characters.</span>
        </div>
        <div>
          <label className="field-label" htmlFor="confirm">Type it again</label>
          <input id="confirm" className="input" type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        {error && <p role="alert" className="small" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
        <button className="btn primary" disabled={busy || !token} style={{ justifyContent: "center", padding: "8px 12px" }}>
          {busy ? "Saving…" : "Set password and sign in"}
        </button>
        <a href="/login" className="small" style={{ textAlign: "center" }}>Back to sign in</a>
      </form>
    </main>
  );
}

export default function ResetPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
