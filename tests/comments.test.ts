import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionedIds, plainComment, splitMentions } from "../src/shared/comments";

const ANA = "usrAAAAAAAAAAAAAA";
const BO = "usrBBBBBBBBBBBBBB";

test("finds each mentioned person once", () => {
  assert.deepEqual(mentionedIds(`Hi @[${ANA}] and @[${BO}], cc @[${ANA}]`), [ANA, BO]);
  assert.deepEqual(mentionedIds("no mentions, just an @ sign and @[bad]"), []);
});

test("splits text and mentions for display", () => {
  assert.deepEqual(splitMentions(`@[${ANA}] can you check?`), [
    { kind: "mention", userId: ANA },
    { kind: "text", text: " can you check?" },
  ]);
});

test("renders plain text for emails", () => {
  const names: Record<string, string> = { [ANA]: "Ana" };
  assert.equal(plainComment(`Thanks @[${ANA}] and @[${BO}]!`, (id) => names[id]), "Thanks @Ana and @someone!");
});
