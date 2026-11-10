# gridbase

An original spreadsheet-database app: tables with typed fields, linked records,
lookups, rollups, formulas, five kinds of views, automations, and live sync
between every open window.

Its behavior is modeled on what we observed in Airtable using REA
(see `research/FINDINGS.md`). The design is in `research/SPEC.md`. All code is
original; nothing was copied from Airtable.

## Run it

```bash
npm install
npm run dev        # http://localhost:3210
```

No database setup is needed. By default it uses an embedded Postgres (PGlite)
stored in `.data/`. To use a real Postgres server instead:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/gridbase npm run dev
```

Other scripts: `npm test` (engine tests), `npm run typecheck`, `npm run build`,
`npm run reset-password -- someone@example.com`, `npm run cleanup-files`.

### Accounts

The first time you open the app it asks you to sign in. Create an account; **the
first account on a database becomes owner of every base that existed before
accounts did**. Share a base from the **Share** button:

| Role | Can |
|---|---|
| Owner | edit, share, change roles, delete the base |
| Editor | change records, fields, views, tables and automations |
| Commenter | read everything and comment on records, but not change data |
| Viewer | look only (edits are refused on the server, and the UI says so) |

**Passwords.** Change yours from the avatar menu (this signs out your other devices).
"Forgot your password?" on the sign-in page emails a one-time link that works for an
hour (the answer is the same whether or not the account exists). Whoever runs the
server can also make a link directly: `npm run reset-password -- someone@example.com`.
That script talks to the running server through a local-only endpoint protected by a
random token in `.data/admin-token` (readable only by the account running the server).

**Email.** Set `SMTP_URL` to send real email (reset links, "shared with you" and
invitations). Without it, emails are printed to the server log instead, which is
enough for local use. Links in emails use `APP_URL`, never the request's Host header.

Sharing with an email that has no account creates an invite that turns into
access when that person signs up with that email **and confirms it**.

**Email confirmation.** New accounts get a confirmation link (valid for a day; with no
`SMTP_URL` it's printed in the server log). Until it's clicked, bases shared with that
address stay locked, so nobody can sign up with someone else's email to get their
invitations. Using a password-reset link confirms the address too. The first account
on a server, and accounts made before this feature, count as confirmed. An unconfirmed
account can still create and use its own bases; the home page shows a banner with
*Send it again*. Set `GRIDBASE_VERIFY_EMAIL=false` to turn confirmation off. Role changes and removals reach
open windows immediately.

How it's secured: passwords are hashed with scrypt; sessions are random tokens in
an httpOnly, SameSite=Lax cookie and only their SHA-256 is stored; changes must come
from the app's own origin; sign-in attempts are rate-limited; people who aren't
members get "not found" for bases and files.

Settings (environment variables):

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | – | Use this Postgres server instead of the embedded one |
| `GRIDBASE_DATA_DIR` | `.data/pglite` | Folder for the embedded database |
| `GRIDBASE_FORM_LIMIT_PER_VISITOR`, `GRIDBASE_FORM_LIMIT_PER_FORM` | `10`, `300` | Public form responses allowed per 15 minutes |
| `GRIDBASE_VERIFY_EMAIL` | `true` | Set `false` to skip email confirmation for new accounts |
| `GRIDBASE_ALLOW_SIGNUP` | `true` | Set `false` to stop new sign-ups (sharing invites then can't be claimed) |
| `GRIDBASE_SECURE_COOKIES` | `true` in production | Set `false` only to test a production build over plain HTTP |
| `PORT`, `HOST` | `3210`, `localhost` | Where the server listens |
| `APP_URL` | `http://HOST:PORT` | Public address used in email links |
| `SMTP_URL` | – | e.g. `smtps://user:pass@smtp.example.com:465`; unset = emails go to the log |
| `GRIDBASE_AUTOMATION_EMAILS_PER_HOUR` | `100` | Most automation emails one base may send per hour |
| `MAIL_FROM` | `gridbase <no-reply@localhost>` | Sender address |

## How it works

- **Every change is an action** (`row.update`, `field.create`, `view.update`, …).
  The browser applies it right away and sends it to `POST /api/bases/:id/actions`.
