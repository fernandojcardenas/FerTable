import { test } from "node:test";
import assert from "node:assert/strict";
import { appUrl, inviteEmail, oneLine, resetEmail, sendMail } from "../src/server/mail";

test("without SMTP, emails are written to the log instead of sent", async () => {
  delete process.env.SMTP_URL;
  const logged: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logged.push(a.join(" ")); };
  try {
    await sendMail(resetEmail("ana@example.com", "Ana", "http://localhost:3210/reset?token=abc"));
  } finally {
    console.log = orig;
  }
  assert.match(logged.join("\n"), /To: ana@example.com/);
  assert.match(logged.join("\n"), /reset\?token=abc/);
});

test("links come from configuration, not from the request", () => {
  process.env.APP_URL = "https://grid.example.com/";
  assert.equal(appUrl(), "https://grid.example.com");
  delete process.env.APP_URL;
  assert.match(appUrl(), /^http:\/\/localhost:\d+$/);
});

test("names can't break email headers", () => {
  assert.equal(oneLine("Evil\r\nBcc: victim@example.com"), "Evil Bcc: victim@example.com");
  const m = inviteEmail("x@example.com", "Mallory\nX-Injected: 1", "Plan", "editor", "http://localhost/login");
  assert.ok(!m.subject.includes("\n"));
});
