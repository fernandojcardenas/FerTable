// Saved connections for automation steps (Slack, Google Sheets, webhooks). Their URLs
// work like passwords, so they live only on the server; base data only names them.
// Posting goes through safePost, which refuses addresses inside private networks.

import { lookup } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";
import type { ConnectionInfo, ConnectionKind } from "../shared/types";
import { newId } from "../shared/ids";
import { ValidationError } from "../shared/reducer";
import { getDb } from "./db";

const KINDS: ConnectionKind[] = ["slack", "sheets", "webhook"];

/** Check a URL for its kind. Slack and Sheets URLs must be the real services; webhooks any public https address. */
export function checkConnectionUrl(kind: ConnectionKind, raw: string): URL {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new ValidationError("That isn't a valid web address"); }
  if (u.protocol !== "https:") throw new ValidationError("Connections must use https://");
  if (u.username || u.password) throw new ValidationError("Put credentials in the path, not before the host");
  if (kind === "slack" && u.hostname !== "hooks.slack.com") throw new ValidationError("A Slack connection is an incoming-webhook URL from hooks.slack.com");
  if (kind === "sheets" && !(u.hostname === "script.google.com" && /^\/macros\/s\/[\w-]+\/exec$/.test(u.pathname)))
    throw new ValidationError("A Google Sheets connection is an Apps Script web app URL (script.google.com/macros/s/…/exec)");
  if (raw.length > 2000) throw new ValidationError("That web address is too long");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || (isIP(host) && isPrivateAddress(host)))
    throw new ValidationError("Connections must be public addresses, not this computer or a private network");
  return u;
}

export async function listConnections(baseId: string): Promise<ConnectionInfo[]> {
  const db = await getDb();
  const { rows } = await db.query<{ id: string; kind: ConnectionKind; name: string; url: string }>(
    "select id, kind, name, url from automation_connections where base_id = $1 order by created_at", [baseId],
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, host: new URL(r.url).hostname }));
}

export async function addConnection(baseId: string, kindIn: unknown, nameIn: unknown, urlIn: unknown): Promise<ConnectionInfo> {
  const kind = KINDS.find((k) => k === kindIn);
  if (!kind) throw new ValidationError("Pick Slack, Google Sheets or webhook");
  const name = String(nameIn ?? "").trim().slice(0, 80) || (kind === "slack" ? "Slack" : kind === "sheets" ? "Google Sheet" : "Webhook");
  const u = checkConnectionUrl(kind, String(urlIn ?? ""));
  const db = await getDb();
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from automation_connections where base_id = $1", [baseId]);
  if (rows[0].n >= 50) throw new ValidationError("A base can have up to 50 connections");
  const id = newId("cnx");
  await db.query("insert into automation_connections (id, base_id, kind, name, url) values ($1, $2, $3, $4, $5)", [id, baseId, kind, name, u.toString()]);
  return { id, kind, name, host: u.hostname };
}

export async function removeConnection(baseId: string, id: string): Promise<void> {
  const db = await getDb();
  await db.query("delete from automation_connections where base_id = $1 and id = $2", [baseId, id]);
}

export async function connectionUrl(baseId: string, id: string): Promise<{ kind: ConnectionKind; url: string } | null> {
  const db = await getDb();
  const { rows } = await db.query<{ kind: ConnectionKind; url: string }>("select kind, url from automation_connections where base_id = $1 and id = $2", [baseId, id]);
  return rows[0] ?? null;
}

/**
 * DNS lookup for outgoing requests that refuses private addresses. Node may ask for
 * one address or (with happy eyeballs) all of them; every answer is checked.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function safeLookup(hostname: string, options: any, cb: any) {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = addresses as unknown as { address: string; family: number }[];
    if (!list.length) return cb(new Error("That address couldn't be found"));
    if (list.some((a) => isPrivateAddress(a.address))) return cb(new Error("That address is inside a private network"));
    if (options?.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

/** Loopback, private, link-local, carrier-grade NAT, multicast and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x);
  }
  return true;
}

/**
 * POST JSON to a public https address. The address is checked when the connection is
 * actually made (so a DNS change can't point it inside the network), redirects aren't
 * followed, and slow or huge answers are cut off.
 */
export function safePost(url: string, body: unknown, timeoutMs = 10_000, extraHeaders: Record<string, string> = {}): Promise<{ status: number }> {
  const u = new URL(url);
  if (u.protocol !== "https:") return Promise.reject(new Error("Only https addresses can be called"));
  // Node never calls `lookup` for a literal IP, so check those here.
  const literal = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal) && isPrivateAddress(literal)) return Promise.reject(new Error("That address is inside a private network"));
  const data = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  if (data.length > 200_000) return Promise.reject(new Error("The message is too large"));
  return new Promise((resolve, reject) => {
    const req = request(u, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": data.length, "user-agent": "gridbase-automation", ...extraHeaders },
      timeout: timeoutMs,
      lookup: safeLookup,
    }, (res) => {
      let size = 0;
      res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 100_000) res.destroy(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      res.on("error", () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on("timeout", () => req.destroy(new Error("The service didn't answer in time")));
    req.on("error", reject);
    req.end(data);
  });
}

/**
 * GET a public https address and return the text (used by CSV / Google Sheets syncs).
 * Same address checks as safePost; a few redirects are followed, each one checked again.
 */
export async function safeGet(url: string, maxBytes = 5_000_000, timeoutMs = 20_000, redirects = 3): Promise<{ status: number; text: string; type: string }> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("Only https addresses can be read");
  const literal = u.hostname.replace(/^\[|\]$/g, "");
  if (u.hostname === "localhost" || (isIP(literal) && isPrivateAddress(literal))) throw new Error("That address is inside a private network");
  const res = await new Promise<{ status: number; text: string; type: string; location?: string }>((resolve, reject) => {
    const req = request(u, {
      method: "GET",
      headers: { "user-agent": "gridbase-sync", accept: "text/csv, text/plain, */*" },
      timeout: timeoutMs,
      lookup: safeLookup,
    }, (r) => {
      const chunks: Buffer[] = [];
      let size = 0;
      r.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { r.destroy(); reject(new Error(`The file is larger than ${Math.round(maxBytes / 1e6)} MB`)); return; }
        chunks.push(chunk);
      });
      r.on("end", () => resolve({ status: r.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), type: String(r.headers["content-type"] ?? ""), location: r.headers.location }));
      r.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("The address didn't answer in time")));
    req.on("error", reject);
    req.end();
  });
  if (res.status >= 300 && res.status < 400 && res.location) {
    if (redirects <= 0) throw new Error("Too many redirects");
    return safeGet(new URL(res.location, u).toString(), maxBytes, timeoutMs, redirects - 1);
  }
  return { status: res.status, text: res.text, type: res.type };
}
