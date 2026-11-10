// The public developer API (/v1), shaped like Airtable's REST API.
// Authenticated with personal access tokens only (never cookies), so it can allow any origin.
//
//   GET    /v1/meta/bases                         bases this token can use
//   GET    /v1/meta/bases/:baseId/tables          tables, fields and views
//   GET    /v1/:baseId/:table                     list records (pageSize, offset, view, maxRecords, fields[], filterByFormula, sort[n][field|direction])
//   GET    /v1/:baseId/:table/:recordId           one record
//   POST   /v1/:baseId/:table                     create (up to 10): { records: [{ fields }], typecast? }
//   PATCH  /v1/:baseId/:table                     update (up to 10): { records: [{ id, fields }], typecast? }
//   PATCH  /v1/:baseId/:table/:recordId           update one: { fields, typecast? }
//   PUT    (same as PATCH)                        replace: fields you leave out are cleared
//   DELETE /v1/:baseId/:table?records[]=id        delete (up to 10)
//   DELETE /v1/:baseId/:table/:recordId           delete one
//   GET/POST /v1/bases/:baseId/webhooks, DELETE /v1/bases/:baseId/webhooks/:id

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Action, BaseState, CellValue, Row, SelectChoice } from "../shared/types";
import { Computer } from "../shared/compute";
import { API_MAX_PAGE, API_MAX_WRITE, apiRecord, apiTable, cellsFromApi, choiceActions, findField, findTable, formulaFilter } from "../shared/api";
import { isReadOnly } from "../shared/fieldTypes";
import { sortRows, viewRows } from "../shared/query";
import { newId } from "../shared/ids";
import { ValidationError } from "../shared/reducer";
import { AuthError } from "./auth";
import { apiRateLimit, apiRole, authFromHeader, type ApiAuth } from "./apiTokens";
import { getEngine } from "./engine";
import { createWebhook, deleteWebhook, listWebhooks } from "./webhooks";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "access-control-max-age": "600",
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...CORS });
  res.end(JSON.stringify(body));
}
const fail = (res: ServerResponse, status: number, type: string, message: string) => send(res, status, { error: { type, message } });

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 2_000_000) throw new ValidationError("Request is too large");
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new ValidationError("Body must be a JSON object");
  }
}

