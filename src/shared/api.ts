// The public developer API's record format, modeled on Airtable's: fields keyed by name,
// select options by name, links as record ids, empty values left out.

import type { Action, BaseState, CellValue, Field, Row, SelectChoice, Table } from "./types";
import { CellError, Computer } from "./compute";
import { FIELD_TYPES, isReadOnly } from "./fieldTypes";
import { evaluate, FormulaError, namesToIds, parseFormula, type FValue } from "./formula";
import { newId } from "./ids";
import { ValidationError } from "./reducer";

export const API_MAX_PAGE = 100;
export const API_MAX_WRITE = 10;

const person = (state: BaseState, id: string) => ({ id, name: state.people?.[id]?.name ?? "Former member", email: state.people?.[id]?.email ?? null });

const choiceName = (f: Field, id: unknown) => f.options.choices?.find((ch) => ch.id === id)?.name;

/** One field's value as the API returns it, or undefined when empty. */
export function apiValue(state: BaseState, c: Computer, row: Row, f: Field): unknown {
  const v = c.value(row, f);
  if (v instanceof CellError) return { error: "#ERROR!", message: v.message };
  const empty = v === null || v === undefined || v === "" || v === false || (Array.isArray(v) && v.length === 0);
  if (empty && f.type !== "button") return undefined;
  switch (f.type) {
    case "singleSelect": return choiceName(f, row.cells[f.id]);
    case "multiSelect": return ((row.cells[f.id] as string[] | undefined) ?? []).map((id) => choiceName(f, id)).filter(Boolean);
    case "user": { const ids = v as string[]; return f.options.multiple ? ids.map((id) => person(state, id)) : person(state, ids[0]); }
    case "lastModifiedBy": return row.modifiedBy ? person(state, row.modifiedBy) : typeof v === "string" ? { id: null, name: v, email: null } : undefined;
    case "createdBy": return row.createdBy ? person(state, row.createdBy) : typeof v === "string" ? { id: null, name: v, email: null } : undefined;
    case "attachment": return (v as unknown as { id: string; name: string; size: number; type: string; url: string }[]).map((a) => ({ id: a.id, url: a.url, filename: a.name, size: a.size, type: a.type }));
    case "button": return { label: f.options.button?.label ?? "", ...(f.options.button?.kind === "url" ? { url: c.display(row, f) || null } : {}) };
    default: return v;
  }
}

/** A record as the API returns it. `only` limits the fields (by id). */
export function apiRecord(state: BaseState, c: Computer, row: Row, only?: Set<string>) {
  const fields: Record<string, unknown> = {};
  for (const id of state.tables[row.tableId].fieldOrder) {
    const f = state.fields[id];
    if (!f || (only && !only.has(id))) continue;
    const v = apiValue(state, c, row, f);
    if (v !== undefined) fields[f.name] = v;
  }
  return { id: row.id, createdTime: row.createdAt, fields };
}

/** A table's schema for /v1/meta. */
export function apiTable(state: BaseState, t: Table) {
  return {
    id: t.id, name: t.name, primaryFieldId: t.primaryFieldId,
    ...(t.sync ? { synced: { from: t.sync.sourceLabel, lastSyncAt: t.sync.lastSyncAt } } : {}),
    fields: t.fieldOrder.map((id) => state.fields[id]).filter(Boolean).map((f) => ({
      id: f.id, name: f.name, type: f.type, readOnly: isReadOnly(f), ...(f.description ? { description: f.description } : {}),
      ...(f.options.choices ? { options: { choices: f.options.choices.map((ch) => ({ id: ch.id, name: ch.name, color: ch.color })) } } : {}),
      ...(f.type === "link" ? { options: { linkedTableId: f.options.linkedTableId } } : {}),
    })),
    views: t.viewOrder.map((id) => state.views[id]).filter(Boolean).map((v) => ({ id: v.id, name: v.name, type: v.type })),
  };
}

/** Find a table or field by id or (exact, then case-insensitive) name. */
export function findTable(state: BaseState, key: string): Table | undefined {
  const all = state.tableOrder.map((id) => state.tables[id]);
  return state.tables[key] ?? all.find((t) => t.name === key) ?? all.find((t) => t.name.toLowerCase() === key.toLowerCase());
}
export function findField(state: BaseState, t: Table, key: string): Field | undefined {
  const all = t.fieldOrder.map((id) => state.fields[id]).filter(Boolean);
  if (state.fields[key]?.tableId === t.id) return state.fields[key];
  return all.find((f) => f.name === key) ?? all.find((f) => f.name.toLowerCase() === key.toLowerCase());
}

const COLORS = ["blue", "cyan", "teal", "green", "yellow", "orange", "red", "pink", "purple", "gray"];

