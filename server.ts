// gridbase server: Next.js pages + JSON API + WebSocket live sync on one port.
// Every API call, file download and socket needs a signed-in user with a role on the base.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import next from "next";
import { WebSocketServer, type WebSocket } from "ws";
import { getEngine, ValidationError } from "./src/server/engine";
import {
  AuthError, cancelInvite, changePassword, clearedCookie, createResetToken, ensureAdminToken, isAdminRequest, listMembers,
  confirmEmail, login, logout, rateLimit, removeMember, sendVerification, requestPasswordReset, requireRole, resetPassword, roleFor, sessionCookie, setRole, share, signup, userFromCookie, type User,
} from "./src/server/auth";
import { getDb } from "./src/server/db";
import { publicFormDefinition } from "./src/shared/publicForm";
import { appUrl, inviteEmail, mailMode, sendMailInBackground, sharedEmail } from "./src/server/mail";
import { addComment, commentCounts, deleteComment, editComment, getComment, listComments, notifyMentions } from "./src/server/comments";
import { Computer } from "./src/shared/compute";
import type { Action } from "./src/shared/types";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3210);
const hostname = process.env.HOST ?? "localhost";
// Send cookies only over HTTPS in production (set GRIDBASE_SECURE_COOKIES=false to test production over plain HTTP).
const secureCookies = !dev && process.env.GRIDBASE_SECURE_COOKIES !== "false";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
const engine = getEngine();

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new ValidationError(limit >= 25 * 1024 * 1024 ? "Files can be at most 25 MB" : "Request is too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = (await readBody(req, 20_000_000)).toString("utf8");
  try {
    const v = text ? JSON.parse(text) : {};
    return v && typeof v === "object" ? v : {};
  } catch {
    throw new ValidationError("Body must be JSON");
  }
}

const clientIp = (req: IncomingMessage) => req.socket.remoteAddress ?? "unknown";

/** Changes must come from this site's own pages (blocks cross-site requests that carry the cookie). */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function requireUser(req: IncomingMessage): Promise<User> {
  const user = await userFromCookie(req.headers.cookie);
  if (!user) throw new AuthError(401, "Please sign in");
  return user;
}

async function handleAuth(req: IncomingMessage, res: ServerResponse, action: string, method: string) {
  if (action === "me" && method === "GET") {
    const user = await userFromCookie(req.headers.cookie);
    return user ? send(res, 200, { user }) : send(res, 401, { error: "Not signed in" });
  }
  if (method !== "POST") return send(res, 404, { error: "Not found" });
  if (action === "logout") {
    await logout(req.headers.cookie);
    return send(res, 200, { ok: true }, { "set-cookie": clearedCookie(secureCookies) });
  }
  const body = await readJson(req);
  if (action === "signup") {
    const { user, token } = await signup(body.email, body.name, body.password, clientIp(req));
    if (!user.verified) sendVerification(user).catch((e) => console.error("verification email failed:", e instanceof Error ? e.message : e));
    return send(res, 201, { user, delivery: mailMode() }, { "set-cookie": sessionCookie(token, secureCookies) });
  }
  if (action === "verify") {
    const user = await confirmEmail(body.token, clientIp(req));
    return send(res, 200, { user });
  }
  if (action === "resend-verification") {
    const user = await requireUser(req);
    if (user.verified) return send(res, 200, { ok: true, already: true });
    await sendVerification(user);
    return send(res, 200, { ok: true, delivery: mailMode() });
  }
  if (action === "login") {
    const { user, token } = await login(body.email, body.password, clientIp(req));
    return send(res, 200, { user }, { "set-cookie": sessionCookie(token, secureCookies) });
  }
  if (action === "password") {
    const user = await requireUser(req);
    await changePassword(user, req.headers.cookie, body.current, body.password);
    return send(res, 200, { ok: true });
  }
  if (action === "forgot") {
    try {
      await requestPasswordReset(body.email, clientIp(req));
    } catch (e) {
      // Bad emails and rate limits are reported; anything else (like SMTP trouble) is logged, not revealed.
      if (e instanceof AuthError && (e.status === 422 || e.status === 429)) throw e;
      console.error("password reset email failed:", e instanceof Error ? e.message : e);
    }
    return send(res, 200, { ok: true, delivery: mailMode() });
  }
  if (action === "reset") {
    const { user, token } = await resetPassword(body.token, body.password, clientIp(req));
    return send(res, 200, { user }, { "set-cookie": sessionCookie(token, secureCookies) });
  }
  return send(res, 404, { error: "Not found" });
}

