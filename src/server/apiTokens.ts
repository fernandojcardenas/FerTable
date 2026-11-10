// Personal access tokens for the public API (/v1). Only a hash is stored; the token is
// shown once when it's made. A token can be read-only and limited to some bases.

import { createHash, randomBytes } from "node:crypto";
import { newId } from "../shared/ids";
import { ValidationError } from "../shared/reducer";
import type { Role } from "../shared/types";
import { AuthError, roleFor, USER_COLS, type User } from "./auth";
import { getDb } from "./db";

export type TokenInfo = { id: string; name: string; hint: string; baseIds: string[] | null; canWrite: boolean; createdAt: string; lastUsedAt: string | null };
export type ApiAuth = { user: User; token: { id: string; baseIds: string[] | null; canWrite: boolean } };

const MAX_TOKENS = 20;
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export async function listTokens(userId: string): Promise<TokenInfo[]> {
  const db = await getDb();
  const { rows } = await db.query<{ id: string; name: string; hint: string; base_ids: string[] | null; can_write: boolean; created_at: string; last_used_at: string | null }>(
    "select id, name, hint, base_ids, can_write, created_at, last_used_at from api_tokens where user_id = $1 order by created_at", [userId]);
  return rows.map((r) => ({ id: r.id, name: r.name, hint: r.hint, baseIds: r.base_ids, canWrite: r.can_write, createdAt: new Date(r.created_at).toISOString(), lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null }));
}

/** Make a token. `baseIds` null = every base you can open. Returns the secret once. */
export async function createToken(userId: string, nameIn: unknown, baseIdsIn: unknown, canWriteIn: unknown): Promise<{ token: string; info: TokenInfo }> {
  const name = typeof nameIn === "string" ? nameIn.trim().slice(0, 100) : "";
  if (!name) throw new ValidationError("Give the token a name");
  let baseIds: string[] | null = null;
  if (baseIdsIn !== null && baseIdsIn !== undefined) {
    if (!Array.isArray(baseIdsIn) || baseIdsIn.length === 0 || baseIdsIn.length > 100 || !baseIdsIn.every((b) => typeof b === "string")) throw new ValidationError("Pick the bases this token can use");
    for (const b of baseIdsIn) if (!(await roleFor(userId, b))) throw new ValidationError("You can only give a token bases you can open");
    baseIds = [...new Set(baseIdsIn as string[])];
  }
  const db = await getDb();
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from api_tokens where user_id = $1", [userId]);
  if (rows[0].n >= MAX_TOKENS) throw new ValidationError(`You can have at most ${MAX_TOKENS} tokens`);
  const id = newId("pat");
  const token = `${id}.${randomBytes(32).toString("base64url")}`;
  const hint = `${id.slice(0, 8)}…`;
  await db.query("insert into api_tokens (id, user_id, name, token_hash, hint, base_ids, can_write) values ($1, $2, $3, $4, $5, $6::jsonb, $7)",
    [id, userId, name, hash(token), hint, baseIds ? JSON.stringify(baseIds) : null, canWriteIn === true]);
  return { token, info: { id, name, hint, baseIds, canWrite: canWriteIn === true, createdAt: new Date().toISOString(), lastUsedAt: null } };
}

export async function revokeToken(userId: string, id: string): Promise<void> {
  const db = await getDb();
  await db.query("delete from api_tokens where user_id = $1 and id = $2", [userId, id]);
}

/** The user and token behind an `Authorization: Bearer …` header. */
export async function authFromHeader(header: string | undefined): Promise<ApiAuth> {
  const m = /^Bearer\s+(pat[A-Za-z0-9]{14}\.[A-Za-z0-9_-]{20,100})$/.exec(header ?? "");
  if (!m) throw new AuthError(401, "Authentication required: send Authorization: Bearer <personal access token>");
  const db = await getDb();
  const { rows } = await db.query<User & { tid: string; base_ids: string[] | null; can_write: boolean }>(
    `select ${USER_COLS}, t.id as tid, t.base_ids, t.can_write from api_tokens t join users u on u.id = t.user_id where t.token_hash = $1`, [hash(m[1])]);
  const r = rows[0];
  if (!r) throw new AuthError(401, "Invalid personal access token");
  void db.query("update api_tokens set last_used_at = now() where id = $1", [r.tid]).catch(() => {});
  return { user: { id: r.id, email: r.email, name: r.name, verified: r.verified }, token: { id: r.tid, baseIds: r.base_ids, canWrite: r.can_write } };
}

const RANK: Record<Role, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 };

/** The token may touch this base, at this level (writes need a write token and editor access). */
export async function apiRole(auth: ApiAuth, baseId: string, write: boolean): Promise<Role> {
  if (auth.token.baseIds && !auth.token.baseIds.includes(baseId)) throw new AuthError(404, "Base not found (or this token can't use it)");
  const role = await roleFor(auth.user.id, baseId);
  if (!role) throw new AuthError(404, "Base not found (or this token can't use it)");
  if (write && !auth.token.canWrite) throw new AuthError(403, "This token is read-only");
  if (write && RANK[role] < RANK.editor) throw new AuthError(403, "You need editor access to change this base");
  return role;
}

/** At most 10 requests a second per token (like Airtable's 5/s per base, a bit looser). */
const buckets = new Map<string, { at: number; n: number }>();
export function apiRateLimit(tokenId: string) {
  const sec = Math.floor(Date.now() / 1000);
  const b = buckets.get(tokenId);
  if (!b || b.at !== sec) { buckets.set(tokenId, { at: sec, n: 1 }); return; }
  if (++b.n > Number(process.env.GRIDBASE_API_PER_SECOND ?? 10)) throw new AuthError(429, "Rate limit reached: wait a second and try again");
}
