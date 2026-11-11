"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { BaseClient, ClientSnapshot } from "../store";
import type { Attachment, CellValue, Field, Row } from "@/shared/types";
import { FIELD_TYPES, isImage, rollupKind } from "@/shared/fieldTypes";
import { toText, type FValue } from "@/shared/formula";
import { ButtonCell, RatingStars, UserChips } from "./newFields";
import { RichText } from "./richText";

// ---- shared context for the open base ----

export type BaseUi = {
  client: BaseClient;
  snap: ClientSnapshot;
  openRecord: (rowId: string) => void;
  openFieldDialog: (opts: { tableId: string; fieldId?: string; afterFieldId?: string | null; presetType?: Field["type"] }) => void;
  /** Text to find in the open view ("" = not searching). */
  search: string;
  setSearch: (q: string) => void;
};

export const BaseContext = createContext<BaseUi | null>(null);

export function useBase(): BaseUi {
  const ctx = useContext(BaseContext);
  if (!ctx) throw new Error("useBase outside BaseContext");
  return ctx;
}

// ---- small building blocks ----

export function useClickOutside(ref: React.RefObject<HTMLElement | null>, onOutside: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    const t = setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", handler);
    };
  }, [ref, onOutside, active]);
}

/**
 * A menu or panel that opens from a button. It floats above the page (position: fixed), so a
 * scrolling strip like the table tabs or a phone's toolbar can't clip it. It opens below the
 * button, or above when there isn't room below, and stays inside the window.
 */
