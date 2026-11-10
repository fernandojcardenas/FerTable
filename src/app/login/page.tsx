"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

/** Only same-site paths are allowed after signing in (no open redirects). */
function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login") ? next : "/";
}

function LoginForm() {
  const params = useSearchParams();
  // Invite emails link here with ?mode=signup&email=… so the form is ready to go.
  const [mode, setMode] = useState<"login" | "signup">(() => (params.get("mode") === "signup" ? "signup" : "login"));
  const [email, setEmail] = useState(() => params.get("email") ?? "");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forgot, setForgot] = useState(false);
  const [forgotMsg, setForgotMsg] = useState<string | null>(null);

  async function sendReset() {
    setForgotMsg(null);
    if (!email) return setForgotMsg("Type your email above first.");
    const res = await fetch("/api/auth/forgot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }).catch(() => null);
    const body = await res?.json().catch(() => ({}));
    if (!res?.ok) return setForgotMsg(body?.error ?? "That didn't work. Try again in a moment.");
    setForgotMsg(body.delivery === "smtp"
      ? "If there's an account for that email, a reset link is on its way. Check your inbox."
      : "If there's an account for that email, a reset link was made. This server can't send email, so the link is in the server's log — ask whoever runs it.");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mode === "signup" ? { email, name, password } : { email, password }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Something went wrong");
      // A full page load so the server sees the new session cookie.
      location.href = safeNext(params.get("next"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  const signup = mode === "signup";
  return (
    <main className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="row" style={{ gap: 10 }}>
          <span className="base-icon" aria-hidden="true">gb</span>
          <div>
            <h1 style={{ margin: 0, fontSize: 20 }}>{signup ? "Create your account" : "Sign in to gridbase"}</h1>
            <span className="muted small">{signup ? "It only takes a moment." : "Welcome back."}</span>
          </div>
        </div>
        {signup && (
          <div>
            <label className="field-label" htmlFor="name">Name</label>
            <input id="name" className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        )}
        <div>
          <label className="field-label" htmlFor="email">Email</label>
          <input id="email" className="input" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="field-label" htmlFor="password">Password</label>
          <input id="password" className="input" type="password" required minLength={signup ? 8 : undefined}
            autoComplete={signup ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} />
          {signup && <span className="muted small">At least 8 characters.</span>}
          {!signup && (
            <button type="button" className="link-btn small" style={{ marginTop: 6 }} onClick={() => setForgot((f) => !f)}>Forgot your password?</button>
          )}
          {!signup && forgot && (
            <div className="stack" style={{ gap: 6, marginTop: 6 }}>
              <button type="button" className="btn small" style={{ alignSelf: "flex-start" }} onClick={sendReset}>Email me a reset link</button>
              {forgotMsg && <p role="status" className="small muted" style={{ margin: 0 }}>{forgotMsg}</p>}
            </div>
          )}
        </div>
        {error && <p role="alert" className="small" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
        <button className="btn primary" disabled={busy} style={{ justifyContent: "center", padding: "8px 12px" }}>
          {busy ? "Please wait…" : signup ? "Create account" : "Sign in"}
        </button>
        <p className="small muted" style={{ margin: 0, textAlign: "center" }}>
          {signup ? "Already have an account? " : "New here? "}
          <button type="button" className="link-btn" onClick={() => { setMode(signup ? "login" : "signup"); setError(null); }}>
            {signup ? "Sign in" : "Create an account"}
          </button>
        </p>
      </form>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
