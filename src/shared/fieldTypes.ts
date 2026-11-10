import type { Attachment, CellValue, Field, FieldOptions, FieldType, SelectChoice } from "./types";
import { isId, newId } from "./ids";
import { parseFormula, resultKind } from "./formula";

export type FieldTypeInfo = {
  label: string;
  icon: string;
  computed: boolean;
  description: string;
};

export const FIELD_TYPES: Record<FieldType, FieldTypeInfo> = {
  text: { label: "Single line text", icon: "A", computed: false, description: "A short piece of text." },
  longText: { label: "Long text", icon: "¶", computed: false, description: "Multiple lines of text." },
  number: { label: "Number", icon: "#", computed: false, description: "A number, currency or percent." },
  checkbox: { label: "Checkbox", icon: "☑", computed: false, description: "Checked or not." },
  singleSelect: { label: "Single select", icon: "◉", computed: false, description: "Pick one option." },
  multiSelect: { label: "Multiple select", icon: "☰", computed: false, description: "Pick several options." },
  date: { label: "Date", icon: "📅", computed: false, description: "A date, optionally with time." },
  attachment: { label: "Attachment", icon: "📎", computed: false, description: "Files and images." },
  email: { label: "Email", icon: "@", computed: false, description: "An email address." },
  url: { label: "URL", icon: "🔗", computed: false, description: "A web link." },
  phone: { label: "Phone", icon: "☎", computed: false, description: "A phone number." },
  link: { label: "Link to another record", icon: "↔", computed: false, description: "Connect rows in another table." },
  lookup: { label: "Lookup", icon: "⤷", computed: true, description: "Show a field from linked records." },
  rollup: { label: "Rollup", icon: "Σ", computed: true, description: "Summarize a field from linked records." },
  count: { label: "Count", icon: "№", computed: true, description: "Count linked records." },
  formula: { label: "Formula", icon: "ƒ", computed: true, description: "Compute a value from other fields." },
  createdTime: { label: "Created time", icon: "⏱", computed: true, description: "When the row was created." },
  autoNumber: { label: "Autonumber", icon: "1²", computed: true, description: "A number that counts up per row." },
  rating: { label: "Rating", icon: "★", computed: false, description: "A score out of a few stars." },
  duration: { label: "Duration", icon: "⏲", computed: false, description: "A length of time, like 1:30." },
  barcode: { label: "Barcode", icon: "▥", computed: false, description: "A barcode or QR code value." },
  user: { label: "User", icon: "👤", computed: false, description: "People in this base." },
  button: { label: "Button", icon: "▣", computed: true, description: "Open a link or run an automation." },
  lastModifiedTime: { label: "Last modified time", icon: "🕘", computed: true, description: "When the record last changed." },
  lastModifiedBy: { label: "Last modified by", icon: "✍", computed: true, description: "Who last changed the record." },
  ai: { label: "AI", icon: "✦", computed: true, description: "Text written by AI from a prompt." },
};

export const FIELD_TYPE_ORDER: FieldType[] = [
  "text", "longText", "number", "checkbox", "singleSelect", "multiSelect", "date", "attachment",
  "email", "url", "phone", "rating", "duration", "barcode", "user", "link", "lookup", "rollup", "count", "formula",
  "ai", "button", "createdTime", "lastModifiedTime", "lastModifiedBy", "autoNumber",
];

export const CHOICE_COLORS = ["blue", "cyan", "teal", "green", "yellow", "orange", "red", "pink", "purple", "gray"];

export function isComputed(type: FieldType): boolean {
  return FIELD_TYPES[type].computed;
}

export function defaultOptions(type: FieldType): FieldOptions {
  switch (type) {
    case "number":
      return { precision: 0, format: "decimal" };
    case "singleSelect":
    case "multiSelect":
      return { choices: [] };
    case "date":
      return { includeTime: false };
    case "rollup":
      return { fn: "sum" };
    case "formula":
      return { expression: "" };
    case "rating":
      return { max: 5 };
    case "duration":
      return { durationFormat: "h:mm" };
    case "user":
      return { multiple: false };
    case "button":
      return { button: { label: "Open", kind: "url", url: "" } };
    case "ai":
      return { prompt: "" };
    default:
      return {};
  }
}