export function Popover({ open, onClose, children, align = "left", anchor }: {
  open: boolean; onClose: () => void; children: ReactNode; align?: "left" | "right"; anchor: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  useClickOutside(ref, onClose, open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  useLayoutEffect(() => {
    if (!open) { setPlace(null); return; }
    const GAP = 4, EDGE = 8;
    const update = () => {
      const a = ref.current?.getBoundingClientRect();
      if (!a) return;
      const vw = window.innerWidth, vh = window.innerHeight;
      const w = Math.min(pop.current?.offsetWidth ?? 260, vw - EDGE * 2);
      const h = pop.current?.scrollHeight ?? 0;
      const below = vh - a.bottom - GAP - EDGE, above = a.top - GAP - EDGE;
      const up = h > below && above > below;
      let left = align === "right" ? a.right - w : a.left;
      left = Math.max(EDGE, Math.min(left, vw - EDGE - w));
      setPlace({
        position: "fixed", left, right: "auto", maxWidth: vw - EDGE * 2, overflowY: "auto",
        ...(up ? { top: "auto", bottom: vh - a.top + GAP, maxHeight: above } : { top: a.bottom + GAP, bottom: "auto", maxHeight: below }),
      });
    };
    update();
    // Measure again once the panel has its real size, and follow the button on scroll and resize.
    const raf = requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [open, align]);
  return (
    <div className="popover-anchor" ref={ref}>
      {anchor}
      {open && (
        <div ref={pop} className={`popover ${align === "right" ? "right" : ""}`}
          style={place ?? { position: "fixed", visibility: "hidden", top: 0, left: 0 }}>
          {children}
        </div>
      )}
    </div>
  );
}

export function Dialog({ title, onClose, children, footer, wide }: {
  title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${wide ? "wide" : ""}`} role="dialog" aria-modal="true">
        <div className="dialog-head">
          {title}
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function FieldIcon({ field }: { field: Field }) {
  return <span className="field-type-icon" title={FIELD_TYPES[field.type].label}>{FIELD_TYPES[field.type].icon}</span>;
}

export function ChoiceChip({ name, color, onRemove }: { name: string; color: string; onRemove?: () => void }) {
  return (
    <span className={`chip c-${color}`}>
      {name}
      {onRemove && <button className="chip-x" onClick={(e) => { e.stopPropagation(); onRemove(); }} aria-label={`Remove ${name}`}>✕</button>}
    </span>
  );
}

/** Read-only rendering of a cell (chips for selects and links, a box for checkboxes). */
/** Lookup values as chips; select values keep their colors, and each chip says which record it came from. */
function LookupContent({ row, field, detailed }: { row: Row; field: Field; detailed?: boolean }) {
  const { snap } = useBase();
  const c = snap.computer;
  const groups = c.lookupGroups(row, field);
  const target = snap.state.fields[field.options.targetFieldId ?? ""];
  const choices = target && (target.type === "singleSelect" || target.type === "multiSelect") ? target.options.choices ?? [] : null;
  const chip = (v: FValue, key: string, from: string) => {
    const text = toText(v);
    const ch = choices?.find((x) => x.name === text);
    return ch
      ? <span key={key} title={`From ${from}`}><ChoiceChip name={ch.name} color={ch.color} /></span>
      : <span key={key} className="chip" title={`From ${from}`}>{text}</span>;
  };
  if (detailed) {
    const withValues = groups.filter((g) => g.values.length);
    if (!withValues.length) return null;
    return (
      <div className="lookup-groups">
        {withValues.map((g) => (
          <div key={g.rowId} className="lookup-group">
            <span className="muted small">{g.name || "(unnamed)"}</span>
            <span>{g.values.map((v, i) => chip(v, `${g.rowId}:${i}`, g.name))}</span>
          </div>
        ))}
      </div>
    );
  }
  return <>{groups.flatMap((g) => g.values.map((v, i) => chip(v, `${g.rowId}:${i}`, g.name || "(unnamed)")))}</>;
}

export function CellContent({ row, field, detailed }: { row: Row; field: Field; detailed?: boolean }) {
  const { snap } = useBase();
  const c = snap.computer;
  const raw: CellValue | undefined = row.cells[field.id];
  if (c.isError(row, field)) return <span className="error" title={c.isError(row, field) ?? ""}>#ERROR</span>;
  switch (field.type) {
    case "checkbox":
      return <span className={`check ${raw ? "on" : ""}`}>{raw ? "✓" : ""}</span>;
    case "singleSelect": {
      const ch = field.options.choices?.find((x) => x.id === raw);
      return ch ? <ChoiceChip name={ch.name} color={ch.color} /> : null;
    }
    case "multiSelect":
      return (
        <>
          {((raw as string[] | null) ?? []).map((id) => {
            const ch = field.options.choices?.find((x) => x.id === id);
            return ch ? <ChoiceChip key={id} name={ch.name} color={ch.color} /> : null;
          })}
        </>
      );
    case "attachment":
      return (
        <span className="att-cell">
          {((raw as Attachment[] | null) ?? []).map((a) => <AttachmentPreview key={a.id} a={a} />)}
        </span>
      );
    case "link":
      return (
        <>
          {((raw as string[] | null) ?? []).filter((id) => snap.state.rows[id]).map((id) => (
            <span key={id} className="chip link">{c.primaryName(id)}</span>
          ))}
        </>
      );
    case "lookup":
      return <LookupContent row={row} field={field} detailed={detailed} />;
    case "rating":
      return typeof raw === "number" ? <RatingStars field={field} value={raw} /> : null;
    case "user":
      return Array.isArray(raw) ? <UserChips ids={raw as string[]} /> : null;
    case "button":
      return <ButtonCell row={row} field={field} />;
    case "longText":
      if (field.options.richText) return <RichText text={typeof raw === "string" ? raw : ""} inline={!detailed} />;
      return <>{c.display(row, field)}</>;
    case "url": {
      const text = c.display(row, field);
      return text ? <a href={/^https?:\/\//.test(text) ? text : `https://${text}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{text}</a> : null;
    }
    default:
      return <>{c.display(row, field)}</>;
  }
}

export const isNumeric = (f: Field) =>
  f.type === "number" || f.type === "count" || f.type === "autoNumber" || f.type === "duration" || (f.type === "rollup" && rollupKind(f) === "number");

/** Small preview of an attachment: the image itself, or a file-type badge. */
export function AttachmentPreview({ a, size = 22 }: { a: Attachment; size?: number }) {
  if (isImage(a)) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={a.url} alt={a.name} title={a.name} className="att-thumb" style={{ height: size, maxWidth: size * 2 }} loading="lazy" />;
  }
  const ext = (a.name.split(".").pop() ?? "").slice(0, 4).toUpperCase() || "FILE";
  return <span className="att-file" title={a.name} style={{ height: size }}>{ext}</span>;
}