- **The server** checks it with the same reducer (`src/shared/reducer.ts`), gives it
  the next per-base **transaction number**, saves the changed rows to Postgres,
  logs it in `action_log`, and broadcasts it over the `/realtime` WebSocket.
- **Clients** apply broadcasts in order. Their own edits come back and are dropped
  from the pending list. A client that reconnects asks for everything after its
  last transaction number.
- **Computed fields** (lookup, rollup, count, formula, created time, autonumber)
  are never stored. They're derived by `src/shared/compute.ts` on both sides.
- **Automations** run on the server after each change and write their own
  transactions (`source: "automation"`), which sync like any other edit.
- **Undo/redo** (⌘Z / ⇧⌘Z, or the arrows in the header): after each of your edits the
  browser stores a patch that reverses it (`src/shared/history.ts`). Undo sends that
  patch as a `restore` action. Rows are restored cell by cell, so other people's
  later edits to the same record are kept. Link cells are saved and undone as
  "link these / unlink those", never as the whole list, so two people linking
  records in the same cell at once both keep theirs. Side effects come back too (a deleted
  field's links, cells and view settings). Saves made while typing in one cell
  undo as one step. History is per tab and survives a reload of that tab (kept in
  `sessionStorage`, about 2 MB, oldest steps dropped first).

```
src/shared   types, ids, reducer, formula language, computed fields, filter/sort/group
src/server   Postgres access (db.ts) and the sync/automation engine (engine.ts)
src/client   sync client (store.ts) and React UI (ui/)
server.ts    one Node server for Next.js pages, the JSON API and WebSockets
research/    REA findings, spec and capture tooling (raw captures are git-ignored)
```

## Features

- **Field types:** single line text, long text, number (decimal/integer/currency/percent),
  checkbox, single and multiple select, date (optional time), attachment, email, URL, phone,
  rating (1–10 stars; type a digit on a cell), duration (`1:30`), barcode, user (base members
  only, checked on the server), link to another record (two-way), lookup, rollup, count,
  formula, AI, button, created time, last modified time, last modified by, autonumber.
- **Button fields** open a link built from the record (`https://…?q={Name}`, values are
  URL-encoded; only `https:`, `mailto:` and `tel:` links) or run an automation on the record.
- **AI fields** fill each record from a prompt such as `Summarize {Notes}` using an AI model
  (`the model set in the settings`, change with `GRIDBASE_AI_MODEL`). The server needs `ANTHROPIC_API_KEY`
  (or an `ant auth login` profile). Answers refresh when the fields the prompt uses change;
  *Regenerate* refills one record or all. Limits: 2 at a time and 500 per base per hour
  (`GRIDBASE_AI_CONCURRENCY`, `GRIDBASE_AI_PER_HOUR`). Problems (no key, refusals) show on
  the cell and the last good answer is kept. `GRIDBASE_AI_FAKE=1` answers without calling the
  API, for testing.
- **Last modified time/by** are kept for every record; changes by automations, forms and AI
  show as "Automation".
- **Attachments:** upload or drop files (up to 25 MB each). They're stored in Postgres
  (`files` table) and served from `/api/files/…`. Only common images, PDFs and plain
  text open in the browser; everything else downloads, so uploads can't run scripts.
  Images show as thumbnails and can be the card cover in Kanban and Gallery. Files no
  cell uses anymore are deleted after 7 days (checked every 6 hours), so undo can still
  bring a removed file back in the meantime.
- **Views:** Grid (keyboard editing, copy/paste, resizable columns, grouping, drag rows by
  the ⠿ handle to reorder them when the view isn't sorted, and it only draws the rows on
  screen, so 5,000+ rows stay fast),
  Kanban (drag cards between stacks), Calendar (drag to reschedule), Gallery,
  and Form (pick questions, mark them required, reword them, add help text and a
  thank-you message; submitting creates a record). A form can also get a **public link**
  (*Edit form → Create public link*): anyone with it can send a response without an
  account, at `/f/<code>`. They see only the form's questions, never records; link and
  attachment questions are left off. Answers are checked on the server, each visitor can
  send 10 responses per 15 minutes and each form 300, a hidden field catches simple bots,
  and *Turn off* or *New link* stops the old link at once. History shows the form as the
  author, and automations run as for any new record.
- **Per view:** filters (and/or), sorts, groups, hidden fields. New fields start hidden in kanban,
  calendar and gallery views (unhide them with *Hide fields*); grids show them right away.
- **Lookups** show the linked records' values as chips, keeping select colors; hover a
  chip to see which record it came from, or open the record to see them grouped.
- **Formulas:** `{Field name}` references, `+ - * / &`, comparisons, and functions such as
  IF, SWITCH, AND, OR, CONCATENATE, LEFT, ROUND, SUM, AVERAGE, DATEADD,
  DATETIME_DIFF, DATETIME_FORMAT, TODAY and NOW.
- **Rollups:** pick a summary (sum, average, min, max, counts, join, all/any true) or
  write your own formula over `values`, e.g. `MAX(values) - MIN(values)` or
  `ARRAYJOIN(ARRAYUNIQUE(values), " · ")`.
- **CSV:** *Download CSV* in a view's ⋯ menu exports what that view shows (its fields,
  filters and sort) as UTF-8 with a BOM, so Excel opens it cleanly. Text that a spreadsheet
  would run as a formula (`=`, `+`, `-`, `@`) is written as plain text. *+ Add table →
  Import a CSV file* makes a new table and guesses each column's type (number, currency,
  percent, date, checkbox, select, email, URL, long text; codes with leading zeros stay
  text), which you can change in the preview. A table's menu also has *Import CSV into
  this table*, which matches columns to fields by name and adds any new select options.
  Imports of any size undo with one ⌘Z.
