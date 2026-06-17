import { spawn } from "node:child_process";

if (!process.env.DATABASE_URL) {
  console.log("DATABASE_URL is not set; skipping Postgres smoke test.");
  process.exit(0);
}

const port = process.env.PORT || "3010";
const baseUrl = `http://127.0.0.1:${port}`;
const token = "db-smoke-token";
const adminToken = "db-smoke-admin-token";

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
    ADMIN_TOKEN: adminToken,
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

  const savedClient = await post(`/api/clients?token=${adminToken}`, {
    businessId: "db-smoke-client",
    businessName: "DB Smoke Client",
    assistantName: "Riley",
    industry: "home services",
    timezone: "America/New_York",
    ownerPhone: "+15555550123",
    ownerWhatsApp: "+15555550123",
    assistantId: "asst_db_smoke",
    phoneNumber: "+15550002001",
    services: "test repair",
    serviceAreas: "33487",
  });
  if (!savedClient.ok || !savedClient.leadViewerToken || savedClient.profile.businessId !== "db-smoke-client") {
    throw new Error("expected Postgres smoke client to be saved");
  }
  if (!savedClient.profile.services.includes("test repair") || !savedClient.profile.serviceAreas.includes("33487")) {
    throw new Error("expected Postgres smoke client save to preserve services and service areas");
  }

  const clients = await fetch(`${baseUrl}/api/clients?token=${adminToken}`).then((res) => res.json());
  if (!clients.ok || clients.storage !== "postgres" || !clients.clients.some((client) => client.id === "db-smoke-client")) {
    throw new Error("expected Postgres smoke client to be readable");
  }
  const systemStatus = await fetch(`${baseUrl}/api/system-status?token=${adminToken}`).then((res) => res.json());
  const clientRoutingCheck = systemStatus.checks?.find((check) => check.key === "client_routing");
  if (!clientRoutingCheck || clientRoutingCheck.status !== "ready" || !clientRoutingCheck.detail.includes("tenant routing")) {
    throw new Error("expected system status to recognize Postgres client routing");
  }

  const clientsPage = await fetch(`${baseUrl}/admin/clients?token=${adminToken}`).then((res) => res.text());
  if (!clientsPage.includes("DB Smoke Client") || !clientsPage.includes("Storage: Postgres")) {
    throw new Error("expected Postgres smoke clients page to render saved client");
  }

  const tenantLead = await post(`/leads?token=${savedClient.leadViewerToken}`, {
    name: "DB Tenant Caller",
    phone: "+15555550188",
    service: "tenant repair",
    address: "33487",
    requestedTime: "tomorrow at 11 AM",
  });
  if (!tenantLead.ok || tenantLead.lead?.businessId !== "db-smoke-client") {
    throw new Error("expected saved client token to create a tenant-scoped lead");
  }

  const tenantLeads = await fetch(`${baseUrl}/api/leads?token=${savedClient.leadViewerToken}`).then((res) => res.json());
  if (!tenantLeads.ok || tenantLeads.leads.some((lead) => lead.businessId !== "db-smoke-client")) {
    throw new Error("expected saved client token to read only its tenant leads");
  }

  await post(`/webhooks/voice`, {
    message: {
      type: "tool-calls",
      call: {
        id: "call_db_routed_client",
        assistantId: "asst_db_smoke",
        phoneNumber: { number: "+15550002001" },
      },
      toolCallList: [
        {
          id: "tool_db_routed_client",
          name: "bookAppointment",
          parameters: {
            name: "DB Routed Caller",
            phone: "+15555550189",
            service: "tenant repair",
            address: "33487",
            bookedTime: "tomorrow at 2 PM",
          },
        },
      ],
    },
  });

  const routedTenantLeads = await fetch(`${baseUrl}/api/leads?token=${savedClient.leadViewerToken}`).then((res) => res.json());
  if (!routedTenantLeads.ok || !routedTenantLeads.leads.some((lead) => lead.callId === "call_db_routed_client" && lead.businessId === "db-smoke-client")) {
    throw new Error("expected saved client assistant ID to route Vapi lead to tenant");
  }

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
