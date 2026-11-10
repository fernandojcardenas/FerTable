// Computed fields and display text. Computed values are never stored; they are
// derived here from stored cells, on both the client and the server.

import type { BaseState, Field, Row } from "./types";
import { evaluate, FormulaError, parseFormula, toNumber, toText, type FNode, type FValue } from "./formula";
import { formatDuration } from "./fieldTypes";

export class CellError {
  constructor(public message: string) {}
}

export type Computed = FValue | CellError;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(iso: string, includeTime: boolean): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00.000Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (!includeTime) return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  // Times show in the viewer's local time zone.
  const date = `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${date} ${((h + 11) % 12) + 1}:${m} ${h < 12 ? "AM" : "PM"}`;
}

export function formatNumber(n: number, field?: Field): string {
  const o = field?.options ?? {};
  const precision = o.format === "integer" ? 0 : o.precision ?? (Number.isInteger(n) ? 0 : 2);
  if (o.format === "percent") return `${(n * 100).toFixed(Math.max(0, precision - 2))}%`;
  const body = n.toLocaleString("en-US", { minimumFractionDigits: precision, maximumFractionDigits: precision });
  if (o.format === "currency") return `${o.symbol ?? "$"}${body}`;
  return body;
}

export class Computer {
  private cache = new Map<string, Computed>();
  private parsed = new Map<string, FNode | CellError>();
  private visiting = new Set<string>();

  constructor(public state: BaseState, public now: Date = new Date()) {}

  field(id: string): Field | undefined {
    return this.state.fields[id];
  }

