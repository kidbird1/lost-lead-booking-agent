import { spawn } from "node:child_process";

const port = process.env.PORT || "3000";
const baseUrl = `http://localhost:${port}`;
const leadViewerToken = "smoke-token";
const callId = `call_smoke_${Date.now()}`;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed: ${JSON.stringify(payload)}`);
  }
  return payload;
}

const server = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: port, LEAD_VIEWER_TOKEN: leadViewerToken },
  stdio: "inherit",
});

try {
  await wait(800);

  const health = await fetch(`${baseUrl}/health`).then((res) => res.json());
  if (!health.ok) throw new Error("health check failed");

  const toolResult = await post("/webhooks/voice", {
    message: {
      type: "tool-calls",
      call: { id: callId },
      toolCallList: [
        {
          id: "tool_smoke_1",
          name: "bookAppointment",
          parameters: {
            name: "Smoke Test",
            phone: "+15555550123",
            service: "roof leak",
            address: "123 Main St",
            urgency: "urgent",
            bookedTime: "Friday 2 PM",
            summary: "Smoke test booking.",
          },
        },
      ],
    },
  });

  if (!Array.isArray(toolResult.results) || toolResult.results.length !== 1) {
    throw new Error("tool call result missing");
  }

  await post("/webhooks/voice", {
    message: {
      type: "end-of-call-report",
      call: { id: callId },
      summary: "Fallback summary should not create a duplicate lead.",
      artifact: { transcript: "Caller booked through the appointment tool." },
    },
  });

  const leadsPayload = await fetch(`${baseUrl}/api/leads?token=${leadViewerToken}`).then((res) => res.json());
  const matchingLeads = leadsPayload.leads.filter((lead) => lead.callId === callId);
  if (matchingLeads.length !== 1) {
    throw new Error(`expected one lead for call, found ${matchingLeads.length}`);
  }

  console.log("Smoke test passed");
} finally {
  server.kill();
}

