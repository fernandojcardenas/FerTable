"use client";

// The notifications bell: mentions, records you were added to, and things shared with you.

import { useCallback, useEffect, useState } from "react";
import { Popover } from "./common";

type Item = { id: string; kind: string; title: string; body: string; link: string | null; createdAt: string; read: boolean };

const ICON: Record<string, string> = { mention: "💬", assigned: "👤", shared: "🔗" };

function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);

  const load = useCallback(() => {
    fetch("/api/notifications", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) { setItems(d.notifications); setUnread(d.unread); } })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    window.addEventListener("fertable:notification", load);
    window.addEventListener("focus", load);
    return () => { clearInterval(t); window.removeEventListener("fertable:notification", load); window.removeEventListener("focus", load); };
  }, [load]);

  const read = async (ids?: string[]) => {
    await fetch("/api/notifications/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ids ? { ids } : {}) }).catch(() => {});
    load();
  };

  return (
    <Popover open={open} onClose={() => setOpen(false)} align="right" anchor={
      <button className="btn ghost bell" onClick={() => setOpen(!open)} aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
        🔔{unread > 0 && <span className="bell-count">{unread > 99 ? "99+" : unread}</span>}
      </button>
    }>
      <div className="notif-panel">
        <div className="row"><strong>Notifications</strong><span className="spacer" />{unread > 0 && <button className="btn ghost small" onClick={() => void read()}>Mark all read</button>}</div>
        {items.length === 0 && <p className="muted small">Nothing yet. You&apos;ll see mentions, records you&apos;re added to, and bases shared with you.</p>}
        {items.map((n) => (
          <a key={n.id} className={`notif ${n.read ? "" : "unread"}`} href={n.link ?? "#"}
            onClick={(e) => { if (!n.read) void read([n.id]); if (!n.link) e.preventDefault(); }}>
            <span className="notif-icon">{ICON[n.kind] ?? "•"}</span>
            <span className="notif-text">
              <span>{n.title}</span>
              {n.body && <span className="muted small">{n.body}</span>}
              <span className="muted small">{ago(n.createdAt)}</span>
            </span>
          </a>
        ))}
      </div>
    </Popover>
  );
}
