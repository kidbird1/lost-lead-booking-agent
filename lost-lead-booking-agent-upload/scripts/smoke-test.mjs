import { spawn } from "node:child_process";

const port = process.env.PORT || "3000";
const baseUrl = `http://localhost:${port}`;
const leadViewerToken = "smoke-token";
const callId = `call_smoke_${Date.now()}`;
const afterHoursCallId = `call_after_hours_${Date.now()}`;
const busySlotCallId = `call_busy_slot_${Date.now()}`;
const availabilityCallId = `call_availability_${Date.now()}`;
const businessProfile = {
  businessName: "Blue Sky Plumbing",
  assistantName: "Riley",
  industry: "plumbing",
  services: ["drain cleaning", "leak repair", "water heater service"],
  serviceAreas: ["33487", "33485"],
};

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
  env: {
    ...process.env,
    PORT: port,
    NODE_ENV: "test",
    LEAD_VIEWER_TOKEN: leadViewerToken,
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
  await wait(800);

  const health = await fetch(`${baseUrl}/health`).then((res) => res.json());
  if (!health.ok) throw new Error("health check failed");

  const agentContext = await fetch(`${baseUrl}/api/agent-context?token=${leadViewerToken}`)
    .then((res) => res.json());
  if (!agentContext.ok || agentContext.profile.businessName !== businessProfile.businessName) {
    throw new Error("expected agent context to use business profile");
  }
  if (!agentContext.prompt.includes("Blue Sky Plumbing") || !agentContext.firstMessage.includes("Blue Sky Plumbing")) {
    throw new Error("expected generated prompt and first message to use business profile");
  }

  const profilePage = await fetch(`${baseUrl}/admin/profile?token=${leadViewerToken}`)
    .then((res) => res.text());
  if (!profilePage.includes("Blue Sky Plumbing Setup") || !profilePage.includes("Copy Prompt")) {
    throw new Error("expected protected profile setup page to render");
  }

  const onboardingPage = await fetch(`${baseUrl}/admin/onboarding?token=${leadViewerToken}`)
    .then((res) => res.text());
  if (!onboardingPage.includes("Client Onboarding") || !onboardingPage.includes("Generate")) {
    throw new Error("expected protected onboarding page to render");
  }

  const previewResult = await post(`/api/profile-preview?token=${leadViewerToken}`, {
    businessName: "Bright Root Dental",
    assistantName: "Riley",
    industry: "dental office",
    services: "cleanings, emergency dental visits",
    serviceAreas: "33487, Boca Raton",
  });
  if (!previewResult.prompt.includes("Bright Root Dental") || !previewResult.envSnippet.includes("BUSINESS_NAME=Bright Root Dental")) {
    throw new Error("expected onboarding preview to generate profile output");
  }

  const availabilityResult = await post("/webhooks/voice", {
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
  if (matchingLeads[0].status !== "booked" || matchingLeads[0].scheduleStatus !== "scheduled") {
    throw new Error("expected in-hours booking to be scheduled");
  }
  if (matchingLeads[0].calendarStatus !== "live" || !matchingLeads[0].calendarLink) {
    throw new Error("expected in-hours booking to create a calendar event");
  }

  await post("/webhooks/voice", {
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

  await post("/webhooks/voice", {
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