export async function handlePublicApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? "GET";
  if (method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
  try {
    const auth = await authFromHeader(req.headers.authorization);
    apiRateLimit(auth.token.id);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); // ["v1", ...]
    const engine = getEngine();

    if (parts[1] === "meta" && parts[2] === "bases") {
      if (!parts[3] && method === "GET") {
        const bases = (await engine.listBases(auth.user.id)).filter((b) => !auth.token.baseIds || auth.token.baseIds.includes(b.id));
        return send(res, 200, { bases: bases.map((b) => ({ id: b.id, name: b.name, permissionLevel: b.role })) });
      }
      if (parts[3] && parts[4] === "tables" && method === "GET") {
        await apiRole(auth, parts[3], false);
        const s = await state(parts[3]);
        return send(res, 200, { tables: s.tableOrder.map((id) => apiTable(s, s.tables[id])) });
      }
      return fail(res, 404, "NOT_FOUND", "Not found");
    }
    if (parts[1] === "bases" && parts[2] && parts[3] === "webhooks") return await webhooks(req, res, auth, parts[2], parts[4], method);

    const [, baseId, tableKey, recordId] = parts;
    if (!baseId || !tableKey || parts.length > 4) return fail(res, 404, "NOT_FOUND", "Not found");
    const write = method !== "GET";
    await apiRole(auth, baseId, write);
    const s = await state(baseId);
    const table = findTable(s, tableKey);
    if (!table) return fail(res, 404, "TABLE_NOT_FOUND", `Could not find table ${tableKey} in this base`);
    const c = new Computer(s);

    if (method === "GET" && recordId) {
      const row = s.rows[recordId];
      if (!row || row.tableId !== table.id) return fail(res, 404, "NOT_FOUND", "Record not found");
      return send(res, 200, apiRecord(s, c, row));
    }
    if (method === "GET") return send(res, 200, list(s, c, table.id, url.searchParams));

    if (method === "DELETE") {
      const ids = recordId ? [recordId] : url.searchParams.getAll("records[]").concat(url.searchParams.getAll("records"));
      if (ids.length === 0 || ids.length > API_MAX_WRITE) throw new ValidationError(`Delete 1 to ${API_MAX_WRITE} records at a time`);
      for (const id of ids) if (s.rows[id]?.tableId !== table.id) return fail(res, 404, "NOT_FOUND", `Record ${id} not found`);
      await apply(baseId, auth, [{ type: "row.delete", rowIds: ids }]);
      return send(res, 200, recordId ? { id: recordId, deleted: true } : { records: ids.map((id) => ({ id, deleted: true })) });
    }

    const body = await readJson(req);
    const typecast = body.typecast === true;
    const pending = new Map<string, SelectChoice[]>();

    if (method === "POST" && !recordId) {
      const single = !Array.isArray(body.records);
      const input = single ? [{ fields: body.fields }] : (body.records as { fields?: unknown }[]);
      if (input.length === 0 || input.length > API_MAX_WRITE) throw new ValidationError(`Create 1 to ${API_MAX_WRITE} records at a time`);
      const creates: Action[] = input.map((r) => ({ type: "row.create", rowId: newId("rec"), tableId: table.id, cells: cellsFromApi(s, table, r?.fields ?? {}, typecast, pending) }));
      const after = await apply(baseId, auth, [...choiceActions(pending), ...creates]);
      const ca = new Computer(after);
      const out = creates.map((a) => apiRecord(after, ca, after.rows[(a as { rowId: string }).rowId]));
      return send(res, 200, single ? out[0] : { records: out });
    }

    if (method === "PATCH" || method === "PUT") {
      const single = Boolean(recordId);
      const input = single ? [{ id: recordId, fields: body.fields }] : (Array.isArray(body.records) ? body.records : null) as { id?: unknown; fields?: unknown }[] | null;
      if (!input || input.length === 0 || input.length > API_MAX_WRITE) throw new ValidationError(`Update 1 to ${API_MAX_WRITE} records at a time`);
      const updates: Action[] = input.map((r) => {
        const id = String(r?.id ?? "");
        const row = s.rows[id];
        if (!row || row.tableId !== table.id) throw new NotFound(`Record ${id} not found`);
        const cells: Record<string, CellValue> = cellsFromApi(s, table, r.fields ?? {}, typecast, pending);
        if (method === "PUT") {
          for (const fid of table.fieldOrder) {
            const f = s.fields[fid];
            if (f && !isReadOnly(f) && f.type !== "attachment" && !(fid in cells)) cells[fid] = null;
          }
        }
        return { type: "row.update", rowId: id, cells };
      });
      const after = await apply(baseId, auth, [...choiceActions(pending), ...updates]);
      const ca = new Computer(after);
      const out = updates.map((a) => apiRecord(after, ca, after.rows[(a as { rowId: string }).rowId]));
      return send(res, 200, single ? out[0] : { records: out });
    }
    return fail(res, 404, "NOT_FOUND", "Not found");
  } catch (e) {
    if (e instanceof NotFound) return fail(res, 404, "NOT_FOUND", e.message);
    if (e instanceof AuthError) {
      const type = e.status === 401 ? "AUTHENTICATION_REQUIRED" : e.status === 429 ? "RATE_LIMIT_REACHED" : e.status === 403 ? "INVALID_PERMISSIONS" : "NOT_FOUND";
      return fail(res, e.status, type, e.message);
    }
    if (e instanceof ValidationError) return fail(res, 422, "INVALID_REQUEST", e.message);
    console.error(e);
    return fail(res, 500, "SERVER_ERROR", "Something went wrong on the server");
  }
}

