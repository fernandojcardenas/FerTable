import type { Action } from "./types";
import { newId } from "./ids";

/** Actions that create a new table with a few useful starting fields and empty rows. */
export function starterTableActions(name: string, emptyRows = 3): { tableId: string; viewId: string; actions: Action[] } {
  const tableId = newId("tbl");
  const viewId = newId("viw");
  const actions: Action[] = [
    { type: "table.create", tableId, name, primaryFieldId: newId("fld"), viewId },
    { type: "field.create", fieldId: newId("fld"), tableId, name: "Notes", fieldType: "longText" },
    {
      type: "field.create", fieldId: newId("fld"), tableId, name: "Status", fieldType: "singleSelect",
      options: {
        choices: [
          { id: newId("opt"), name: "Todo", color: "red" },
          { id: newId("opt"), name: "In progress", color: "yellow" },
          { id: newId("opt"), name: "Done", color: "green" },
        ],
      },
    },
  ];
  for (let i = 0; i < emptyRows; i++) actions.push({ type: "row.create", rowId: newId("rec"), tableId });
  return { tableId, viewId, actions };
}
