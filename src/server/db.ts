// Postgres access. Uses a real server when DATABASE_URL is set, otherwise an
// embedded Postgres (PGlite) stored in .data/ so the app runs with no setup.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type Queryable = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export type Db = Queryable & {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  kind: "postgres" | "pglite";
};

const SCHEMA = `
create table if not exists bases (
  id text primary key,
  name text not null,
  txn integer not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists tables_ (id text primary key, base_id text not null references bases(id) on delete cascade, data jsonb not null);
create table if not exists fields (id text primary key, base_id text not null references bases(id) on delete cascade, data jsonb not null);
create table if not exists rows_ (id text primary key, base_id text not null references bases(id) on delete cascade, data jsonb not null);
create table if not exists views (id text primary key, base_id text not null references bases(id) on delete cascade, data jsonb not null);
create table if not exists automations (id text primary key, base_id text not null references bases(id) on delete cascade, data jsonb not null);
create table if not exists base_meta (base_id text primary key references bases(id) on delete cascade, table_order jsonb not null);
create table if not exists action_log (
  base_id text not null references bases(id) on delete cascade,
  txn integer not null,
  client_id text,
  request_id text,
  source text not null,
  at text not null,
  actions jsonb not null,
  created_at timestamptz not null default now(),
  primary key (base_id, txn)
);
create table if not exists automation_runs (
  id serial primary key,
  base_id text not null references bases(id) on delete cascade,
  automation_id text not null,
  txn integer,
  status text not null,
  message text not null,
  created_at timestamptz not null default now()
);
create table if not exists files (
  id text primary key,
  base_id text not null references bases(id) on delete cascade,
  name text not null,
  type text not null,
  size integer not null,
  data bytea not null,
  created_at timestamptz not null default now()
);
create table if not exists users (
  id text primary key,
  email text not null unique,
  name text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);
create table if not exists sessions (
  token_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create table if not exists base_members (
  base_id text not null references bases(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null,
  primary key (base_id, user_id)
);
create table if not exists base_invites (
  base_id text not null references bases(id) on delete cascade,
  email text not null,
  role text not null,
  primary key (base_id, email)
);
create table if not exists password_resets (
  token_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  expires_at timestamptz not null
);
alter table action_log add column if not exists user_id text;
-- Accounts that existed before email confirmation count as confirmed; new ones start unconfirmed.
alter table users add column if not exists email_verified_at timestamptz default now();
alter table users alter column email_verified_at drop default;
create table if not exists email_verifications (
  token_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  expires_at timestamptz not null
);
alter table base_members drop constraint if exists base_members_role_check;
alter table base_members add constraint base_members_role_check check (role in ('owner', 'editor', 'commenter', 'viewer'));
alter table base_invites drop constraint if exists base_invites_role_check;
alter table base_invites add constraint base_invites_role_check check (role in ('owner', 'editor', 'commenter', 'viewer'));
create table if not exists comments (
  id text primary key,
  base_id text not null references bases(id) on delete cascade,
  row_id text not null,
  user_id text not null references users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index if not exists comments_row on comments(base_id, row_id, created_at);
create table if not exists row_history (
  base_id text not null references bases(id) on delete cascade,
  row_id text not null,
  txn integer not null,
  user_id text,
  actor text,
  kind text not null,
  note text,
  title text not null,
  changes jsonb not null,
  at text not null,
  primary key (base_id, row_id, txn)
);
alter table row_history add column if not exists snapshot jsonb;
create index if not exists row_history_deleted on row_history(base_id, kind, txn);
create index if not exists members_user on base_members(user_id);
create index if not exists sessions_user on sessions(user_id);
create index if not exists tables_base on tables_(base_id);
create index if not exists fields_base on fields(base_id);
create index if not exists rows_base on rows_(base_id);
create index if not exists views_base on views(base_id);
create index if not exists automations_base on automations(base_id);
create index if not exists runs_base on automation_runs(base_id, id desc);
`;

async function openPostgres(url: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return {
    kind: "postgres",
    query: (sql, params) => pool.query(sql, params as unknown[]) as never,
    exec: async (sql) => { await pool.query(sql); },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await fn({ query: (sql, params) => client.query(sql, params as unknown[]) as never });
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback");
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

async function openPglite(dir: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  mkdirSync(dir, { recursive: true });
  const db = await PGlite.create(dir);
  // PGlite runs one query at a time; serialize transactions explicitly.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  return {
    kind: "pglite",
    query: (sql, params) => serial(() => db.query(sql, params)) as never,
    exec: (sql) => serial(async () => { await db.exec(sql); }),
    tx: (fn) => serial(() => db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) as never }))),
  };
}

/** Folder holding the embedded database (also where the admin token file lives). */
export function dataDir(): string {
  return process.env.GRIDBASE_DATA_DIR || join(process.cwd(), ".data", "pglite");
}

let dbPromise: Promise<Db> | null = null;

export function getDb(): Promise<Db> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const url = process.env.DATABASE_URL;
      const db = url ? await openPostgres(url) : await openPglite(dataDir());
      await db.exec(SCHEMA);
      return db;
    })();
  }
  return dbPromise;
}
