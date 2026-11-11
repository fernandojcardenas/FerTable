// The notifications bell: mentions, records assigned to you, and bases or workspaces
// shared with you. Open windows are told to refresh the bell straight away.

import { newId } from "../shared/ids";
import { getDb } from "./db";

export type Notification = { id: string; kind: string; title: string; body: string; link: string | null; baseId: string | null; createdAt: string; read: boolean };

type Push = (userId: string) => void;
let push: Push = () => {};
/** Set by the engine so new notifications reach open windows. */
export function onNotify(fn: Push) { push = fn; }

export async function notify(userId: string, n: { baseId?: string | null; kind: string; title: string; body?: string; link?: string | null }) {
  const db = await getDb();
  await db.query(
    "insert into notifications (id, user_id, base_id, kind, title, body, link) values ($1, $2, $3, $4, $5, $6, $7)",
    [newId("ntf"), userId, n.baseId ?? null, n.kind, n.title.slice(0, 300), (n.body ?? "").slice(0, 1000), n.link ?? null],
  );
  // Keep the newest 200 per person.
  await db.query(
    "delete from notifications where user_id = $1 and id not in (select id from notifications where user_id = $1 order by created_at desc limit 200)", [userId]);
  push(userId);
}

export async function listNotifications(userId: string): Promise<{ notifications: Notification[]; unread: number }> {
  const db = await getDb();
  const { rows } = await db.query<{ id: string; kind: string; title: string; body: string; link: string | null; base_id: string | null; created_at: Date | string; read_at: Date | string | null }>(
    // Only for bases the person can still open.
    `select n.* from notifications n
     where n.user_id = $1 and (n.base_id is null or exists (select 1 from access a where a.base_id = n.base_id and a.user_id = $1))
     order by n.created_at desc limit 50`, [userId]);
  const unread = await db.query<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and read_at is null", [userId]);
  return {
    unread: unread.rows[0]?.n ?? 0,
    notifications: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, baseId: r.base_id, createdAt: new Date(r.created_at).toISOString(), read: Boolean(r.read_at) })),
  };
}

export async function markRead(userId: string, ids: unknown) {
  const db = await getDb();
  if (Array.isArray(ids)) await db.query("update notifications set read_at = now() where user_id = $1 and id = any($2::text[]) and read_at is null", [userId, ids.filter((x) => typeof x === "string")]);
  else await db.query("update notifications set read_at = now() where user_id = $1 and read_at is null", [userId]);
}
