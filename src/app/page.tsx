"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AccountMenu, type Me } from "@/client/ui/AccountMenu";
import { VerifyBanner } from "@/client/ui/VerifyBanner";

type BaseSummary = { id: string; name: string; txn: number; role: "owner" | "editor" | "commenter" | "viewer" };

const ROLE_LABEL = { owner: "Owner", editor: "Editor", commenter: "Can comment", viewer: "View only" };

export default function Home() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [bases, setBases] = useState<BaseSummary[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const toLogin = () => { location.href = "/login"; };
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.status === 401 ? toLogin() : r.json().then((d) => setMe(d.user))))
      .catch(() => {});
    fetch("/api/bases", { cache: "no-store" })
      .then(async (r) => {
        if (r.status === 401) return toLogin();
        setBases((await r.json()).bases);
      })
      .catch(() => setError("Could not load bases. Is the server running?"));
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/bases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name || "Untitled base" }),
      });
      if (!res.ok) throw new Error();
      const { id } = await res.json();
      router.push(`/base/${id}`);
    } catch {
      setError("Could not create the base");
      setBusy(false);
    }
  }

  return (
    <main className="home">
      <div className="row">
        <h1 style={{ margin: 0 }}>gridbase</h1>
        <span className="spacer" />
        {me && <AccountMenu me={me} />}
      </div>
      {me && <VerifyBanner me={me} />}
      <p className="muted">Spreadsheet-style databases with linked records, formulas, views and live sync.</p>
      <form onSubmit={create} className="row" style={{ marginTop: 20, maxWidth: 480 }}>
        <input className="input" placeholder="New base name" value={name} onChange={(e) => setName(e.target.value)} aria-label="New base name" />
        <button className="btn primary" disabled={busy}>Create base</button>
      </form>
      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      {bases === null && !error && <p className="muted">Loading…</p>}
      {bases?.length === 0 && <p className="muted">No bases yet. Create one above, or ask someone to share theirs with you.</p>}
      <div className="base-grid">
        {bases?.map((b) => (
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
    </main>
  );
}
