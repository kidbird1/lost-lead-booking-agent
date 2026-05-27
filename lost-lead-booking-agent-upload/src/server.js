import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

const port = Number(process.env.PORT || 3000);
const dataDir = new URL("../data/", import.meta.url);
const leadsFile = new URL("../data/leads.json", import.meta.url);
const eventsFile = new URL("../data/events.json", import.meta.url);
const fileWriteQueues = new Map();

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
  return enqueueJsonWrite(fileUrl, async () => {
    const current = await readJsonFile(fileUrl);
    current.push(item);
    await writeJsonFile(fileUrl, current);
    return item;
  });
}

async function readJsonFile(fileUrl) {
  await ensureStore();
  const raw = await readFile(fileUrl, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const end = raw.lastIndexOf("]");
    if (end >= 0) {
      try {
        const recovered = JSON.parse(raw.slice(0, end + 1));
        return Array.isArray(recovered) ? recovered : [];
      } catch {
        return [];
      }
    }
    return [];
  }
}

async function writeJsonFile(fileUrl, items) {
  await ensureStore();
  await writeFile(fileUrl, `${JSON.stringify(items, null, 2)}\n`);
}

async function enqueueJsonWrite(fileUrl, task) {
  const key = fileUrl.href;
  const previous = fileWriteQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  fileWriteQueues.set(key, next.finally(() => {
    if (fileWriteQueues.get(key) === next) fileWriteQueues.delete(key);
  }));
  return next;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function leadViewerKey() {
  return process.env.LEAD_VIEWER_TOKEN || process.env.LEADS_VIEW_KEY || "";
}

function leadViewerUrlSuffix(url) {
  const token = url.searchParams.get("token");
  const key = url.searchParams.get("key");
  if (token) return `?token=${encodeURIComponent(token)}`;
  if (key) return `?key=${encodeURIComponent(key)}`;
  return "";
}

function isLeadViewerAuthorized(req, url) {
  const configuredKey = leadViewerKey();
  if (!configuredKey) return false;

  const requestKey = url.searchParams.get("token") || url.searchParams.get("key");
  const auth = req.headers.authorization || "";
  return requestKey === configuredKey || auth === `Bearer ${configuredKey}`;
}

function publicLead(lead) {
  return {
    id: lead.id,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt || "",
    callId: lead.callId || "",
    status: lead.status || "new",
    source: lead.source || "",
    name: lead.name || "",
    phone: lead.phone || "",
    service: lead.service || "",
    address: lead.address || "",
    urgency: lead.urgency || "",
    requestedTime: lead.requestedTime || "",
    bookedTime: lead.bookedTime || "",
    summary: lead.summary || "",
    followUpNote: lead.followUpNote || "",
  };
}

function phoneHref(value, channel = "tel") {
  const phone = String(value || "").replace(/[^\d+]/g, "");
  if (!phone) return "";
  if (channel === "sms") return `sms:${phone}`;
  if (channel === "whatsapp") return `https://wa.me/${phone.replace(/[^\d]/g, "")}`;
  return `tel:${phone}`;
}

function statusLabel(status) {
  return String(status || "new").replaceAll("_", " ");
}

function renderLeadViewerDisabled() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lead Follow-Up</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #f7f5f0; color: #181818; }
    main { max-width: 560px; margin: 12vh auto; padding: 24px; }
    h1 { margin: 0 0 10px; font-size: 28px; }
    p { color: #4b5563; line-height: 1.5; }
    code { background: #ece7dc; border-radius: 4px; padding: 2px 6px; }
  </style>
</head>
<body>
  <main>
    <h1>Lead Follow-Up</h1>
    <p>Set <code>LEAD_VIEWER_TOKEN</code> or <code>LEADS_VIEW_KEY</code> in Render to enable this page.</p>
  </main>
</body>
</html>`;
}

function renderUnauthorizedLeadViewer() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unauthorized</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #f7f5f0; color: #181818; }
    main { max-width: 520px; margin: 12vh auto; padding: 24px; }
    h1 { margin: 0 0 10px; font-size: 28px; }
    p { color: #4b5563; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>Unauthorized</h1>
    <p>Use the private lead viewer link from Render.</p>
  </main>
</body>
</html>`;
}

function renderLeadsPage(leads, url) {
  const visibleLeads = leads
    .map(publicLead)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  const counts = visibleLeads.reduce((totals, lead) => {
    totals.all += 1;
    totals[lead.status] = (totals[lead.status] || 0) + 1;
    return totals;
  }, { all: 0 });

  const suffix = leadViewerUrlSuffix(url);
  const rows = visibleLeads.map((lead) => {
    const time = lead.bookedTime || lead.requestedTime || "Needs follow-up";
    const call = phoneHref(lead.phone, "tel");
    const sms = phoneHref(lead.phone, "sms");
    const whatsapp = phoneHref(lead.phone, "whatsapp");

    return `<article class="lead" data-status="${escapeHtml(lead.status)}" data-id="${escapeHtml(lead.id)}">
      <div class="lead-head">
        <div>
          <p class="created">${escapeHtml(formatDate(lead.createdAt))}</p>
          <h2>${escapeHtml(lead.name || "Unknown caller")}</h2>
          <p class="service">${escapeHtml(lead.service || "Service request")}</p>
        </div>
        <span class="status status-${escapeHtml(lead.status)}">${escapeHtml(statusLabel(lead.status))}</span>
      </div>
      <dl>
        <div><dt>Phone</dt><dd>${escapeHtml(lead.phone || "Unknown")}</dd></div>
        <div><dt>Address</dt><dd>${escapeHtml(lead.address || "Unknown")}</dd></div>
        <div><dt>Urgency</dt><dd>${escapeHtml(lead.urgency || "Unknown")}</dd></div>
        <div><dt>Time</dt><dd>${escapeHtml(time)}</dd></div>
      </dl>
      ${lead.summary ? `<p class="summary">${escapeHtml(lead.summary)}</p>` : ""}
      ${lead.followUpNote ? `<p class="note">${escapeHtml(lead.followUpNote)}</p>` : ""}
      <div class="actions">
        ${call ? `<a href="${escapeHtml(call)}">Call</a>` : ""}
        ${sms ? `<a href="${escapeHtml(sms)}">Text</a>` : ""}
        ${whatsapp ? `<a href="${escapeHtml(whatsapp)}" target="_blank" rel="noreferrer">WhatsApp</a>` : ""}
        <button type="button" data-action="needs_follow_up">Follow up</button>
        <button type="button" data-action="contacted">Contacted</button>
        <button type="button" data-action="booked">Booked</button>
        <button type="button" data-action="lost">Lost</button>
      </div>
    </article>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lead Follow-Up</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #171717;
      --muted: #5f6673;
      --paper: #fbfaf6;
      --line: #ddd8cb;
      --green: #2f6f4e;
      --blue: #245c88;
      --red: #a13f3f;
      --gold: #8a6b1f;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; background: var(--paper); color: var(--ink); }
    header { background: #fff; border-bottom: 1px solid var(--line); }
    .wrap { max-width: 1120px; margin: 0 auto; padding: 24px; }
    h1 { margin: 0; font-size: 30px; line-height: 1.1; }
    .sub { margin: 8px 0 0; color: var(--muted); }
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 22px; }
    .metric { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: #f4f0e7; }
    .metric strong { display: block; font-size: 24px; }
    .metric span { color: var(--muted); font-size: 13px; }
    .filters { display: flex; gap: 8px; flex-wrap: wrap; margin: 22px 0; }
    button, .actions a { border: 1px solid var(--line); border-radius: 6px; min-height: 36px; padding: 8px 12px; background: #fff; color: var(--ink); font: inherit; text-decoration: none; cursor: pointer; }
    .filters button.active { background: var(--ink); color: #fff; border-color: var(--ink); }
    .grid { display: grid; gap: 12px; }
    .lead { border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 18px; }
    .lead-head { display: flex; align-items: start; justify-content: space-between; gap: 16px; }
    .created { margin: 0 0 6px; color: var(--muted); font-size: 13px; }
    h2 { margin: 0; font-size: 20px; }
    .service { margin: 6px 0 0; color: var(--muted); }
    .status { display: inline-flex; min-height: 28px; align-items: center; border-radius: 999px; padding: 4px 10px; font-size: 13px; text-transform: capitalize; white-space: nowrap; background: #eceff3; color: #26303d; }
    .status-booked { background: #e0f0e7; color: var(--green); }
    .status-contacted { background: #e3edf6; color: var(--blue); }
    .status-needs_follow_up, .status-new, .status-needs_review { background: #f4ead0; color: var(--gold); }
    .status-lost { background: #f6e1df; color: var(--red); }
    dl { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 18px 0; }
    dt { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
    dd { margin: 0; overflow-wrap: anywhere; }
    .summary, .note { margin: 12px 0 0; line-height: 1.45; color: #323842; }
    .note { border-left: 3px solid var(--blue); padding-left: 10px; color: var(--muted); }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
    .empty { border: 1px dashed var(--line); border-radius: 8px; padding: 36px; text-align: center; color: var(--muted); background: #fff; }
    @media (max-width: 760px) {
      .wrap { padding: 18px; }
      .metrics, dl { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .lead-head { display: block; }
      .status { margin-top: 12px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <h1>Lead Follow-Up</h1>
      <p class="sub">Call leads from Vapi and Twilio, ready for owner follow-up.</p>
      <section class="metrics" aria-label="Lead totals">
        <div class="metric"><strong>${counts.all || 0}</strong><span>Total leads</span></div>
        <div class="metric"><strong>${(counts.needs_follow_up || 0) + (counts.needs_review || 0) + (counts.new || 0)}</strong><span>Need follow-up</span></div>
        <div class="metric"><strong>${counts.booked || 0}</strong><span>Booked</span></div>
        <div class="metric"><strong>${counts.contacted || 0}</strong><span>Contacted</span></div>
      </section>
    </div>
  </header>
  <main class="wrap">
    <nav class="filters" aria-label="Lead filters">
      <button type="button" class="active" data-filter="all">All</button>
      <button type="button" data-filter="needs_follow_up">Follow-up</button>
      <button type="button" data-filter="booked">Booked</button>
      <button type="button" data-filter="contacted">Contacted</button>
      <button type="button" data-filter="lost">Lost</button>
    </nav>
    <section class="grid">${rows || `<div class="empty">No leads saved yet.</div>`}</section>
  </main>
  <script>
    const suffix = window.location.search || "";
    document.querySelectorAll("[data-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll("[data-filter]").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        const filter = button.dataset.filter;
        document.querySelectorAll(".lead").forEach((lead) => {
          const status = lead.dataset.status;
          const isFollowUp = filter === "needs_follow_up" && ["needs_follow_up", "needs_review", "new"].includes(status);
          lead.hidden = filter !== "all" && status !== filter && !isFollowUp;
        });
      });
    });
    document.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const lead = button.closest(".lead");
        const note = prompt("Add a follow-up note", "");
        const response = await fetch("/leads/status" + suffix, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: lead.dataset.id, status: button.dataset.action, note }),
        });
        if (response.ok) location.reload();
        else alert("Could not update lead.");
      });
    });
  </script>
</body>
</html>`;
}

async function updateLeadStatus({ id, status, note }) {
  const allowedStatuses = new Set(["new", "needs_follow_up", "needs_review", "contacted", "booked", "lost"]);
  if (!id || !allowedStatuses.has(status)) {
    return { ok: false, error: "invalid_lead_status_update" };
  }

  return enqueueJsonWrite(leadsFile, async () => {
    const leads = await readJsonFile(leadsFile);
    const index = leads.findIndex((lead) => lead.id === id);
    if (index === -1) return { ok: false, error: "lead_not_found" };

    leads[index] = {
      ...leads[index],
      status,
      followUpNote: note || leads[index].followUpNote || "",
      updatedAt: new Date().toISOString(),
    };

    await writeJsonFile(leadsFile, leads);
    return { ok: true, lead: publicLead(leads[index]) };
  });
}

function normalizeLead(input = {}) {
  const parameters = input.parameters || input.arguments || input;
  return {
    callId: parameters.callId || input.callId || input.call?.id || "",
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

function vapiCallId(message = {}) {
  return message.call?.id
    || message.callId
    || message.call_id
    || message.artifact?.callId
    || message.artifact?.call?.id
    || "";
}

async function findLeadByCallId(callId) {
  if (!callId) return null;
  const leads = await readJsonFile(leadsFile);
  return leads.find((lead) => lead.callId === callId) || null;
}

async function saveLead(input) {
  const lead = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    callId: input.callId || "",
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
  }

  if (!lead.phone || !(lead.bookedTime || lead.requestedTime)) {
    return { mode: "skipped", reason: "missing_phone_or_time" };
  }

  const businessName = process.env.BUSINESS_NAME || "the business";
  const message = `Your appointment with ${businessName} is booked for ${lead.bookedTime || lead.requestedTime}. Reply here if you need to update anything.`;

  if (process.env.PREFER_CUSTOMER_WHATSAPP === "true" && process.env.TWILIO_WHATSAPP_FROM) {
    const result = await sendTwilioMessage({ to: lead.phone, body: message, channel: "whatsapp" });
    if (result.mode !== "error") return { ...result, message };
  }

  return sendTwilioMessage({ to: lead.phone, body: message, channel: "sms" });
}

async function processBooking(input) {
  const existing = await findLeadByCallId(input.callId);
  if (existing && existing.source === "vapi_tool") {
    return {
      lead: existing,
      calendar: { mode: "skipped", reason: "duplicate_call" },
      ownerNotification: { mode: "skipped", reason: "duplicate_call" },
      customerConfirmation: { mode: "skipped", reason: "duplicate_call" },
    };
  }

  const lead = await saveLead({
    ...normalizeLead(input),
    callId: input.callId || "",
    status: input.bookedTime || input.appointmentTime ? "booked" : "needs_follow_up",
  });
  const calendar = await createCalendarBooking(lead);
  const ownerNotification = await sendOwnerNotification(lead);
  const customerConfirmation = lead.status === "booked"
    ? await sendCustomerConfirmation(lead)
    : { mode: "skipped", reason: "not_booked" };

  return { lead, calendar, ownerNotification, customerConfirmation };
}

function parseToolParameters(toolCall) {
  const value = toolCall.parameters
    || toolCall.arguments
    || toolCall.function?.arguments
    || toolCall.input
    || {};

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return { summary: value };
    }
  }

  return value;
}

async function handleVapiToolCalls(message) {
  const toolCalls = message.toolCallList || message.toolCalls || message.tool_calls || [];
  const results = [];

  for (const toolCall of toolCalls) {
    const toolName = String(
      toolCall.name
        || toolCall.function?.name
        || toolCall.toolName
        || toolCall.tool?.name
        || "",
    ).toLowerCase();

    const isBookingTool = ["bookappointment", "capturelead", "savelead"].includes(toolName)
      || toolName.includes("appointment")
      || toolName.includes("booking");

    if (isBookingTool) {
      const processed = await processBooking({
        ...parseToolParameters(toolCall),
        callId: vapiCallId(message),
        toolCallId: toolCall.id,
        source: "vapi_tool",
      });
      results.push({
        name: toolCall.name || toolCall.function?.name || toolCall.toolName || toolCall.tool?.name || "bookAppointment",
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
        name: toolCall.name || toolCall.function?.name || toolCall.toolName || toolCall.tool?.name || "unknown",
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
    const callId = vapiCallId(message);
    const existingLead = await findLeadByCallId(callId);
    if (existingLead) {
      return {
        ok: true,
        type,
        skipped: true,
        reason: "lead_already_saved_for_call",
        leadId: existingLead.id,
      };
    }

    const transcript = message.artifact?.transcript || "";
    const summary = message.summary || message.analysis?.summary || transcript.slice(0, 500);
    if (summary) {
      const lead = await saveLead(normalizeLead({
        source: "vapi_end_of_call",
        status: "needs_review",
        summary,
        transcript,
        callId,
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

function html(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, service: "lost-lead-booking-agent" });
    }

    if (req.method === "GET" && (url.pathname === "/leads" || url.pathname === "/admin/leads")) {
      if (!leadViewerKey()) {
        return html(res, 503, renderLeadViewerDisabled());
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return html(res, 401, renderUnauthorizedLeadViewer());
      }

      const leads = await readJsonFile(leadsFile);
      return html(res, 200, renderLeadsPage(leads, url));
    }

    if (req.method === "GET" && url.pathname === "/api/leads") {
      if (!leadViewerKey()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const leads = await readJsonFile(leadsFile);
      return json(res, 200, { ok: true, leads: leads.map(publicLead) });
    }

    if (req.method === "POST" && url.pathname === "/leads/status") {
      if (!leadViewerKey()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const body = await readJson(req);
      const result = await updateLeadStatus(body);
      return json(res, result.ok ? 200 : 400, result);
    }

    if (req.method === "POST" && url.pathname === "/leads") {
      if (!leadViewerKey()) {
        return json(res, 503, { ok: false, error: "manual_leads_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

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
      if (!leadViewerKey()) {
        return json(res, 503, { ok: false, error: "manual_bookings_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const body = await readJson(req);
      const processed = await processBooking({ ...body, status: "booked", source: "booking_api" });
      return json(res, 201, { ok: true, ...processed });
    }

    return json(res, 404, { ok: false, error: "not_found" });
  } catch (error) {
    console.error(error);
    return json(res, 500, { ok: false, error: "internal_server_error" });
  }
});

await ensureStore();

server.listen(port, () => {
  console.log(`Lost Lead Booking Agent listening on ${port}`);
});
