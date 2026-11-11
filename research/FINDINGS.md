# Airtable behavior findings (REA study of "Test Base")

Scope: only the Airtable base **Test Base** (`appXXXXXXXXXXXXXX`). Everything here
comes from watching the app in a test account. It describes *behavior*, not
Airtable's code. Our clone ("FerTable") is an original implementation.

Legend: **[O]** observed directly · **[I]** inferred from observations · **[?]** unknown / still to check

Raw evidence lives in `research/raw/` (git-ignored, contains test-account data).

---

## 1. Client app shape

- **[O]** Single-page app. The base page loads ~684 JS files (~33 MB) from
  `static.airtable.com`, built with esbuild, split into ES-module chunks
  (`/esbuild/by_sha/<sha>/br/chunks/chunk-*.js`). REA evidence:
  `ev_4de2f1f8…` (inspect_web_page with script sources), analysis `ev_153310…`.
- **[O]** Source maps are referenced (`airtable.com/jsSourceMap/...`) but were
  not fetched. We don't need Airtable's source.
- **[O]** Uses React-style hooks (`useMemo` etc.) and feature-flag gating everywhere.
- **[O]** Grid DOM marks rows with `data-rowid` and cells with `data-columnid`,
  `data-columnindex`, `data-columntype`; rows have `data-rowindex`.
  The frozen (left) pane and the scrolling (right) pane render separately.

## 2. Loading a base

- **[O]** One call loads the whole base: `GET /v0.3/application/{baseId}/read`
  with query `stringifiedObjectParams`, `requestId`, `secretSocketId`.
- **[O]** Response is **MessagePack** (`application/msgpack`) using msgpackr
  "records" (ext type `0x72`): each object shape's keys are sent once, then reused.
  For our clone, plain JSON is fine to start.
- **[O]** Response = `{ msg: "SUCCESS", data: {...} }`. Key parts of `data`:
  - `applicationTransactionNumber` — a per-base counter (3 for a fresh base).
  - `tableSchemas[]` — schema for each table.
  - `tableDatas[]` — rows and per-view state for each table.
  - plus permissions, feature flags, automations (`workflow*`), interfaces (`page*`).

### 2.1 Data model

**[O]** IDs are a 3-letter prefix + 14 base62 chars:
`app` base · `tbl` table · `fld` field · `viw` view · `rec` row · `sel` select choice · `usr` user.

**[O] Table schema** (`tableSchemas[i]`):
```
{ id, name, primaryColumnId,
  columns: [ { id, name, type, typeOptions?, description?,
               initialCreatedTime, initialCreatedByUserId,
               lastModifiedTime, lastModifiedByUserId } ],
  views:   [ { id, name, type, personalForUserId, description, createdByUserId } ],
  viewOrder: [viewId], viewsById, viewSectionsById, meaningfulColumnOrder,
  columnSetById, rowTemplatesById, rowUnit, dateDependencySettings }
```

**[O] Field types seen so far** (internal names → UI names):
| internal `type` | UI name | `typeOptions` seen |
|---|---|---|
| `text` | Single line text | — |
| `multilineText` | Long text | — |
| `collaborator` | User | `shouldNotify`, `canAddNonBaseCollaborators` |
| `select` | Single select | `choices: {selId: {id,name,color}}`, `choiceOrder: [selId]` |
| `multipleAttachment` | Attachment | `unreversed` |
| `asyncText` | AI text | `sourceType:"ai"`, prompt parts with `{field:{columnId}}` refs, `columnIdDependencies` |
| `date` | Date | `isDateTime`, `dateFormat` |
| `foreignKey` | Link to another record | `foreignTableId`, `relationship:"many"`, `unreversed`, `symmetricColumnId` (see 7.1) |
| `lookup` | Lookup | `relationColumnId`, `foreignTableRollupColumnId` (+ result info the server adds, 7.2) |
| `rollup` | Rollup | `relationColumnId`, `foreignTableRollupColumnId`, `formulaText` over `values` |
| `count` | Count | `relationColumnId` |
| `formula` | Formula | `formulaText` (stored as `formulaTextParsed` with field IDs) |

