"use client";

import { useState } from "react";
import type { Me } from "./AccountMenu";

/** Shown until the account's email is confirmed: bases shared with it stay locked till then. */
export function VerifyBanner({ me }: { me: Me }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "logged" | string>("idle");
  if (me.verified !== false) return null;

  async function resend() {
    setState("sending");
    try {
      const r = await fetch("/api/auth/resend-verification", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Couldn't send the email");
      setState(d.already ? "already" : d.delivery === "log" ? "logged" : "sent");
      if (d.already) location.reload();
    } catch (e) {
      setState(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="verify-banner" role="status">
      <span>
        <strong>Confirm your email.</strong> We sent a link to <b>{me.email}</b>. Bases people share with you open once you click it.
      </span>
      <span className="spacer" />
      {state === "sent" ? <span className="small">Sent. Check your inbox.</span>
        : state === "logged" ? <span className="small">Sent to the server log (email isn't set up on this server).</span>
        : !["idle", "sending"].includes(state) ? <span className="small" style={{ color: "var(--danger)" }}>{state}</span>
        : <button className="btn small" disabled={state === "sending"} onClick={() => void resend()}>{state === "sending" ? "Sending…" : "Send it again"}</button>}
    </div>
  );
}
