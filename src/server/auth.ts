// Accounts, sessions and per-base roles.
//
// - Passwords are hashed with scrypt (node:crypto), never stored.
// - A session is a random token in an httpOnly cookie; only its SHA-256 is stored.
// - Every base has members with a role: owner > editor > viewer.

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { newId } from "../shared/ids";
import type { Role } from "../shared/types";
import { dataDir, getDb, type Queryable } from "./db";
import { appUrl, resetEmail, sendMail, verifyEmail } from "./mail";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export const SESSION_COOKIE = "gb_session";
const SESSION_DAYS = 30;
export const ROLE_RANK: Record<Role, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 };

export type User = { id: string; email: string; name: string; verified: boolean; admin?: boolean };

/** Set GRIDBASE_VERIFY_EMAIL=false to skip email confirmation (every account counts as confirmed). */
export const verifyEmailRequired = () => process.env.GRIDBASE_VERIFY_EMAIL !== "false";

export const USER_COLS = "u.id, u.email, u.name, (u.email_verified_at is not null) as verified, u.is_admin as admin";

/** With single sign-on set to "only", password sign-in and sign-up are off. */
export const ssoOnly = () => process.env.GRIDBASE_OIDC_ONLY === "true" && Boolean(process.env.GRIDBASE_OIDC_ISSUER);

export class AuthError extends Error {
  constructor(public status: 401 | 403 | 404 | 409 | 422 | 429, message: string) {
    super(message);
  }
}

// ---- passwords ----

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// A real hash to compare against when the email doesn't exist, so timing doesn't reveal accounts.
const dummyHash = hashPassword("not-a-real-password");

// ---- validation & rate limiting ----

export function normalizeEmail(email: unknown): string {
  const e = String(email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) throw new AuthError(422, "Enter a valid email address");
  return e;
}

function checkPassword(password: unknown): string {
  const p = String(password ?? "");
  if (p.length < 8) throw new AuthError(422, "Use at least 8 characters for your password");
  if (p.length > 200) throw new AuthError(422, "That password is too long");
  return p;
}

const attempts = new Map<string, { count: number; resetAt: number }>();

/** Allow `max` attempts per key per 15 minutes. */
export function rateLimit(key: string, max: number) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
    return;
  }
  a.count += 1;
  if (a.count > max) throw new AuthError(429, "Too many attempts. Try again in a few minutes.");
}