**[O] Table data** (`tableDatas[i]`):
```
{ id, rows: [ { id, createdTime, cellValuesByColumnId: { fldId: value } } ],
  viewDatas: [ ... ], loadedSlices, signedUserContentUrls, ... }
```
- **[O]** Rows are **sparse**: empty cells are left out of `cellValuesByColumnId`.
- **[O]** Computed cells hold a status object, e.g. AI text:
  `{state:"error", errorType:"emptyDependency", value:null, erroredColumnIds:[...]}`.

**[O] View data** (`viewDatas[i]`) — every view keeps its own state:
```
{ id, type:"grid", frozenColumnCount: 1,
  columnOrder: [ {columnId, visibility} ],
  rowOrder:    [ {rowId,    visibility} ],
  filters, lastSortsApplied, groupLevels, colorConfig,
  applicationTransactionNumber }
```
- **[I]** Each view keeps an explicit row order, so manual drag-reordering works
  per view. Filtered-out rows likely stay in the list with `visibility:false`.

## 3. Real-time sync

- **[O]** Two SockJS websocket channels:
  1. `wss://airtable.com/rtb/sockjs_with_compression/...` — user/page channel.
     Client sends `{clientProtocolVersion:7, lastTransactionNumberReceivedByClient:0,
     secretSocketId, browserId, route:"/handshake/"}` → server replies
     `{route:"/confirmHandshake/"}`.
  2. `wss://airtable.com/singleApplicationRealtime/withCompression/...?applicationId=…&transactionNumber=3`
     — one channel per base. The client sends a base64 JSON hello that includes
     `applicationTransactionNumber`, `needsCellBackfill`, `needsQueryBackfill`,
     then `{route:"/applicationUpdateViews/", subscribedViewIdsByTableId:{tbl:[viw]}}`.
- **[I]** Sync model: every change to a base gets the next **transaction number**.
  The client says which number it has, and the server sends anything newer
  ("backfill"). Clients subscribe only to the views they have open.
- **[O]** Once the per-base socket closed with code `4009 appNotLoadedOrInvalid`
  during a recording, and the page reconnected. **[?]** Cause unknown.

## 4. Writes (the action log)

Recorded by REA typing "A" into Name on row `recXXXXXXXXXXXXXX`
(scenario evidence in `research/raw/`, traffic in `raw/sessions/02-edit-text-cell.json`).

- **[O]** Writes are RPC-style: `POST /v0.3/{modelClassName}/{modelId}/{action}`.
  Example: `POST /v0.3/row/recXXXXXXXXXXXXXX/updatePrimitiveCell`.
- **[O]** Body is form-encoded:
  `stringifiedObjectParams={"columnId":"fldXXXXXXXXXXXXXX","cellValue":"A"}&requestId=req…&secretSocketId=soc…`.
  Response is just `{msg:"SUCCESS", data:null}`.
- **[O]** The UI updates right away and shows "Saving…" until the server confirms
  (**[I]** optimistic update).
- **[O]** The server then pushes this over the per-base socket:
  ```
  { route: "/appChanges/", transactionNumber: 4,
    parsedData: {
      perApplicationTransactionNumber: 4,
      didOriginateFromOwnClient: true,
      originatingUserId: "usr…",
      changes: { workspaces: { wsp…: { applications: { app…: { tables: { tbl…: {
                 rows: { rec…: { updated: { updatePrimitiveCell: [ {columnId, cellValue} ] } } }
               } } } } } },
      trimmedOriginatingParsedCrudReq: {
        action: "updatePrimitiveCell", modelClassName: "row", modelId: "rec…",
        requestId, actionId: "act…", isUndoable: true,
        isUndoOrRedoOrRevert: false, undoRedoOrRevertActionId: null },
      cellBackfillByTableId: {...} } }
  ```
- **[O]** The base went from transaction 3 to 4 with this edit.
- **[O]** The per-base socket dropped (`4009`) right after the write and reconnected
  saying it had transaction 3. The server resent transaction 4 at once.
- **[I]** Design: every change is a typed **action** (`modelClassName`, `modelId`,
  `action`, params) stored with the next per-base transaction number. Clients
  apply their own edits optimistically, match the echo by `requestId`, and catch
  up after a reconnect by asking for everything after their last number.
  Undo/redo uses the stored `actionId` (`isUndoable`, `undoRedoOrRevertActionId`).