/**
 * Turn API `fields` into cells. Select options are matched by name (or id); with
 * `typecast`, missing options are created and loose values (like "3" for a number) accepted.
 * Returns the cells and any field.update actions that must run first.
 */
export function cellsFromApi(state: BaseState, t: Table, input: unknown, typecast: boolean, pending = new Map<string, SelectChoice[]>()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError("`fields` must be an object");
  const cells: Record<string, CellValue> = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const f = findField(state, t, key);
    if (!f) throw new ValidationError(`Unknown field name: "${key}"`);
    if (isReadOnly(f)) throw new ValidationError(`Field "${f.name}" cannot accept a value because it is ${f.syncSourceFieldId ? "synced from another base" : "computed"}`);
    if (raw === null || raw === undefined) { cells[f.id] = null; continue; }
    const bad = () => new ValidationError(`Field "${f.name}" (${FIELD_TYPES[f.type].label}) can't take ${JSON.stringify(raw).slice(0, 60)}`);
    switch (f.type) {
      case "singleSelect": case "multiSelect": {
        const list = f.type === "multiSelect" ? (Array.isArray(raw) ? raw : typecast && typeof raw === "string" ? raw.split(",").map((x) => x.trim()).filter(Boolean) : null) : [raw];
        if (!list) throw bad();
        const choices = pending.get(f.id) ?? [...(f.options.choices ?? [])];
        const ids = list.map((name) => {
          if (typeof name !== "string") throw bad();
          const hit = choices.find((ch) => ch.id === name || ch.name === name);
          if (hit) return hit.id;
          if (!typecast) throw new ValidationError(`Insufficient permissions to create new select option "${name}" in "${f.name}" (send "typecast": true to create it)`);
          const ch: SelectChoice = { id: newId("opt"), name: name.slice(0, 200), color: COLORS[choices.length % COLORS.length] as SelectChoice["color"] };
          choices.push(ch);
          pending.set(f.id, choices);
          return ch.id;
        });
        cells[f.id] = f.type === "multiSelect" ? ids : ids[0];
        break;
      }
      case "user": {
        const list = Array.isArray(raw) ? raw : [raw];
        cells[f.id] = list.map((p) => {
          const key = typeof p === "string" ? p : p && typeof p === "object" ? String((p as { id?: string; email?: string }).id ?? (p as { email?: string }).email ?? "") : "";
          const hit = Object.entries(state.people ?? {}).find(([id, x]) => id === key || x.email.toLowerCase() === key.toLowerCase());
          if (!hit) throw new ValidationError(`"${key}" isn't a member of this base`);
          return hit[0];
        });
        break;
      }
      case "link":
        if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) throw bad();
        cells[f.id] = raw as string[];
        break;
      case "number": case "rating": case "duration":
        if (typeof raw !== "number" && !(typecast && typeof raw === "string")) throw bad();
        cells[f.id] = raw as CellValue;
        break;
      case "checkbox":
        if (typeof raw !== "boolean" && !typecast) throw bad();
        cells[f.id] = typecast ? Boolean(raw) && raw !== "false" && raw !== "0" : (raw as boolean);
        break;
      case "attachment":
        throw new ValidationError(`Files can't be added through the API yet ("${f.name}")`);
      default:
        if (typeof raw !== "string" && !(typecast && (typeof raw === "number" || typeof raw === "boolean"))) throw bad();
        cells[f.id] = String(raw);
    }
  }
  return cells;
}

/** field.update actions for select options that cellsFromApi created. */
export function choiceActions(pending: Map<string, SelectChoice[]>): Action[] {
  return [...pending].map(([fieldId, choices]) => ({ type: "field.update", fieldId, options: { choices } }) as Action);
}

/** A filterByFormula check: field names in {braces}, keep records where the result is truthy. */
export function formulaFilter(state: BaseState, t: Table, c: Computer, formula: string): (row: Row) => boolean {
  const fields = t.fieldOrder.map((id) => state.fields[id]).filter(Boolean);
  let node;
  try {
    node = parseFormula(namesToIds(formula, fields));
  } catch (e) {
    throw new ValidationError(`Invalid filterByFormula: ${e instanceof Error ? e.message : String(e)}`);
  }
  return (row) => {
    try {
      const v: FValue = evaluate(node, {
        now: c.now,
        ref: (id) => {
          const f = state.fields[id];
          if (!f || f.tableId !== t.id) throw new FormulaError("Unknown field");
          const x = c.value(row, f);
          if (x instanceof CellError) throw new FormulaError(x.message);
          return x;
        },
      });
      return Boolean(v) && !(Array.isArray(v) && v.length === 0);
    } catch {
      return false;
    }
  };
}
