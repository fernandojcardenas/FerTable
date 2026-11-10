// Records Airtable API traffic (XHR/fetch bodies + websocket frames) from the
// REA Chrome profile on CDP port 9333. Headers and cookies are never recorded.
//
// Usage:
//   node cdp-recorder.mjs <session-name> [--seconds 30] [--reload]
//
// Refuses to run unless the active tab is the allowed base (Test Base).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unpack as decodeMsgpack } from "msgpackr";

// The one base it may record. Kept out of git: research/raw/allowed-base.txt or REA_ALLOWED_BASE_ID.
const ALLOWED_BASE_ID = (process.env.REA_ALLOWED_BASE_ID ?? (() => {
  try { return readFileSync(new URL("../raw/allowed-base.txt", import.meta.url), "utf8"); } catch { return ""; }
})()).trim();
if (!/^app[A-Za-z0-9]{14}$/.test(ALLOWED_BASE_ID)) {
  console.error("Put the allowed base ID in research/raw/allowed-base.txt (or REA_ALLOWED_BASE_ID); refusing to record.");
  process.exit(1);
}
const CDP = "http://127.0.0.1:9333";
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "raw", "sessions");

const args = process.argv.slice(2);
const name = args[0];
if (!name || name.startsWith("--")) {
  console.error("usage: node cdp-recorder.mjs <session-name> [--seconds N] [--reload]");
  process.exit(2);
}
const seconds = Number(args[args.indexOf("--seconds") + 1]) || 30;
const reload = args.includes("--reload");

// Telemetry and static assets are skipped.
const SKIP = [/\/internal\/exposures/, /\/\.csp\/report/, /\/icons\//, /\/images\//];
const isApi = (url) =>
  /^(https|wss):\/\/airtable\.com\//.test(url) && !SKIP.some((re) => re.test(url));

const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes(`/${ALLOWED_BASE_ID}`));
if (!page) {
  console.error(`No tab open on base ${ALLOWED_BASE_ID}; refusing to record.`);
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const t0 = Date.now();
const requests = new Map(); // requestId -> record
const sockets = new Map(); // requestId -> url
const events = [];

ws.onmessage = async (msg) => {
  const m = JSON.parse(msg.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(m.error) : p.resolve(m.result);
    return;
  }
  const { method, params } = m;
  const t = Date.now() - t0;
  switch (method) {
    case "Network.requestWillBeSent": {
      const { requestId, request, type } = params;
      if (!isApi(request.url) || !["XHR", "Fetch", "EventSource", "Document"].includes(type)) return;
      if (type === "Document" && !request.url.includes(ALLOWED_BASE_ID)) return;
      const rec = { t, kind: "http", type, method: request.method, url: request.url, requestBody: request.postData ?? null };
      requests.set(requestId, rec);
      events.push(rec);
      if (request.hasPostData && rec.requestBody == null) {
        try {
          rec.requestBody = (await send("Network.getRequestPostData", { requestId })).postData;
        } catch {}
      }
      break;
    }
    case "Network.responseReceived": {
      const rec = requests.get(params.requestId);
      if (rec) Object.assign(rec, { status: params.response.status, mimeType: params.response.mimeType });
      break;
    }
    case "Network.loadingFinished": {
      const rec = requests.get(params.requestId);
      if (!rec || rec.type === "Document") return;
      try {
        const { body, base64Encoded } = await send("Network.getResponseBody", { requestId: params.requestId });
        const bytes = base64Encoded ? Buffer.from(body, "base64") : Buffer.from(body, "utf8");
        if (/msgpack/.test(rec.mimeType ?? "")) {
          rec.encoding = "msgpack";
          try { rec.responseBody = decodeMsgpack(bytes); } catch (e) { rec.responseBody = { msgpackError: String(e), base64: bytes.toString("base64") }; }
        } else {
          const text = bytes.toString("utf8");
          try { rec.responseBody = JSON.parse(text); } catch { rec.responseBody = text; }
        }
      } catch (e) {
        rec.responseBody = { unavailable: e.message ?? String(e) };
      }
      break;
    }
    case "Network.webSocketCreated":
      if (isApi(params.url)) {
        sockets.set(params.requestId, params.url);
        events.push({ t, kind: "ws-open", url: params.url });
      }
      break;
    case "Network.webSocketFrameSent":
    case "Network.webSocketFrameReceived": {
      // Sockets opened before recording started have no known URL.
      const url = sockets.get(params.requestId) ?? `ws:${params.requestId} (opened before recording)`;
      events.push({
        t,
        kind: method.endsWith("Sent") ? "ws-sent" : "ws-recv",
        url,
        payload: params.response.payloadData,
      });
      break;
    }
  }
};

await new Promise((r) => (ws.onopen = r));
await send("Network.enable", { maxPostDataSize: 10_000_000, maxResourceBufferSize: 50_000_000, maxTotalBufferSize: 200_000_000 });
if (reload) await send("Page.reload", { ignoreCache: false });
console.log(`Recording "${name}" on ${page.url} for up to ${seconds}s${reload ? " (reloaded)" : ""}...`);

mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${name}.json`);
const save = () => {
  // Never keep traffic that names a different base.
  const kept = events.filter((e) => !mentionsOtherBase(JSON.stringify(e)));
  writeFileSync(file, JSON.stringify({ name, baseId: ALLOWED_BASE_ID, pageUrl: page.url, recordedAt: new Date().toISOString(), seconds, events: kept }, null, 2));
  return kept;
};
const autosave = setInterval(save, 30_000);

// Stop at the time limit, or early on Ctrl-C / kill.
await new Promise((resolve) => {
  setTimeout(resolve, seconds * 1000);
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await new Promise((r) => setTimeout(r, 1500)); // let pending body fetches finish
clearInterval(autosave);
ws.close();

const kept = save();
const http = kept.filter((e) => e.kind === "http").length;
const frames = kept.filter((e) => e.kind.startsWith("ws-") && e.kind !== "ws-open").length;
console.log(`Saved ${file}\n${http} HTTP calls, ${frames} websocket frames`);
process.exit(0);

function mentionsOtherBase(text) {
  // Base IDs are "app" + 14 chars; skip words like "applicationsByIds".
  const ids = (text.match(/\bapp[A-Za-z0-9]{14}\b/g) ?? []).filter((id) => !id.startsWith("applica"));
  return ids.some((id) => id !== ALLOWED_BASE_ID);
}