- **[O]** Heartbeats: about every 15 s the client sends `/clientToServerHeartbeat/`
  with `lastTransactionNumberReceivedByClient`. The server replies
  `/ackClientToServerHeartbeat/` and also sends `/applicationHeartbeat/`.

## 5. Guided session (user drove the UI, recorder captured traffic)

Source: `raw/sessions/03-guided-features.json`, decoded list in `03-guided-actions.txt`.
Websocket frames were **not** captured in this session: the sockets opened before
the recorder attached. The recorder has since been fixed.

### 5.1 Every write follows the same action shape **[O]**
`POST /v0.3/{modelClassName}/{modelId}/{action}` with `stringifiedObjectParams`.
Actions seen:

| model | action | params (abridged) |
|---|---|---|
| row | `create` | `{tableId, cellValuesByColumnId:{}, activeViewId}` |
| row | `updatePrimitiveCell` | `{columnId, cellValue}` |
| column | `create` | `{tableId, name, config:{type, typeOptions, default}, description, activeViewId, afterOverallColumnIndex, origin}` |
| table | `create` | `{applicationId, name}` |
| table | `updateName` | `{name}` |
| table | `updateRowUnit` | `{rowUnit:"record"}` |
| view | `create` | `{tableId, name, type, copyFromViewId, copyMode:"new", personalForUserId, lock}` |
| view | `updateFilters` | `{filters:{filterSet:[{id, columnId, operator, value}], conjunction:"and"}}` |
| view | `updateGroupLevels` | `{groupLevels:[{id, columnId, order:"ascending", emptyGroupState:"hidden"}]}` |
| view | `updateCalendarDateColumnRanges` | `{dateColumnRanges:[{startColumnId}]}` |
| view / table | `setAsLastUsed` | `{}` (remembers the user's last view/table) |

### 5.2 Behaviors **[O]**
- **The browser creates IDs itself.** `row/recPqyKu…/create` names the new row
  in the URL, and the same goes for fields, views and tables. **[I]** This is
  what makes creates feel instant.
- **Autosave while typing.** The open cell editor sends `updatePrimitiveCell`
  about every 3 s ("F" → "Fern" → "Fernando"), then once more on commit.
- **New tables come pre-filled.** A blank table gets "Table 2", default fields
  and 3 empty rows. Renaming is a separate `updateName` call.
- **New views copy the current one** (`copyFromViewId`), so a new view starts
  with the same field order and visibility.
  - Kanban: `groupLevels` holds the "stack by" field. `metadata.kanban.coverColumnId`
    holds the cover image field (defaulted to the attachment field).
  - Calendar: `dateColumnRanges:[{startColumnId}]`. When no date field existed,
    the UI offered to create one (`origin:"calendarNewFieldButton"`).
  - Gallery: no extra config seen.
- **Filters save on every keystroke**, and each condition has its own `flt…` ID.
- **Tables load lazily.** `GET /v0.3/table/{tbl}/readData?stringifiedObjectParams=
  {includeDataForViewIds:[viw], mayOnlyIncludeRowAndCellDataForIncludedViews:true,
  mayExcludeCellDataForLargeViews:true, allowMsgpackOfResult:true}` runs the first
  time a table or view opens.
- **Server-side validation.** Making a Lookup with no link field gave
  `422 {error:{type:"VALIDATION_FAILED", message:"...options are not valid."}}`.
  The client sent `typeOptions:{relationColumnId:null, foreignTableRollupColumnId:null}`.
  **[I]** So a lookup references a link field (`relationColumnId`) and a field in
  the linked table (`foreignTableRollupColumnId`).
- **Dependency graph.** `GET application/{app}/getDependencyGraph` returns edges
  `{source:{modelClassName:"column", modelId}, destination:{modelClassName:"view", modelId},
  edgeType:"viewVisibleColumn" | "viewFilters" | …}`. **[I]** Used to warn what
  breaks when a field is deleted or changed.
- **Transaction numbers kept climbing** with each change (4 → 15 → 23).
- **New field type seen:** `date` with `typeOptions:{isDateTime:false, dateFormat:"Local"}`.

### 5.3 Not captured yet **[?]**
Most of the gaps once listed here were filled on 2026-11-10 (section 7). Still not
captured: a real form submission, an automation switched on and running,
number/checkbox/multi-select options, and comments.

## 6. Other calls seen at page load
- `readApplicationStatistics`, `getWorkflowWarningLevel` (automations),
  `getUserProperties`, `getFavorites`, `addMostRecentlyViewedApplication`.
- Telemetry (`/internal/*`, Amplitude, Sentry) is ignored.

## 7. Links, computed fields, sorts, forms, automations, live sync (2026-11-10)

Source: `raw/sessions/04-gaps.json` and `raw/sessions/05-computed.json`. REA drove
the UI in Test Base (`capture_browser_scenario`, accessibility trees in
`raw/*-a11y.txt`) while the recorder captured traffic. Fields added to Test Base for
this: Tasks (link to Test Table), Task status (lookup), Task names (rollup), Task
count, Task summary (formula). Also added: a Form view on Test Table and a draft,
switched-off "Automation 1".

### 7.1 Link fields **[O]**
- Create: `column/{fld}/create` with
  `config:{type:"foreignKey", typeOptions:{foreignTableId, relationship:"many", unreversed:true}}`.
- In the same transaction the server creates the **inverse field** in the other
  table, named after this table ("Table 1"), and links the two with
  `symmetricColumnId` on each side.
- A new field is shown in the grid view it was created from (and the other
  table's grid), and hidden in kanban, calendar and gallery views
  (`diffColumnOrder: [{createdIdsWithVisibilitiesAtIndices: {fld: {index, visibility}}}]`).
- Adding a link sends one item, not the whole list:
  `row/{rec}/updateArrayTypeCellByAddingItem {columnId, item:{foreignRowId, foreignRowDisplayName}}`.
  The cell keeps the linked record's display name next to its ID.
- The echo carries the back-link on the other record (`addItemToArrayTypeCell`
  with an `index`) **and** new values for every computed field that depends on the link.
- Then the client loads card data for the linked record:
  `table/{tbl}/readDataForRowCards {rowIds, includeViewAndColumnData:true}`.
- Picker: in the expanded record, "Add record" opens a searchable list of cards
  (primary field plus a few other fields) with "Create a new record" at the top.
  Picking one closes the picker. Enter picks the highlighted card.

### 7.2 Lookup, rollup, count and formula **[O]**
| type | client sends | server adds |
|---|---|---|
| `lookup` | `relationColumnId`, `foreignTableRollupColumnId` | `resultType` (here `select`), `resultIsArray:true`, `foreignTableRollupColumnType`, a copy of the source field's `choices`/`choiceOrder` (so pills keep their colors), `dependencies.referencedColumnIdsForValue` |
| `rollup` | the same two IDs + `formulaText:"ARRAYUNIQUE(values)"` | `formulaTextParsed`, `dependencies {referencedColumnIdsForValue, referencedFormulaFunctions, dependsOnCurrentRow}`, `resultType:"text"`, `resultIsArray:true` |
| `count` | `relationColumnId` | `resultType:"number"`, `dependencies` |
| `formula` | `formulaText` with `{Field name}` | `formulaTextParsed` with `{column_value_fldXXXX}` references, operators as functions (`>` → `larger`, `&` → `CONCATENATE`), `dependencies`, `resultType` |

- **Formulas are stored by field ID**, so renaming a field doesn't break them.
- A rollup's aggregation is itself a formula over `values` (default for text:
  `ARRAYUNIQUE(values)`). Its dialog has a code editor, "only include linked
  records that meet conditions" and "sort records before summarizing". Lookups
  offer the same filter plus sort and "limit the number of items".
- When a table has one link field, lookup/rollup/count preselect it.
- **Formula preview** shows the result for one chosen record as you type, worked
  out by the server: `table/{tbl}/tableFormulaExampleEvaluation {formulaText, rowIdsToEvaluate}`
  → `{evaluatedFormulaByRowId:{rec: "No tasks"}}`.
- A new Count field got a "Sum" column summary automatically.
- **Computed values come from the server.** Linking a record produced, in the same
  transaction, `updatePrimitiveCell` entries for the rollup (`["Test"]`), the count
  (`1`) and the formula (`"1 tasks"`). Changing Status on the linked task (other
  table) updated the lookup on this table's record in that same transaction.
  **[I]** The server keeps the dependency graph and pushes recomputed cells; clients
  don't compute them.
- Lookup cell value keeps values grouped by linked record:
  `{valuesByForeignRowId:{rec:["sel…"]}, foreignRowIdOrder:[rec]}`.
- Single-select cells store the choice ID (`sel…`), not its name.
- `cellBackfillByTableId` was `{"":{}}` in every frame. **[?]** Probably filled
  when a client subscribes to views it hasn't loaded yet.

### 7.3 Sorts **[O]**
- `view/{viw}/applySorts {sortObjs:[{id:"srt…", columnId, ascending:true}], shouldAutoSort:true}`.
- The server **moves the rows in the view's stored row order**
  (`diffRowOrder:[{movedIdsToIndices:{rec: 2}}]`) and saves
  `lastSortsApplied {sortSet, shouldAutoSort, appliedTime}`.
- Removing the sort sends `sortObjs:[]` and only clears `lastSortsApplied`, so
  **rows keep the sorted order** afterwards.
- Ascending put empty values **first** (single select sorts by choice order; the
  direction button reads "First → Last").
- UI: "Automatically sort records" switch (on by default) and "Add another sort".

### 7.4 Form view **[O]**
- "Create new… → Form" first offers Airtable's newer form builder or "Create a form
  view". The classic path asks for a name and who can edit
  (Collaborative / Personal / Locked), then sends
  `view/{viw}/create {type:"form", copyFromViewId, copyMode:"new", personalForUserId:null, lock:null}`.
- The form has a public link right away (`/{app}/shr…`), with "Share form" and
  "Open form" buttons.
- Builder: every field starts on the form; each has a Required switch, its own label
  and help text; drag a field out to hide it; cover image, logo, title and
  description. After submitting: show a message or redirect to a URL, optionally a
  "Submit another response" button or a fresh form after 5 seconds; email the owner
  on each response; toggle branding.
- Public page: labelled inputs, Submit, a "do not submit passwords" note and
  "Report malicious form". The AI text field appeared on the form too.
- Not tested: submitting a response.

### 7.5 Automations **[O]**
- Triggers offered first: record matches conditions, form submitted, record
  created, record updated, scheduled time, record enters a view (more under
  "See all"). Suggestions use the base's own fields ("When Status is Done, send an email").
- Picking a trigger saves a draft immediately:
  `workflow/{wfl}/create {applicationId, version:1, name:"Automation 1", workflowGraphId:"wgr…",
  workflowTrigger:{workflowTriggerTypeId:"wttRECORDCREATED0", inputExpressions:[], workflowTriggerId:"wtr…"}, workflowNodes:[]}`.
- Settings are typed **input expressions**:
  `workflowTrigger/{wtr}/updateConfiguration {inputExpressions:{tableId:{type:"literal", value:"tbl…"}}}`.
  **[I]** Other expression types reference earlier steps' outputs (the "+" menu).
- Actions are graph nodes:
  `workflowAction/{wac}/create {workflowGraphId, typeId:"watUPDATERECORD00", nextNodeId:null, parentNodeId:null}`.
  The graph stores `entryWorkflowActionId`; each action has `nextWorkflowActionId`.
  Update record starts with `updateRecordMethod:{type:"literal", value:"customFields"}`.
- Every edit bumps the workflow `version` (1 → 2 → 3). It stays
  `deploymentStatus:"undeployed"` until switched on (`liveWorkflowDeploymentVersion`).
  **[I]** Switching on publishes a snapshot; later edits are a draft until republished.
- The editor flags missing settings ("1 field is missing configuration"), offers a
  Test step per step (suggested or chosen record), lets each action run "Always" or
  on conditions, and writes the automation's description for you
  ("When a record is created, update a record").
- Action list: send email, create / update / delete record, find records, sort
  list, run script, generate with AI, conditional logic, repeating group, and
  integrations (Slack, Teams, Gmail, Google Calendar/Sheets/Docs/Forms, GitHub
  Issues, Outlook, Twilio and more).
- Creating a workflow or action is `isUndoable:false`; changing trigger settings is
  `isUndoable:true`. Automation edits share the base's transaction numbers (#42–44).

### 7.6 Live sync from another client **[O]**
- Edited Notes in a second tab. The first tab got `/appChanges/` transaction #45
  with `didOriginateFromOwnClient:false`, the other tab's `requestId`, and the same
  `changes` shape as its own edits. No extra fetch followed.
