import { spawn } from "node:child_process";

const port = process.env.PORT || "3000";
const baseUrl = `http://127.0.0.1:${port}`;
const leadViewerToken = "smoke-token";
const clientAToken = "smoke-client-a-token";
const clientBToken = "smoke-client-b-token";
const webhookSecret = "smoke-webhook-secret";
const callId = `call_smoke_${Date.now()}`;
const afterHoursCallId = `call_after_hours_${Date.now()}`;
const busySlotCallId = `call_busy_slot_${Date.now()}`;
const spokenTimeCallId = `call_spoken_time_${Date.now()}`;
const vagueTimeCallId = `call_vague_time_${Date.now()}`;
const availabilityCallId = `call_availability_${Date.now()}`;
const routedClientACallId = `call_routed_client_a_${Date.now()}`;
const concurrentClientACallId = `call_concurrent_client_a_${Date.now()}`;
const retryOwnerAlertCallId = `call_owner_alert_retry_${Date.now()}`;
const exhaustedOwnerAlertCallId = `call_owner_alert_exhausted_${Date.now()}`;
const unknownRouteCallId = `call_unknown_route_${Date.now()}`;
const fallbackCallId = `call_fallback_${Date.now()}`;
const businessProfile = {
  businessId: "blue-sky-plumbing",
  businessName: "Blue Sky Plumbing",
  assistantName: "Riley",
  industry: "plumbing",
  services: ["drain cleaning", "leak repair", "water heater service"],
  serviceAreas: ["33487", "33485"],
};
const clients = [
  {
    businessId: "client-a-plumbing",
    businessName: "Client A Plumbing",
    assistantName: "Riley",
    industry: "plumbing",
    services: ["leak repair"],
    serviceAreas: ["33487"],
    leadViewerToken: clientAToken,
    assistantId: "asst_client_a",
    phoneNumber: "+15550001001",
  },
  {
    businessId: "client-b-hvac",
    businessName: "Client B HVAC",
    assistantName: "Casey",
    industry: "HVAC",
    services: ["AC repair"],
    serviceAreas: ["33485"],
    leadViewerToken: clientBToken,
    assistantId: "asst_client_b",
    phoneNumber: "+15550001002",
  },
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      const payload = await response.json();
      if (response.ok && payload.ok) return payload;
      lastError = new Error(`health check returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(150);
  }

  throw lastError || new Error("health check timed out");
}

async function waitForValue(load, matches, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await load();
    if (matches(value)) return value;
    await wait(20);
  }
  throw new Error("timed out waiting for expected value");
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

async function postForm(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const payload = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed: ${payload}`);
  }
  return payload;
}

function webhookPath(path) {
  return `${path}?webhook_secret=${encodeURIComponent(webhookSecret)}`;
}

const server = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env,
    PORT: port,
    NODE_ENV: "test",
    LEAD_VIEWER_TOKEN: leadViewerToken,
    ADMIN_TOKEN: "smoke-admin-token",
    CLIENTS_JSON: JSON.stringify(clients),
    WEBHOOK_SHARED_SECRET: webhookSecret,
    SEND_LIVE_MESSAGES: "false",
    SEND_LIVE_CALENDAR: "true",
    CHECK_CALENDAR_AVAILABILITY: "true",
    MOCK_GOOGLE_CALENDAR: "true",
    MOCK_GOOGLE_CALENDAR_BUSY_CALL_IDS: busySlotCallId,
    MOCK_OWNER_ALERT_FAIL_ONCE_CALL_IDS: retryOwnerAlertCallId,
    MOCK_OWNER_ALERT_ALWAYS_FAIL_CALL_IDS: exhaustedOwnerAlertCallId,
    OWNER_ALERT_MAX_ATTEMPTS: "3",
    OWNER_ALERT_RETRY_BASE_SECONDS: "0.02",
    OWNER_ALERT_WORKER_INTERVAL_SECONDS: "0.02",
    ENABLE_OPERATOR_ALERTS: "true",
    OPERATOR_WHATSAPP_NUMBER: "+15555550199",
    BUSINESS_TIMEZONE: "America/New_York",
    BUSINESS_HOURS_START: "08:00",
    BUSINESS_HOURS_END: "18:00",
    DEFAULT_APPOINTMENT_MINUTES: "60",
    AVAILABLE_SLOT_INTERVAL_MINUTES: "60",
    MAX_AVAILABLE_SLOTS: "3",
    SCHEDULING_NOW_ISO: "2026-05-27T10:00:00-04:00",
    BUSINESS_PROFILE_JSON: JSON.stringify(businessProfile),
  },
  stdio: "inherit",
});

