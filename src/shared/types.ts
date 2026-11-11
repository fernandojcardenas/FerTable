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
  | "autoNumber"
  | "rating"
  | "duration"
  | "barcode"
  | "user"
  | "button"
  | "lastModifiedTime"
  | "lastModifiedBy"
  | "createdBy";

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
  /** Rating: highest score (1–10). */
  max?: number;
  /** Duration display. */
  durationFormat?: "h:mm" | "h:mm:ss";
  /** User fields: allow several people. */
  multiple?: boolean;
  /** Button fields: what a click does. `url` may use {fldId} placeholders. */
  button?: { label: string; kind: "url" | "automation"; url?: string; automationId?: string };
  /** Long text: allow formatting (bold, italic, lists, links, headings), stored as Markdown. */
  richText?: boolean;
};

/** Who may change a field's values, or add and delete a table's records. "editors" = anyone who can edit the base. */
export type EditPermission = "editors" | "owners" | { userIds: string[] };

export type ButtonConfig = NonNullable<FieldOptions["button"]>;

export type Field = {
  id: string;
  tableId: string;
  name: string;
  type: FieldType;
  options: FieldOptions;
  description?: string;
  /** In a synced table: the source field this one copies (read-only here). */
  syncSourceFieldId?: string;
  /** Who can change this field's values (missing = everyone who can edit the base). */
  editableBy?: EditPermission;
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
  /** Who created the record (null = automation, form or sync; missing on records made before this was kept). */
  createdBy?: string | null;
  /** When the record last changed and who changed it (null = automation or form). */
  modifiedAt?: string;
  modifiedBy?: string | null;
  /** In a synced table: the source record this row copies. */
  sourceRowId?: string;
};

/** Base members' names, sent with a snapshot so user fields can show names. */
export type People = Record<string, { name: string; email: string }>;

export type Table = {
  id: string;
  name: string;
  primaryFieldId: string;
  fieldOrder: string[];
  rowOrder: string[];
  viewOrder: string[];
  nextAutoNumber: number;
  /** Set when this table copies a view of a table in another base. */
  sync?: TableSync;
  /** Who can add and delete records (missing = everyone who can edit the base). */
  recordsEditableBy?: EditPermission;
};

/** A read-only copy of a view in another base, kept up to date by the server. */
export type TableSync = {
  /** "base" copies a view of another base; "url" reads a CSV file or a Google Sheet. Missing = "base". */
  kind?: "base" | "url";
  sourceBaseId: string;
  sourceTableId: string;
  sourceViewId: string;
  /** Names to show ("Base › Table › View"); refreshed on each sync. */
  sourceLabel: string;
  /** The person who set it up; the sync reads the source with their access. */
  createdBy: string;
  lastSyncAt: string | null;
  error: string | null;
};

/** One synced field: its id here, the source field, and how it's stored here. */
export type SyncFieldDef = { fieldId: string; sourceFieldId: string; name: string; fieldType: FieldType; options: FieldOptions };

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

export type ViewType = "grid" | "kanban" | "calendar" | "gallery" | "form" | "timeline" | "list";

/** A summary shown under a grid column. */
export type SummaryFn =
  | "filled" | "empty" | "percentFilled" | "percentEmpty" | "unique"
  | "sum" | "avg" | "median" | "min" | "max" | "range"
  | "checked" | "unchecked" | "percentChecked"
  | "earliest" | "latest" | "dateRange";

/** Record coloring: by a single select's option colors, or by rules (the first matching rule wins). */
export type RecordColoring =
  | { mode: "select"; fieldId: string }
  | { mode: "conditions"; rules: { id: string; color: string; filters: Filters }[] };

export type RowHeight = "short" | "medium" | "tall" | "extraTall";

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
  rowHeight?: RowHeight;
  /** Grid columns that stay put while scrolling sideways, primary field included (1–5). */
  frozenCount?: number;
  /** Grid footer summaries, by field id. */
  summaries?: Record<string, SummaryFn>;
  colors?: RecordColoring | null;
  /** Timeline / Gantt: bars from a start date to an end date (or one day), optional dependency arrows. */
  timeline?: { startFieldId: string | null; endFieldId: string | null; scale: "day" | "week" | "month"; dependencyFieldId: string | null };
  /** List view: show each record's linked records nested under it. */
  list?: { nestFieldId: string | null };
  /** Secret code for a read-only public link to this view (/v/<code>); unset = members only. */
  shareToken?: string | null;
  /** Locked views can't be changed until an owner unlocks them. */
  locked?: boolean;
};