/** Operator-only endpoints for local scripts (see scripts/). Need the admin token and a local connection. */
async function handleAdmin(req: IncomingMessage, res: ServerResponse, action: string) {
  if (!isAdminRequest(String(req.headers["x-admin-token"] ?? ""), req.socket.remoteAddress)) return send(res, 404, { error: "Not found" });
  const body = await readJson(req);
  if (action === "reset-link") {
    const { token, email } = await createResetToken(body.email);
    return send(res, 200, { email, url: `${appUrl()}/reset?token=${token}`, expiresInMinutes: 60 });
  }
  if (action === "cleanup-files") {
    const graceHours = typeof body.graceHours === "number" ? body.graceHours : undefined;
    return send(res, 200, { deleted: await engine.cleanupFiles(graceHours) });
  }
  return send(res, 404, { error: "Not found" });
}

/**
 * Public form links: anyone with the link can read the questions and send answers,
 * no account needed. Limits keep one visitor (or a script) from flooding a base.
 */
async function handlePublicForm(req: IncomingMessage, res: ServerResponse, token: string, method: string) {
  const found = await engine.findPublicForm(token);
  if (!found) return send(res, 404, { error: "This form isn't available. The link may have been turned off." });
  if (method === "GET") return send(res, 200, publicFormDefinition(found.state, found.view));
  if (method !== "POST") return send(res, 404, { error: "Not found" });
  rateLimit(`form:${token}:${clientIp(req)}`, PUBLIC_FORM_PER_VISITOR);
  rateLimit(`form:${token}`, PUBLIC_FORM_PER_FORM);
  let body: Record<string, unknown>;
  try {
    const text = (await readBody(req, 200_000)).toString("utf8");
    body = JSON.parse(text || "{}");
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError("Body must be JSON");
  }
  // A field people can't see; simple bots fill it in. Pretend it worked and save nothing.
  if (typeof body.website === "string" && body.website.trim() !== "") return send(res, 200, { ok: true });
  await engine.submitPublicForm(token, body.answers);
  return send(res, 200, { ok: true });
}

