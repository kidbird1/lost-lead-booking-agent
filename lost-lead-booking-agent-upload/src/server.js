import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

const port = Number(process.env.PORT || 3000);
const dataDir = new URL("../data/", import.meta.url);
const leadsFile = new URL("../data/leads.json", import.meta.url);
const eventsFile = new URL("../data/events.json", import.meta.url);

async function ensureStore() {
  if (!existsSync(dataDir)) {
    await mkdir(dataDir, { recursive: true });
  }
  if (!existsSync(leadsFile)) {
    await writeFile(leadsFile, "[]\n");
  }
  if (!existsSync(eventsFile)) {
    await writeFile(eventsFile, "[]\n");
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

async function appendJson(fileUrl, item) {
  await ensureStore();
  const current = JSON.parse(await readFile(fileUrl, "utf8"));
  current.push(item);
  await writeFile(fileUrl, `${JSON.stringify(current, null, 2)}\n`);
  return item;
}

function normalizeLead(input = {}) {
  const parameters = input.parameters || input.arguments || input;
  return {
    status: parameters.status || input.status || "new",
    source: input.source || "voice",
    name: parameters.name || parameters.customerName || parameters.callerName || "",
    phone: parameters.phone || parameters.phoneNumber || parameters.callerPhone || "",
    service: parameters.service || parameters.serviceNeeded || parameters.reason || "",
    address: parameters.address || parameters.zip || parameters.location || "",
    urgency: parameters.urgency || "",
    requestedTime: parameters.requestedTime || parameters.preferredTime || "",
    bookedTime: parameters.bookedTime || parameters.appointmentTime || "",
    summary: parameters.summary || input.summary || "",
    raw: input,
  };
}

async function saveLead(input) {
  const lead = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    status: input.status || "new",
    source: input.source || "voice",
    name: input.name || "",
    phone: input.phone || "",
    service: input.service || "",
    address: input.address || "",
    urgency: input.urgency || "",
    requestedTime: input.requestedTime || "",
    bookedTime: input.bookedTime || "",
    summary: input.summary || "",
    raw: input,
  };
  return appendJson(leadsFile, lead);
}

async function saveEvent(input) {
  return appendJson(eventsFile, {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...input,
  });
}

async function sendTwilioMessage({ to, body, channel = "sms" }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const smsFrom = process.env.TWILIO_PHONE_NUMBER;
  const whatsappFrom = process.env.TWILIO_WHATSAPP_FROM;

  const from = channel === "whatsapp" ? whatsappFrom : smsFrom;
  const formattedTo = channel === "whatsapp" && !to.startsWith("whatsapp:")
    ? `whatsapp:${to}`
    : to;

  if (process.env.SEND_LIVE_MESSAGES !== "true") {
    return { mode: "test", channel, to: formattedTo, body };
  }

  if (!accountSid || !authToken || !from || !to) {
    return { mode: "error", error: "missing_twilio_configuration", channel };
  }

  const form = new URLSearchParams();
  form.set("From", from);
  form.set("To", formattedTo);
  form.set("Body", body);

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    },
  );

  const payload = await response.json();
  if (!response.ok) {
    return { mode: "error", channel, status: response.status, payload };
  }
  return { mode: "live", channel, sid: payload.sid, status: payload.status };
}

async function createCalendarBooking(lead) {
  if (process.env.SEND_LIVE_CALENDAR !== "true") {
    return { mode: "test", bookedTime: lead.bookedTime || lead.requestedTime || "" };
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const startIso = lead.raw.appointmentStartIso || lead.raw.startIso;
  const endIso = lead.raw.appointmentEndIso || lead.raw.endIso;

  if (!clientId || !clientSecret || !refreshToken || !calendarId) {
    return { mode: "error", error: "missing_google_calendar_configuration" };
  }

  if (!startIso || !endIso) {
    return { mode: "needs_review", error: "missing_iso_booking_times" };
  }

  const tokenForm = new URLSearchParams();
  tokenForm.set("client_id", clientId);
  tokenForm.set("client_secret", clientSecret);
  tokenForm.set("refresh_token", refreshToken);
  tokenForm.set("grant_type", "refresh_token");

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenForm,
  });
  const tokenPayload = await tokenResponse.json();
  if (!tokenResponse.ok) {
    return { mode: "error", error: "google_token_refresh_failed", payload: tokenPayload };
  }

  const event = {
    summary: `${lead.service || "Service call"} - ${lead.name || "New caller"}`,
    description: [
      `Name: ${lead.name || "Unknown"}`,
      `Phone: ${lead.phone || "Unknown"}`,
      `Service: ${lead.service || "Unknown"}`,
      `Address: ${lead.address || "Unknown"}`,
      `Urgency: ${lead.urgency || "Unknown"}`,
      `Summary: ${lead.summary || ""}`,
    ].join("\n"),
    start: { dateTime: startIso },
    end: { dateTime: endIso },
  };

  const createResponse = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenPayload.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
    },
  );
  const createPayload = await createResponse.json();
  if (!createResponse.ok) {
    return { mode: "error", error: "google_event_create_failed", payload: createPayload };
  }

  return { mode: "live", eventId: createPayload.id, htmlLink: createPayload.htmlLink };
}

