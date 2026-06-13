import { spawn } from "node:child_process";

if (!process.env.DATABASE_URL) {
  console.log("DATABASE_URL is not set; skipping Postgres smoke test.");
  process.exit(0);
}

const port = process.env.PORT || "3010";
const baseUrl = `http://127.0.0.1:${port}`;
const token = "db-smoke-token";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      const payload = await response.json();
      if (response.ok && payload.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(150);
  }

  throw lastError || new Error("health check timed out");
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${path} failed: ${JSON.stringify(payload)}`);
  return payload;
}

const server = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env,
    PORT: port,
    NODE_ENV: "test",
    LEAD_VIEWER_TOKEN: token,
    SEND_LIVE_MESSAGES: "false",
    SEND_LIVE_CALENDAR: "false",
    BUSINESS_NAME: "DB Smoke Services",
    ASSISTANT_NAME: "Riley",
    BUSINESS_INDUSTRY: "home services",
    BUSINESS_TIMEZONE: "America/New_York",
  },
  stdio: "inherit",
});

try {
  await waitForHealth();

  const created = await post(`/leads?token=${token}`, {
    name: "DB Smoke Caller",
    phone: "+15555550177",
    service: "test repair",
    address: "33487",
    requestedTime: "tomorrow at 10 AM",
    summary: "Postgres smoke test lead.",
  });
  if (!created.ok || !created.lead?.id) {
    throw new Error("expected Postgres smoke lead to be created");
  }

  const leads = await fetch(`${baseUrl}/api/leads?token=${token}`).then((res) => res.json());
  if (!leads.ok || !leads.leads.some((lead) => lead.id === created.lead.id)) {
    throw new Error("expected Postgres smoke lead to be readable");
  }

  const status = await post(`/leads/status?token=${token}`, {
    id: created.lead.id,
    status: "contacted",
    note: "DB smoke status update.",
  });
  if (!status.ok || status.lead.status !== "contacted") {
    throw new Error("expected Postgres smoke lead status update");
  }

  const backup = await fetch(`${baseUrl}/api/backup.json?token=${token}`).then((res) => res.json());
  if (!backup.ok || !backup.leads.some((lead) => lead.id === created.lead.id)) {
    throw new Error("expected Postgres smoke backup to include lead");
  }

  console.log("Postgres smoke test passed");
} finally {
  server.kill();
}
