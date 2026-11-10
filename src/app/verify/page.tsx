"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

function Verify() {
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<"working" | "done" | string>(token ? "working" : "This link is missing its code. Sign in and ask for a new one.");
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    fetch("/api/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Something went wrong");
        setState("done");
      })
      .catch((e) => setState(e instanceof Error ? e.message : String(e)));
  }, [token]);

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <h1 style={{ margin: 0, fontSize: 20 }}>{state === "done" ? "Email confirmed" : state === "working" ? "Confirming your email…" : "Couldn't confirm"}</h1>
        {state === "done" && <p className="muted" style={{ margin: 0 }}>Thanks! Bases shared with this address are open to you now.</p>}
        {state !== "done" && state !== "working" && <p role="alert" className="small" style={{ color: "var(--danger)", margin: 0 }}>{state}</p>}
        {state !== "working" && <a className="btn primary" href="/" style={{ alignSelf: "flex-start" }}>Go to your bases</a>}
      </div>
    </main>
  );
}

export default function VerifyPage() {
  return <Suspense fallback={null}><Verify /></Suspense>;
}