async function sendOwnerNotification(lead) {
  const message = [
    "New booked job:",
    `Name: ${lead.name || "Unknown"}`,
    `Phone: ${lead.phone || "Unknown"}`,
    `Service: ${lead.service || "Unknown"}`,
    `Address: ${lead.address || "Unknown"}`,
    `Urgency: ${lead.urgency || "Unknown"}`,
    `Time: ${lead.bookedTime || lead.requestedTime || "Needs follow-up"}`,
  ].join("\n");

  const ownerWhatsApp = process.env.OWNER_WHATSAPP_NUMBER;
  const ownerSms = process.env.OWNER_PHONE_NUMBER;

  if (ownerWhatsApp) {
    const result = await sendTwilioMessage({ to: ownerWhatsApp, body: message, channel: "whatsapp" });
    if (result.mode !== "error") return { ...result, message };
  }

  if (ownerSms) {
    const result = await sendTwilioMessage({ to: ownerSms, body: message, channel: "sms" });
    return { ...result, message };
  }

  return { mode: "test", message };
}

async function sendCustomerConfirmation(lead) {
  if (process.env.SEND_CUSTOMER_CONFIRMATIONS !== "true") {
    return { mode: "skipped", reason: "customer_confirmations_disabled" };
  

  if (!lead.phone || !(lead.bookedTime || lead.requestedTime)) {

  const businessName = process.env.BUSINESS_NAME || "the business";
  const message = `Your appointment with ${businessName} is booked for ${lead.bookedTime || lead.requestedTime}. Reply here if you need to update anything.`;

  if (process.env.PREFER_CUSTOMER_WHATSAPP === "true" && process.env.TWILIO_WHATSAPP_FROM) {
    const result = await sendTwilioMessage({ to: lead.phone, body: message, channel: "whatsapp" });
    if (result.mode !== "error") return { ...result, message };
  }

  return sendTwilioMessage({ to: lead.phone, body: message, channel: "sms" });
}

async function processBooking(input) {
  const lead = await saveLead({
    ...normalizeLead(input),
    status: input.bookedTime || input.appointmentTime ? "booked" : "needs_follow_up",
  });
  const calendar = await createCalendarBooking(lead);
  const ownerNotification = await sendOwnerNotification(lead);
  const customerConfirmation = lead.status === "booked"
    ? await sendCustomerConfirmation(lead)
    : { mode: "skipped", reason: "not_booked" };

  return { lead, calendar, ownerNotification, customerConfirmation };
}

async function handleVapiToolCalls(message) {
  const toolCalls = message.toolCallList || [];
  const results = [];

  for (const toolCall of toolCalls) {
    if (["bookAppointment", "captureLead", "saveLead"].includes(toolCall.name)) {
      const processed = await processBooking({
        ...(toolCall.parameters || {}),
        source: "vapi_tool",
      });
      results.push({
        name: toolCall.name,
        toolCallId: toolCall.id,
        result: JSON.stringify({
          ok: true,
          leadId: processed.lead.id,
          status: processed.lead.status,
          message: processed.lead.status === "booked"
            ? "The appointment has been saved."
            : "The owner has been notified for follow-up.",
        }),
      });
    } else {
      results.push({
        name: toolCall.name,
        toolCallId: toolCall.id,
        result: JSON.stringify({ ok: false, error: "unknown_tool" }),
      });
    }
  }

  return { results };
}

async function handleVapiWebhook(body) {
  const message = body.message || body;
  const type = message.type || "unknown";

  await saveEvent({ provider: "vapi", type, raw: body });

  if (type === "assistant-request") {
    if (process.env.VAPI_ASSISTANT_ID) {
      return { assistantId: process.env.VAPI_ASSISTANT_ID };
    }
    return { error: "Assistant is not configured yet." };
  }

  if (type === "tool-calls") {
    return handleVapiToolCalls(message);
  }

  if (type === "end-of-call-report") {
    const transcript = message.artifact?.transcript || "";
    const summary = message.summary || message.analysis?.summary || transcript.slice(0, 500);
    if (summary) {
      const lead = await saveLead(normalizeLead({
        source: "vapi_end_of_call",
        status: "needs_review",
        summary,
        transcript,
        callId: message.call?.id,
      }));
      const notification = await sendOwnerNotification(lead);
      return { ok: true, type, leadId: lead.id, notification };
    }
  }

  return { ok: true, type };
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, service: "lost-lead-booking-agent" });
    }

    if (req.method === "POST" && url.pathname === "/leads") {
      const body = await readJson(req);
      const processed = await processBooking({ ...body, source: "manual" });
      return json(res, 201, { ok: true, ...processed });
    }

    if (req.method === "POST" && url.pathname === "/webhooks/voice") {
      const body = await readJson(req);
      const result = await handleVapiWebhook(body);
      return json(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/bookings") {
      const body = await readJson(req);
      const processed = await processBooking({ ...body, status: "booked", source: "booking_api" });
      return json(res, 201, { ok: true, ...processed });
    }

    return json(res, 404, { ok: false, error: "not_found" });
  } catch (error) {
    return json(res, 500, { ok: false, error: error.message });
  }
});

await ensureStore();

server.listen(port, () => {
  console.log(`Lost Lead Booking Agent listening on ${port}`);
});