class NotFound extends Error {}

async function state(baseId: string): Promise<BaseState> {
  const engine = getEngine();
  const s = await engine.getState(baseId);
  if (!s) throw new NotFound("Base not found");
  return { ...s, people: await engine.people(baseId) };
}

async function apply(baseId: string, auth: ApiAuth, actions: Action[]): Promise<BaseState> {
  const engine = getEngine();
  await engine.apply(baseId, { clientId: null, requestId: null, userId: auth.user.id, actions }, "api");
  return state(baseId);
}

/** List records: a view's filters and order (or the table's), then filterByFormula and sort, then a page. */
function list(s: BaseState, c: Computer, tableId: string, q: URLSearchParams) {
  const table = s.tables[tableId];
  let rows: Row[];
  const viewKey = q.get("view");
  if (viewKey) {
    const view = s.views[viewKey] ?? table.viewOrder.map((id) => s.views[id]).find((v) => v?.name === viewKey);
    if (!view || view.tableId !== tableId) throw new NotFound(`View ${viewKey} not found`);
    rows = viewRows(c, s, view);
  } else {
    rows = table.rowOrder.map((id) => s.rows[id]).filter(Boolean);
  }
  const formula = q.get("filterByFormula");
  if (formula) rows = rows.filter(formulaFilter(s, table, c, formula));
  const sorts = [];
  for (let i = 0; i < 10; i++) {
    const key = q.get(`sort[${i}][field]`);
    if (!key) break;
    const f = findField(s, table, key);
    if (!f) throw new ValidationError(`Unknown field name in sort: "${key}"`);
    sorts.push({ fieldId: f.id, direction: q.get(`sort[${i}][direction]`) === "desc" ? "desc" as const : "asc" as const });
  }
  if (sorts.length) rows = sortRows(c, rows, sorts);
  const max = Number(q.get("maxRecords") ?? 0);
  if (max > 0) rows = rows.slice(0, max);
  const pageSize = Math.min(Math.max(Number(q.get("pageSize") ?? API_MAX_PAGE) || API_MAX_PAGE, 1), API_MAX_PAGE);
  const offsetIn = q.get("offset");
  const start = offsetIn ? Number(/^itr(\d+)$/.exec(offsetIn)?.[1] ?? NaN) : 0;
  if (!Number.isInteger(start) || start < 0) throw new ValidationError("Invalid offset");
  const names = q.getAll("fields[]").concat(q.getAll("fields"));
  let only: Set<string> | undefined;
  if (names.length) {
    only = new Set(names.map((n) => { const f = findField(s, table, n); if (!f) throw new ValidationError(`Unknown field name: "${n}"`); return f.id; }));
  }
  const page = rows.slice(start, start + pageSize);
  const next = start + pageSize < rows.length ? `itr${start + pageSize}` : undefined;
  return { records: page.map((r) => apiRecord(s, c, r, only)), ...(next ? { offset: next } : {}) };
}

async function webhooks(req: IncomingMessage, res: ServerResponse, auth: ApiAuth, baseId: string, id: string | undefined, method: string) {
  if (method === "GET" && !id) {
    await apiRole(auth, baseId, false);
    return send(res, 200, { webhooks: await listWebhooks(baseId) });
  }
  await apiRole(auth, baseId, true);
  if (method === "POST" && !id) {
    const body = await readJson(req);
    const s = await state(baseId);
    const tableKey = typeof body.table === "string" ? body.table : null;
    const table = tableKey ? findTable(s, tableKey) : null;
    if (tableKey && !table) throw new NotFound(`Could not find table ${tableKey}`);
    return send(res, 200, await createWebhook(baseId, s, auth.user.id, body.notificationUrl ?? body.url, table?.id ?? null));
  }
  if (method === "DELETE" && id) {
    await deleteWebhook(baseId, id);
    return send(res, 200, { id, deleted: true });
  }
  return fail(res, 404, "NOT_FOUND", "Not found");
}
