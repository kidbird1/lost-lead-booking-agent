// Sends pretend "check this location" requests to the Worker, like the agent does mid-call.
//   node scripts/area-test.mjs <assistant-id> "<location>" ["<location>" ...] [--url http://localhost:8787]
// Uses VAPI_SERVER_SECRET from worker/.dev.vars.

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const urlFlag = args.indexOf("--url");
const base = urlFlag >= 0 ? args.splice(urlFlag, 2)[1] : "http://localhost:8787";
const [assistantId, ...locations] = args;
const secret = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^VAPI_SERVER_SECRET\s*=\s*"?([^"\r\n]+)"?/m)?.[1];

for (const location of locations) {
  const res = await fetch(`${base}/vapi`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-vapi-secret": secret },
    body: JSON.stringify({ message: { type: "tool-calls", call: { id: `area-test-${Date.now()}`, assistantId },
      toolCallList: [{ id: "x", function: { name: "checkServiceArea", arguments: { location } } }] } }),
  });
  const data = await res.json();
  console.log(`[${location}]\n    ${data.results?.[0]?.result || JSON.stringify(data)}`);
  await new Promise((r) => setTimeout(r, 1100)); // OpenStreetMap asks for 1 lookup a second
}
