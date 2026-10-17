// Sends a pretend "call ended" report to the Worker, like Vapi would.
//   node scripts/fake-call.mjs <assistant-id> [worker-url]
// Uses VAPI_SERVER_SECRET from worker/.dev.vars.

import { readFileSync } from "node:fs";

const assistantId = process.argv[2] || "test-assistant";
const base = (process.argv[3] || "http://localhost:8787").replace(/\/$/, "");
const vars = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
const secret = vars.match(/^VAPI_SERVER_SECRET\s*=\s*"?([^"\r\n]+)"?/m)?.[1];

const report = {
  message: {
    type: "end-of-call-report",
    endedReason: "assistant-ended-call",
    durationSeconds: 94,
    call: { id: `fake-${Date.now()}`, assistantId, customer: { number: "+15615550123" } },
    analysis: {
      summary: "Caller has a roof leak over the kitchen after last night's storm. Wants someone out tomorrow morning.",
      structuredData: {
        name: "Dana Lopez", callback: "+15615550123", service: "Roof leak over kitchen",
        address: "412 Palm Way, Boca Raton", urgency: "this week", best_time: "tomorrow morning",
      },
    },
    artifact: { transcript: "AI: Thanks for calling Test Roofing...\nUser: Hi, my roof is leaking..." },
  },
};

for (const [label, headers] of [["good secret", { "x-vapi-secret": secret }], ["bad secret", { "x-vapi-secret": "wrong" }]]) {
  const res = await fetch(`${base}/vapi`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(report) });
  console.log(label, res.status, await res.text());
}
// Same call again: should be ignored as a duplicate.
const again = await fetch(`${base}/vapi`, { method: "POST", headers: { "content-type": "application/json", "x-vapi-secret": secret }, body: JSON.stringify(report) });
console.log("duplicate", again.status, await again.text());
