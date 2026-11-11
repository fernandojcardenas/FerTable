"use client";

// The Bases button at the top left of a base: jump straight to another base, or go home.

import { useEffect, useState } from "react";
import { Popover } from "./common";

type BaseItem = { id: string; name: string; workspaceId: string | null };
type Workspace = { id: string; name: string };

export function BaseSwitcher({ currentId }: { currentId: string }) {
  const [open, setOpen] = useState(false);
  const [bases, setBases] = useState<BaseItem[] | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!open) return;
    fetch("/api/bases", { cache: "no-store" }).then((r) => r.json()).then((d) => setBases(d.bases ?? [])).catch(() => setBases([]));
    fetch("/api/workspaces", { cache: "no-store" }).then((r) => r.json()).then((d) => setWorkspaces(d.workspaces ?? [])).catch(() => {});
  }, [open]);

  const needle = q.trim().toLowerCase();
  const shown = (bases ?? []).filter((b) => !needle || b.name.toLowerCase().includes(needle));
  const groups = [
    ...workspaces.map((w) => ({ name: w.name, items: shown.filter((b) => b.workspaceId === w.id) })),
    { name: workspaces.length ? "Other bases" : "", items: shown.filter((b) => !b.workspaceId || !workspaces.some((w) => w.id === b.workspaceId)) },
  ].filter((g) => g.items.length);

  return (
    <Popover open={open} onClose={() => setOpen(false)} anchor={
      <button className="btn ghost base-switch" onClick={() => { setOpen(!open); setQ(""); }} aria-label="Switch base" title="Switch to another base">
        ◧<span className="hide-sm"> Bases</span> <span className="muted small">▾</span>
      </button>
    }>
      <div className="base-switcher">
        <a className="view-item" href="/">⌂ All bases</a>
        {(bases?.length ?? 0) > 6 && (
          <input className="input" autoFocus placeholder="Find a base" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a base" />
        )}
        {bases === null && <span className="muted small" style={{ padding: 8 }}>Loading…</span>}
        {groups.map((g) => (
          <div key={g.name || "all"} className="stack" style={{ gap: 2 }}>
            {g.name && <span className="muted small" style={{ padding: "6px 8px 2px" }}>{g.name}</span>}
            {g.items.map((b) => (
              <a key={b.id} className={`view-item ${b.id === currentId ? "active" : ""}`} href={`/base/${b.id}`} aria-current={b.id === currentId ? "page" : undefined}>
                <span className="base-dot">{b.name.slice(0, 2)}</span> {b.name}
              </a>
            ))}
          </div>
        ))}
        {bases !== null && shown.length === 0 && <span className="muted small" style={{ padding: 8 }}>No bases match.</span>}
      </div>
    </Popover>
  );
}
