// Core data model shared by the browser and the server.

export type FieldType =
  | "text"
  | "longText"
  | "number"
  | "checkbox"
  | "singleSelect"
  | "multiSelect"
  | "date"
  | "attachment"
  | "email"
  | "url"
  | "phone"
  | "link"
  | "lookup"
  | "rollup"
  | "count"
  | "formula"
  | "createdTime"
  | "autoNumber";

export type SelectChoice = { id: string; name: string; color: string };

export type NumberFormat = "decimal" | "integer" | "currency" | "percent";

export type RollupFn = "sum" | "avg" | "min" | "max" | "count" | "counta" | "concat" | "and" | "or" | "formula";

export type FieldOptions = {
  precision?: number;
  format?: NumberFormat;
  symbol?: string;
  choices?: SelectChoice[];
  includeTime?: boolean;
  linkedTableId?: string;
  inverseFieldId?: string | null;
  linkFieldId?: string;
  targetFieldId?: string;
  fn?: RollupFn;
  /** Formula fields, and rollups with fn "formula" (which may use `values`). */
  expression?: string;
};

export type Field = {
  id: string;
  tableId: string;
  name: string;
  type: FieldType;
  options: FieldOptions;
  description?: string;
};

/** A file stored by the server. `url` always points at /api/files/. */
export type Attachment = { id: string; name: string; size: number; type: string; url: string };

export type CellValue = string | number | boolean | string[] | Attachment[] | null;

export type Row = {
  id: string;
  tableId: string;
  cells: Record<string, CellValue>;
  createdAt: string;
  autoNumber: number;
};

export type Table = {
  id: string;
  name: string;
  primaryFieldId: string;
  fieldOrder: string[];
  rowOrder: string[];
  viewOrder: string[];
  nextAutoNumber: number;
};

export type FormConfig = {
  title: string;
  description: string;
  fieldIds: string[];
  submitLabel: string;
  /** Questions that must be answered. Missing on older forms: then only the primary field is required. */
  requiredFieldIds?: string[];
  /** Question text to show instead of the field name. */
  labels?: Record<string, string>;
  /** Help text under a question (falls back to the field's description). */
  help?: Record<string, string>;
  /** Shown after someone submits. */
  thankYou?: string;
  /** Secret code for the public link (/f/<code>); unset = members only. */
  publicToken?: string | null;
};

export type ViewType = "grid" | "kanban" | "calendar" | "gallery" | "form";

export type FilterCondition = { id: string; fieldId: string; operator: string; value: unknown };
export type Filters = { conjunction: "and" | "or"; conditions: FilterCondition[] };
export type SortSpec = { fieldId: string; direction: "asc" | "desc" };

export type ViewConfig = {
  hiddenFieldIds: string[];
  filters: Filters;
  sorts: SortSpec[];
  groupBy: SortSpec[];
  kanban?: { stackFieldId: string | null; coverFieldId?: string | null };
  calendar?: { dateFieldId: string | null };
  gallery?: { coverFieldId: string | null };
  form?: FormConfig;
  fieldWidths?: Record<string, number>;
};

export type View = {
  id: string;
  tableId: string;
  name: string;
  type: ViewType;
  config: ViewConfig;
};

export type AutomationTrigger =
  | { type: "recordCreated"; tableId: string }
  | { type: "recordUpdated"; tableId: string; watchFieldIds: string[] }
  | { type: "recordMatches"; tableId: string; filters: Filters };

// Step values are templates: literal text, with {fieldId} replaced by the
// trigger record's value for that field.
export type AutomationStep =
  | { type: "updateRecord"; values: Record<string, string> }
  | { type: "createRecord"; tableId: string; values: Record<string, string> }
  /** to/subject/body are templates too; `to` is a comma-separated list of addresses. */
  | { type: "sendEmail"; to: string; subject: string; body: string };

export type Automation = {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  steps: AutomationStep[];
};

export type BaseInfo = { id: string; name: string; txn: number };

export type BaseState = {
  base: BaseInfo;
  tableOrder: string[];
  tables: Record<string, Table>;
  fields: Record<string, Field>;
  rows: Record<string, Row>;
  views: Record<string, View>;
  automations: Record<string, Automation>;
};

// ---- Actions: every change to a base is one of these ----

