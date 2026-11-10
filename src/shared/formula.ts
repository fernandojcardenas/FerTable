// A small spreadsheet-style formula language.
// Field references are written {Field name} in the editor and stored as {fldXXXXXXXXXXXXXX}.

export class FormulaError extends Error {}

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ref"; v: string }
  | { t: "ident"; v: string }
  | { t: "op"; v: string }
  | { t: "(" }
  | { t: ")" }
  | { t: "," };

export type FNode =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "ref"; id: string }
  /** A named value given by the caller, such as `values` in a rollup formula. */
  | { k: "var"; name: string }
  | { k: "call"; name: string; args: FNode[] }
  | { k: "unary"; op: string; arg: FNode }
  | { k: "bin"; op: string; left: FNode; right: FNode };

const OPS = ["<=", ">=", "!=", "=", "<", ">", "&", "+", "-", "*", "/"];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(" || c === ")" || c === ",") { out.push({ t: c } as Token); i++; continue; }
    if (c === "{") {
      const end = src.indexOf("}", i);
      if (end < 0) throw new FormulaError("Missing } after field name");
      out.push({ t: "ref", v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) { s += src[j + 1]; j += 2; continue; }
        s += src[j++];
      }
      if (j >= src.length) throw new FormulaError("Unclosed text in quotes");
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?/i.exec(src.slice(i));
      if (!m) throw new FormulaError(`Unexpected "${c}"`);
      out.push({ t: "num", v: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: "ident", v: m[0].toUpperCase() });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) { out.push({ t: "op", v: op }); i += op.length; continue; }
    throw new FormulaError(`Unexpected "${c}"`);
  }
  return out;
}

const PREC: Record<string, number> = { "=": 1, "!=": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4 };

/** `vars` are bare names the formula may use, such as VALUES in rollups. */
export function parseFormula(src: string, opts: { vars?: string[] } = {}): FNode {
  const vars = opts.vars ?? [];
  const tokens = tokenize(src);
  if (tokens.length === 0) throw new FormulaError("The formula is empty");
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function primary(): FNode {
    const tok = next();
    if (!tok) throw new FormulaError("The formula ends too early");
    switch (tok.t) {
      case "num": return { k: "num", v: tok.v };
      case "str": return { k: "str", v: tok.v };
      case "ref": return { k: "ref", id: tok.v };
      case "op":
        if (tok.v === "-" || tok.v === "+") return { k: "unary", op: tok.v, arg: expr(5) };
        throw new FormulaError(`Unexpected "${tok.v}"`);
      case "(": {
        const e = expr(0);
        if (next()?.t !== ")") throw new FormulaError("Missing )");
        return e;
      }
      case "ident": {
        if (tok.v === "TRUE" && peek()?.t !== "(") return { k: "bool", v: true };
        if (tok.v === "FALSE" && peek()?.t !== "(") return { k: "bool", v: false };
        if (peek()?.t !== "(" && vars.includes(tok.v)) return { k: "var", name: tok.v };
        if (peek()?.t !== "(") throw new FormulaError(`Unknown name "${tok.v}". Put field names in {braces}.`);
        next();
        const args: FNode[] = [];
        if (peek()?.t !== ")") {
          for (;;) {
            args.push(expr(0));
            const sep = next();
            if (sep?.t === ")") break;
            if (sep?.t !== ",") throw new FormulaError(`Expected , or ) in ${tok.v}()`);
          }
        } else next();
        if (!(tok.v in FUNCTIONS)) throw new FormulaError(`Unknown function ${tok.v}()`);
        return { k: "call", name: tok.v, args };
      }
      default:
        throw new FormulaError(`Unexpected "${tok.t}"`);
    }
  }

  function expr(minPrec: number): FNode {
    let left = primary();
    for (;;) {
      const tok = peek();
      if (!tok || tok.t !== "op") break;
      const p = PREC[tok.v];
      if (p === undefined || p < minPrec) break;
      next();
      const right = expr(p + 1);
      left = { k: "bin", op: tok.v, left, right };
    }
    return left;
  }

  const result = expr(0);
  if (pos < tokens.length) throw new FormulaError("Unexpected text after the end of the formula");
  return result;
}

export function referencedIds(node: FNode, out: Set<string> = new Set()): Set<string> {
  switch (node.k) {
    case "ref": out.add(node.id); break;
    case "call": node.args.forEach((a) => referencedIds(a, out)); break;
    case "unary": referencedIds(node.arg, out); break;
    case "bin": referencedIds(node.left, out); referencedIds(node.right, out); break;
  }
  return out;
}