/** Responses per visitor and per form, each per 15 minutes. */
const PUBLIC_FORM_PER_VISITOR = Number(process.env.GRIDBASE_FORM_LIMIT_PER_VISITOR ?? 10);
const PUBLIC_FORM_PER_FORM = Number(process.env.GRIDBASE_FORM_LIMIT_PER_FORM ?? 300);

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "bases", id?, sub?, item?]
  const method = req.method ?? "GET";
  try {
    if (method !== "GET" && !sameOrigin(req)) throw new AuthError(403, "Cross-site request blocked");
    if (parts[1] === "auth") return await handleAuth(req, res, parts[2] ?? "", method);
    if (parts[1] === "admin" && method === "POST") return await handleAdmin(req, res, parts[2] ?? "");
    if (parts[1] === "forms" && parts[2]) return await handlePublicForm(req, res, parts[2], method);

    const user = await requireUser(req);
    if (parts[1] === "files" && method === "GET" && parts[2]) return await serveFile(res, parts[2], user);
    if (parts[1] !== "bases") return send(res, 404, { error: "Not found" });
    const baseId = parts[2];
    const sub = parts[3];
    const item = parts[4] ? decodeURIComponent(parts[4]) : undefined;

    if (!baseId && method === "GET") return send(res, 200, { bases: await engine.listBases(user.id) });
    if (!baseId && method === "POST") {
      const body = await readJson(req);
      return send(res, 201, { id: await engine.createBase(String(body.name ?? ""), user.id) });
    }
    if (!baseId) return send(res, 404, { error: "Not found" });

    if (!sub && method === "DELETE") {
      await requireRole(user, baseId, "owner");
      await engine.deleteBase(baseId);
      return send(res, 200, { ok: true });
    }
    if (sub === "me" && method === "GET") {
      return send(res, 200, { user, role: await requireRole(user, baseId, "viewer") });
    }
    if (sub === "snapshot" && method === "GET") {
      await requireRole(user, baseId, "viewer");
      const state = await engine.getState(baseId);
      return state ? send(res, 200, state) : send(res, 404, { error: "Base not found" });
    }
    if (sub === "actions" && method === "POST") {
      await requireRole(user, baseId, "editor");
      const body = await readJson(req);
      const batch = await engine.apply(baseId, {
        clientId: typeof body.clientId === "string" ? body.clientId : null,
        requestId: typeof body.requestId === "string" ? body.requestId : null,
        actions: Array.isArray(body.actions) ? (body.actions as Action[]) : [],
        userId: user.id,
      });
      return send(res, 200, { txn: batch.txn });
    }
    if (sub === "files" && method === "POST") {
      await requireRole(user, baseId, "editor");
      const data = await readBody(req, 25 * 1024 * 1024);
      if (data.length === 0) throw new ValidationError("The file is empty");
      const att = await engine.saveFile(baseId, url.searchParams.get("name") ?? "file", String(req.headers["content-type"] ?? ""), data);
      return send(res, 201, att);
    }
    // ---- comments ----
    if (sub === "comment-counts" && method === "GET") {
      await requireRole(user, baseId, "viewer");
      return send(res, 200, { counts: await commentCounts(baseId) });
    }
    if (sub === "rows" && item && parts[5] === "comments") {
      const state = await engine.getState(baseId);
      if (method === "GET") {
        await requireRole(user, baseId, "viewer");
        return send(res, 200, { comments: await listComments(baseId, item) });
      }
      if (method === "POST") {
        await requireRole(user, baseId, "commenter");
        const row = state?.rows[item];
        if (!row) throw new AuthError(404, "That record doesn't exist");
        const comment = await addComment(baseId, item, user, (await readJson(req)).body);
        engine.publish(baseId, { type: "comment", event: "created", comment });
        void notifyMentions(baseId, state!.base.name, new Computer(state!).primaryName(row.id), comment).catch((e) => console.error("mention email failed", e));
        return send(res, 201, { comment });
      }
    }
    if (sub === "rows" && item && parts[5] === "history" && method === "GET") {
      await requireRole(user, baseId, "viewer");
      const before = url.searchParams.get("before");
      return send(res, 200, await engine.rowHistory(baseId, item, before ? Number(before) : null, Number(url.searchParams.get("limit") ?? 50)));
    }
    if (sub === "comments" && item && (method === "PATCH" || method === "DELETE")) {
      const role = await requireRole(user, baseId, "commenter");
      if (method === "PATCH") {
        const state = await engine.getState(baseId);
        const previous = await getComment(baseId, item);
        const comment = await editComment(baseId, item, user, (await readJson(req)).body);
        engine.publish(baseId, { type: "comment", event: "updated", comment });
        // Only people newly mentioned by the edit get an email.
        const row = state?.rows[comment.rowId];
        if (state && row) void notifyMentions(baseId, state.base.name, new Computer(state).primaryName(row.id), comment, previous.body).catch(() => {});
        return send(res, 200, { comment });
      }
      const comment = await deleteComment(baseId, item, user, role === "owner");
      engine.publish(baseId, { type: "comment", event: "deleted", comment });
      return send(res, 200, { ok: true });
    }
    if (sub === "deleted" && method === "GET") {
      await requireRole(user, baseId, "viewer");
      return send(res, 200, { records: await engine.deletedRows(baseId, url.searchParams.get("tableId") ?? "") });
    }
    if (sub === "automation-runs" && method === "GET") {
      await requireRole(user, baseId, "viewer");
      return send(res, 200, { runs: await engine.automationRuns(baseId) });
    }
    // POST /api/bases/:id/automations/:automationId/run {rowId} — run it once now, for real.
    if (sub === "automations" && item && parts[5] === "run" && method === "POST") {
      await requireRole(user, baseId, "editor");
      const body = await readJson(req);
      if (typeof body.rowId !== "string") throw new ValidationError("Pick a record");
      return send(res, 200, await engine.runNow(baseId, item, body.rowId));
    }
    if (sub === "members") {
      if (method === "GET") {
        const myRole = await requireRole(user, baseId, "viewer");
        return send(res, 200, { ...(await listMembers(baseId)), myRole, me: user.id });
      }
      // Anyone may leave a base; everything else is for owners.
      if (method === "DELETE" && item === user.id) {
        await requireRole(user, baseId, "viewer");
        await removeMember(baseId, user.id);
        engine.notifyAccess(baseId, user.id, null);
        return send(res, 200, { ok: true });
      }
      await requireRole(user, baseId, "owner");
      if (method === "POST" && !item) {
        const body = await readJson(req);
        const result = await share(baseId, body.email, body.role);
        if (result.userId) engine.notifyAccess(baseId, result.userId, await roleFor(result.userId, baseId));
        // Let them know by email (in the background; sharing doesn't wait for it).
        const baseName = (await engine.getState(baseId))?.base.name ?? "a base";
        if (result.added && !result.wasMember) {
          sendMailInBackground(sharedEmail(result.email, user.name, baseName, result.role, `${appUrl()}/base/${baseId}`));
        } else if (!result.added) {
          const link = `${appUrl()}/login?mode=signup&email=${encodeURIComponent(result.email)}&next=${encodeURIComponent(`/base/${baseId}`)}`;
          sendMailInBackground(inviteEmail(result.email, user.name, baseName, result.role, link));
        }
        return send(res, 200, { added: result.added, emailed: !result.wasMember, unconfirmed: Boolean(result.unconfirmed), delivery: mailMode() });
      }
      if (method === "PATCH" && item) {
        const body = await readJson(req);
        await setRole(baseId, item, body.role);
        engine.notifyAccess(baseId, item, await roleFor(item, baseId));
        return send(res, 200, { ok: true });
      }
      if (method === "DELETE" && item) {
        await removeMember(baseId, item);
        engine.notifyAccess(baseId, item, null);
        return send(res, 200, { ok: true });
      }
    }
    if (sub === "invites" && method === "DELETE" && item) {
      await requireRole(user, baseId, "owner");
      await cancelInvite(baseId, item);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "Not found" });
  } catch (e) {
    if (e instanceof AuthError) return send(res, e.status, { error: e.message });
    if (e instanceof ValidationError) return send(res, 422, { error: e.message });
    console.error(e);
    return send(res, 500, { error: "Something went wrong on the server" });
  }
}