export function makeChoice(name: string, index: number): SelectChoice {
  return { id: newId("opt"), name, color: CHOICE_COLORS[index % CHOICE_COLORS.length] };
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

/** Normalize a value someone wants to store in a cell. Returns null for "empty". */
export function coerceValue(field: Field, value: unknown): CellValue {
  if (isBlank(value)) return null;
  switch (field.type) {
    case "text":
    case "email":
    case "url":
    case "phone":
      return String(value).replace(/\n/g, " ");
    case "longText":
      return String(value);
    case "number": {
      const n = typeof value === "number" ? value : parseFloat(String(value).replace(/[^0-9.eE+-]/g, ""));
      if (!Number.isFinite(n)) return null;
      const p = field.options.format === "integer" ? 0 : field.options.precision ?? 8;
      return Number(n.toFixed(Math.min(Math.max(p, 0), 8)));
    }
    case "checkbox":
      if (typeof value === "string") return ["true", "yes", "1", "checked", "x"].includes(value.trim().toLowerCase());
      return Boolean(value) || null;
    case "singleSelect": {
      const id = Array.isArray(value) ? value[0] : String(value);
      return (field.options.choices ?? []).some((c) => c.id === id) ? id : null;
    }
    case "multiSelect": {
      const ids = (Array.isArray(value) ? value : [value]).map(String);
      const valid = new Set((field.options.choices ?? []).map((c) => c.id));
      const out = [...new Set(ids.filter((id) => valid.has(id)))];
      return out.length ? out : null;
    }
    case "date": {
      const s = String(value);
      const d = new Date(s.length === 10 ? `${s}T00:00:00.000Z` : s);
      if (Number.isNaN(d.getTime())) return null;
      return field.options.includeTime ? d.toISOString() : d.toISOString().slice(0, 10);
    }
    case "attachment": {
      const list = (Array.isArray(value) ? value : [value]).filter(isAttachment).map((a) => ({
        id: a.id, name: a.name.slice(0, 255), size: a.size, type: a.type.slice(0, 100), url: a.url,
      }));
      const seen = new Set<string>();
      const out = list.filter((a) => !seen.has(a.id) && seen.add(a.id));
      return out.length ? out : null;
    }
    case "link": {
      const ids = (Array.isArray(value) ? value : [value]).map(String).filter((id) => id.startsWith("rec"));
      const out = [...new Set(ids)];
      return out.length ? out : null;
    }
    case "rating": {
      const n = Math.round(typeof value === "number" ? value : parseFloat(String(value)));
      const max = Math.min(Math.max(field.options.max ?? 5, 1), 10);
      return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : null;
    }
    case "duration": {
      const secs = typeof value === "number" ? value : parseDuration(String(value));
      return secs === null || !Number.isFinite(secs) || secs < 0 ? null : Math.round(secs);
    }
    case "barcode":
      return String(value).replace(/[\r\n]+/g, " ").slice(0, 500);
    case "user": {
      const ids = [...new Set((Array.isArray(value) ? value : [value]).map(String).filter((id) => isId(id, "usr")))];
      const out = field.options.multiple ? ids : ids.slice(0, 1);
      return out.length ? out : null;
    }
    default:
      return null; // computed fields never store values
  }
}

/** Find choice IDs for text values, adding new choices when needed. Used for type changes and automations. */
export function choicesFromText(field: Field, texts: string[]): { choices: SelectChoice[]; ids: string[] } {
  const choices = [...(field.options.choices ?? [])];
  const ids: string[] = [];
  for (const raw of texts) {
    const name = raw.trim();
    if (!name) continue;
    let c = choices.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!c) {
      c = makeChoice(name, choices.length);
      choices.push(c);
    }
    ids.push(c.id);
  }
  return { choices, ids };
}

/** Only well-formed attachments that point at this server's file endpoint are accepted. */
export function isAttachment(v: unknown): v is Attachment {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return isId(a.id, "att") && typeof a.name === "string" && typeof a.size === "number" && typeof a.type === "string"
    && typeof a.url === "string" && a.url.startsWith(`/api/files/${a.id}/`);
}

export function isImage(a: Attachment): boolean {
  return /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(a.type);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** What a rollup gives: a number, yes/no, or text (a custom formula is judged by its outermost part). */
export function rollupKind(field: Field): "number" | "checkbox" | "text" {
  const fn = field.options.fn ?? "sum";
  if (fn === "formula") {
    try { return resultKind(parseFormula(field.options.expression ?? "", { vars: ["VALUES"] })); } catch { return "text"; }
  }
  return fn === "concat" ? "text" : fn === "and" || fn === "or" ? "checkbox" : "number";
}

/** "1:30" → 5400 s, "1:02:03" → 3723 s, "90" → 90 minutes. Returns null when it isn't a duration. */
export function parseDuration(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(":");
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p.trim()))) return null;
  const n = parts.map((p) => parseFloat(p));
  if (n.length === 1) return n[0] * 60;
  if (n.length === 2) return n[0] * 3600 + n[1] * 60;
  return n[0] * 3600 + n[1] * 60 + n[2];
}

/** 5400 → "1:30" (or "1:30:00" with seconds). */
export function formatDuration(secs: number, format: "h:mm" | "h:mm:ss" = "h:mm"): string {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  return format === "h:mm:ss" ? `${h}:${mm}:${String(sec).padStart(2, "0")}` : `${h}:${mm}`;
}
