# FerTable — product & architecture spec

FerTable is an original spreadsheet-database app. Its behavior is modeled on
what I observed in Airtable (see `FINDINGS.md`), but every name, API, schema
and line of code here is my own. Nothing is copied from Airtable's code.

Each section marks where it came from:
**[obs]** follows observed Airtable behavior · **[mine]** my own design choice.

---

## 1. Goals

- A base holds tables. Each table has typed fields, rows and several views.
- Edits show instantly, sync live to every open window, and survive reconnects.
- Computed fields (link → lookup / rollup / count, formulas) stay correct as data changes.
- Grid, Kanban, Calendar, Gallery and Form views, with filters, sorts, groups and hidden fields per view.
- Simple automations: when a record is created, updated or matches conditions → create or update records.

Out of scope for v1: login and permissions, attachments upload, interfaces,
AI fields, sharing links, revision history UI.

## 2. Data model

IDs: 3-letter prefix + 14 random base62 chars, generated **by the client** **[obs]**
(`bas`, `tbl`, `fld`, `viw`, `rec`, `opt`, `flt`, `aut`). This lets creates show
up immediately, before the server answers.

```
Base        { id, name, txn }                       txn = last transaction number [obs]
Table       { id, baseId, name, primaryFieldId, fieldOrder[], rowOrder[], position }
Field       { id, tableId, name, type, options, description }
Row         { id, tableId, cells: { [fieldId]: value }, createdAt, autoNumber }   sparse cells [obs]
View        { id, tableId, name, type, position, config }
Automation  { id, baseId, name, enabled, trigger, steps[] }
ActionLog   { baseId, txn, action, clientId, requestId, source, createdAt }
```

**View config [obs shape, my names]:**
```
{ hiddenFieldIds[], fieldOrder[]?, frozenFieldCount,
  filters: { conjunction: "and"|"or", conditions: [ {id, fieldId, operator, value} ] },
  sorts:   [ {fieldId, direction: "asc"|"desc"} ],
  groupBy: [ {fieldId, direction} ],
  kanban:   { stackFieldId, coverFieldId? },
  calendar: { dateFieldId },
  gallery:  { coverFieldId? },
  form:     { title, description, fieldIds[], submitLabel } }
```
New views copy the config of the view you're on **[obs]**.

### 2.1 Field types

| type | stored value | options |
|---|---|---|
| `text` | string | — |
| `longText` | string | — |
| `number` | number | `{ precision: 0-8, format: "decimal"|"integer"|"currency"|"percent", symbol? }` |
| `checkbox` | boolean | — |
| `singleSelect` | optionId | `{ choices: [{id, name, color}] }` [obs: choices + order] |
| `multiSelect` | optionId[] | same |
| `date` | ISO string | `{ includeTime: boolean }` [obs: isDateTime] |
| `email`, `url`, `phone` | string | — |
| `link` | rowId[] | `{ linkedTableId, inverseFieldId, single?: boolean }` |
| `lookup` | *computed* | `{ linkFieldId, targetFieldId }` [obs: relationColumnId + foreign field] |
| `rollup` | *computed* | `{ linkFieldId, targetFieldId, fn: sum|avg|min|max|count|counta|concat|and|or }` |
| `count` | *computed* | `{ linkFieldId }` |
| `formula` | *computed* | `{ expression }` (stored with field IDs, shown with names) |
| `createdTime`, `autoNumber` | *computed* | — |

Computed fields are **never stored**. They are derived from stored values by
one shared module that runs on both client and server **[mine]**.

Links are two-way. Creating a link field also creates its inverse field in the
other table, and changing one side updates the other in the same transaction **[mine]**.

## 3. Sync engine

### 3.1 Actions [obs pattern, my names]
Every change is one typed action:

```
table.create {tableId, name, primaryFieldId, viewId}   table.rename {tableId, name}   table.delete
field.create {fieldId, tableId, name, type, options, inverseFieldId?}
field.update {fieldId, name?, type?, options?}          field.delete {fieldId}
row.create   {rowId, tableId, cells}                    row.delete {rowIds}
row.update   {rowId, cells}                             (merge, last writer wins per cell)
link.add / link.remove {rowId, fieldId, linkedRowIds}   (only those links; others in the cell are kept)
view.create  {viewId, tableId, name, type, copyFromViewId?}
view.update  {viewId, name?, config patch}              view.delete {viewId}
automation.upsert {automation}                          automation.delete {automationId}
```

### 3.2 Flow
1. **Client** creates the action (with new IDs) and applies it to its *pending*
   layer right away. The UI shows `confirmed state + pending actions` **[obs: optimistic + "Saving…"]**.
2. Client sends `POST /api/bases/:id/actions {clientId, requestId, actions[]}`.
3. **Server**, in one DB transaction: validates against its in-memory base state
   **[obs: 422 VALIDATION_FAILED]**, bumps `base.txn`, applies the action, writes
   `action_log`, and commits.
4. Server broadcasts `{txn, actions, clientId, requestId}` to every socket on that base **[obs: /appChanges/]**.
5. Every client applies broadcasts to its *confirmed* state in txn order. The
   sender drops the matching pending action by `requestId` **[obs: didOriginateFromOwnClient]**.
6. **Reconnect:** the socket opens with `?since=<last txn>`. The server sends
   every logged action after it, or tells the client to reload the snapshot
   if the gap is too big **[obs: backfill by transaction number]**.
7. **Rejection:** the client drops the pending action and shows an error.

Heartbeat ping every 15 s; reconnect with backoff **[obs: ~15 s heartbeat]**.

