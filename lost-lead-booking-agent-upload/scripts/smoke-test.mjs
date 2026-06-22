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

  const clientScopedClientsPage = await fetch(`${baseUrl}/admin/clients?token=${clientAToken}`);
  if (clientScopedClientsPage.status !== 401) {
    throw new Error("expected client token to be blocked from operator clients page");
  }

  const clientsList = await fetch(`${baseUrl}/api/clients?token=smoke-admin-token`).then((res) => res.json());
  if (!clientsList.ok || clientsList.storage !== "env" || clientsList.clients.length !== clients.length) {
    throw new Error("expected client list API to fall back to env clients without Postgres");
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