export type View = {
  id: string;
  tableId: string;
  name: string;
  type: ViewType;
  config: ViewConfig;
  /** A personal view: only this person sees it in the list and can change it. */
  personalFor?: string | null;
};

export type AutomationTrigger =
  | { type: "recordCreated"; tableId: string }
  | { type: "recordUpdated"; tableId: string; watchFieldIds: string[] }
  | { type: "recordMatches"; tableId: string; filters: Filters }
  /** A record was created through a form (a member's form view or a public link); null = any form. */
  | { type: "formSubmitted"; tableId: string; viewId: string | null }
  /** A record starts showing in a view (it now matches the view's filters). */
  | { type: "enteredView"; tableId: string; viewId: string }
  /**
   * On a schedule, in UTC. With a view, the steps run once for each record in it (up to 100);
   * without one they run once with no record.
   */
  | { type: "schedule"; tableId: string; every: "hour" | "day" | "week"; minute: number; hourUtc: number; weekdayUtc: number; viewId: string | null };

// Step values are templates: literal text, with {fieldId} replaced by the
// current record's value for that field (or the trigger record's, for its fields).
export type AutomationStep =
  | { type: "updateRecord"; values: Record<string, string> }
  | { type: "createRecord"; tableId: string; values: Record<string, string> }
  /** to/subject/body are templates too; `to` is a comma-separated list of addresses. Works with Gmail through SMTP_URL. */
  | { type: "sendEmail"; to: string; subject: string; body: string }
  /** Run `then` when the current record matches the conditions, otherwise `otherwise`. */
  | { type: "condition"; filters: Filters; then: AutomationStep[]; otherwise: AutomationStep[] }
  /** Run the steps once for each record linked in this field (the linked record becomes the current record). */
  | { type: "forEach"; linkFieldId: string; steps: AutomationStep[] }
  /** JavaScript run in a sandbox: sees `record`, may return { "Field name": value } to update it. */
  | { type: "script"; code: string }
  /** Post a message to Slack through a saved incoming-webhook connection. */
  | { type: "slack"; connectionId: string; text: string }
  /** Add a row to a Google Sheet through a saved Apps Script web app connection. */
  | { type: "sheets"; connectionId: string; columns: string[] }
  /** POST JSON to a saved webhook connection; `body` is a template. */
  | { type: "webhook"; connectionId: string; body: string };

/** Where a connection posts. The URL itself stays on the server. */
export type ConnectionKind = "slack" | "sheets" | "webhook";
export type ConnectionInfo = { id: string; kind: ConnectionKind; name: string; host: string };

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
  /** Interface pages (dashboards). */
  pages: Record<string, InterfacePage>;
  /** Members' names (not saved with the base; filled in by the server). */
  people?: People;
};

// ---- Interfaces: dashboard pages built from elements on a 12-column grid ----

export type Aggregate = "count" | "sum" | "avg" | "min" | "max";
/** Where an element's records come from: a table, optionally narrowed by one of its views. */
export type ElementSource = { tableId: string; viewId: string | null };
type Box = { id: string; x: number; y: number; w: number; h: number; title: string };
export type PageElement = Box & (
  | { kind: "number"; source: ElementSource; fn: Aggregate; fieldId: string | null }
  | { kind: "chart"; source: ElementSource; chartType: "bar" | "line" | "pie"; groupFieldId: string; fn: Aggregate; fieldId: string | null }
  | { kind: "list"; source: ElementSource; fieldIds: string[]; limit: number }
  | { kind: "map"; source: ElementSource; locationFieldId: string; lngFieldId: string | null; labelFieldId: string | null }
  | { kind: "text"; text: string }
  | { kind: "button"; label: string; action: { type: "url"; url: string } | { type: "automation"; automationId: string } | { type: "view"; viewId: string } }
);
/** A filter people viewing a dashboard can change; it narrows every element that reads the same table. */
export type PageControl = { id: string; tableId: string; fieldId: string };

