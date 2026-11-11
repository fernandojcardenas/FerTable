# FerTable

[![CI](https://github.com/fernandojcardenas/FerTable/actions/workflows/ci.yml/badge.svg)](https://github.com/fernandojcardenas/FerTable/actions/workflows/ci.yml)

FerTable is a self-hosted spreadsheet-database app: tables with typed fields, linked records,
formulas and rollups, seven kinds of views, dashboards, automations and a developer API, with
every change syncing live between everyone who has the base open. It runs as a single Node.js
server and needs no database setup to try. An embedded Postgres starts with it, and a real
Postgres server can take over in production.

![The Projects grid of a product launch base: records colored by status, people, budgets and dates, with column totals underneath](docs/screenshots/grid.png)

## What is included

- **Tables and fields:** 26 field types, including linked records, lookups, rollups, counts,
  formulas, rich text, attachments, ratings, durations, barcodes, people, buttons, and created and
  last-modified time and by.
- **Seven views:** grid, kanban, calendar, gallery, form, timeline (Gantt, with dependency
  arrows) and list (records nested under their linked records). Filters, sorts, groups, hidden
  fields, search, column totals, row heights, frozen columns and record colors are saved per
  view. Views can be personal or locked.
- **Live collaboration:** edits appear instantly and reach every open window within a moment.
  Undo and redo, comments with @mentions, a full history of every record with one-click restore,
  and recently deleted records.
- **Interfaces:** dashboards made of numbers, bar, line and pie charts, record lists, maps, text
  and buttons, with filters the viewer can change. Also record review pages, and print layouts
  for invoices and labels.
- **Automations:** triggers on record changes, form submissions, records entering a view, or a
  schedule. Steps can update or create records, send email, branch, repeat, run sandboxed
  JavaScript, or post to Slack, Google Sheets and webhooks.
- **Sharing:** owner, editor, commenter and viewer roles, workspaces for teams, field and
  record permissions enforced by the server, notifications, and read-only public links for views
  and dashboards. Forms can take responses from people without an account.
- **Data in and out:** CSV and Excel import, CSV export, tables synced from another base, a
  Google Sheet or a CSV link, templates, duplicate table or base, and daily snapshots you can
  restore.
- **For developers:** a REST API for records with personal access tokens, signed webhooks, and an
  installable web app for phones.
- **For admins:** an audit log, account management, email confirmation and password reset, and
  single sign-on through any OpenID Connect provider (Google Workspace, Microsoft Entra ID, Okta
  and others).

## Screenshots

All screenshots show fictional demo data.

| Timeline with dependencies | Kanban board |
|:---:|:---:|
| <img src="docs/screenshots/timeline.png" width="420" alt="Timeline view with project bars across November and December, dependency arrows, and a red line for today"> | <img src="docs/screenshots/kanban.png" width="420" alt="Kanban board with Planning, In progress and Done stacks of project cards"> |
| **Dashboard** | **Record with comments and history** |
| <img src="docs/screenshots/dashboard.png" width="420" alt="Launch overview dashboard with budget totals, a bar chart by status, a pie chart of tasks by assignee, and an upcoming list"> | <img src="docs/screenshots/record.png" width="420" alt="Expanded record with editable fields, rich text notes, linked tasks, and an activity panel with comments and changes"> |
| **Workspaces and bases** | **On a phone** |
| <img src="docs/screenshots/home.png" width="420" alt="Home page with a Northwind Studio workspace holding three bases, plus other bases"> | <img src="docs/screenshots/phone.png" width="200" alt="Kanban view on a phone-sized screen"> |

## Run locally

Prerequisites: Node.js 22+ and npm. Nothing else is required. Data is kept in an embedded
Postgres (PGlite) in `.data/`, which is created on first start and is not stored in git.

```bash
npm install
npm run dev
```

Open `http://localhost:3210` and create an account. The first account on a server becomes its
admin, and it also owns any bases that existed before accounts did.

To build and run a production server:

```bash
npm run build
npm start
```

To host it, see [docs/hosting.md](docs/hosting.md): it runs on Google Cloud's always-free machine with automatic HTTPS and nightly backups.

To use a real Postgres server instead of the embedded one:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/fertable npm start
```

## Configuration

Everything works with no settings. These are the ones most people change:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Use this Postgres server instead of the embedded one |
| `APP_URL` | The public address, used for links in emails and for single sign-on |
| `SMTP_URL`, `MAIL_FROM` | Send real email (without them, emails are printed to the server log) |
| `FERTABLE_OIDC_ISSUER`, `FERTABLE_OIDC_CLIENT_ID`, `FERTABLE_OIDC_CLIENT_SECRET` | Single sign-on |
| `FERTABLE_ALLOW_SIGNUP`, `FERTABLE_VERIFY_EMAIL` | Turn sign-up or email confirmation off |
| `PORT`, `HOST` | Where the server listens (default `localhost:3210`) |

The full list, with every feature explained, is in the [guide](docs/guide.md).

## Architecture

| Area | Technology | Purpose |
| --- | --- | --- |
| Server | Node.js + TypeScript (tsx) | One process for pages, the JSON API, the `/v1` API and WebSockets |
| Interface | Next.js 16 + React 19 | Views, dialogs, interfaces and the installable web app |
| Sync | WebSocket (`ws`) + a shared reducer | Optimistic edits in the browser, numbered transactions from the server |
| Storage | PostgreSQL, or embedded PGlite | Bases, records, history, files, accounts and the audit log |
| Formulas | Own parser and evaluator | Formula fields, rollups, filters and the API's `filterByFormula` |
| Scripts | QuickJS (WebAssembly) | Sandboxed automation scripts with time and memory limits |
| Maps | Leaflet + OpenStreetMap tiles | Map elements on dashboards |
| Email | Nodemailer | Invites, mentions, password resets and automation emails |

Every change is an action applied by one reducer on both sides, so the browser never waits for
the server to show an edit, and the server never trusts the browser. See
[docs/architecture.md](docs/architecture.md) for how the pieces fit together.

## Testing

```bash
npm test            # engine tests
npm run typecheck   # TypeScript, all files
npm run build       # production build
```

The 103 tests in `tests/` cover the reducer, formulas, rollups, links, undo and restore, record
history, permissions, CSV and sync, automations (including the script sandbox and the refusal of
private network addresses), the developer API, interfaces, templates and duplication. CI runs
them on every push, together with a production build, a typecheck and a gitleaks scan of the full
git history.

## How it was built

FerTable is original code. It started as a study of how spreadsheet-database tools behave: I
recorded how Airtable's web app handles edits, sync, computed fields, forms and automations on a
single test base, then designed and built my own implementation from those observations. The
observations are in [research/FINDINGS.md](research/FINDINGS.md) and the design in
[research/SPEC.md](research/SPEC.md). No Airtable code, assets or branding are used, and
FerTable is not affiliated with Airtable.

## Versioning

This repository uses Git tags for meaningful milestones. The first release is `v0.1.0`.

## Privacy and safety

FerTable is self-hosted: your data stays in your own database, and nothing is sent anywhere
unless you set it up. That means email through your SMTP server, and the webhooks, Slack, Sheets and syncs you add. Passwords are hashed with
scrypt, sessions and API tokens are stored only as hashes, changes must come from the app's own
pages, and outgoing requests refuse addresses inside private networks. Public links show only
what their view or page shows.

Do not add secrets, API keys or personal data to the repository. The `.data/` folder (the
embedded database) and `research/raw/` (recordings) are ignored by git.

## Status and known issues

Working and tested on a single server. Not built yet:

- A native iOS app (planned).
- Syncing from services that need their own sign-in, such as Jira or Salesforce.
- Running more than one server process against the same database (live sync is in-process).

## Credits

FerTable builds on open-source projects, used under their own licenses:
[Next.js](https://nextjs.org), [React](https://react.dev), [PGlite](https://pglite.dev),
[node-postgres](https://node-postgres.com), [ws](https://github.com/websockets/ws),
[QuickJS](https://github.com/justjake/quickjs-emscripten), [Leaflet](https://leafletjs.com) with
[OpenStreetMap](https://www.openstreetmap.org/copyright) data, and
[Nodemailer](https://nodemailer.com).

## License

MIT. See [LICENSE](LICENSE).
