// Settings were called GRIDBASE_* before the app was renamed FerTable. Old names still
// work: each GRIDBASE_X (or NEXT_PUBLIC_GRIDBASE_X) fills in FERTABLE_X when that isn't set.
// Imported first, before anything reads the environment.

for (const [key, value] of Object.entries(process.env)) {
  const m = /^(NEXT_PUBLIC_)?GRIDBASE_(.+)$/.exec(key);
  if (!m || value === undefined) continue;
  const next = `${m[1] ?? ""}FERTABLE_${m[2]}`;
  if (process.env[next] === undefined) process.env[next] = value;
}

export {};