try {
  const health = await waitForHealth();
  if (!health.deployment || health.deployment.version !== "0.1.0") {
    throw new Error("expected health endpoint to include deployment version");
  }

  const agentContext = await fetch(`${baseUrl}/api/agent-context?token=${leadViewerToken}`)
    .then((res) => res.json());
  if (!agentContext.ok || agentContext.profile.businessName !== businessProfile.businessName) {
    throw new Error("expected agent context to use business profile");
  }
  if (agentContext.profile.businessId !== businessProfile.businessId) {
    throw new Error("expected agent context to expose business ID");
  }
  if (!agentContext.prompt.includes("Blue Sky Plumbing") || !agentContext.firstMessage.includes("Blue Sky Plumbing")) {
    throw new Error("expected generated prompt and first message to use business profile");
  }

  const profilePage = await fetch(`${baseUrl}/admin/profile?token=${leadViewerToken}`)
    .then((res) => res.text());
  if (!profilePage.includes("Blue Sky Plumbing Setup") || !profilePage.includes("Copy Prompt")) {
    throw new Error("expected protected profile setup page to render");
  }
  if (!profilePage.includes("Clients")) {
    throw new Error("expected profile setup page to link to clients");
  }

  const onboardingPage = await fetch(`${baseUrl}/admin/onboarding?token=${leadViewerToken}`)
    .then((res) => res.text());
  if (!onboardingPage.includes("Client Onboarding") || !onboardingPage.includes("Generate")) {
    throw new Error("expected protected onboarding page to render");
  }
  if (!onboardingPage.includes("Save Client") || !onboardingPage.includes("Private Lead Viewer Token")) {
    throw new Error("expected onboarding page to include client save controls");
  }
  if (!onboardingPage.includes("Clients")) {
    throw new Error("expected onboarding page to link to clients");
  }

  const clientsPage = await fetch(`${baseUrl}/admin/clients?token=smoke-admin-token`).then((res) => res.text());
  if (!clientsPage.includes("Clients") || !clientsPage.includes("Client A Plumbing") || !clientsPage.includes("Storage: Environment config")) {
    throw new Error("expected protected clients page to render env clients");
  }
  if (!clientsPage.includes("Vapi Route") || !clientsPage.includes("Lead Viewer") || !clientsPage.includes("Open issues")) {
    throw new Error("expected protected clients page to show operator control room fields");
  }
  if (!clientsPage.includes("clientId=client-a-plumbing") || !clientsPage.includes("clientId=client-b-hvac")) {
    throw new Error("expected client control room actions to open tenant-scoped views");
  }

  const clientScopedClientsPage = await fetch(`${baseUrl}/admin/clients?token=${clientAToken}`);
  if (clientScopedClientsPage.status !== 401) {
    throw new Error("expected client token to be blocked from operator clients page");
  }

  const clientsList = await fetch(`${baseUrl}/api/clients?token=smoke-admin-token`).then((res) => res.json());
  if (!clientsList.ok || clientsList.storage !== "env" || clientsList.clients.length !== clients.length) {
    throw new Error("expected client list API to fall back to env clients without Postgres");
  }
  if (!clientsList.clients.every((client) => client.setupStatus && Number.isFinite(client.leadCount) && Number.isFinite(client.issueCount))) {
    throw new Error("expected client list API to include control room counts");
  }

  const clientSaveResponse = await fetch(`${baseUrl}/api/clients?token=smoke-admin-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      businessId: "smoke-new-client",
      businessName: "Smoke New Client",
    }),
  });
  const clientSavePayload = await clientSaveResponse.json();
  if (clientSaveResponse.status !== 503 || clientSavePayload.error !== "database_not_configured") {
    throw new Error("expected client save API to fail safely without Postgres");
  }

  const statusPage = await fetch(`${baseUrl}/admin/status?token=${leadViewerToken}`)
    .then((res) => res.text());
  if (!statusPage.includes("System Status")
    || !statusPage.includes("Owner notifications")
    || !statusPage.includes("Pilot Readiness")
    || !statusPage.includes("Live Pilot Checklist")) {
    throw new Error("expected protected system status page to render");
  }

  const systemStatus = await fetch(`${baseUrl}/api/system-status?token=${leadViewerToken}`)
    .then((res) => res.json());
  if (!systemStatus.ok || !Array.isArray(systemStatus.checks)) {
    throw new Error("expected protected system status API to return checks");
  }
  if (!systemStatus.deployment || systemStatus.deployment.version !== "0.1.0") {
    throw new Error("expected protected system status API to return deployment details");
  }
  if (!systemStatus.pilotReadiness || !Array.isArray(systemStatus.pilotReadiness.nextActions)) {
    throw new Error("expected protected system status API to return pilot readiness");
  }
  if (!systemStatus.ready) {
    throw new Error("expected system status to be ready in mock live mode");
  }
  if (systemStatus.profile.businessId !== businessProfile.businessId) {
    throw new Error("expected system status to expose business ID");
  }
  const clientRoutingCheck = systemStatus.checks.find((check) => check.key === "client_routing");
  if (!clientRoutingCheck || clientRoutingCheck.status !== "ready" || !clientRoutingCheck.detail.includes("tenant routing")) {
    throw new Error("expected system status to recognize configured client routing");
  }
  if (!systemStatus.checks.some((check) => check.key === "calendar_booking" && check.status === "ready")) {
    throw new Error("expected system status to show calendar booking ready in mock live mode");
  }
  if (!systemStatus.checks.some((check) => check.key === "voice_fallback" && check.status === "ready")) {
    throw new Error("expected system status to show Twilio voice fallback ready");
  }

  const previewResult = await post(`/api/profile-preview?token=${leadViewerToken}`, {
    businessId: "bright-root-dental",
    businessName: "Bright Root Dental",
    assistantName: "Riley",
    industry: "dental office",
    timezone: "America/New_York",
    businessHoursStart: "09:00",
    businessHoursEnd: "17:00",
    ownerPhone: "+15555550129",
    ownerWhatsApp: "+15555550130",
    bookingLink: "https://calendly.com/bright-root/visit",
    services: "cleanings, emergency dental visits",
    serviceAreas: "33487, Boca Raton",
  });
  if (!previewResult.prompt.includes("Bright Root Dental") || !previewResult.envSnippet.includes("BUSINESS_NAME=Bright Root Dental")) {
    throw new Error("expected onboarding preview to generate profile output");
  }
  if (!previewResult.prompt.includes("I saved your appointment request. The team will confirm.")) {
    throw new Error("expected onboarding prompt to use safe appointment request wording");
  }
  if (!previewResult.setup
    || previewResult.setup.clientId !== "bright-root-dental"
    || !previewResult.setup.leadViewerLink.includes("/admin/leads?token=")
    || !previewResult.setup.vapiToolUrl.endsWith("/webhooks/voice")
    || !previewResult.setup.ownerNotificationSetup.includes("OWNER_WHATSAPP_NUMBER=+15555550130")
    || previewResult.setup.bookingLink !== "https://calendly.com/bright-root/visit"
    || !previewResult.setup.liveTestChecklist.some((item) => item.includes("exactly one lead"))) {
    throw new Error("expected onboarding preview to return complete client setup output");
  }

  const clientAContext = await fetch(`${baseUrl}/api/agent-context?token=${clientAToken}`)
    .then((res) => res.json());
  if (!clientAContext.ok || clientAContext.profile.businessId !== "client-a-plumbing") {
    throw new Error("expected client token to load its own agent context");
  }

  const clientLead = await post(`/leads?token=${clientAToken}`, {
    name: "Tenant Caller",
    phone: "+15555550131",
    service: "leak repair",
    address: "33487",
    requestedTime: "Friday at 10 AM",
  });
  if (!clientLead.ok || clientLead.lead.businessId !== "client-a-plumbing") {
    throw new Error("expected client token to create a client-scoped lead");
  }

  const clientALeads = await fetch(`${baseUrl}/api/leads?token=${clientAToken}`).then((res) => res.json());
  if (!clientALeads.leads.some((lead) => lead.id === clientLead.lead.id)) {
    throw new Error("expected client A token to see its own lead");
  }

  const clientBLeads = await fetch(`${baseUrl}/api/leads?token=${clientBToken}`).then((res) => res.json());
  if (clientBLeads.leads.some((lead) => lead.id === clientLead.lead.id)) {
    throw new Error("expected client B token not to see client A lead");
  }

  const adminClientALeads = await fetch(`${baseUrl}/api/leads?token=smoke-admin-token&clientId=client-a-plumbing`)
    .then((res) => res.json());
  if (!adminClientALeads.leads.some((lead) => lead.id === clientLead.lead.id)
    || adminClientALeads.leads.some((lead) => lead.businessId !== "client-a-plumbing")) {
    throw new Error("expected admin client A view to contain only client A leads");
  }

  const adminClientBLeads = await fetch(`${baseUrl}/api/leads?token=smoke-admin-token&clientId=client-b-hvac`)
    .then((res) => res.json());
  if (adminClientBLeads.leads.some((lead) => lead.id === clientLead.lead.id)
    || adminClientBLeads.leads.some((lead) => lead.businessId !== "client-b-hvac")) {
    throw new Error("expected admin client B view to contain only client B leads");
  }

  const adminClientALeadsPage = await fetch(`${baseUrl}/admin/leads?token=smoke-admin-token&clientId=client-a-plumbing`)
    .then((res) => res.text());
  if (!adminClientALeadsPage.includes("Client A Plumbing Lead Follow-Up")
    || !adminClientALeadsPage.includes("Tenant Caller")) {
    throw new Error("expected admin client A leads page to use the selected tenant");
  }

  const adminClientAIssues = await fetch(`${baseUrl}/api/issues?token=smoke-admin-token&clientId=client-a-plumbing`)
    .then((res) => res.json());
  if (adminClientAIssues.issues.some((issue) => issue.businessId !== "client-a-plumbing")) {
    throw new Error("expected admin client A issues to contain only client A records");
  }

  const adminClientAIssuesPage = await fetch(`${baseUrl}/admin/issues?token=smoke-admin-token&clientId=client-a-plumbing`)
    .then((res) => res.text());
  if (!adminClientAIssuesPage.includes("<title>Client A Plumbing Issues</title>")
    || !adminClientAIssuesPage.includes("<h1>Client A Plumbing Issues</h1>")
    || !adminClientAIssuesPage.includes("client-a-plumbing")
    || adminClientAIssuesPage.includes("client-b-hvac")) {
    throw new Error("expected admin client A issues page to show only the selected tenant");
  }

  await post(webhookPath("/webhooks/voice"), {
    message: {
      type: "tool-calls",
      call: { id: retryOwnerAlertCallId, assistantId: "asst_client_a" },
      toolCallList: [
        {
          id: "tool_owner_alert_retry",
          name: "bookAppointment",
          parameters: {
            name: "Retry Test Caller",
            phone: "+15555550132",
            service: "leak repair",
            requestedTime: "Friday morning",
            summary: "Verify a transient owner alert failure retries safely.",
          },
        },
      ],
    },
  });

  const retriedOwnerAlertLead = await waitForValue(
    async () => {
      const payload = await fetch(`${baseUrl}/api/leads?token=${clientAToken}`).then((res) => res.json());
      return payload.leads.find((lead) => lead.callId === retryOwnerAlertCallId);
    },
    (lead) => lead?.ownerNotificationMode === "test" && lead.ownerNotificationAttempts === 2,
  );
  if (retriedOwnerAlertLead.businessId !== "client-a-plumbing"
    || retriedOwnerAlertLead.ownerNotificationError
    || retriedOwnerAlertLead.ownerNotificationNextRetryAt) {
    throw new Error("expected transient owner alert failure to recover inside the selected tenant");
  }
  const clientBAfterRetry = await fetch(`${baseUrl}/api/leads?token=${clientBToken}`).then((res) => res.json());
  if (clientBAfterRetry.leads.some((lead) => lead.callId === retryOwnerAlertCallId)) {
    throw new Error("expected retried owner alert lead to remain isolated from client B");
  }

  await post(webhookPath("/webhooks/voice"), {
    message: {
      type: "tool-calls",
      call: { id: exhaustedOwnerAlertCallId, assistantId: "asst_client_b" },
      toolCallList: [
        {
          id: "tool_owner_alert_exhausted",
          name: "bookAppointment",
          parameters: {
            name: "Exhausted Retry Caller",
            phone: "+15555550133",
            service: "AC repair",
            requestedTime: "Friday afternoon",
            summary: "Verify permanent owner alert failure stops safely.",
          },
        },
      ],
    },
  });

  const exhaustedOwnerAlertLead = await waitForValue(
    async () => {
      const payload = await fetch(`${baseUrl}/api/leads?token=${clientBToken}`).then((res) => res.json());
      return payload.leads.find((lead) => lead.callId === exhaustedOwnerAlertCallId);
    },
    (lead) => lead?.ownerNotificationMode === "error" && lead.ownerNotificationAttempts === 3,
  );
  if (exhaustedOwnerAlertLead.ownerNotificationNextRetryAt) {
    throw new Error("expected permanent owner alert failure to stop after the attempt limit");
  }
  const clientBFailureIssues = await fetch(`${baseUrl}/api/issues?token=${clientBToken}`).then((res) => res.json());
  if (!clientBFailureIssues.issues.some((issue) => issue.type === "owner_alert_failed" && issue.leadId === exhaustedOwnerAlertLead.id)
    || clientBFailureIssues.issues.some((issue) => issue.businessId !== "client-b-hvac")) {
    throw new Error("expected exhausted owner alert failure to remain visible only to client B");
  }
  const clientAIssuesAfterFailure = await fetch(`${baseUrl}/api/issues?token=${clientAToken}`).then((res) => res.json());
  if (clientAIssuesAfterFailure.issues.some((issue) => issue.leadId === exhaustedOwnerAlertLead.id)) {
    throw new Error("expected client A not to see client B owner alert failure");
  }
  const operatorEventsAfterFailure = await fetch(`${baseUrl}/api/events?token=smoke-admin-token`).then((res) => res.json());
  const exhaustedAlertEvents = operatorEventsAfterFailure.events.filter((event) => event.type === "operator_alert_test"
    && event.businessId === "client-b-hvac"
    && event.callId === exhaustedOwnerAlertCallId);
  if (exhaustedAlertEvents.length !== 1 || !exhaustedAlertEvents[0].summary.includes("Owner alert failed permanently")) {
    throw new Error("expected one sanitized operator WhatsApp alert for exhausted client B retries");
  }
  const repeatedManualAlert = await fetch(`${baseUrl}/leads/notify-owner?token=${clientBToken}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: exhaustedOwnerAlertLead.id }),
  });
  if (repeatedManualAlert.status !== 400) {
    throw new Error("expected repeated failed owner notification to report failure");
  }
  const operatorEventsAfterDuplicate = await fetch(`${baseUrl}/api/events?token=smoke-admin-token`).then((res) => res.json());
  if (operatorEventsAfterDuplicate.events.filter((event) => event.type === "operator_alert_test"
    && event.callId === exhaustedOwnerAlertCallId).length !== 1) {
    throw new Error("expected exhausted owner alert notification to be deduplicated");
  }

  const missingAdminClient = await fetch(`${baseUrl}/api/leads?token=smoke-admin-token&clientId=missing-client`);
  if (missingAdminClient.status !== 404) {
    throw new Error("expected unknown admin client scope to fail safely");
  }

  const blockedClientDetail = await fetch(`${baseUrl}/api/leads/${clientLead.lead.id}?token=${clientBToken}`);
  if (blockedClientDetail.status !== 404) {
    throw new Error("expected client B token not to access client A lead detail");
  }

  const blockedWebhook = await fetch(`${baseUrl}/webhooks/voice`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: { type: "tool-calls", toolCallList: [] } }),
  });
  if (blockedWebhook.status !== 401) {
    throw new Error("expected webhook secret to protect voice webhook");
  }

  const fallbackTwiml = await fetch(`${baseUrl}${webhookPath("/webhooks/twilio/voice-fallback")}`).then((res) => res.text());
  if (!fallbackTwiml.includes("<Record") || !fallbackTwiml.includes("/webhooks/twilio/recording") || !fallbackTwiml.includes("webhook_secret=")) {
    throw new Error("expected Twilio fallback endpoint to return recording TwiML");
  }

  await postForm(webhookPath("/webhooks/twilio/recording"), {
    CallSid: fallbackCallId,
    From: "+15555550128",
    TranscriptionText: "My name is Backup Caller. I need leak repair at ZIP 33487 tomorrow at 10 AM.",
  });

  const fallbackPayload = await fetch(`${baseUrl}/api/leads?token=${leadViewerToken}`).then((res) => res.json());
  const fallbackLead = fallbackPayload.leads.find((lead) => lead.callId === fallbackCallId);
  if (!fallbackLead || fallbackLead.status !== "needs_follow_up" || fallbackLead.source !== "twilio_voice_fallback") {
    throw new Error("expected Twilio fallback recording to save a follow-up lead");
  }
  if (fallbackLead.businessId !== businessProfile.businessId) {
    throw new Error("expected fallback lead to include business ID");
  }
  if (fallbackLead.ownerNotificationMode !== "test") {
    throw new Error("expected fallback lead to record owner notification status");
  }

  const availabilityResult = await post(webhookPath("/webhooks/voice"), {
    message: {
      type: "tool-calls",
      call: { id: availabilityCallId },
      toolCallList: [
        {
          id: "tool_availability_1",
          name: "getAvailableSlots",
          parameters: {
            requestedTime: "Friday",
          },
        },
      ],
    },
  });
  const availability = JSON.parse(availabilityResult.results?.[0]?.result || "{}");
  if (!availability.ok || !Array.isArray(availability.slots) || availability.slots.length === 0) {
    throw new Error("expected available slots from Vapi availability tool");
  }
  if (!availability.slots[0].label.includes("Friday")) {
    throw new Error("expected availability label to include requested day");
  }

  const availabilityApi = await fetch(`${baseUrl}/api/availability?token=${leadViewerToken}&requestedTime=Friday`)
    .then((res) => res.json());
  if (!availabilityApi.ok || !Array.isArray(availabilityApi.slots) || availabilityApi.slots.length === 0) {
    throw new Error("expected available slots from protected availability API");
  }

  const clientAAssistantRequest = await post(webhookPath("/webhooks/voice"), {
    message: {
      type: "assistant-request",
      call: {
        id: "call_assistant_request_client_a",
        assistantId: "asst_client_a",
        phoneNumber: { number: "+15550001001" },
      },
    },
  });
  if (clientAAssistantRequest.assistantId !== "asst_client_a") {
    throw new Error("expected assistant request to route to client A assistant");
  }

  const unknownRouteResult = await post(webhookPath("/webhooks/voice"), {
    message: {
      type: "tool-calls",
      call: { id: unknownRouteCallId, assistantId: "asst_unknown" },
      toolCallList: [
        {
          id: "tool_unknown_route",
          name: "bookAppointment",
          parameters: {
            name: "Unknown Route",
            phone: "+15555559999",
            service: "test",
            bookedTime: "Friday 1 PM",
          },
        },
      ],
    },
  });
  if (unknownRouteResult.ok !== false || unknownRouteResult.error !== "client_route_not_found") {
    throw new Error("expected unknown tenant route to fail safely");
  }
  await post(webhookPath("/webhooks/voice"), {
    message: {
      type: "tool-calls",
      call: { id: unknownRouteCallId, assistantId: "asst_unknown" },
      toolCallList: [],
    },
  });
  const unknownRouteEvents = await fetch(`${baseUrl}/api/events?token=smoke-admin-token`).then((res) => res.json());
  const routeFailureEvents = unknownRouteEvents.events.filter((event) => event.type === "tenant_route_failed"
    && event.callId === unknownRouteCallId);
  const routeAlertEvents = unknownRouteEvents.events.filter((event) => event.type === "operator_alert_test"
    && event.businessId === "unrouted"
    && event.callId === unknownRouteCallId);
  if (routeFailureEvents.length !== 2
    || routeFailureEvents.some((event) => event.businessId !== "unrouted")
    || routeAlertEvents.length !== 1) {
    throw new Error("expected repeated unknown route failures to create one unrouted operator alert");
  }

  await post(webhookPath("/webhooks/voice"), {
    message: {
      type: "tool-calls",
      call: {
        id: routedClientACallId,
        assistantId: "asst_client_a",
        phoneNumber: { number: "+15550001001" },
      },
      toolCallList: [
        {
          id: "tool_routed_client_a",
          name: "bookAppointment",
          parameters: {
            name: "Client A Caller",
            phone: "+15555550131",
            service: "leak repair",
            address: "33487",
            bookedTime: "Friday 3 PM",
            summary: "Routed client A booking.",
          },
        },
      ],
    },
  });

  const concurrentBookingBody = {
    message: {
      type: "tool-calls",
      call: { id: concurrentClientACallId, assistantId: "asst_client_a" },
      toolCallList: [
        {
          id: "tool_concurrent_client_a",
          name: "bookAppointment",
          parameters: {
            name: "Concurrent Retry Caller",
            phone: "+15555550134",
            service: "leak repair",
            address: "33487",
            bookedTime: "Friday 4 PM",
            summary: "Two Vapi deliveries should create one lead and one owner alert.",
          },
        },
      ],
    },
  };
  await Promise.all([
    post(webhookPath("/webhooks/voice"), concurrentBookingBody),
    post(webhookPath("/webhooks/voice"), concurrentBookingBody),
  ]);
  const concurrentClientALeads = await fetch(`${baseUrl}/api/leads?token=${clientAToken}`).then((res) => res.json());
  const concurrentMatches = concurrentClientALeads.leads.filter((lead) => lead.callId === concurrentClientACallId);
  if (concurrentMatches.length !== 1
    || concurrentMatches[0].ownerNotificationAttempts !== 1
    || concurrentMatches[0].calendarStatus !== "live") {
    throw new Error("expected simultaneous Vapi retries to create one client A lead, calendar event, and owner alert");
  }

  const routedClientALeads = await fetch(`${baseUrl}/api/leads?token=${clientAToken}`).then((res) => res.json());
  const routedClientALead = routedClientALeads.leads.find((lead) => lead.callId === routedClientACallId);
  if (!routedClientALead || routedClientALead.businessId !== "client-a-plumbing") {
    throw new Error("expected routed Vapi call to create a client A lead");
  }

  const routedClientBLeads = await fetch(`${baseUrl}/api/leads?token=${clientBToken}`).then((res) => res.json());
  if (routedClientBLeads.leads.some((lead) => lead.callId === routedClientACallId)) {
    throw new Error("expected routed client A lead to stay out of client B viewer");
  }

  const toolResult = await post(webhookPath("/webhooks/voice"), {
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

  await post(webhookPath("/webhooks/voice"), {
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
  if (matchingLeads[0].status !== "booked" || matchingLeads[0].scheduleStatus !== "scheduled") {
    throw new Error("expected in-hours booking to be scheduled");
  }
  if (matchingLeads[0].businessId !== businessProfile.businessId) {
    throw new Error("expected booking lead to include business ID");
  }
  if (matchingLeads[0].calendarStatus !== "live" || !matchingLeads[0].calendarLink) {
    throw new Error("expected in-hours booking to create a calendar event");
  }
  if (matchingLeads[0].ownerNotificationMode !== "test") {
    throw new Error("expected booking lead to record owner notification status");
  }

  const topLevelCallId = `smoke_top_level_${Date.now()}`;
  await post(webhookPath("/webhooks/voice"), {
    call: { id: topLevelCallId },
    message: {
      type: "tool-calls",
      toolCallList: [
        {
          id: "tool_smoke_top_level_1",
          name: "bookAppointment",
          parameters: {
            name: "Christopher Wallace",
            phone: "+15615576837",
            service: "roof repair",
            address: "33476",
            bookedTime: "tomorrow at 3 PM",
            summary: "Caller needs roof repair tomorrow at 3 PM.",
          },
        },
      ],
    },
  });

  await post(webhookPath("/webhooks/voice"), {
    message: {
      type: "end-of-call-report",
      call: { id: topLevelCallId },
      summary: "AI saved your appointment request for tomorrow at three PM.",
      artifact: {
        transcript: "User asked for roof repair. BookAppointment completed successfully. Assistant saved your appointment request.",
      },
    },
  });

  const topLevelPayload = await fetch(`${baseUrl}/api/leads?token=${leadViewerToken}`).then((res) => res.json());
  const topLevelLeads = topLevelPayload.leads.filter((lead) => lead.callId === topLevelCallId);
  if (topLevelLeads.length !== 1) {
    throw new Error(`expected one top-level call lead, found ${topLevelLeads.length}`);
  }
  if (topLevelLeads[0].name !== "Christopher Wallace" || topLevelLeads[0].source !== "vapi_tool") {
    throw new Error("expected top-level call ID booking to keep the structured tool lead only");
  }

  const endCallFallbackCallId = `smoke_end_call_fallback_${Date.now()}`;
  await post(webhookPath("/webhooks/voice"), {
    message: {
      type: "end-of-call-report",
      call: { id: endCallFallbackCallId },
      summary: "Transcript-only fallback should still save useful caller details.",
      artifact: {
        transcript: "AI: Thanks for calling Demo Roofing Co. How can I help you today? User: Yeah. It's Jonathan Kominger. I'm looking for a roof worker, a maintenance person to do maintenance work on the roof. I'm calling for tomorrow at three PM. That's the time I want someone to come in. And my address, ZIP code is six nine seven seven three, and my phone number is two two seven eight six zero nine four six oh. AI: Perfect. I saved your appointment request for tomorrow at three PM.",
      },
    },
  });

  const endCallFallbackPayload = await fetch(`${baseUrl}/api/leads?token=${leadViewerToken}`).then((res) => res.json());
  const endCallFallbackLead = endCallFallbackPayload.leads.find((lead) => lead.callId === endCallFallbackCallId);
  if (!endCallFallbackLead) {
    throw new Error("expected transcript-only fallback to save a lead");
  }
  if (endCallFallbackLead.name !== "Jonathan Kominger") {
    throw new Error(`expected fallback lead name, got ${endCallFallbackLead.name || "blank"}`);
  }
  if (endCallFallbackLead.phone !== "2278609460") {
    throw new Error(`expected fallback phone digits, got ${endCallFallbackLead.phone || "blank"}`);
  }
  if (endCallFallbackLead.address !== "69773" || !endCallFallbackLead.bookedTime.toLowerCase().includes("tomorrow at three pm")) {
    throw new Error("expected fallback lead to extract ZIP and requested time");
  }
  if (endCallFallbackLead.ownerNotificationMode !== "test") {
    throw new Error("expected transcript-only fallback to record owner notification status");
  }

  const locationFallbackCallId = `smoke_location_fallback_${Date.now()}`;
  await post(webhookPath("/webhooks/voice"), {
    message: {
      type: "end-of-call-report",
      call: { id: locationFallbackCallId },
      summary: "Transcript-only fallback should extract city-style location.",
      artifact: {
        transcript: "AI: Thanks for calling Demo Roofing Co. How can I help you today? User: I need a roof repair. My name is Caller Jones. My phone number is five six one five five five zero one nine nine. I'm in Boca Raton. I want it at... tomorrow at three PM. AI: Perfect. I saved your appointment request for tomorrow at at three PM.",
      },
    },
  });

  const locationFallbackPayload = await fetch(`${baseUrl}/api/leads?token=${leadViewerToken}`).then((res) => res.json());
  const locationFallbackLead = locationFallbackPayload.leads.find((lead) => lead.callId === locationFallbackCallId);
  if (!locationFallbackLead) {
    throw new Error("expected location fallback to save a lead");
  }
  if (locationFallbackLead.address !== "Boca Raton") {
    throw new Error(`expected fallback location Boca Raton, got ${locationFallbackLead.address || "blank"}`);
  }
  if (locationFallbackLead.bookedTime.includes("at at")) {
    throw new Error("expected fallback requested time to clean duplicate at");
  }

  const leadDetailPage = await fetch(`${baseUrl}/admin/leads/${matchingLeads[0].id}?token=${leadViewerToken}`)
    .then((res) => res.text());
  if (!leadDetailPage.includes("Lead Details") || !leadDetailPage.includes("Raw Intake") || !leadDetailPage.includes("Smoke Test") || !leadDetailPage.includes("Lead status")) {
    throw new Error("expected protected lead detail page to render saved lead context");
  }

  const leadDetailApi = await fetch(`${baseUrl}/api/leads/${matchingLeads[0].id}?token=${leadViewerToken}`)
    .then((res) => res.json());
  if (!leadDetailApi.ok || leadDetailApi.lead.id !== matchingLeads[0].id || leadDetailApi.lead.businessId !== businessProfile.businessId) {
    throw new Error("expected protected lead detail API to return saved lead");
  }

  const notifyAgainResult = await post(`/leads/notify-owner?token=${leadViewerToken}`, {
    id: matchingLeads[0].id,
  });
  if (!notifyAgainResult.ok || notifyAgainResult.notification?.mode !== "test") {
    throw new Error("expected protected owner notification resend to work in test mode");
  }

  const detailStatusResult = await post(`/leads/status?token=${leadViewerToken}`, {
    id: matchingLeads[0].id,
    status: "contacted",
    note: "Owner called from detail page.",
  });
  if (!detailStatusResult.ok || detailStatusResult.lead.status !== "contacted") {
    throw new Error("expected protected detail status action to update lead");
  }
  if (!Array.isArray(detailStatusResult.lead.followUpHistory) || !detailStatusResult.lead.followUpHistory.some((item) => item.note === "Owner called from detail page.")) {
    throw new Error("expected protected detail status action to save follow-up history");
  }

  const updatedLeadDetailPage = await fetch(`${baseUrl}/admin/leads/${matchingLeads[0].id}?token=${leadViewerToken}`)
    .then((res) => res.text());
  if (!updatedLeadDetailPage.includes("Follow-Up History") || !updatedLeadDetailPage.includes("Owner called from detail page.")) {
    throw new Error("expected protected lead detail page to show follow-up history");
  }

  const eventsPage = await fetch(`${baseUrl}/admin/events?token=${leadViewerToken}`).then((res) => res.text());
  if (!eventsPage.includes("Event Log") || !eventsPage.includes("tool-calls")) {
    throw new Error("expected protected event log page to show webhook events");
  }

  const eventsPayload = await fetch(`${baseUrl}/api/events?token=${leadViewerToken}`).then((res) => res.json());
  if (!eventsPayload.ok || !eventsPayload.events.some((event) => event.type === "tool-calls")) {
    throw new Error("expected protected event API to include tool-call events");
  }

  const leadsCsv = await fetch(`${baseUrl}/api/leads.csv?token=${leadViewerToken}`).then((res) => res.text());
  if (!leadsCsv.includes("businessId,createdAt,updatedAt,status,name,phone") || !leadsCsv.includes("ownerNotificationMode") || !leadsCsv.includes("followUpHistory") || !leadsCsv.includes("Smoke Test")) {
    throw new Error("expected protected CSV export to include saved leads");
  }

  const backupPayload = await fetch(`${baseUrl}/api/backup.json?token=${leadViewerToken}`)
    .then((res) => res.json());
  if (!backupPayload.ok || backupPayload.profile.businessId !== businessProfile.businessId || !backupPayload.leads.some((lead) => lead.name === "Smoke Test")) {
    throw new Error("expected protected backup export to include profile and saved leads");
  }

  await post(webhookPath("/webhooks/voice"), {
    message: {
      type: "tool-calls",
      call: { id: afterHoursCallId },
      toolCallList: [
        {
          id: "tool_smoke_2",
          name: "bookAppointment",
          parameters: {
            name: "Late Night Test",
            phone: "+15555550124",
            service: "roof inspection",
            address: "456 Main St",
            urgency: "normal",
            bookedTime: "tomorrow at 11 PM",
            summary: "After-hours booking should need review.",
          },
        },
      ],
    },
  });

  const afterHoursPayload = await fetch(`${baseUrl}/api/leads?token=${leadViewerToken}`).then((res) => res.json());
  const afterHoursLead = afterHoursPayload.leads.find((lead) => lead.callId === afterHoursCallId);
  if (!afterHoursLead) throw new Error("expected after-hours lead to be saved");
  if (afterHoursLead.status !== "needs_follow_up" || afterHoursLead.scheduleReason !== "outside_business_hours") {
    throw new Error("expected after-hours lead to need follow-up");
  }

  const issuesPayload = await fetch(`${baseUrl}/api/issues?token=${leadViewerToken}`).then((res) => res.json());
  if (!issuesPayload.ok || !issuesPayload.issues.some((issue) => issue.type === "outside_business_hours")) {
    throw new Error("expected protected issues API to report scheduling follow-up");
  }

  const issuesPage = await fetch(`${baseUrl}/admin/issues?token=${leadViewerToken}`).then((res) => res.text());
  if (!issuesPage.includes("Issues") || !issuesPage.includes("Production watchlist") || !issuesPage.includes("outside_business_hours")) {
    throw new Error("expected protected issues page to render current issues");
  }

  await post(webhookPath("/webhooks/voice"), {
    message: {
      type: "tool-calls",
      call: { id: spokenTimeCallId },
      toolCallList: [
        {
          id: "tool_smoke_spoken",
          name: "bookAppointment",
          parameters: {
            name: "Spoken Time Test",
            phone: "+15555550126",
            service: "roof inspection",
            address: "100 Main St",
            urgency: "normal",
            bookedTime: "Friday, nine in the morning",
            summary: "Caller asked for Friday at nine in the morning.",
          },
        },
      ],
    },
  });

  const spokenPayload = await fetch(`${baseUrl}/api/leads?token=${leadViewerToken}`).then((res) => res.json());
  const spokenLead = spokenPayload.leads.find((lead) => lead.callId === spokenTimeCallId);
  if (!spokenLead) throw new Error("expected spoken-time lead to be saved");
  if (spokenLead.status !== "booked" || spokenLead.scheduleStatus !== "scheduled") {
    throw new Error(`expected spoken-time booking to schedule, got status=${spokenLead.status} schedule=${spokenLead.scheduleStatus} reason=${spokenLead.scheduleReason}`);
  }
  if (!spokenLead.appointmentStartIso) {
    throw new Error("expected spoken-time booking to include appointmentStartIso");
  }

  await post(webhookPath("/webhooks/voice"), {
    message: {
      type: "tool-calls",
      call: { id: vagueTimeCallId },
      toolCallList: [
        {
          id: "tool_smoke_vague",
          name: "bookAppointment",
          parameters: {
            name: "Vague Time Test",
            phone: "+15555550127",
            service: "roof inspection",
            address: "101 Main St",
            urgency: "normal",
            bookedTime: "Friday morning",
            summary: "Caller asked for Friday morning without an exact time.",
          },
        },
      ],
    },
  });

  const vaguePayload = await fetch(`${baseUrl}/api/leads?token=${leadViewerToken}`).then((res) => res.json());
  const vagueLead = vaguePayload.leads.find((lead) => lead.callId === vagueTimeCallId);
  if (!vagueLead) throw new Error("expected vague-time lead to be saved");
  if (vagueLead.status !== "needs_follow_up" || vagueLead.scheduleReason !== "missing_exact_clock_time") {
    throw new Error(`expected vague-time booking to need exact-time follow-up, got status=${vagueLead.status} reason=${vagueLead.scheduleReason}`);
  }

  await post(webhookPath("/webhooks/voice"), {
    message: {
      type: "tool-calls",
      call: { id: busySlotCallId },
      toolCallList: [
        {
          id: "tool_smoke_3",
          name: "bookAppointment",
          parameters: {
            name: "Busy Calendar Test",
            phone: "+15555550125",
            service: "roof inspection",
            address: "789 Main St",
            urgency: "normal",
            bookedTime: "Friday 3 PM",
            summary: "Busy calendar slot should need review.",
          },
        },
      ],
    },
  });

  const busyPayload = await fetch(`${baseUrl}/api/leads?token=${leadViewerToken}`).then((res) => res.json());
  const busyLead = busyPayload.leads.find((lead) => lead.callId === busySlotCallId);
  if (!busyLead) throw new Error("expected busy calendar lead to be saved");
  if (busyLead.status !== "needs_follow_up" || busyLead.scheduleReason !== "calendar_slot_unavailable") {
    throw new Error("expected busy calendar slot to need follow-up");
  }

  console.log("Smoke test passed");
} finally {
  server.kill();
}

