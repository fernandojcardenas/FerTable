// Ready-made bases to start from. Each template is a list of ordinary actions applied
// to a new, empty base, with a few sample records so the views have something to show.

import type { Action, CellValue, FieldOptions, FieldType, ViewConfig, ViewType } from "./types";
import { makeChoice } from "./fieldTypes";
import { newId } from "./ids";

export type TemplateInfo = { id: string; name: string; icon: string; description: string };

class Builder {
  actions: Action[] = [];
  private tableFields = new Map<string, Map<string, string>>();
  private tableNames = new Map<string, string>();
  private choiceIds = new Map<string, Map<string, string>>();

  table(name: string, primary = "Name"): string {
    const tableId = newId("tbl"), primaryFieldId = newId("fld"), viewId = newId("viw");
    this.actions.push({ type: "table.create", tableId, name, primaryFieldId, viewId });
    if (primary !== "Name") this.actions.push({ type: "field.update", fieldId: primaryFieldId, name: primary });
    this.tableFields.set(tableId, new Map([[primary, primaryFieldId]]));
    this.tableNames.set(tableId, name);
    return tableId;
  }

  field(tableId: string, name: string, fieldType: FieldType, options: FieldOptions = {}, choices?: string[]): string {
    const fieldId = newId("fld");
    if (choices) {
      const list = choices.map((c, i) => makeChoice(c, i));
      options = { ...options, choices: list };
      this.choiceIds.set(fieldId, new Map(list.map((c) => [c.name, c.id])));
    }
    const inverseFieldId = fieldType === "link" && options.linkedTableId !== tableId ? newId("fld") : undefined;
    this.actions.push({ type: "field.create", fieldId, tableId, name, fieldType, options, inverseFieldId });
    this.tableFields.get(tableId)!.set(name, fieldId);
    // The other side of a link is named after this table.
    if (inverseFieldId) this.tableFields.get(options.linkedTableId!)!.set(this.tableNames.get(tableId)!, inverseFieldId);
    return fieldId;
  }

  f(tableId: string, name: string): string {
    return this.tableFields.get(tableId)!.get(name)!;
  }

