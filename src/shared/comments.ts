// Mentions in comments are stored as @[usrXXXXXXXXXXXXXX] so renamed people still resolve.

export const MENTION_RE = /@\[(usr[A-Za-z0-9]{14})\]/g;

export function mentionedIds(body: string): string[] {
  return [...new Set([...body.matchAll(MENTION_RE)].map((m) => m[1]))];
}

export type CommentPart = { kind: "text"; text: string } | { kind: "mention"; userId: string };

export function splitMentions(body: string): CommentPart[] {
  const parts: CommentPart[] = [];
  let last = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    if (m.index! > last) parts.push({ kind: "text", text: body.slice(last, m.index) });
    parts.push({ kind: "mention", userId: m[1] });
    last = m.index! + m[0].length;
  }
  if (last < body.length) parts.push({ kind: "text", text: body.slice(last) });
  return parts;
}

/** Plain text for emails and previews: mentions become @Name. */
export function plainComment(body: string, nameOf: (userId: string) => string | undefined): string {
  return splitMentions(body).map((p) => (p.kind === "text" ? p.text : `@${nameOf(p.userId) ?? "someone"}`)).join("");
}
