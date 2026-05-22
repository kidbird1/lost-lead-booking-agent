import { spawn } from "node:child_process";

const port = process.env.PORT || "3000";
const baseUrl = `http://localhost:${port}`;

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
  env: { ...process.env, PORT: port },
  stdio: "inherit",
});

try {
  await wait(800);

  const health = await fetch(`${baseUrl}/health`).then((res) => res.json());
  if (!health.ok) throw new Error("health check failed");

  const toolResult = await post("/webhooks/voice", {
    message: {
      type: "tool-calls",
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

  console.log("Smoke test passed");
} finally {
  server.kill();
}

