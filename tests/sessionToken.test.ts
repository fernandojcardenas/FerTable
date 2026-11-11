import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionToken } from "../src/server/auth";

test("the iOS app's bearer token and the browser's cookie both identify a session", () => {
  assert.equal(sessionToken({ authorization: "Bearer abc123" }), "abc123");
  assert.equal(sessionToken({ cookie: "x=1; ft_session=cookieTok" }), "cookieTok");
  assert.equal(sessionToken({ authorization: "Bearer abc123", cookie: "ft_session=cookieTok" }), "abc123", "the header wins");
  assert.equal(sessionToken({ authorization: "Bearer patABCDEFGHIJKLMN.xyz" }), null, "API tokens are for /v1 only");
  assert.equal(sessionToken({ authorization: "Basic abc" }), null);
  assert.equal(sessionToken({}), null);
});