export type Action =
  | { type: "table.create"; tableId: string; name: string; primaryFieldId: string; viewId: string }
  | { type: "table.rename"; tableId: string; name: string }
  | { type: "table.delete"; tableId: string }
  | { type: "field.create"; fieldId: string; tableId: string; name: string; fieldType: FieldType; options?: FieldOptions; inverseFieldId?: string; afterFieldId?: string | null }
  | { type: "field.update"; fieldId: string; name?: string; fieldType?: FieldType; options?: FieldOptions; description?: string; inverseFieldId?: string }
  | { type: "field.delete"; fieldId: string }
  | { type: "field.move"; fieldId: string; toIndex: number }
  | { type: "row.create"; rowId: string; tableId: string; cells?: Record<string, CellValue>; createdAt?: string; afterRowId?: string | null }
  | { type: "row.update"; rowId: string; cells: Record<string, CellValue> }
  | { type: "row.delete"; rowIds: string[] }
  /** Move rows (keeping their relative order) to just after afterRowId, or to the top when null. */
  | { type: "row.move"; rowIds: string[]; afterRowId: string | null }
  /**
   * Link or unlink records in one link cell, leaving its other links alone, so two
   * people editing the same cell at once don't overwrite each other.
   */
  | { type: "link.add"; rowId: string; fieldId: string; linkedRowIds: string[] }
  | { type: "link.remove"; rowId: string; fieldId: string; linkedRowIds: string[] }
  | { type: "view.create"; viewId: string; tableId: string; name: string; viewType: ViewType; copyFromViewId?: string | null }
  | { type: "view.update"; viewId: string; name?: string; config?: Partial<ViewConfig> }
  | { type: "view.delete"; viewId: string }
  | { type: "base.rename"; name: string }
  | { type: "automation.upsert"; automation: Automation }
  | { type: "automation.delete"; automationId: string }
  // Puts things back the way they were. Used by undo and redo.
  | { type: "restore"; patch: RestorePatch };

// ---- Undo/redo patches ----

/** Change an ordered id list without replacing it, so other people's additions survive. */
export type OrderPatch = { remove: string[]; insert: { id: string; after: string | null }[] };

export type RowPatch =
  | { kind: "delete" }
  | { kind: "put"; row: Row }
  /**
   * Set only these cells (null = empty), leaving the rest of the row alone.
   * Link cells go in `links` as add/remove lists, so links other people made since are kept.
   */
  | { kind: "cells"; cells: Record<string, CellValue>; links?: Record<string, OrderPatch> };

export type TablePatch =
  | { kind: "put"; table: Table }
  | { kind: "delete" }
  | { kind: "change"; name?: string; rowOrder?: OrderPatch; fieldOrder?: OrderPatch; viewOrder?: OrderPatch };

export type RestorePatch = {
  baseName?: string;
  tableOrder?: OrderPatch;
  tables?: Record<string, TablePatch>;
  fields?: Record<string, Field | null>;
  views?: Record<string, View | null>;
  automations?: Record<string, Automation | null>;
  rows?: Record<string, RowPatch>;
};

// ---- Wire messages ----

/** owner > editor > commenter > viewer. Commenters can read and comment but not change data. */
export type Role = "owner" | "editor" | "commenter" | "viewer";

export type Comment = {
  id: string;
  rowId: string;
  userId: string;
  userName: string;
  /** Text; mentions are written as @[usrXXXXXXXXXXXXXX]. */
  body: string;
  createdAt: string;
  editedAt: string | null;
};

export type ActionBatch = {
  txn: number;
  /** Who made the change (null for automations and system changes). */
  userId: string | null;
  /** Server time for this transaction; the reducer uses it so every client computes the same result. */
  at: string;
  actions: Action[];
  clientId: string | null;
  requestId: string | null;
  source: "client" | "automation";
};

export type ServerMessage =
  | { type: "hello"; txn: number }
  | { type: "batch"; batch: ActionBatch }
  | { type: "resync"; reason: string }
  /** Your access changed while connected (null = removed). */
  | { type: "access"; role: Role | null }
  /** Comments live outside the action log; they arrive as their own events. */
  | { type: "comment"; event: "created" | "updated" | "deleted"; comment: Comment }
  | { type: "pong" };
