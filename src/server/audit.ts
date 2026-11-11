// The audit log: sign-ins, sharing, access tokens, public links, snapshots and admin
// changes, with who, when and from where. Admins read it on /admin.

import { getDb } from "./db";

export type AuditEvent = { userId?: string | null; email?: string | null; ip?: string | null; action: string; baseId?: string | null; detail?: Record<string, unknown> };

export function audit(e: AuditEvent): void {
  void getDb()
    .then((db) => db.query(
      "insert into audit_log (user_id, user_email, ip, action, base_id, detail) values ($1, $2, $3, $4, $5, $6::jsonb)",
      [e.userId ?? null, e.email ?? null, e.ip ?? null, e.action, e.baseId ?? null, JSON.stringify(e.detail ?? {})],
    ))
    .catch((err) => console.error("audit log write failed", err));
}

export type AuditEntry = { id: number; at: string; userId: string | null; email: string | null; ip: string | null; action: string; baseId: string | null; detail: Record<string, unknown> };

/** Newest first. `before` pages back by id; `action` matches a prefix ("auth." for all sign-in events). */
export async function readAudit(opts: { before?: number | null; action?: string | null; user?: string | null; baseId?: string | null; limit?: number }): Promise<AuditEntry[]> {
  const db = await getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (opts.before) where.push(`id < ${p(opts.before)}`);
  if (opts.action) where.push(`action like ${p(`${opts.action}%`)}`);
  if (opts.user) where.push(`(user_email ilike ${p(`%${opts.user}%`)} or user_id = ${p(opts.user)})`);
  if (opts.baseId) where.push(`base_id = ${p(opts.baseId)}`);
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 100)), 500);
  const { rows } = await db.query<{ id: number; at: Date | string; user_id: string | null; user_email: string | null; ip: string | null; action: string; base_id: string | null; detail: Record<string, unknown> }>(
    `select * from audit_log ${where.length ? `where ${where.join(" and ")}` : ""} order by id desc limit ${limit}`, params);
  return rows.map((r) => ({ id: r.id, at: new Date(r.at).toISOString(), userId: r.user_id, email: r.user_email, ip: r.ip, action: r.action, baseId: r.base_id, detail: r.detail }));
}
