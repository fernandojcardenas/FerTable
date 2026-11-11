// Workspaces: folders of bases shared with a team. A workspace member gets their
// workspace role on every base in it (or their own base role, if that's higher).

import type { Role } from "../shared/types";
import { newId } from "../shared/ids";
import { getDb } from "./db";
import { AuthError, normalizeEmail, parseRole, ROLE_RANK } from "./auth";

export type WorkspaceInfo = { id: string; name: string; role: Role; members: number; bases: number };

export async function listWorkspaces(userId: string): Promise<WorkspaceInfo[]> {
  const db = await getDb();
  const { rows } = await db.query<WorkspaceInfo>(
    `select w.id, w.name, m.role,
       (select count(*)::int from workspace_members x where x.workspace_id = w.id) as members,
       (select count(*)::int from bases b where b.workspace_id = w.id) as bases
     from workspaces w join workspace_members m on m.workspace_id = w.id
     where m.user_id = $1 order by w.created_at`, [userId]);
  return rows;
}

export async function workspaceRole(userId: string, workspaceId: string): Promise<Role | null> {
  const db = await getDb();
  const { rows } = await db.query<{ role: Role }>("select role from workspace_members where workspace_id = $1 and user_id = $2", [workspaceId, userId]);
  return rows[0]?.role ?? null;
}

export async function requireWorkspaceRole(userId: string, workspaceId: string, min: Role): Promise<Role> {
  const role = await workspaceRole(userId, workspaceId);
  if (!role) throw new AuthError(404, "Workspace not found");
  if (ROLE_RANK[role] < ROLE_RANK[min]) throw new AuthError(403, min === "owner" ? "Only workspace owners can do that" : "You can't change this workspace");
  return role;
}

export async function createWorkspace(userId: string, nameIn: unknown): Promise<string> {
  const name = String(nameIn ?? "").trim().slice(0, 100) || "My workspace";
  const db = await getDb();
  const id = newId("wsp");
  await db.tx(async (q) => {
    await q.query("insert into workspaces (id, name, created_by) values ($1, $2, $3)", [id, name, userId]);
    await q.query("insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [id, userId]);
  });
  return id;
}

export async function renameWorkspace(id: string, nameIn: unknown) {
  const name = String(nameIn ?? "").trim().slice(0, 100);
  if (!name) throw new AuthError(422, "A workspace needs a name");
  const db = await getDb();
  await db.query("update workspaces set name = $2 where id = $1", [id, name]);
}

/** Deleting a workspace keeps its bases; they just stop being in a workspace. */
export async function deleteWorkspace(id: string) {
  const db = await getDb();
  await db.query("delete from workspaces where id = $1", [id]);
}

export async function listWorkspaceMembers(id: string) {
  const db = await getDb();
  const { rows } = await db.query<{ userId: string; name: string; email: string; role: Role }>(
    `select m.user_id as "userId", u.name, u.email, m.role from workspace_members m join users u on u.id = m.user_id
     where m.workspace_id = $1 order by u.name`, [id]);
  return rows;
}

async function ensureAnotherOwner(id: string, userId: string) {
  const db = await getDb();
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from workspace_members where workspace_id = $1 and role = 'owner' and user_id <> $2", [id, userId]);
  if ((rows[0]?.n ?? 0) === 0) throw new AuthError(422, "A workspace needs at least one owner");
}

/** Add someone who already has a confirmed account. */
export async function shareWorkspace(id: string, emailIn: unknown, roleIn: unknown): Promise<{ userId: string; name: string; email: string; role: Role }> {
  const email = normalizeEmail(emailIn);
  const role = parseRole(roleIn);
  const db = await getDb();
  const { rows } = await db.query<{ id: string; name: string; verified: boolean }>("select id, name, (email_verified_at is not null) as verified from users where email = $1", [email]);
  if (!rows[0]) throw new AuthError(422, "There's no account with that email yet. Ask them to sign up first, then add them.");
  if (!rows[0].verified) throw new AuthError(422, "That person hasn't confirmed their email address yet.");
  const current = await workspaceRole(rows[0].id, id);
  if (current === "owner" && role !== "owner") await ensureAnotherOwner(id, rows[0].id);
  await db.query(
    "insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3) on conflict (workspace_id, user_id) do update set role = excluded.role",
    [id, rows[0].id, role]);
  return { userId: rows[0].id, name: rows[0].name, email, role };
}

export async function setWorkspaceRole(id: string, userId: string, roleIn: unknown) {
  const role = parseRole(roleIn);
  const current = await workspaceRole(userId, id);
  if (!current) throw new AuthError(404, "That person isn't in this workspace");
  if (current === "owner" && role !== "owner") await ensureAnotherOwner(id, userId);
  const db = await getDb();
  await db.query("update workspace_members set role = $3 where workspace_id = $1 and user_id = $2", [id, userId, role]);
}

export async function removeWorkspaceMember(id: string, userId: string) {
  const current = await workspaceRole(userId, id);
  if (!current) return;
  if (current === "owner") await ensureAnotherOwner(id, userId);
  const db = await getDb();
  await db.query("delete from workspace_members where workspace_id = $1 and user_id = $2", [id, userId]);
}

/** Bases in a workspace (for telling open windows about access changes). */
export async function workspaceBaseIds(id: string): Promise<string[]> {
  const db = await getDb();
  const { rows } = await db.query<{ id: string }>("select id from bases where workspace_id = $1", [id]);
  return rows.map((r) => r.id);
}

/** Move a base into a workspace (or out, with null). Needs base owner, and editor in the workspace. */
export async function moveBase(userId: string, baseId: string, workspaceId: string | null) {
  const db = await getDb();
  const own = await db.query<{ role: Role }>("select role from access where base_id = $1 and user_id = $2", [baseId, userId]);
  if (own.rows[0]?.role !== "owner") throw new AuthError(403, "Only base owners can move a base");
  if (workspaceId) await requireWorkspaceRole(userId, workspaceId, "editor");
  await db.query("update bases set workspace_id = $2 where id = $1", [baseId, workspaceId]);
  // The mover keeps owning the base even after it leaves a workspace that gave them access.
  await db.query("insert into base_members (base_id, user_id, role) values ($1, $2, 'owner') on conflict (base_id, user_id) do update set role = 'owner'", [baseId, userId]);
}
