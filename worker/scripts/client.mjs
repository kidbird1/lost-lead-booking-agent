// Operator commands. You (or Claude / Codex) run these instead of clicking around.
//
//   node scripts/client.mjs add clients/acme-roofing.json
//   node scripts/client.mjs pause acme-roofing
//   node scripts/client.mjs resume acme-roofing
//   node scripts/client.mjs status
//   node scripts/client.mjs numbers      (phone numbers you already own in Vapi)
//
// Reads WORKER_URL and ADMIN_PASSWORD from worker/.ops.env (or the environment).

import { readFileSync, existsSync } from "node:fs";

const envFile = new URL("../.ops.env", import.meta.url);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const base = (process.env.WORKER_URL || "http://localhost:8787").replace(/\/$/, "");
const password = process.env.ADMIN_PASSWORD;
if (!password) {
  console.error("Set ADMIN_PASSWORD in worker/.ops.env first.");
  process.exit(1);
}

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: "Basic " + Buffer.from(`ops:${password}`).toString("base64"), "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(async () => ({ raw: await res.text() }));
  console.log(JSON.stringify(data, null, 2));
  if (!res.ok || data.ok === false) process.exit(1);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "add" && arg) await call("POST", "/admin/clients", JSON.parse(readFileSync(arg, "utf8")));
else if ((cmd === "pause" || cmd === "resume") && arg) await call("POST", `/admin/clients/${arg}/${cmd}`);
else if (cmd === "status") await call("GET", "/admin/status");
else if (cmd === "numbers") await call("GET", "/admin/vapi-numbers");
else console.log("Usage: add <file.json> | pause <id> | resume <id> | status | numbers");