// ---- sessions ----

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(userId: string): Promise<string> {
  const db = await getDb();
  await db.query("update users set last_login_at = now() where id = $1", [userId]);
  const token = randomBytes(32).toString("base64url");
  await db.query("insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + ($3 || ' days')::interval)", [tokenHash(token), userId, String(SESSION_DAYS)]);
  return token;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`;
}

export function clearedCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export async function userFromCookie(cookieHeader: string | undefined): Promise<User | null> {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  const db = await getDb();
  const { rows } = await db.query<User>(
    `select ${USER_COLS} from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now() and u.disabled_at is null`,
    [tokenHash(token)],
  );
  return rows[0] ?? null;
}

// ---- sign up / in / out ----

export async function signup(emailIn: unknown, nameIn: unknown, passwordIn: unknown, ip: string): Promise<{ user: User; token: string }> {
  rateLimit(`signup:${ip}`, 20);
  if (process.env.GRIDBASE_ALLOW_SIGNUP === "false") throw new AuthError(403, "Sign-up is turned off on this server");
  if (ssoOnly()) throw new AuthError(403, "Accounts on this server are made by signing in with single sign-on");
  const email = normalizeEmail(emailIn);
  const password = checkPassword(passwordIn);
  const name = String(nameIn ?? "").trim().slice(0, 100) || email.split("@")[0];
  const db = await getDb();
  const user: User = { id: newId("usr"), email, name, verified: false };
  const hash = await hashPassword(password);
  try {
    await db.tx(async (q) => {
      // The first account is whoever set up this server; there's nobody to impersonate yet.
      const { rows: any } = await q.query<{ n: number }>("select count(*)::int as n from users");
      user.verified = !verifyEmailRequired() || any[0].n === 0;
      // The first account also runs the server (admin page, audit log).
      user.admin = any[0].n === 0;
      await q.query("insert into users (id, email, name, password_hash, email_verified_at, is_admin) values ($1, $2, $3, $4, $5, $6)",
        [user.id, email, name, hash, user.verified ? new Date().toISOString() : null, user.admin]);
      // Invitations sent to this email become memberships once the address is confirmed.
      if (user.verified) await claimInvites(q, user.id, email);
      // Bases made before accounts existed have no owner; the first person to sign up gets them.
      await q.query(
        "insert into base_members (base_id, user_id, role) select b.id, $1, 'owner' from bases b where not exists (select 1 from base_members m where m.base_id = b.id)",
        [user.id],
      );
    });
  } catch (e) {
    if (String((e as { code?: string }).code) === "23505" || /duplicate key/.test(String(e))) throw new AuthError(409, "An account with that email already exists. Sign in instead.");
    throw e;
  }
  return { user, token: await createSession(user.id) };
}

export async function login(emailIn: unknown, passwordIn: unknown, ip: string): Promise<{ user: User; token: string }> {
  rateLimit(`login-ip:${ip}`, 50);
  const email = normalizeEmail(emailIn);
  rateLimit(`login:${email}`, 10);
  const db = await getDb();
  if (ssoOnly()) throw new AuthError(403, "Sign in with single sign-on");
  const { rows } = await db.query<User & { password_hash: string; disabled: boolean }>(`select ${USER_COLS}, u.password_hash, (u.disabled_at is not null) as disabled from users u where u.email = $1`, [email]);
  const row = rows[0];
  const ok = await verifyPassword(String(passwordIn ?? ""), row?.password_hash ?? (await dummyHash));
  if (!row || !ok) throw new AuthError(401, "That email and password don't match");
  if (row.disabled) throw new AuthError(403, "This account has been turned off. Ask the server's admin.");
  attempts.delete(`login:${email}`);
  return { user: { id: row.id, email: row.email, name: row.name, verified: row.verified, admin: row.admin }, token: await createSession(row.id) };
}

export async function logout(cookieHeader: string | undefined): Promise<void> {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (!token) return;
  const db = await getDb();
  await db.query("delete from sessions where token_hash = $1", [tokenHash(token)]);
}

// ---- roles & sharing ----

export async function roleFor(userId: string, baseId: string): Promise<Role | null> {
  const db = await getDb();
  const { rows } = await db.query<{ role: Role }>("select role from access where base_id = $1 and user_id = $2", [baseId, userId]);
  return rows[0]?.role ?? null;
}

/** Throws unless the user has at least `min` on the base. Non-members get 404 so bases can't be probed. */
export async function requireRole(user: User, baseId: string, min: Role): Promise<Role> {
  const role = await roleFor(user.id, baseId);
  if (!role) throw new AuthError(404, "Base not found");
  if (ROLE_RANK[role] < ROLE_RANK[min]) {
    throw new AuthError(403,
      min === "owner" ? "Only owners can do that"
      : min === "commenter" ? "You have view-only access to this base"
      : role === "commenter" ? "You can comment on this base but not change it"
      : "You have view-only access to this base");
  }
  return role;
}

export async function addMember(baseId: string, userId: string, role: Role) {
  const db = await getDb();
  await db.query(
    "insert into base_members (base_id, user_id, role) values ($1, $2, $3) on conflict (base_id, user_id) do update set role = excluded.role",
    [baseId, userId, role],
  );
}

export function parseRole(role: unknown): Role {
  if (role === "owner" || role === "editor" || role === "commenter" || role === "viewer") return role;
  throw new AuthError(422, "Role must be owner, editor, commenter or viewer");
}

export async function listMembers(baseId: string) {
  const db = await getDb();
  const members = await db.query<{ user_id: string; email: string; name: string; role: Role }>(
    "select m.user_id, u.email, u.name, m.role from base_members m join users u on u.id = m.user_id where m.base_id = $1 order by u.name",
    [baseId],
  );
  const invites = await db.query<{ email: string; role: Role }>("select email, role from base_invites where base_id = $1 order by email", [baseId]);
  return {
    members: members.rows.map((m) => ({ userId: m.user_id, email: m.email, name: m.name, role: m.role })),
    invites: invites.rows,
  };
}

/** Share by email: existing accounts are added now; others get an invite that applies when they sign up. */
export async function share(baseId: string, emailIn: unknown, roleIn: unknown): Promise<{ added: boolean; userId?: string; email: string; role: Role; wasMember: boolean; unconfirmed?: boolean }> {
  const email = normalizeEmail(emailIn);
  const role = parseRole(roleIn);
  const db = await getDb();
  const { rows } = await db.query<{ id: string; verified: boolean }>("select id, (email_verified_at is not null) as verified from users where email = $1", [email]);
  // Someone could sign up with another person's address; access waits until they confirm it.
  if (rows[0] && !rows[0].verified && !(await roleFor(rows[0].id, baseId))) {
    await db.query(
      "insert into base_invites (base_id, email, role) values ($1, $2, $3) on conflict (base_id, email) do update set role = excluded.role",
      [baseId, email, role],
    );
    return { added: false, email, role, wasMember: false, unconfirmed: true };
  }
  if (rows[0]) {
    const current = await roleFor(rows[0].id, baseId);
    if (current === "owner" && role !== "owner") await ensureAnotherOwner(baseId, rows[0].id);
    await addMember(baseId, rows[0].id, role);
    return { added: true, userId: rows[0].id, email, role, wasMember: Boolean(current) };
  }
  await db.query(
    "insert into base_invites (base_id, email, role) values ($1, $2, $3) on conflict (base_id, email) do update set role = excluded.role",
    [baseId, email, role],
  );
  return { added: false, email, role, wasMember: false };
}

async function ensureAnotherOwner(baseId: string, userId: string) {
  const db = await getDb();
  const { rows } = await db.query<{ n: number }>(
    "select count(*)::int as n from base_members where base_id = $1 and role = 'owner' and user_id <> $2",
    [baseId, userId],
  );
  if ((rows[0]?.n ?? 0) === 0) throw new AuthError(422, "A base needs at least one owner");
}

export async function setRole(baseId: string, userId: string, roleIn: unknown) {
  const role = parseRole(roleIn);
  const current = await roleFor(userId, baseId);
  if (!current) throw new AuthError(404, "That person isn't a member of this base");
  if (current === "owner" && role !== "owner") await ensureAnotherOwner(baseId, userId);
  await addMember(baseId, userId, role);
}

export async function removeMember(baseId: string, userId: string) {
  const current = await roleFor(userId, baseId);
  if (!current) return;
  if (current === "owner") await ensureAnotherOwner(baseId, userId);
  const db = await getDb();
  await db.query("delete from base_members where base_id = $1 and user_id = $2", [baseId, userId]);
}

export async function cancelInvite(baseId: string, emailIn: unknown) {
  const db = await getDb();
  await db.query("delete from base_invites where base_id = $1 and email = $2", [baseId, normalizeEmail(emailIn)]);
}

// ---- changing & resetting passwords ----

/** Change your own password. Signs out your other devices; this one stays signed in. */
export async function changePassword(user: User, cookieHeader: string | undefined, current: unknown, next: unknown): Promise<void> {
  rateLimit(`password:${user.id}`, 10);
  const password = checkPassword(next);
  const db = await getDb();
  const { rows } = await db.query<{ password_hash: string }>("select password_hash from users where id = $1", [user.id]);
  if (!rows[0] || !(await verifyPassword(String(current ?? ""), rows[0].password_hash))) throw new AuthError(401, "Your current password isn't right");
  const keep = tokenHash(readCookie(cookieHeader, SESSION_COOKIE) ?? "");
  await db.tx(async (q) => {
    await q.query("update users set password_hash = $2 where id = $1", [user.id, await hashPassword(password)]);
    await q.query("delete from sessions where user_id = $1 and token_hash <> $2", [user.id, keep]);
  });
}

/** One-time link to set a new password, valid for an hour. Made by the server operator (there's no email yet). */
export async function createResetToken(emailIn: unknown): Promise<{ token: string; email: string }> {
  const email = normalizeEmail(emailIn);
  const db = await getDb();
  const { rows } = await db.query<{ id: string }>("select id from users where email = $1", [email]);
  if (!rows[0]) throw new AuthError(404, `No account uses ${email}`);
  const token = randomBytes(32).toString("base64url");
  await db.query("delete from password_resets where user_id = $1", [rows[0].id]);
  await db.query("insert into password_resets (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 hour')", [tokenHash(token), rows[0].id]);
  return { token, email };
}

/** Use a reset link: set the new password, sign out everywhere, and sign in here. */
export async function resetPassword(tokenIn: unknown, next: unknown, ip: string): Promise<{ user: User; token: string }> {
  rateLimit(`reset:${ip}`, 20);
  const password = checkPassword(next);
  const hash = tokenHash(String(tokenIn ?? ""));
  const db = await getDb();
  const { rows } = await db.query<User>(
    `select ${USER_COLS} from password_resets r join users u on u.id = r.user_id where r.token_hash = $1 and r.expires_at > now()`,
    [hash],
  );
  const user = rows[0];
  if (!user) throw new AuthError(422, "This reset link has expired or was already used. Ask for a new one.");
  const newHash = await hashPassword(password);
  await db.tx(async (q) => {
    await q.query("update users set password_hash = $2 where id = $1", [user.id, newHash]);
    await q.query("delete from sessions where user_id = $1", [user.id]);
    await q.query("delete from password_resets where user_id = $1", [user.id]);
    // The reset link reached this inbox, so the address is confirmed too.
    if (!user.verified) {
      await q.query("update users set email_verified_at = now() where id = $1", [user.id]);
      await claimInvites(q, user.id, user.email);
    }
  });
  return { user: { ...user, verified: true }, token: await createSession(user.id) };
}

// ---- operator access (local only) ----

/**
 * A random secret in a file next to the database, readable only by the account
 * running the server. Local scripts use it to ask the running server for things
 * like reset links, without opening the database themselves.
 */
export function adminTokenPath(): string {
  return join(dirname(dataDir()), "admin-token");
}

export function ensureAdminToken(): string {
  const path = adminTokenPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, randomBytes(32).toString("base64url"), { mode: 0o600 });
  }
  chmodSync(path, 0o600);
  return readFileSync(path, "utf8").trim();
}

export function isAdminRequest(token: string | undefined, remoteAddress: string | undefined): boolean {
  const local = remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
  if (!local || !token) return false;
  const expected = Buffer.from(ensureAdminToken());
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * "Forgot password": email a reset link if the account exists. The answer is the
 * same either way, so this can't be used to find out who has an account.
 */
export async function requestPasswordReset(emailIn: unknown, ip: string): Promise<void> {
  rateLimit(`forgot-ip:${ip}`, 10);
  const email = normalizeEmail(emailIn);
  rateLimit(`forgot:${email}`, 3);
  const db = await getDb();
  const { rows } = await db.query<{ name: string }>("select name from users where email = $1", [email]);
  if (!rows[0]) return;
  const { token } = await createResetToken(email);
  await sendMail(resetEmail(email, rows[0].name, `${appUrl()}/reset?token=${token}`));
}

// ---- email confirmation ----

/** Turn invitations for this address into memberships. */
async function claimInvites(q: Queryable, userId: string, email: string) {
  await q.query(
    "insert into base_members (base_id, user_id, role) select base_id, $1, role from base_invites where email = $2 on conflict do nothing",
    [userId, email],
  );
  await q.query("delete from base_invites where email = $1", [email]);
}

/** Email a link that confirms the account's address (valid for a day). Rate-limited per account. */
export async function sendVerification(user: User): Promise<void> {
  if (user.verified) return;
  rateLimit(`verify-send:${user.id}`, 5);
  const token = randomBytes(32).toString("base64url");
  const db = await getDb();
  await db.query("delete from email_verifications where user_id = $1", [user.id]);
  await db.query("insert into email_verifications (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 day')", [tokenHash(token), user.id]);
  await sendMail(verifyEmail(user.email, user.name, `${appUrl()}/verify?token=${token}`));
}

/** Use a confirmation link: mark the address confirmed and turn its invitations into access. */
export async function confirmEmail(tokenIn: unknown, ip: string): Promise<User> {
  rateLimit(`verify:${ip}`, 30);
  const db = await getDb();
  const { rows } = await db.query<User>(
    `select ${USER_COLS} from email_verifications v join users u on u.id = v.user_id where v.token_hash = $1 and v.expires_at > now()`,
    [tokenHash(String(tokenIn ?? ""))],
  );
  const user = rows[0];
  if (!user) throw new AuthError(422, "This link has expired or was already used. Sign in and ask for a new one.");
  await db.tx(async (q) => {
    await q.query("update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1", [user.id]);
    await q.query("delete from email_verifications where user_id = $1", [user.id]);
    await claimInvites(q, user.id, user.email);
  });
  return { ...user, verified: true };
}

// ---- single sign-on ----

/**
 * Sign in someone the identity provider vouched for. An existing account with the same
 * email is used (and counts as confirmed when the provider confirmed the email); otherwise
 * an account is made, with an unusable password.
 */
export async function loginWithSso(emailIn: string, nameIn: string, emailVerified: boolean): Promise<{ user: User; token: string; created: boolean }> {
  const email = normalizeEmail(emailIn);
  const db = await getDb();
  const { rows } = await db.query<User & { disabled: boolean }>(`select ${USER_COLS}, (u.disabled_at is not null) as disabled from users u where u.email = $1`, [email]);
  if (rows[0]) {
    if (rows[0].disabled) throw new AuthError(403, "This account has been turned off. Ask the server's admin.");
    // Only an email the provider confirmed may take over an account that was made with a password.
    if (!emailVerified) throw new AuthError(403, "Your identity provider didn't confirm this email address");
    if (!rows[0].verified) {
      await db.query("update users set email_verified_at = now() where id = $1", [rows[0].id]);
      await db.tx((q) => claimInvites(q, rows[0].id, email));
    }
    return { user: { ...rows[0], verified: true }, token: await createSession(rows[0].id), created: false };
  }
  if (process.env.GRIDBASE_ALLOW_SIGNUP === "false") throw new AuthError(403, "Sign-up is turned off on this server");
  const user: User = { id: newId("usr"), email, name: nameIn.trim().slice(0, 100) || email.split("@")[0], verified: emailVerified };
  const hash = await hashPassword(randomBytes(32).toString("base64"));
  await db.tx(async (q) => {
    const { rows: any } = await q.query<{ n: number }>("select count(*)::int as n from users");
    user.admin = any[0].n === 0;
    await q.query("insert into users (id, email, name, password_hash, email_verified_at, is_admin) values ($1, $2, $3, $4, $5, $6)",
      [user.id, email, user.name, hash, emailVerified ? new Date().toISOString() : null, user.admin]);
    if (emailVerified) await claimInvites(q, user.id, email);
  });
  return { user, token: await createSession(user.id), created: true };
}

// ---- admin ----

export async function requireAdmin(user: User) {
  if (!user.admin) throw new AuthError(404, "Not found");
}

export async function listUsers() {
  const db = await getDb();
  const { rows } = await db.query<{ id: string; email: string; name: string; verified: boolean; admin: boolean; created_at: Date | string; last_login_at: Date | string | null; disabled_at: Date | string | null; bases: number }>(
    `select ${USER_COLS}, u.created_at, u.last_login_at, u.disabled_at,
       (select count(*)::int from base_members m where m.user_id = u.id) as bases
     from users u order by u.created_at`);
  const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
  return rows.map((r) => ({ id: r.id, email: r.email, name: r.name, verified: r.verified, admin: r.admin, createdAt: iso(r.created_at), lastLoginAt: iso(r.last_login_at), disabled: Boolean(r.disabled_at), bases: r.bases }));
}

/** Make or unmake an admin, or turn an account off (which signs it out everywhere) or back on. */
export async function updateUser(actor: User, userId: string, patch: { admin?: unknown; disabled?: unknown }) {
  if (userId === actor.id && (patch.admin === false || patch.disabled === true)) throw new AuthError(422, "You can't remove your own admin access or turn off your own account");
  const db = await getDb();
  if (typeof patch.admin === "boolean") await db.query("update users set is_admin = $2 where id = $1", [userId, patch.admin]);
  if (patch.disabled === true) {
    await db.query("update users set disabled_at = now() where id = $1", [userId]);
    await db.query("delete from sessions where user_id = $1", [userId]);
    await db.query("delete from api_tokens where user_id = $1", [userId]);
  } else if (patch.disabled === false) {
    await db.query("update users set disabled_at = null where id = $1", [userId]);
  }
}
