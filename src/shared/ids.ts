// IDs are a 3-letter prefix plus 14 random base62 characters, made by whoever
// creates the object (usually the browser) so new things can appear instantly.

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export type IdPrefix = "bas" | "tbl" | "fld" | "viw" | "rec" | "opt" | "flt" | "aut" | "req" | "cli" | "att" | "usr" | "com" | "cnx" | "srt" | "pat" | "ach" | "pag" | "elm" | "prt" | "ctl" | "wsp" | "snp" | "ntf";

export function newId(prefix: IdPrefix): string {
  const bytes = new Uint8Array(14);
  globalThis.crypto.getRandomValues(bytes);
  let out = prefix;
  for (const b of bytes) out += ALPHABET[b % 62];
  return out;
}

export function isId(value: unknown, prefix: IdPrefix): value is string {
  return typeof value === "string" && value.length === 17 && value.startsWith(prefix);
}
