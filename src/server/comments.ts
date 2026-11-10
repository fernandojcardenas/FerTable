// Comments on records. Kept outside the action log: they don't go through undo
// and don't make the base snapshot bigger. They still sync live (see server.ts).

import type { Comment } from "../shared/types";
import { mentionedIds, plainComment } from "../shared/comments";
import { newId } from "../shared/ids";
import { AuthError, type User } from "./auth";
import { getDb } from "./db";
import { appUrl, oneLine, sendMailInBackground } from "./mail";

const MAX_BODY = 10_000;

type CommentRow = { id: string; row_id: string; user_id: string; name: string; body: string; created_at: string | Date; edited_at: string | Date | null };

const toComment = (r: CommentRow): Comment => ({
  id: r.id, rowId: r.row_id, userId: r.user_id, userName: r.name, body: r.body,
  createdAt: new Date(r.created_at).toISOString(), editedAt: r.edited_at ? new Date(r.edited_at).toISOString() : null,
});

const SELECT = "select c.id, c.row_id, c.user_id, u.name, c.body, c.created_at, c.edited_at from comments c join users u on u.id = c.user_id";

function cleanBody(body: unknown): string {
  const text = String(body ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) throw new AuthError(422, "A comment can't be empty");
  if (text.length > MAX_BODY) throw new AuthError(422, "That comment is too long");
  return text;
}

export async function listComments(baseId: string, rowId: string): Promise<Comment[]> {
  const db = await getDb();
  const { rows } = await db.query<CommentRow>(`${SELECT} where c.base_id = $1 and c.row_id = $2 order by c.created_at, c.id`, [baseId, rowId]);
  return rows.map(toComment);
}

export async function commentCounts(baseId: string): Promise<Record<string, number>> {
  const db = await getDb();
  const { rows } = await db.query<{ row_id: string; n: number }>("select row_id, count(*)::int as n from comments where base_id = $1 group by row_id", [baseId]);
  return Object.fromEntries(rows.map((r) => [r.row_id, r.n]));
}

export async function getComment(baseId: string, id: string): Promise<Comment> {
  const db = await getDb();
  const { rows } = await db.query<CommentRow>(`${SELECT} where c.base_id = $1 and c.id = $2`, [baseId, id]);
  if (!rows[0]) throw new AuthError(404, "Comment not found");
  return toComment(rows[0]);
}

export async function addComment(baseId: string, rowId: string, user: User, body: unknown): Promise<Comment> {
  const text = cleanBody(body);
  const db = await getDb();
  const id = newId("com");
  await db.query("insert into comments (id, base_id, row_id, user_id, body) values ($1, $2, $3, $4, $5)", [id, baseId, rowId, user.id, text]);
  return getComment(baseId, id);
}

export async function editComment(baseId: string, id: string, user: User, body: unknown): Promise<Comment> {
  const existing = await getComment(baseId, id);
  if (existing.userId !== user.id) throw new AuthError(403, "You can only edit your own comments");
  const db = await getDb();
  await db.query("update comments set body = $3, edited_at = now() where base_id = $1 and id = $2", [baseId, id, cleanBody(body)]);
  return getComment(baseId, id);
}

/** Authors can delete their own comments; owners can delete any. */
export async function deleteComment(baseId: string, id: string, user: User, isOwner: boolean): Promise<Comment> {
  const existing = await getComment(baseId, id);
  if (existing.userId !== user.id && !isOwner) throw new AuthError(403, "You can only delete your own comments");
  const db = await getDb();
  await db.query("delete from comments where base_id = $1 and id = $2", [baseId, id]);
  return existing;
}

/** Email people mentioned in a comment (only members of the base, never the author). */
export async function notifyMentions(baseId: string, baseName: string, recordName: string, comment: Comment, previousBody = "") {
  const already = new Set(mentionedIds(previousBody));
  const ids = mentionedIds(comment.body).filter((id) => id !== comment.userId && !already.has(id));
  if (!ids.length) return;
  const db = await getDb();
  const { rows } = await db.query<{ id: string; email: string; name: string }>(
    "select u.id, u.email, u.name from base_members m join users u on u.id = m.user_id where m.base_id = $1 and u.id = any($2::text[])",
    [baseId, ids],
  );
  const names = await db.query<{ id: string; name: string }>("select u.id, u.name from base_members m join users u on u.id = m.user_id where m.base_id = $1", [baseId]);
  const nameOf = (id: string) => names.rows.find((r) => r.id === id)?.name;
  const text = plainComment(comment.body, nameOf);
  const link = `${appUrl()}/base/${baseId}?record=${comment.rowId}`;
  for (const r of rows) {
    sendMailInBackground({
      to: r.email,
      subject: `${oneLine(comment.userName, 60)} mentioned you on “${oneLine(recordName, 80)}”`,
      text: `${oneLine(comment.userName, 60)} mentioned you in a comment on “${oneLine(recordName, 80)}” in ${oneLine(baseName, 80)}:\n\n${text}\n\nOpen the record:\n\n${link}\n`,
    });
  }
}
