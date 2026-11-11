// Delete uploaded files no cell uses anymore (the server also does this every 6 hours).
//   npm run cleanup-files            files unused and older than 7 days
//   npm run cleanup-files -- 0       any unused file, right now

import "../src/server/env";
import { readFileSync } from "node:fs";
import { adminTokenPath } from "../src/server/auth";

const graceHours = process.argv[2] !== undefined ? Number(process.argv[2]) : undefined;
const token = readFileSync(adminTokenPath(), "utf8").trim();
const res = await fetch(`http://${process.env.HOST ?? "localhost"}:${process.env.PORT ?? "3210"}/api/admin/cleanup-files`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-admin-token": token },
  body: JSON.stringify(graceHours === undefined ? {} : { graceHours }),
});
const body = await res.json();
console.log(res.ok ? `Removed ${body.deleted} unused file(s).` : body.error);