  /** Value as formulas, lookups, filters and sorting see it (choice names, linked row names). */
  value(row: Row, field: Field): Computed {
    const key = `${row.id}|${field.id}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    if (this.visiting.has(key)) return new CellError("Circular reference");
    this.visiting.add(key);
    let out: Computed;
    try {
      out = this.compute(row, field);
    } catch (e) {
      out = new CellError(e instanceof Error ? e.message : "Error");
    } finally {
      this.visiting.delete(key);
    }
    this.cache.set(key, out);
    return out;
  }

  /**
   * A lookup's values kept per linked record, in link order, so the UI can show
   * where each value came from. (value() gives formulas and filters one flat list.)
   */
  lookupGroups(row: Row, field: Field): { rowId: string; name: string; values: FValue[] }[] {
    if (field.type !== "lookup") return [];
    const target = this.state.fields[field.options.targetFieldId ?? ""];
    if (!target) return [];
    let linked: Row[];
    try { linked = this.linkedRows(row, field.options.linkFieldId); } catch { return []; }
    return linked.map((r) => {
      const v = this.value(r, target);
      const values = v instanceof CellError ? [] : (Array.isArray(v) ? v : [v]).filter((x) => x !== null && x !== "" && x !== false);
      return { rowId: r.id, name: this.primaryName(r.id), values };
    });
  }

  private linkedRows(row: Row, linkFieldId: string | undefined): Row[] {
    const lf = linkFieldId ? this.state.fields[linkFieldId] : undefined;
    if (!lf || lf.type !== "link" || lf.tableId !== row.tableId) throw new FormulaError("Link field is missing");
    const ids = (row.cells[lf.id] as string[] | undefined) ?? [];
    return ids.map((id) => this.state.rows[id]).filter((r): r is Row => Boolean(r));
  }

  private compute(row: Row, field: Field): Computed {
    const raw = row.cells[field.id];
    switch (field.type) {
      case "singleSelect":
        return typeof raw === "string" ? field.options.choices?.find((c) => c.id === raw)?.name ?? null : null;
      case "multiSelect":
        return Array.isArray(raw)
          ? raw.map((id) => field.options.choices?.find((c) => c.id === id)?.name).filter((n): n is string => Boolean(n))
          : null;
      case "link":
        return Array.isArray(raw) ? (raw as string[]).filter((id) => this.state.rows[id]).map((id) => this.primaryName(id)) : null;
      case "attachment":
        // Formulas, lookups and filters see attachments as their file names.
        return Array.isArray(raw) ? (raw as { name: string }[]).map((a) => a.name) : null;
      case "checkbox":
        return raw === true;
      case "createdTime":
        return row.createdAt;
      case "autoNumber":
        return row.autoNumber;
      case "lastModifiedTime":
        return row.modifiedAt ?? row.createdAt;
      case "lastModifiedBy":
        return row.modifiedBy ? this.personName(row.modifiedBy) : row.modifiedAt ? "Automation" : null;
      case "user":
        return Array.isArray(raw) ? (raw as string[]).map((id) => this.personName(id)) : null;
      case "button":
        return field.options.button?.label ?? null;
      case "ai":
        if (row.aiErrors?.[field.id]) return new CellError(row.aiErrors[field.id]);
        return typeof raw === "string" ? raw : null;
      case "count":
        return this.linkedRows(row, field.options.linkFieldId).length;
      case "lookup": {
        const target = this.state.fields[field.options.targetFieldId ?? ""];
        if (!target) throw new FormulaError("Lookup field is missing");
        const out: FValue[] = [];
        for (const r of this.linkedRows(row, field.options.linkFieldId)) {
          const v = this.value(r, target);
          if (v instanceof CellError) throw new FormulaError(v.message);
          if (Array.isArray(v)) out.push(...v);
          else if (v !== null && v !== "" && v !== false) out.push(v);
        }
        return out;
      }
      case "rollup": {
        const target = this.state.fields[field.options.targetFieldId ?? ""];
        if (!target) throw new FormulaError("Rollup field is missing");
        const vals: FValue[] = [];
        for (const r of this.linkedRows(row, field.options.linkFieldId)) {
          const v = this.value(r, target);
          if (v instanceof CellError) throw new FormulaError(v.message);
          if (Array.isArray(v)) vals.push(...v);
          else vals.push(v);
        }
        const present = vals.filter((v) => v !== null && v !== "");
        if (field.options.fn === "formula") {
          const node = this.parse(field);
          if (node instanceof CellError) return node;
          return evaluate(node, { now: this.now, vars: { VALUES: vals }, ref: () => { throw new FormulaError("A rollup formula can only use values"); } });
        }
        switch (field.options.fn ?? "sum") {
          case "sum": return present.reduce<number>((a, v) => a + toNumber(v), 0);
          case "avg": return present.length ? present.reduce<number>((a, v) => a + toNumber(v), 0) / present.length : null;
          case "min": return present.length ? Math.min(...present.map(toNumber)) : null;
          case "max": return present.length ? Math.max(...present.map(toNumber)) : null;
          case "count": return vals.length;
          case "counta": return present.length;
          case "concat": return present.map(toText).join(", ");
          case "and": return vals.length > 0 && vals.every((v) => Boolean(v));
          case "or": return vals.some((v) => Boolean(v));
        }
        return null;
      }
      case "formula": {
        const node = this.parse(field);
        if (node instanceof CellError) return node;
        return evaluate(node, {
          now: this.now,
          ref: (id) => {
            const f = this.state.fields[id];
            if (!f || f.tableId !== row.tableId) throw new FormulaError("A referenced field was deleted");
            const v = this.value(row, f);
            if (v instanceof CellError) throw new FormulaError(v.message);
            return v;
          },
        });
      }
      default:
        return raw === undefined ? null : (raw as FValue);
    }
  }

  private parse(field: Field): FNode | CellError {
    const expr = field.options.expression ?? "";
    const key = `${field.id}:${expr}`;
    let node = this.parsed.get(key);
    if (!node) {
      try {
        node = parseFormula(expr, field.type === "rollup" ? { vars: ["VALUES"] } : {});
      } catch (e) {
        node = new CellError(e instanceof Error ? e.message : "Invalid formula");
      }
      this.parsed.set(key, node);
    }
    return node;
  }

  /** A member's name, from the people list the server sends with the base. */
  personName(userId: string): string {
    return this.state.people?.[userId]?.name ?? "Former member";
  }

  primaryName(rowId: string): string {
    const row = this.state.rows[rowId];
    if (!row) return "";
    const table = this.state.tables[row.tableId];
    const primary = table && this.state.fields[table.primaryFieldId];
    const text = primary ? this.display(row, primary) : "";
    return text || "Unnamed record";
  }

  /** Text for showing a cell. */
  display(row: Row, field: Field): string {
    const v = this.value(row, field);
    if (v instanceof CellError) return "#ERROR";
    if (v === null || v === undefined) return "";
    switch (field.type) {
      case "number":
        return typeof v === "number" ? formatNumber(v, field) : "";
      case "date":
        return typeof v === "string" ? formatDate(v, Boolean(field.options.includeTime)) : "";
      case "createdTime":
      case "lastModifiedTime":
        return typeof v === "string" ? formatDate(v, true) : "";
      case "duration":
        return typeof v === "number" ? formatDuration(v, field.options.durationFormat) : "";
      case "checkbox":
        return v ? "✓" : "";
      case "rollup": {
        const target = this.state.fields[field.options.targetFieldId ?? ""];
        if (typeof v === "number") return formatNumber(v, target?.type === "number" ? target : undefined);
        return toText(v);
      }
      case "lookup": {
        const target = this.state.fields[field.options.targetFieldId ?? ""];
        if (Array.isArray(v) && target?.type === "number") return v.map((x) => formatNumber(toNumber(x), target)).join(", ");
        if (Array.isArray(v) && target?.type === "date") return v.map((x) => formatDate(toText(x), Boolean(target.options.includeTime))).join(", ");
        return toText(v);
      }
      case "formula":
        return typeof v === "number" ? formatNumber(v) : toText(v);
      default:
        return toText(v);
    }
  }

  isError(row: Row, field: Field): string | null {
    const v = this.value(row, field);
    return v instanceof CellError ? v.message : null;
  }
}