Text cells save while typing, debounced to about 600 ms **[obs: periodic saves while typing; mine: shorter delay]**.

### 3.3 Automations [mine]
After each committed client transaction, the server checks enabled
automations. Triggers: `recordCreated`, `recordUpdated` (optional watched
fields), `recordMatches` (conditions became true). Steps: `updateRecord`
(trigger record) and `createRecord` (any table). Steps run as new server
transactions with `source: "automation"` and broadcast like any change.
Automations can't trigger other automations, so they can't loop forever.
Each run is logged. A `sendEmail` step (to/subject/body templates) sends after the
record changes are saved. Step building lives in `src/shared/automation.ts`, so the
editor can preview a run with the same code the server uses.

## 4. HTTP & socket API [mine]

```
GET  /api/bases                       list bases
POST /api/bases                       create base (with starter table)
GET  /api/bases/:id/snapshot          full base state + txn
POST /api/bases/:id/actions           apply actions → {txn}
GET  /api/bases/:id/automation-runs   recent automation runs
WS   /realtime?baseId=…&since=…       live actions
```

## 5. UI
- **Home:** base list and "New base".
- **Base page:** table tabs, view sidebar, toolbar (Hide fields, Filter, Group, Sort) and the active view.
- **Grid:** row numbers, frozen primary column, inline editing, keyboard
  navigation (arrows, Enter, Esc, Tab, typing to start editing), add row, add field,
  field menu (rename, change type, delete), group headers, expand-record dialog.
- **Kanban:** stacks per select option plus "Uncategorized". Drag a card to change its value.
- **Calendar:** month grid on a date field. Click a day to add a record.
- **Gallery:** cards with the first fields.
- **Form:** fill-in form that creates a record, with a field picker in edit mode.
- **Automations panel:** list, toggle, edit trigger and steps, recent runs.

## 6. Tech [mine]
Next.js (App Router, TypeScript) served by a custom Node server that also runs
the WebSocket endpoint (`ws`). Postgres through `pg` when `DATABASE_URL` is
set, otherwise embedded PGlite in `.data/`, so it runs with zero setup.
Shared code (`src/shared`): types, ID generator, action reducer, formula
engine, computed fields, filtering and sorting.

## 7. Checked against Airtable (2026-11-10 recording)

The second recording (FINDINGS §7) covered links, computed fields, sorts, forms,
automations and live sync. How FerTable compares:

**Already the same**
- Links are two-way: both sides change in one transaction.
- Lookup / rollup / count point at a link field plus a field in the linked table.
- Formulas are stored by field ID (`{fld…}`), so renaming a field is safe.
- Every change, automation edits included, gets the next per-base transaction
  number. Other clients apply it from the socket without refetching.
- Automation triggers (created / updated / matches conditions) and the
  update / create record steps line up with Airtable's basic set.

**Different on purpose (keep mine)**
- *Who computes.* Airtable computes lookups, rollups and formulas on the server and
  pushes the new cell values. FerTable derives them on both sides from stored
  cells, which keeps traffic small and lets edits show up instantly. Revisit only
  if very large bases make full recomputes slow.
- *Removing a sort.* Airtable rewrites the view's manual order when a sort is
  applied, so rows stay sorted after the sort is removed. FerTable sorts when it
  draws, so removing a sort brings back the manual order. Mine is less
  surprising. A "keep this order" button could cover the other case.
- *Empty values.* Airtable puts empties first when ascending; FerTable keeps
  them last in both directions.

**Worth adopting (most useful first)**
1. ~~**Add/remove-item actions for links.**~~ **Done 2026-11-10.** Link edits from
   the grid, record dialog, paste and Delete now send `link.add` / `link.remove`
   with just the records that changed, and undo restores link cells the same way,
   so neither overwrites links someone else made in between. (Like Airtable's
   `updateArrayTypeCellByAddingItem`.)
2. ~~**Form options**~~ **Done 2026-11-10:** a Required switch, custom question
   text and help text per question, and a message after submitting. Missing
   answers are flagged on submit without the form jumping. (A public share link
   is a bigger job: it needs abuse protection for anonymous visitors.)
3. ~~**Automation test + Send email**~~ **Done 2026-11-10:** the editor's Test panel
   shows what every step would do for a chosen record (values, recipients, email
   text) without changing anything, and "Run now" runs the saved automation once
   for real. Email steps take `{Field}` placeholders in To/Subject/Message, at most
   10 recipients, and a per-base cap of 100 automation emails an hour
   (`FERTABLE_AUTOMATION_EMAILS_PER_HOUR`).
4. ~~**Rollups as a formula over `values`**~~ **Done 2026-11-10:** the Summary menu
   has "Custom formula…", which starts from the chosen preset's formula
   (`MAX(values)` etc.) and previews the result on the first record. `values` only
   exists in rollup formulas, and they can't reference other fields. New list
   functions: `ARRAYUNIQUE`, `ARRAYCOMPACT`, `ARRAYFLATTEN`, `COUNTALL`.
5. ~~**New fields hidden in kanban, calendar and gallery views**~~ **Done
   2026-11-10**, including the back-link a new link field creates in the other table.
6. ~~**Lookup values grouped by linked record**~~ **Done 2026-11-10:** lookups show as
   chips (select values keep their colors) with the source record in each tooltip,
   and the expanded record lists values under each linked record. Formulas and
   filters still see one flat list (`Computer.lookupGroups` gives the grouped form).

Not planned: Airtable's draft/publish versions for automations, its integration
catalog, and AI steps.
