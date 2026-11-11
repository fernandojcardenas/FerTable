// Make a one-time password reset link for someone (there's no email sending yet).
//   npm run reset-password -- someone@example.com
// The FerTable server must be running; this asks it through a local-only admin endpoint.

import "../src/server/env";
import { readFileSync } from "node:fs";
import { adminTokenPath } from "../src/server/auth";

const email = process.argv[2];
if (!email) {
  console.error("Usage: npm run reset-password -- someone@example.com");
  process.exit(2);
}
let token: string;
try {
  token = readFileSync(adminTokenPath(), "utf8").trim();
} catch {
  console.error(`Can't read ${adminTokenPath()}. Start the FerTable server once first (it creates this file).`);
  process.exit(1);
}
const port = process.env.PORT ?? "3210";
const res = await fetch(`http://${process.env.HOST ?? "localhost"}:${port}/api/admin/reset-link`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-admin-token": token },
  body: JSON.stringify({ email }),
}).catch(() => null);
if (!res) {
  console.error(`The FerTable server isn't reachable on port ${port}. Start it with npm run dev.`);
  process.exit(1);
}
const body = await res.json();
if (!res.ok) {
  console.error(body.error ?? `Failed (${res.status})`);
  process.exit(1);
}
console.log(`Reset link for ${body.email} (works once, for ${body.expiresInMinutes} minutes):\n\n  ${body.url}\n\nSend it to them privately.`);