  /** A formula written with {Field name} references. */
  formula(tableId: string, name: string, expression: string): string {
    const expr = expression.replace(/\{([^}]+)\}/g, (_, n: string) => `{${this.f(tableId, n)}}`);
    return this.field(tableId, name, "formula", { expression: expr });
  }

  view(tableId: string, name: string, viewType: ViewType, config: Partial<ViewConfig> = {}): string {
    const viewId = newId("viw");
    this.actions.push({ type: "view.create", viewId, tableId, name, viewType });
    if (Object.keys(config).length) this.actions.push({ type: "view.update", viewId, config });
    return viewId;
  }

  /** A record, with values by field name (select options by name, links by record id). */
  row(tableId: string, values: Record<string, CellValue>): string {
    const rowId = newId("rec");
    const cells: Record<string, CellValue> = {};
    for (const [name, v] of Object.entries(values)) {
      const fid = this.f(tableId, name);
      const ch = this.choiceIds.get(fid);
      cells[fid] = ch ? (Array.isArray(v) ? (v as string[]).map((x) => ch.get(x)!) : ch.get(String(v))!) : v;
    }
    this.actions.push({ type: "row.create", rowId, tableId, cells });
    return rowId;
  }
}

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const BUILDERS: Record<string, { info: TemplateInfo; build: (b: Builder) => void }> = {
  projects: {
    info: { id: "projects", name: "Project tracker", icon: "📋", description: "Projects and their tasks, with a board by status and a timeline." },
    build(b) {
      const p = b.table("Projects");
      b.field(p, "Status", "singleSelect", {}, ["Planning", "In progress", "Done"]);
      b.field(p, "Owner", "user");
      b.field(p, "Start", "date");
      b.field(p, "Due", "date");
      b.field(p, "Notes", "longText", { richText: true });
      const t = b.table("Tasks");
      b.field(t, "Project", "link", { linkedTableId: p });
      b.field(t, "Done", "checkbox");
      b.field(t, "Due", "date");
      b.field(t, "Assignee", "user");
      b.field(p, "Task count", "count", { linkFieldId: b.f(p, "Tasks") });
      b.view(p, "Board", "kanban", { kanban: { stackFieldId: b.f(p, "Status") } });
      b.view(p, "Timeline", "timeline", { timeline: { startFieldId: b.f(p, "Start"), endFieldId: b.f(p, "Due"), scale: "week", dependencyFieldId: null } });
      const web = b.row(p, { Name: "Website refresh", Status: "In progress", Start: day(-10), Due: day(20), Notes: "**Goal:** a faster, simpler site.\n- New home page\n- Better search" });
      const launch = b.row(p, { Name: "Spring launch", Status: "Planning", Start: day(15), Due: day(60) });
      b.row(p, { Name: "Customer survey", Status: "Done", Start: day(-40), Due: day(-12) });
      b.row(t, { Name: "Draft new home page", Project: [web], Done: true, Due: day(-2) });
      b.row(t, { Name: "Review search results", Project: [web], Due: day(5) });
      b.row(t, { Name: "Pick launch date", Project: [launch], Due: day(18) });
    },
  },
  crm: {
    info: { id: "crm", name: "Sales CRM", icon: "🤝", description: "Companies, contacts and deals, with a pipeline board." },
    build(b) {
      const co = b.table("Companies");
      b.field(co, "Website", "url");
      b.field(co, "Industry", "singleSelect", {}, ["Software", "Retail", "Health", "Finance"]);
      const ct = b.table("Contacts");
      b.field(ct, "Company", "link", { linkedTableId: co });
      b.field(ct, "Email", "email");
      b.field(ct, "Phone", "phone");
      const d = b.table("Deals");
      b.field(d, "Company", "link", { linkedTableId: co });
      b.field(d, "Stage", "singleSelect", {}, ["Lead", "Qualified", "Proposal", "Won", "Lost"]);
      b.field(d, "Value", "number", { format: "currency", symbol: "$", precision: 0 });
      b.field(d, "Close date", "date");
      b.field(d, "Owner", "user");
      b.view(d, "Pipeline", "kanban", { kanban: { stackFieldId: b.f(d, "Stage") } });
      b.view(d, "Closing soon", "calendar", { calendar: { dateFieldId: b.f(d, "Close date") } });
      const acme = b.row(co, { Name: "Acme Corp", Website: "https://example.com", Industry: "Software" });
      const blue = b.row(co, { Name: "Bluebird Health", Industry: "Health" });
      b.row(ct, { Name: "Dana Lee", Company: [acme], Email: "dana@example.com" });
      b.row(ct, { Name: "Sam Ortiz", Company: [blue], Email: "sam@example.com" });
      b.row(d, { Name: "Acme annual plan", Company: [acme], Stage: "Proposal", Value: 24000, "Close date": day(14) });
      b.row(d, { Name: "Bluebird pilot", Company: [blue], Stage: "Qualified", Value: 8000, "Close date": day(30) });
    },
  },
  content: {
    info: { id: "content", name: "Content calendar", icon: "🗓", description: "Plan posts by channel and publish date, on a calendar." },
    build(b) {
      const p = b.table("Posts", "Title");
      b.field(p, "Channel", "multiSelect", {}, ["Blog", "Newsletter", "Social", "Video"]);
      b.field(p, "Status", "singleSelect", {}, ["Idea", "Drafting", "Scheduled", "Published"]);
      b.field(p, "Publish date", "date");
      b.field(p, "Author", "user");
      b.field(p, "Draft", "longText", { richText: true });
      b.view(p, "Calendar", "calendar", { calendar: { dateFieldId: b.f(p, "Publish date") } });
      b.view(p, "By status", "kanban", { kanban: { stackFieldId: b.f(p, "Status") } });
      b.row(p, { Title: "10 tips for spring", Channel: ["Blog", "Social"], Status: "Drafting", "Publish date": day(7), Draft: "## Outline\n1. Start small\n2. Keep a list" });
      b.row(p, { Title: "Monthly roundup", Channel: ["Newsletter"], Status: "Scheduled", "Publish date": day(3) });
      b.row(p, { Title: "Product walkthrough", Channel: ["Video"], Status: "Idea" });
    },
  },
  inventory: {
    info: { id: "inventory", name: "Inventory", icon: "📦", description: "Items, stock levels and what needs reordering." },
    build(b) {
      const i = b.table("Items");
      b.field(i, "SKU", "barcode");
      b.field(i, "Category", "singleSelect", {}, ["Hardware", "Supplies", "Packaging"]);
      b.field(i, "In stock", "number", { precision: 0 });
      b.field(i, "Reorder at", "number", { precision: 0 });
      b.field(i, "Price", "number", { format: "currency", symbol: "$", precision: 2 });
      b.field(i, "Photo", "attachment");
      b.formula(i, "Reorder?", 'IF({In stock} <= {Reorder at}, "Reorder", "")');
      b.view(i, "Gallery", "gallery");
      b.row(i, { Name: "Shipping boxes (M)", SKU: "BX-200", Category: "Packaging", "In stock": 40, "Reorder at": 50, Price: 0.85 });
      b.row(i, { Name: "Label printer", SKU: "HW-031", Category: "Hardware", "In stock": 3, "Reorder at": 1, Price: 129 });
      b.row(i, { Name: "Packing tape", SKU: "SP-114", Category: "Supplies", "In stock": 120, "Reorder at": 30, Price: 2.5 });
    },
  },
};

export const TEMPLATES: TemplateInfo[] = Object.values(BUILDERS).map((t) => t.info);

/** The actions that build a template, or null for an unknown id. */
export function templateActions(id: string): Action[] | null {
  const t = BUILDERS[id];
  if (!t) return null;
  const b = new Builder();
  t.build(b);
  return b.actions;
}