/** {Field name} → {fldId}. Unknown names throw. */
export function namesToIds(expr: string, fields: { id: string; name: string }[]): string {
  return expr.replace(/\{([^}]*)\}/g, (_, name: string) => {
    const f = fields.find((x) => x.name === name) ?? fields.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!f) throw new FormulaError(`No field named "${name}"`);
    return `{${f.id}}`;
  });
}

/** {fldId} → {Field name}, for showing a stored formula. */
export function idsToNames(expr: string, fields: { id: string; name: string }[]): string {
  return expr.replace(/\{(fld[A-Za-z0-9]{14})\}/g, (m, id: string) => {
    const f = fields.find((x) => x.id === id);
    return f ? `{${f.name}}` : "{#deleted field}";
  });
}

// ---- evaluation ----

export type FValue = number | string | boolean | null | FValue[];

export type EvalContext = { ref: (fieldId: string) => FValue; now: Date; vars?: Record<string, FValue> };

const flat = (vals: FValue[]): FValue[] => vals.flatMap((v) => (Array.isArray(v) ? flat(v) : [v]));

export function toNumber(v: FValue): number {
  if (Array.isArray(v)) return v.length === 1 ? toNumber(v[0]) : flat(v).reduce<number>((a, x) => a + toNumber(x), 0);
  if (v === null || v === "") return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  const n = parseFloat(v);
  if (Number.isFinite(n) && /^\s*[-+]?[0-9.]/.test(v)) return n;
  throw new FormulaError(`"${v}" is not a number`);
}

export function toText(v: FValue): string {
  if (v === null) return "";
  if (Array.isArray(v)) return flat(v).map(toText).join(", ");
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(10)));
  if (typeof v === "boolean") return v ? "true" : "false";
  return v;
}

function truthy(v: FValue): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return !(v === null || v === 0 || v === "" || v === false);
}

function toDate(v: FValue): Date {
  const s = toText(v);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s);
  if (Number.isNaN(d.getTime())) throw new FormulaError(`"${s}" is not a date`);
  return d;
}

const UNIT_MS: Record<string, number> = {
  milliseconds: 1, seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 604_800_000,
};