/** Print layouts place record fields on a sheet of paper (positions and sizes in millimetres). */
export type PrintItem = {
  id: string; x: number; y: number; w: number; h: number;
  /** field: a field's value; text: fixed text where {Field name} is filled in; image: the first image of an attachment field; line: a rule. */
  kind: "field" | "text" | "image" | "line";
  fieldId?: string | null; text?: string; size: number; bold: boolean; label: boolean; align: "left" | "center" | "right";
};

export type InterfacePage = {
  id: string;
  name: string;
  elements: PageElement[];
  /** dashboard (default): elements on a grid. record: pick a record and see its fields. print: a printable layout. */
  kind?: "dashboard" | "record" | "print";
  /** Record and print pages: which table, and (record pages) which fields to show. */
  tableId?: string | null;
  viewId?: string | null;
  fieldIds?: string[];
  /** Print pages: the sheet and what goes on it. */
  paper?: "a4" | "letter";
  items?: PrintItem[];
  /** Dashboard filters viewers can change. */
  controls?: PageControl[];
  /** Secret code for a read-only public link (/i/<code>); unset = members only. */
  shareToken?: string | null;
};

// ---- Actions: every change to a base is one of these ----

export type Action =
  | { type: "table.create"; tableId: string; name: string; primaryFieldId: string; viewId: string; sync?: TableSync }
  | { type: "table.rename"; tableId: string; name: string }
  | { type: "table.permissions"; tableId: string; recordsEditableBy: EditPermission | null }
  | { type: "table.delete"; tableId: string }
  | { type: "field.create"; fieldId: string; tableId: string; name: string; fieldType: FieldType; options?: FieldOptions; inverseFieldId?: string; afterFieldId?: string | null }
  | { type: "field.update"; fieldId: string; name?: string; fieldType?: FieldType; options?: FieldOptions; description?: string; inverseFieldId?: string; editableBy?: EditPermission | null }
  | { type: "field.delete"; fieldId: string }
  | { type: "field.move"; fieldId: string; toIndex: number }
  | { type: "row.create"; rowId: string; tableId: string; cells?: Record<string, CellValue>; createdAt?: string; afterRowId?: string | null; formViewId?: string }
  | { type: "row.update"; rowId: string; cells: Record<string, CellValue> }
  | { type: "row.delete"; rowIds: string[] }
  /**
   * The server copies a source view into a synced table (clients can't send this):
   * fields to add, change or drop, rows to add or change (matched by source record), and rows to remove.
   */
  | { type: "sync.apply"; tableId: string; fields: SyncFieldDef[]; removeFieldIds: string[];
      upserts: { rowId: string; sourceRowId: string; cells: Record<string, CellValue> }[]; deleteRowIds: string[];
      sourceLabel: string; error: string | null }
  /** Move rows (keeping their relative order) to just after afterRowId, or to the top when null. */
  | { type: "row.move"; rowIds: string[]; afterRowId: string | null }
  /**
   * Link or unlink records in one link cell, leaving its other links alone, so two
   * people editing the same cell at once don't overwrite each other.
   */
  | { type: "link.add"; rowId: string; fieldId: string; linkedRowIds: string[] }
  | { type: "link.remove"; rowId: string; fieldId: string; linkedRowIds: string[] }
  | { type: "view.create"; viewId: string; tableId: string; name: string; viewType: ViewType; copyFromViewId?: string | null; personal?: boolean }
  | { type: "view.update"; viewId: string; name?: string; config?: Partial<ViewConfig> }
  | { type: "view.delete"; viewId: string }
  | { type: "base.rename"; name: string }
  | { type: "automation.upsert"; automation: Automation }
  | { type: "automation.delete"; automationId: string }
  | { type: "page.upsert"; page: InterfacePage }
  | { type: "page.delete"; pageId: string }
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
  pages?: Record<string, InterfacePage | null>;
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
  source: "client" | "automation" | "sync" | "api";
};

export type ServerMessage =
  | { type: "hello"; txn: number }
  | { type: "batch"; batch: ActionBatch }
  | { type: "resync"; reason: string }
  /** Something for you in the notifications bell. */
  | { type: "notification" }
  /** Your access changed while connected (null = removed). */
  | { type: "access"; role: Role | null }
  /** Comments live outside the action log; they arrive as their own events. */
  | { type: "comment"; event: "created" | "updated" | "deleted"; comment: Comment }
  | { type: "pong" };