// Only these open in the browser; anything else (HTML, SVG, scripts…) downloads,
// so an uploaded file can never run code on this site.
const INLINE_TYPES = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|application\/pdf|text\/plain)$/;

async function serveFile(res: ServerResponse, id: string, user: User) {
  const file = await engine.getFile(id);
  if (!file || !(await roleFor(user.id, file.baseId))) return send(res, 404, { error: "File not found" });
  const inline = INLINE_TYPES.test(file.type);
  res.writeHead(200, {
    "content-type": inline ? file.type : "application/octet-stream",
    "content-length": file.data.length,
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    "cache-control": "private, max-age=31536000, immutable",
  });
  res.end(file.data);
}

function handleSocket(ws: WebSocket, url: URL, user: User) {
  const baseId = url.searchParams.get("baseId") ?? "";
  const since = Number(url.searchParams.get("since") ?? "0");
  let unsubscribe: (() => void) | null = null;
  let closed = false;

  engine
    .subscribe(baseId, Number.isFinite(since) ? since : -1, (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      if (msg.type === "access" && msg.role === null) ws.close(4003, "access removed");
    }, user.id)
    .then((unsub) => {
      if (closed) unsub();
      else unsubscribe = unsub;
    })
    .catch((e) => {
      console.error("subscribe failed", e);
      ws.close(1011, "subscribe failed");
    });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(String(data));
      if (msg?.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    } catch {
      /* ignore bad frames */
    }
  });
  ws.on("close", () => {
    closed = true;
    unsubscribe?.();
  });
}

/** Pages anyone may load without signing in. */
function isPublicPath(path: string): boolean {
  return path === "/login" || path === "/reset" || path === "/verify" || path.startsWith("/f/") || path.startsWith("/_next/") || path.startsWith("/__nextjs") || path === "/favicon.ico";
}

await app.prepare();
await getDb(); // run migrations before taking traffic
ensureAdminToken();

// Remove uploaded files nothing uses anymore: shortly after start, then every 6 hours.
const cleanup = () => engine.cleanupFiles().then((n) => n && console.log(`Removed ${n} unused file(s)`)).catch((e) => console.error("file cleanup failed", e));
setTimeout(cleanup, 60_000).unref();
setInterval(cleanup, 6 * 60 * 60_000).unref();

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    void handleApi(req, res, url);
    return;
  }
  void (async () => {
    if (!isPublicPath(url.pathname) || url.pathname === "/login") {
      const user = await userFromCookie(req.headers.cookie).catch(() => null);
      if (!user && url.pathname !== "/login") {
        res.writeHead(302, { location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` });
        return res.end();
      }
      if (user && url.pathname === "/login") {
        res.writeHead(302, { location: "/" });
        return res.end();
      }
    }
    await handle(req, res);
  })();
});

const wss = new WebSocketServer({ noServer: true });
const nextUpgrade = (app as unknown as { getUpgradeHandler?: () => (req: IncomingMessage, socket: unknown, head: Buffer) => void }).getUpgradeHandler?.();

function reject(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/realtime") {
    if (nextUpgrade) nextUpgrade(req, socket, head); // Next.js dev hot reload
    else socket.destroy();
    return;
  }
  void (async () => {
    if (!sameOrigin(req)) return reject(socket, 403, "Forbidden");
    const user = await userFromCookie(req.headers.cookie).catch(() => null);
    if (!user) return reject(socket, 401, "Unauthorized");
    const role = await roleFor(user.id, url.searchParams.get("baseId") ?? "");
    if (!role) return reject(socket, 403, "Forbidden");
    wss.handleUpgrade(req, socket, head, (ws) => handleSocket(ws, url, user));
  })();
});

server.listen(port, hostname, () => {
  console.log(`gridbase ready on http://${hostname}:${port} (${dev ? "dev" : "production"})`);
});