- **Comments:** every expanded record has a comment panel. Type `@` to mention someone in
  the base (they get an email with a link straight to the record). Comments sync live,
  authors can edit or delete their own, and owners can delete any. Rows with comments show
  a 💬 count in the grid. *Copy link* in a record gives a `/base/…?record=…` address that
  opens it directly. Comments live in their own table, not in the undo history.
- **Record history:** the expanded record's *Activity* panel mixes comments with every
  change: who (a person, or "Automation “name”"), when, and each field's old → new value,
  including links changed from the other side and undo/redo. Filter to *Comments* or
  *Changes*; older changes page in. History is written as each change is saved (table
  `row_history`), using the values as they looked then, so it stays readable after fields
  are renamed or options deleted. Deleting or retyping a field isn't logged on every record.
  Each change has **↶ Restore**, which puts those fields back the way they were before it
  (links are restored without dropping links others added since; ⌘Z undoes a restore).
  Fields deleted or retyped since, removed select options, attachments and very large
  values are skipped, and the panel says so.
- **Recently deleted:** a table's menu has *Recently deleted records…*, listing records
  deleted in the last 30 days with who deleted them and what they held. *Restore* brings
  a record back with its id, created time, number, values, files and links (on both
  sides). Files of recently deleted records aren't cleaned up while they can still be
  restored. Records from a deleted table aren't listed.