function addToDate(d: Date, n: number, unit: string): Date {
  const out = new Date(d.getTime());
  const u = unit.toLowerCase().replace(/s$/, "") + "s";
  if (u === "months") out.setUTCMonth(out.getUTCMonth() + n);
  else if (u === "years") out.setUTCFullYear(out.getUTCFullYear() + n);
  else if (UNIT_MS[u]) out.setTime(out.getTime() + n * UNIT_MS[u]);
  else throw new FormulaError(`Unknown time unit "${unit}"`);
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

type Fn = (args: FValue[], ctx: EvalContext) => FValue;
const num1 = (f: (x: number) => number): Fn => ([a]) => f(toNumber(a));

const FUNCTIONS: Record<string, Fn | "lazy"> = {
  IF: "lazy",
  SWITCH: "lazy",
  AND: (a) => flat(a).every(truthy),
  OR: (a) => flat(a).some(truthy),
  NOT: ([a]) => !truthy(a),
  XOR: (a) => flat(a).filter(truthy).length % 2 === 1,
  BLANK: () => null,
  ISBLANK: ([a]) => !truthy(a) && a !== 0,
  ERROR: ([a]) => { throw new FormulaError(toText(a ?? "Error")); },
  CONCATENATE: (a) => a.map(toText).join(""),
  LEN: ([a]) => toText(a).length,
  UPPER: ([a]) => toText(a).toUpperCase(),
  LOWER: ([a]) => toText(a).toLowerCase(),
  TRIM: ([a]) => toText(a).trim(),
  LEFT: ([a, n]) => toText(a).slice(0, toNumber(n ?? 1)),
  RIGHT: ([a, n]) => { const s = toText(a); const k = toNumber(n ?? 1); return k <= 0 ? "" : s.slice(-k); },
  MID: ([a, start, n]) => toText(a).substr(toNumber(start) - 1, toNumber(n)),
  FIND: ([needle, hay, start]) => toText(hay).indexOf(toText(needle), toNumber(start ?? 1) - 1) + 1,
  SUBSTITUTE: ([a, from, to]) => toText(a).split(toText(from)).join(toText(to)),
  REPT: ([a, n]) => toText(a).repeat(Math.max(0, toNumber(n))),
  T: ([a]) => (typeof a === "string" ? a : ""),
  VALUE: ([a]) => toNumber(toText(a).replace(/[^0-9.eE+-]/g, "")),
  ARRAYUNIQUE: (a) => {
    const out: FValue[] = [];
    const seen = new Set<string>();
    for (const x of flat(a)) {
      const key = `${typeof x}:${toText(x)}`;
      if (!seen.has(key)) { seen.add(key); out.push(x); }
    }
    return out;
  },
  ARRAYCOMPACT: (a) => flat(a).filter((x) => x !== null && x !== ""),
  ARRAYFLATTEN: (a) => flat(a),
  ARRAYJOIN: ([a, sep]) => flat(Array.isArray(a) ? a : [a]).map(toText).join(sep === undefined ? ", " : toText(sep)),
  ROUND: ([a, p]) => { const f = 10 ** toNumber(p ?? 0); return Math.round(toNumber(a) * f) / f; },
  ROUNDUP: ([a, p]) => { const f = 10 ** toNumber(p ?? 0); const x = toNumber(a) * f; return (x < 0 ? Math.floor(x) : Math.ceil(x)) / f; },
  ROUNDDOWN: ([a, p]) => { const f = 10 ** toNumber(p ?? 0); return Math.trunc(toNumber(a) * f) / f; },
  FLOOR: num1(Math.floor),
  CEILING: num1(Math.ceil),
  INT: num1(Math.floor),
  ABS: num1(Math.abs),
  SQRT: num1(Math.sqrt),
  EXP: num1(Math.exp),
  LOG: ([a, b]) => Math.log(toNumber(a)) / Math.log(toNumber(b ?? 10)),
  POWER: ([a, b]) => toNumber(a) ** toNumber(b),
  MOD: ([a, b]) => { const d = toNumber(b); if (d === 0) throw new FormulaError("Division by zero"); return toNumber(a) % d; },
  SUM: (a) => flat(a).reduce<number>((s, x) => s + (x === null || x === "" ? 0 : toNumber(x)), 0),
  AVERAGE: (a) => { const v = flat(a).filter((x) => x !== null && x !== ""); return v.length ? v.reduce<number>((s, x) => s + toNumber(x), 0) / v.length : 0; },
  MIN: (a) => { const v = flat(a).filter((x) => x !== null && x !== "").map(toNumber); return v.length ? Math.min(...v) : 0; },
  MAX: (a) => { const v = flat(a).filter((x) => x !== null && x !== "").map(toNumber); return v.length ? Math.max(...v) : 0; },
  COUNT: (a) => flat(a).filter((x) => typeof x === "number").length,
  COUNTA: (a) => flat(a).filter((x) => x !== null && x !== "").length,
  COUNTALL: (a) => flat(a).length,
  TODAY: (_a, ctx) => ctx.now.toISOString().slice(0, 10),
  NOW: (_a, ctx) => ctx.now.toISOString(),
  YEAR: ([a]) => toDate(a).getUTCFullYear(),
  MONTH: ([a]) => toDate(a).getUTCMonth() + 1,
  DAY: ([a]) => toDate(a).getUTCDate(),
  WEEKDAY: ([a]) => toDate(a).getUTCDay(),
  HOUR: ([a]) => toDate(a).getUTCHours(),
  MINUTE: ([a]) => toDate(a).getUTCMinutes(),
  DATEADD: ([d, n, unit]) => addToDate(toDate(d), toNumber(n), toText(unit)).toISOString(),
  DATETIME_DIFF: ([a, b, unit]) => {
    const u = toText(unit ?? "seconds").toLowerCase().replace(/s$/, "") + "s";
    const ms = toDate(a).getTime() - toDate(b).getTime();
    if (u === "months" || u === "years") {
      const da = toDate(a), db = toDate(b);
      const months = (da.getUTCFullYear() - db.getUTCFullYear()) * 12 + (da.getUTCMonth() - db.getUTCMonth());
      return u === "months" ? months : Math.trunc(months / 12);
    }
    if (!UNIT_MS[u]) throw new FormulaError(`Unknown time unit "${toText(unit)}"`);
    return Math.trunc(ms / UNIT_MS[u]);
  },
  DATETIME_FORMAT: ([a, fmt]) => {
    const d = toDate(a);
    const f = toText(fmt ?? "YYYY-MM-DD");
    return f
      .replace(/YYYY/g, String(d.getUTCFullYear()))
      .replace(/MM/g, pad(d.getUTCMonth() + 1))
      .replace(/DD/g, pad(d.getUTCDate()))
      .replace(/HH/g, pad(d.getUTCHours()))
      .replace(/mm/g, pad(d.getUTCMinutes()));
  },
  IS_BEFORE: ([a, b]) => toDate(a).getTime() < toDate(b).getTime(),
  IS_AFTER: ([a, b]) => toDate(a).getTime() > toDate(b).getTime(),
};

export const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();

function compare(op: string, a: FValue, b: FValue): boolean {
  const bothNum = (typeof a === "number" || a === null) && (typeof b === "number" || b === null);
  if (op === "=" || op === "!=") {
    const eq = bothNum ? (a ?? 0) === (b ?? 0) : toText(a) === toText(b);
    return op === "=" ? eq : !eq;
  }
  const x = bothNum || typeof a === "number" || typeof b === "number" ? toNumber(a) : toText(a);
  const y = bothNum || typeof a === "number" || typeof b === "number" ? toNumber(b) : toText(b);
  switch (op) {
    case "<": return x < y;
    case ">": return x > y;
    case "<=": return x <= y;
    default: return x >= y;
  }
}

export function evaluate(node: FNode, ctx: EvalContext): FValue {
  switch (node.k) {
    case "num": return node.v;
    case "str": return node.v;
    case "bool": return node.v;
    case "ref": return ctx.ref(node.id);
    case "var": return ctx.vars?.[node.name] ?? null;
    case "unary": {
      const v = toNumber(evaluate(node.arg, ctx));
      return node.op === "-" ? -v : v;
    }
    case "bin": {
      const a = evaluate(node.left, ctx);
      const b = evaluate(node.right, ctx);
      switch (node.op) {
        case "&": return toText(a) + toText(b);
        case "+": return toNumber(a) + toNumber(b);
        case "-": return toNumber(a) - toNumber(b);
        case "*": return toNumber(a) * toNumber(b);
        case "/": {
          const d = toNumber(b);
          if (d === 0) throw new FormulaError("Division by zero");
          return toNumber(a) / d;
        }
        default: return compare(node.op, a, b);
      }
    }
    case "call": {
      if (node.name === "IF") {
        const [cond, yes, no] = node.args;
        if (!cond) throw new FormulaError("IF needs a condition");
        return truthy(evaluate(cond, ctx)) ? (yes ? evaluate(yes, ctx) : null) : no ? evaluate(no, ctx) : null;
      }
      if (node.name === "SWITCH") {
        const [subject, ...rest] = node.args;
        const v = toText(evaluate(subject, ctx));
        for (let i = 0; i + 1 < rest.length; i += 2) {
          if (toText(evaluate(rest[i], ctx)) === v) return evaluate(rest[i + 1], ctx);
        }
        return rest.length % 2 === 1 ? evaluate(rest[rest.length - 1], ctx) : null;
      }
      const fn = FUNCTIONS[node.name] as Fn;
      return fn(node.args.map((a) => evaluate(a, ctx)), ctx);
    }
  }
}

/** What kind of value a formula gives, judged from its outermost part (for filters and number alignment). */
export function resultKind(node: FNode): "number" | "checkbox" | "text" {
  switch (node.k) {
    case "num": return "number";
    case "bool": return "checkbox";
    case "unary": return "number";
    case "bin": return ["+", "-", "*", "/"].includes(node.op) ? "number" : node.op === "&" ? "text" : "checkbox";
    case "call":
      if (NUMBER_FNS.has(node.name)) return "number";
      if (BOOL_FNS.has(node.name)) return "checkbox";
      if (node.name === "IF" && node.args.length >= 2) {
        const kinds = node.args.slice(1).map(resultKind);
        return kinds.every((k) => k === kinds[0]) ? kinds[0] : "text";
      }
      return "text";
    default: return "text";
  }
}

const NUMBER_FNS = new Set(["SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "COUNTALL", "ROUND", "ROUNDUP", "ROUNDDOWN", "FLOOR", "CEILING",
  "INT", "ABS", "SQRT", "EXP", "LOG", "POWER", "MOD", "LEN", "VALUE", "FIND", "YEAR", "MONTH", "DAY", "WEEKDAY", "HOUR", "MINUTE", "DATETIME_DIFF"]);
const BOOL_FNS = new Set(["AND", "OR", "NOT", "XOR", "ISBLANK", "IS_BEFORE", "IS_AFTER"]);

/** Formula a rollup uses: its custom one, or the one matching its menu choice. */
export const ROLLUP_PRESET_FORMULAS: Record<string, string> = {
  sum: "SUM(values)", avg: "AVERAGE(values)", min: "MIN(values)", max: "MAX(values)", count: "COUNTALL(values)",
  counta: "COUNTA(values)", concat: "ARRAYJOIN(ARRAYCOMPACT(values))", and: "AND(values)", or: "OR(values)",
};
