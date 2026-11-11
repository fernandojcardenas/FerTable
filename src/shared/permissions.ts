// Who may change what, beyond the base-wide roles: fields and tables can be limited
// to owners or to chosen people, locked views can only be unlocked by owners, and
// only owners change these limits. The server checks this on every change from a
// person; the browser uses the same rules to explain before sending.

import type { Action, BaseState, EditPermission, Field, Role, Table } from "./types";

/** Whether this person passes a permission ("editors" when missing). Owners always do. */
export function allowed(p: EditPermission | undefined, userId: string | null, role: Role): boolean {
  if (role === "owner") return true;
  if (role !== "editor") return false;
  if (!p || p === "editors") return true;
  if (p === "owners") return false;
  return Boolean(userId && p.userIds.includes(userId));
}

export const canEditFieldValues = (f: Field, userId: string | null, role: Role) => allowed(f.editableBy, userId, role);
export const canChangeRecords = (t: Table, userId: string | null, role: Role) => allowed(t.recordsEditableBy, userId, role);

/** Why a person can't make these changes, or null when they can. */
export function permissionProblem(state: BaseState, actions: Action[], userId: string | null, role: Role): string | null {
  const fieldNo = (fieldId: string) => {
    const f = state.fields[fieldId];
    return f && !canEditFieldValues(f, userId, role) ? `You don't have permission to change "${f.name}"` : null;
  };
  const tableNo = (tableId: string | undefined, what: string) => {
    const t = tableId ? state.tables[tableId] : undefined;
    return t && !canChangeRecords(t, userId, role) ? `You don't have permission to ${what} records in "${t.name}"` : null;
  };
  for (const a of actions) {
    let p: string | null = null;
    switch (a.type) {
      case "row.create":
        p = tableNo(a.tableId, "add");
        for (const fid of Object.keys(a.cells ?? {})) p ??= fieldNo(fid);
        break;
      case "row.update":
        for (const fid of Object.keys(a.cells ?? {})) p ??= fieldNo(fid);
        break;
      case "link.add": case "link.remove":
        p = fieldNo(a.fieldId);
        break;
      case "row.delete":
        for (const id of a.rowIds) p ??= tableNo(state.rows[id]?.tableId, "delete");
        break;
      case "table.permissions":
        if (role !== "owner") p = "Only owners can change who may add and delete records";
        break;
      case "field.update":
        if (a.editableBy !== undefined && role !== "owner") p = "Only owners can change who may edit a field";
        break;
      case "view.update": {
        const v = state.views[a.viewId];
        if (v?.config.locked && a.config?.locked === false && role !== "owner") p = "Only owners can unlock a view";
        break;
      }
      case "restore":
        // Undo can't be used to get around a field or table limit.
        for (const [rowId, rp] of Object.entries(a.patch?.rows ?? {})) {
          const row = state.rows[rowId];
          if (rp.kind === "cells") {
            for (const fid of [...Object.keys(rp.cells ?? {}), ...Object.keys(rp.links ?? {})]) p ??= fieldNo(fid);
          } else if (rp.kind === "delete") p ??= tableNo(row?.tableId, "delete");
          else if (rp.kind === "put" && !row) p ??= tableNo(rp.row.tableId, "add");
        }
        break;
    }
    if (p) return p;
  }
  return null;
}