- **Automations:** start when a record is created, updated, starts matching
  conditions, enters a view, or comes in through a form (including public links), or
  on a schedule (every hour, day or week; once, or for each record in a view, up to
  100). Steps: update the record, create records, send an email (use Gmail by pointing
  `SMTP_URL` at Gmail's SMTP with an app password), **If / otherwise** branches,
  **Repeat** for each linked record (up to 100), **Run a script**, **Post to Slack**,
  **Add a row to Google Sheets**, and **Call a webhook**. Values use `{Field name}`
  placeholders. Branches and loops nest up to 3 deep, with 50 steps per automation
  and 200 steps per run.
  - Scripts are JavaScript running in QuickJS (WebAssembly), with no files, network
    or Node APIs, a 1-second limit and 16 MB of memory. They see `record` and
    `trigger` (field name → value), `console.log` goes to the run log, and returning
    `{ "Field": value }` updates the record.
  - Slack, Sheets and webhook addresses are saved as **Connections**
    (`automation_connections`). They stay on the server; steps refer to them by id.
    Posts only go to public https addresses: private and loopback IPs are refused
    when you save and when the connection is made (so a DNS change can't point
    inside the network). Redirects aren't followed, and posts time out after
    10 seconds. For Sheets, deploy an Apps Script web app whose `doPost(e)` appends
    `JSON.parse(e.postData.contents).values` as a row.
  - The **Test** panel shows what each step would do for a record you pick.
    **Run now** runs it once for real.
  - Limits per base per hour: 100 emails (`GRIDBASE_AUTOMATION_EMAILS_PER_HOUR`) and
    300 posts (`GRIDBASE_AUTOMATION_POSTS_PER_HOUR`). Each email goes to at most 10
    addresses. The server checks schedules every minute (`automation_schedule`
    keeps the last run). A new schedule waits for its first due time.

- **Public developer API** (`/v1`, `src/server/publicApi.ts`), shaped like Airtable's:
  - Records are `{ id, createdTime, fields }`, with fields keyed by name. Select
    options are given by name, links as record ids, and people as
    `{ id, name, email }`.
  - Endpoints: `GET/POST/PATCH/PUT/DELETE /v1/:baseId/:table[/:recordId]` (up to 100
    per page and 10 per write; supports `view`, `filterByFormula`, `sort[n][field]`,
    `fields[]`, `offset` and `typecast`), `GET /v1/meta/bases`, and
    `GET /v1/meta/bases/:id/tables`.
  - Auth: personal access tokens only (`Authorization: Bearer pat…`), made under
    **</> API → Access tokens**. They're stored as SHA-256 hashes and can be read-only
    and limited to some bases. A token never exceeds its owner's role, and writes
    need editor access.
  - Limits: 10 requests a second per token (`GRIDBASE_API_PER_SECOND`). CORS is
    open, because cookies are never accepted on `/v1`.
  - API changes start automations and show the token's owner in record history.
- **Webhooks** (`src/server/webhooks.ts`), managed under **</> API → Webhooks** or
  `/v1/bases/:id/webhooks`:
  - After each change, the server POSTs the created, updated and deleted records
    (with field values) to each webhook, optionally only for one table.
  - Each POST carries `X-Gridbase-Signature: sha256=HMAC(secret, "<X-Gridbase-Timestamp>.<body>")`.
  - Delivery goes through the same public-https-only poster as automations. A
    webhook is switched off after 20 failures in a row.
- **Synced tables** (`src/shared/sync.ts`): **+ Add table → Sync from another base**
  copies a grid view (its filtered records and visible fields) into a read-only table.
  - It updates a couple of seconds after the source changes, and every 15 minutes.
    **Sync now** forces an update.
  - You can add your own fields to the synced table. Synced fields and records
    can't be edited there, even through the API.
  - Setting one up needs editor access to the source base. If the person who set
    it up loses that access, the sync stops with a message and keeps the last copy.
  - Computed, link, user and file fields arrive as text (counts as numbers).

- **Interfaces** (the **Data / Interfaces** switch in the header): dashboard pages
  that everyone in the base can view and editors can design.
  - Elements: **Number** (count, sum, average, min or max), **Chart** (bar, line or
    pie, grouped by any field), **Record list**, **Map**, **Text** and **Button**
    (open a link, open a view, or run an automation that needs no record).
  - Each data element reads a table, optionally narrowed by one of its views.
    Clicking a chart group lists its records, and records open in the usual dialog.
  - **Edit page** shows a 12-column grid: drag an element's top bar to move it and
    its corner to resize it. A side panel sets it up.
  - Pages are stored as `page.upsert` / `page.delete` actions (`src/shared/types.ts`,
    `pages` table), so they sync live and undo like everything else. Data comes from
    `src/shared/interfaces.ts` and charts are plain SVG (`src/client/ui/charts.tsx`).
    Every chart has a table view.
  - Maps use Leaflet with OpenStreetMap tiles loaded in the viewer's browser. Point
    them elsewhere with `NEXT_PUBLIC_GRIDBASE_MAP_TILES` and
    `NEXT_PUBLIC_GRIDBASE_MAP_ATTRIBUTION`. A location is a text field like
    "40.7, -74.0", or separate latitude and longitude number fields.
  - On narrow screens, elements stack in one column.

## Not built yet

Ideas for later: timeline, list and Gantt views; native iOS app.
