import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import * as chrono from "chrono-node";
import { DateTime } from "luxon";

const port = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || new URL("../data/", import.meta.url);
const leadsFile = process.env.DATA_DIR ? join(process.env.DATA_DIR, "leads.json") : new URL("../data/leads.json", import.meta.url);
const eventsFile = process.env.DATA_DIR ? join(process.env.DATA_DIR, "events.json") : new URL("../data/events.json", import.meta.url);
const fileWriteQueues = new Map();
const defaultBusinessTimezone = "America/New_York";
const defaultBusinessName = "Demo Home Services";
const defaultAssistantName = "Riley";
const defaultIntakeFields = [
  "service needed",
  "caller name",
  "phone number",
  "address or ZIP code",
  "preferred day or time",
];
const defaultNeverSay = [
  "Do not quote exact prices.",
  "Do not promise emergency arrival.",
  "Do not diagnose dangerous problems.",
];

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

async function readFormOrJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};

  const contentType = String(req.headers["content-type"] || "");
  if (contentType.includes("application/json")) {
    return JSON.parse(raw);
  }

  return Object.fromEntries(new URLSearchParams(raw).entries());
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
  const key = typeof fileUrl === "string" ? fileUrl : fileUrl.href;
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

function parseJsonObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function listFromValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function listWithFallback(value, fallback = []) {
  const list = listFromValue(value);
  return list.length ? list : fallback;
}

function slugFromValue(value = "") {
  const slug = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "default-business";
}

function businessProfile() {
  const configured = parseJsonObject(process.env.BUSINESS_PROFILE_JSON);
  const businessName = configured.businessName || process.env.BUSINESS_NAME || defaultBusinessName;
  return {
    businessId: configured.businessId || process.env.BUSINESS_ID || slugFromValue(businessName),
    businessName: configured.businessName || process.env.BUSINESS_NAME || defaultBusinessName,
    assistantName: configured.assistantName || process.env.ASSISTANT_NAME || defaultAssistantName,
    industry: configured.industry || process.env.BUSINESS_INDUSTRY || "home services",
    ownerName: configured.ownerName || process.env.OWNER_NAME || "",
    services: listWithFallback(configured.services || process.env.BUSINESS_SERVICES, []),
    serviceAreas: listWithFallback(configured.serviceAreas || process.env.BUSINESS_SERVICE_AREAS, []),
    intakeFields: listWithFallback(configured.intakeFields || process.env.BUSINESS_INTAKE_FIELDS, defaultIntakeFields),
    neverSay: listWithFallback(configured.neverSay || process.env.BUSINESS_NEVER_SAY, defaultNeverSay),
    greeting: configured.greeting || process.env.FIRST_MESSAGE || "",
    bookingRules: {
      afterHours: configured.bookingRules?.afterHours || "Collect the details and mark the lead for follow-up.",
      emergency: configured.bookingRules?.emergency || "Tell the caller to contact emergency services if there is immediate danger, then collect details if they want to continue.",
      ownerReview: configured.bookingRules?.ownerReview || "If unclear, save the lead for owner review.",
    },
  };
}

function profileFromInput(input = {}) {
  const configured = parseJsonObject(input.businessProfileJson);
  const source = Object.keys(configured).length ? configured : input;
  const businessName = source.businessName || defaultBusinessName;
  return {
    businessId: source.businessId || slugFromValue(businessName),
    businessName,
    assistantName: source.assistantName || defaultAssistantName,
    industry: source.industry || "home services",
    ownerName: source.ownerName || "",
    services: listWithFallback(source.services, []),
    serviceAreas: listWithFallback(source.serviceAreas, []),
    intakeFields: listWithFallback(source.intakeFields, defaultIntakeFields),
    neverSay: listWithFallback(source.neverSay, defaultNeverSay),
    greeting: source.greeting || source.firstMessage || "",
    bookingRules: {
      afterHours: source.bookingRules?.afterHours || "Collect the details and mark the lead for follow-up.",
      emergency: source.bookingRules?.emergency || "Tell the caller to contact emergency services if there is immediate danger, then collect details if they want to continue.",
      ownerReview: source.bookingRules?.ownerReview || "If unclear, save the lead for owner review.",
    },
  };
}

function businessProfileJson(profile) {
  return JSON.stringify(publicBusinessProfile(profile), null, 2);
}

function profileEnvSnippet(profile) {
  return [
    `BUSINESS_ID=${profile.businessId || slugFromValue(profile.businessName)}`,
    `BUSINESS_NAME=${profile.businessName}`,
    `ASSISTANT_NAME=${profile.assistantName}`,
    `BUSINESS_INDUSTRY=${profile.industry}`,
    `BUSINESS_SERVICES=${profile.services.join(", ")}`,
    `BUSINESS_SERVICE_AREAS=${profile.serviceAreas.join(", ")}`,
    `BUSINESS_TIMEZONE=${businessTimeZone()}`,
    `BUSINESS_HOURS_START=${process.env.BUSINESS_HOURS_START || "08:00"}`,
    `BUSINESS_HOURS_END=${process.env.BUSINESS_HOURS_END || "18:00"}`,
    `DEFAULT_APPOINTMENT_MINUTES=${appointmentDurationMinutes()}`,
    `BUSINESS_PROFILE_JSON=${businessProfileJson(profile).replace(/\s+/g, " ")}`,
  ].join("\n");
}

function publicBusinessProfile(profile = businessProfile()) {
  return {
    businessId: profile.businessId || slugFromValue(profile.businessName),
    businessName: profile.businessName,
    assistantName: profile.assistantName,
    industry: profile.industry,
    services: profile.services,
    serviceAreas: profile.serviceAreas,
    intakeFields: profile.intakeFields,
    neverSay: profile.neverSay,
    greeting: firstMessageForProfile(profile),
    bookingRules: profile.bookingRules,
  };
}

function envIsTrue(name) {
  return process.env[name] === "true";
}

function envIsSet(name) {
  return Boolean(String(process.env[name] || "").trim());
}

function readinessStatus(ready, off = false) {
  if (ready) return "ready";
  return off ? "off" : "missing";
}

function systemStatusSnapshot(req, url) {
  const profile = businessProfile();
  const messagingLive = envIsTrue("SEND_LIVE_MESSAGES");
  const calendarLive = envIsTrue("SEND_LIVE_CALENDAR");
  const twilioCoreReady = envIsSet("TWILIO_ACCOUNT_SID") && envIsSet("TWILIO_AUTH_TOKEN");
  const smsReady = twilioCoreReady && envIsSet("TWILIO_PHONE_NUMBER");
  const whatsappReady = twilioCoreReady && envIsSet("TWILIO_WHATSAPP_FROM");
  const ownerReady = envIsSet("OWNER_WHATSAPP_NUMBER") || envIsSet("OWNER_PHONE_NUMBER");
  const googleReady = googleCalendarMockEnabled() || envIsSet("GOOGLE_CLIENT_ID")
    && envIsSet("GOOGLE_CLIENT_SECRET")
    && envIsSet("GOOGLE_REFRESH_TOKEN")
    && envIsSet("GOOGLE_CALENDAR_ID");
  const { start, end } = businessHours();

  return {
    ok: true,
    service: "lost-lead-booking-agent",
    ready: Boolean(leadViewerKey())
      && Boolean(profile.businessName && profile.assistantName)
      && (!messagingLive || (ownerReady && (smsReady || whatsappReady)))
      && (!calendarLive || googleReady),
    baseUrl: requestBaseUrl(req, url),
    profile: publicBusinessProfile(profile),
    businessTimezone: businessTimeZone(),
    businessHours: {
      start: `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`,
      end: `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`,
    },
    checks: [
      {
        key: "lead_viewer",
        label: "Lead viewer protection",
        status: readinessStatus(envIsSet("LEAD_VIEWER_TOKEN") || envIsSet("LEADS_VIEW_KEY")),
        detail: "Admin pages require a private token.",
      },
      {
        key: "business_profile",
        label: "Business profile",
        status: readinessStatus(Boolean(profile.businessName && profile.assistantName)),
        detail: `${profile.businessName} / ${profile.assistantName}`,
      },
      {
        key: "data_storage",
        label: "Lead storage path",
        status: envIsSet("DATA_DIR") ? "ready" : "off",
        detail: envIsSet("DATA_DIR")
          ? "DATA_DIR is set for an external data path."
          : "Using the app data folder. Set DATA_DIR when adding a persistent disk.",
      },
      {
        key: "vapi_webhook",
        label: "Vapi webhook",
        status: "ready",
        detail: `${requestBaseUrl(req, url)}/webhooks/voice`,
      },
      {
        key: "webhook_auth",
        label: "Webhook protection",
        status: envIsSet("WEBHOOK_SHARED_SECRET") || envIsSet("VOICE_WEBHOOK_SECRET") ? "ready" : "off",
        detail: envIsSet("WEBHOOK_SHARED_SECRET") || envIsSet("VOICE_WEBHOOK_SECRET")
          ? "Voice webhooks require the configured secret."
          : "Optional. Set WEBHOOK_SHARED_SECRET to protect Vapi and fallback webhooks.",
      },
      {
        key: "voice_fallback",
        label: "Twilio voice fallback",
        status: "ready",
        detail: `${requestBaseUrl(req, url)}/webhooks/twilio/voice-fallback`,
      },
      {
        key: "twilio_credentials",
        label: "Twilio credentials",
        status: readinessStatus(twilioCoreReady),
        detail: "Account SID and auth token must be in Render env.",
      },
      {
        key: "owner_notification",
        label: "Owner notifications",
        status: readinessStatus(messagingLive && ownerReady && (smsReady || whatsappReady), !messagingLive),
        detail: messagingLive
          ? "Requires owner phone/WhatsApp and a Twilio sender."
          : "SEND_LIVE_MESSAGES is off.",
      },
      {
        key: "sms_sender",
        label: "SMS sender",
        status: readinessStatus(smsReady, !messagingLive),
        detail: "Requires TWILIO_PHONE_NUMBER.",
      },
      {
        key: "whatsapp_sender",
        label: "WhatsApp sender",
        status: readinessStatus(whatsappReady, !messagingLive),
        detail: "Requires TWILIO_WHATSAPP_FROM. Sandbox users must stay joined.",
      },
      {
        key: "calendar_booking",
        label: "Calendar booking",
        status: readinessStatus(calendarLive && googleReady, !calendarLive),
        detail: calendarLive
          ? "Requires Google Calendar OAuth env vars."
          : "SEND_LIVE_CALENDAR is off.",
      },
      {
        key: "calendar_availability",
        label: "Calendar availability check",
        status: process.env.CHECK_CALENDAR_AVAILABILITY === "false" ? "off" : readinessStatus(calendarLive && googleReady, !calendarLive),
        detail: "Checks whether requested slots are free before booking.",
      },
    ],
  };
}

function firstMessageForProfile(profile = businessProfile()) {
  return profile.greeting
    || `Thanks for calling ${profile.businessName}. This is ${profile.assistantName}. What can I help you with today?`;
}

function buildVapiPrompt(profile = businessProfile()) {
  const serviceText = profile.services.length
    ? `Common services: ${profile.services.join(", ")}.`
    : "Ask what service or help the caller needs.";
  const areaText = profile.serviceAreas.length
    ? `Normal service areas: ${profile.serviceAreas.join(", ")}. If the caller may be outside this area, save the lead for owner review.`
    : "If the caller may be outside the normal service area, save the lead for owner review.";

  return [
    `You are ${profile.assistantName}, the front desk booking assistant for ${profile.businessName}.`,
    "",
    `Business type: ${profile.industry}.`,
    "Your job is to answer calls, collect job details, check available times when needed, and save appointment requests.",
    "",
    "Sound like a calm, helpful receptionist.",
    "Use short sentences.",
    "Ask one question at a time.",
    "Do not ask for everything at once.",
    "",
    serviceText,
    areaText,
    "",
    "Collect these details:",
    ...profile.intakeFields.map((field, index) => `${index + 1}. ${field}`),
    "",
    "If the caller asks what times are open, call getAvailableSlots.",
    "Before offering exact appointment options, call getAvailableSlots.",
    "Offer up to three open times.",
    "When the caller chooses one, call bookAppointment with the chosen appointmentStartIso and appointmentEndIso.",
    "",
    "After bookAppointment succeeds, treat the appointment request as saved.",
    "Do not say there was trouble saving unless the tool fails.",
    "If the caller says no, that's it, thank you, or goodbye, say the goodbye sentence first, then call end_call_tool.",
    "",
    "Never:",
    ...profile.neverSay.map((rule) => `- ${rule}`),
    "",
    `Goodbye sentence: "Thanks for calling ${profile.businessName}. Have a great day."`,
  ].join("\n");
}

function businessTimeZone() {
  const configured = process.env.BUSINESS_TIMEZONE || defaultBusinessTimezone;
  return DateTime.now().setZone(configured).isValid ? configured : defaultBusinessTimezone;
}

function currentBusinessTime() {
  const zone = businessTimeZone();
  const configuredNow = process.env.SCHEDULING_NOW_ISO;
  if (configuredNow) {
    const parsed = DateTime.fromISO(configuredNow, { zone });
    if (parsed.isValid) return parsed.setZone(zone);
  }
  return DateTime.now().setZone(zone);
}

function parseClockMinutes(value, fallback) {
  const match = String(value || "").trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return fallback;
  return hours * 60 + minutes;
}

function businessHours() {
  return {
    start: parseClockMinutes(process.env.BUSINESS_HOURS_START, 8 * 60),
    end: parseClockMinutes(process.env.BUSINESS_HOURS_END, 18 * 60),
  };
}

function appointmentDurationMinutes() {
  const configured = Number(process.env.DEFAULT_APPOINTMENT_MINUTES || 60);
  return Number.isFinite(configured) && configured > 0 ? configured : 60;
}

function appointmentText(input = {}) {
  return input.appointmentTime
    || input.bookedTime
    || input.requestedTime
    || input.preferredTime
    || "";
}

const spokenHourWords = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

function normalizeAppointmentTimeText(text = "") {
  const hourWordPattern = Object.keys(spokenHourWords).join("|");
  let normalized = String(text).toLowerCase();

  normalized = normalized.replace(
    new RegExp(`\\b(${hourWordPattern})\\s+in\\s+the\\s+(morning|afternoon|evening)\\b`, "gi"),
    (_, word, part) => {
      const hour = spokenHourWords[word.toLowerCase()];
      const meridiem = part === "morning" ? "am" : "pm";
      return `${hour} ${meridiem}`;
    },
  );

  normalized = normalized.replace(/\b(at\s+)?noon\b/gi, "12 pm");
  normalized = normalized.replace(/\b(at\s+)?midnight\b/gi, "12 am");
  normalized = normalized.replace(/\bo['']?clock\b/gi, "");

  normalized = normalized.replace(
    new RegExp(`\\b(?:at\\s+|,\\s*)?(${hourWordPattern})\\b`, "gi"),
    (_, word) => String(spokenHourWords[word.toLowerCase()]),
  );

  return normalized.replace(/\s+/g, " ").trim();
}

function parseAppointmentTime(text, referenceDate) {
  const attempts = [String(text).trim(), normalizeAppointmentTimeText(text)];
  const seen = new Set();

  for (const attempt of attempts) {
    if (!attempt || seen.has(attempt)) continue;
    seen.add(attempt);

    const result = chrono.parse(attempt, referenceDate, { forwardDate: true })[0];
    if (!result) continue;

    if (result.start.isCertain("hour")) {
      return { result, parsedText: attempt };
    }
  }

  const fallbackText = normalizeAppointmentTimeText(text);
  const fallback = chrono.parse(fallbackText, referenceDate, { forwardDate: true })[0];
  if (fallback) {
    return { result: fallback, parsedText: fallbackText };
  }

  return { result: null, parsedText: String(text).trim() };
}

function scheduleReasonLabel(reason) {
  const labels = {
    missing_time: "No appointment time was provided.",
    unclear_time: "The requested time needs owner review.",
    missing_exact_clock_time: "The request needs an exact appointment time.",
    missing_iso_booking_times: "Calendar booking needs an exact start and end time.",
    invalid_datetime: "The appointment time could not be read.",
    outside_business_hours: "Requested time is outside business hours.",
    inside_business_hours: "Appointment time is inside business hours.",
    calendar_slot_unavailable: "Requested time is already busy on the calendar.",
    calendar_check_failed: "Calendar availability could not be confirmed.",
    calendar_event_create_failed: "Calendar event could not be created.",
  };
  return labels[reason] || "";
}

function scheduleFromDateTime(start, end, reason = "inside_business_hours") {
  const { start: openMinutes, end: closeMinutes } = businessHours();
  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = end.hour * 60 + end.minute;

  if (
    startMinutes < openMinutes
    || startMinutes >= closeMinutes
    || endMinutes > closeMinutes
    || !start.hasSame(end, "day")
  ) {
    return {
      scheduleStatus: "needs_follow_up",
      scheduleReason: "outside_business_hours",
      scheduleNote: scheduleReasonLabel("outside_business_hours"),
      businessTimezone: start.zoneName,
      appointmentStartIso: start.toISO(),
      appointmentEndIso: end.toISO(),
    };
  }

  return {
    scheduleStatus: "scheduled",
    scheduleReason: reason,
    scheduleNote: scheduleReasonLabel(reason),
    businessTimezone: start.zoneName,
    appointmentStartIso: start.toISO(),
    appointmentEndIso: end.toISO(),
  };
}

function buildAppointmentSchedule(input = {}) {
  const parameters = input.parameters || input.arguments || input;
  const zone = businessTimeZone();
  const duration = appointmentDurationMinutes();
  const explicitStart = parameters.appointmentStartIso || parameters.startIso || input.appointmentStartIso || input.startIso;
  const explicitEnd = parameters.appointmentEndIso || parameters.endIso || input.appointmentEndIso || input.endIso;

  if (explicitStart) {
    const start = DateTime.fromISO(explicitStart, { setZone: true }).setZone(zone);
    if (!start.isValid) {
      return {
        scheduleStatus: "needs_follow_up",
        scheduleReason: "invalid_datetime",
        scheduleNote: scheduleReasonLabel("invalid_datetime"),
        businessTimezone: zone,
        appointmentStartIso: "",
        appointmentEndIso: "",
      };
    }

    const end = explicitEnd
      ? DateTime.fromISO(explicitEnd, { setZone: true }).setZone(zone)
      : start.plus({ minutes: duration });

    if (!end.isValid) {
      return {
        scheduleStatus: "needs_follow_up",
        scheduleReason: "invalid_datetime",
        scheduleNote: scheduleReasonLabel("invalid_datetime"),
        businessTimezone: zone,
        appointmentStartIso: start.toISO(),
        appointmentEndIso: "",
      };
    }

    return scheduleFromDateTime(start, end);
  }

  const text = appointmentText(parameters);
  if (!text) {
    return {
      scheduleStatus: "needs_follow_up",
      scheduleReason: "missing_time",
      scheduleNote: scheduleReasonLabel("missing_time"),
      businessTimezone: zone,
      appointmentStartIso: "",
      appointmentEndIso: "",
    };
  }

  const reference = currentBusinessTime();
  const { result } = parseAppointmentTime(text, reference.toJSDate());
  if (!result) {
    return {
      scheduleStatus: "needs_follow_up",
      scheduleReason: "unclear_time",
      scheduleNote: scheduleReasonLabel("unclear_time"),
      businessTimezone: zone,
      appointmentStartIso: "",
      appointmentEndIso: "",
    };
  }

  if (!result.start.isCertain("hour")) {
    return {
      scheduleStatus: "needs_follow_up",
      scheduleReason: "missing_exact_clock_time",
      scheduleNote: scheduleReasonLabel("missing_exact_clock_time"),
      businessTimezone: zone,
      appointmentStartIso: "",
      appointmentEndIso: "",
    };
  }

  const start = DateTime.fromObject({
    year: result.start.get("year"),
    month: result.start.get("month"),
    day: result.start.get("day"),
    hour: result.start.get("hour"),
    minute: result.start.get("minute") || 0,
  }, { zone });

  if (!start.isValid) {
    return {
      scheduleStatus: "needs_follow_up",
      scheduleReason: "invalid_datetime",
      scheduleNote: scheduleReasonLabel("invalid_datetime"),
      businessTimezone: zone,
      appointmentStartIso: "",
      appointmentEndIso: "",
    };
  }

  return scheduleFromDateTime(start, start.plus({ minutes: duration }));
}

function leadViewerKey() {
  return process.env.LEAD_VIEWER_TOKEN || process.env.LEADS_VIEW_KEY || "";
}

function webhookSharedSecret() {
  return process.env.WEBHOOK_SHARED_SECRET || process.env.VOICE_WEBHOOK_SECRET || "";
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

function isWebhookAuthorized(req, url) {
  const configuredSecret = webhookSharedSecret();
  if (!configuredSecret) return true;

  const requestSecret = url.searchParams.get("webhook_secret") || url.searchParams.get("secret");
  const headerSecret = req.headers["x-webhook-secret"];
  const auth = req.headers.authorization || "";
  return requestSecret === configuredSecret
    || headerSecret === configuredSecret
    || auth === `Bearer ${configuredSecret}`;
}

function webhookUrlSuffix(url) {
  const secret = url.searchParams.get("webhook_secret") || url.searchParams.get("secret");
  return secret ? `?webhook_secret=${encodeURIComponent(secret)}` : "";
}

function requestBaseUrl(req, url) {
  const protocol = String(req.headers["x-forwarded-proto"] || url.protocol.replace(":", "") || "http")
    .split(",")[0]
    .trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || url.host)
    .split(",")[0]
    .trim();
  return `${protocol}://${host}`;
}

function publicLead(lead) {
  return {
    id: lead.id,
    businessId: lead.businessId || "",
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
    scheduleStatus: lead.scheduleStatus || "",
    scheduleReason: lead.scheduleReason || "",
    scheduleNote: lead.scheduleNote || "",
    businessTimezone: lead.businessTimezone || "",
    appointmentStartIso: lead.appointmentStartIso || "",
    appointmentEndIso: lead.appointmentEndIso || "",
    calendarStatus: lead.calendarStatus || "",
    calendarEventId: lead.calendarEventId || "",
    calendarLink: lead.calendarLink || "",
    ownerNotificationMode: lead.ownerNotificationMode || "",
    ownerNotificationChannel: lead.ownerNotificationChannel || "",
    ownerNotificationStatus: lead.ownerNotificationStatus || "",
    ownerNotificationError: lead.ownerNotificationError || "",
    summary: lead.summary || "",
    followUpNote: lead.followUpNote || "",
  };
}

function publicEvent(event) {
  return {
    id: event.id || "",
    businessId: event.businessId || event.raw?.businessId || "",
    createdAt: event.createdAt || "",
    provider: event.provider || "",
    type: event.type || "",
    summary: event.summary || event.raw?.message?.type || event.raw?.type || "",
    callId: event.raw?.message?.call?.id
      || event.raw?.message?.callId
      || event.raw?.CallSid
      || event.raw?.callSid
      || "",
  };
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function leadsCsv(leads) {
  const columns = [
    "businessId",
    "createdAt",
    "updatedAt",
    "status",
    "name",
    "phone",
    "service",
    "address",
    "urgency",
    "requestedTime",
    "bookedTime",
    "scheduleStatus",
    "scheduleReason",
    "appointmentStartIso",
    "appointmentEndIso",
    "calendarStatus",
    "calendarLink",
    "ownerNotificationMode",
    "ownerNotificationChannel",
    "ownerNotificationStatus",
    "ownerNotificationError",
    "summary",
    "followUpNote",
    "callId",
    "source",
  ];

  const rows = leads
    .map(publicLead)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .map((lead) => columns.map((column) => csvCell(lead[column])).join(","));

  return `${columns.join(",")}\n${rows.join("\n")}${rows.length ? "\n" : ""}`;
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

function detailRows(items) {
  return items
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || "Unknown")}</dd></div>`)
    .join("");
}

function ownerNotificationLabel(lead) {
  if (!lead.ownerNotificationMode) return "";
  if (lead.ownerNotificationMode === "live") {
    const channel = lead.ownerNotificationChannel || "message";
    const status = lead.ownerNotificationStatus || "sent";
    return `Owner alert: ${channel} ${status}`;
  }
  if (lead.ownerNotificationMode === "test") return "Owner alert: test mode";
  if (lead.ownerNotificationMode === "skipped") return `Owner alert: skipped${lead.ownerNotificationError ? ` (${lead.ownerNotificationError})` : ""}`;
  if (lead.ownerNotificationMode === "error") return `Owner alert error: ${lead.ownerNotificationError || "check Twilio settings"}`;
  return `Owner alert: ${lead.ownerNotificationMode}`;
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

function renderNotFoundLeadViewer() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lead Not Found</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #f7f5f0; color: #181818; }
    main { max-width: 520px; margin: 12vh auto; padding: 24px; }
    h1 { margin: 0 0 10px; font-size: 28px; }
    p { color: #4b5563; line-height: 1.5; }
    a { color: #181818; }
  </style>
</head>
<body>
  <main>
    <h1>Lead Not Found</h1>
    <p>This lead may have been moved, deleted, or created in another environment.</p>
  </main>
</body>
</html>`;
}

function renderSystemStatusPage(req, url) {
  const snapshot = systemStatusSnapshot(req, url);
  const suffix = leadViewerUrlSuffix(url);
  const statusClass = (status) => `state state-${escapeHtml(status)}`;
  const rows = snapshot.checks.map((check) => `<article class="check">
    <div>
      <h2>${escapeHtml(check.label)}</h2>
      <p>${escapeHtml(check.detail)}</p>
    </div>
    <span class="${statusClass(check.status)}">${escapeHtml(check.status)}</span>
  </article>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(snapshot.profile.businessName)} System Status</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #171717;
      --muted: #5f6673;
      --paper: #fbfaf6;
      --line: #ddd8cb;
      --panel: #fff;
      --green: #2f6f4e;
      --gold: #8a6b1f;
      --red: #a13f3f;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; background: var(--paper); color: var(--ink); }
    main { max-width: 960px; margin: 0 auto; padding: 28px 22px 46px; }
    h1 { margin: 0; font-size: 30px; line-height: 1.1; }
    h2 { margin: 0; font-size: 18px; }
    p { margin: 8px 0 0; color: var(--muted); line-height: 1.45; }
    a { border: 1px solid var(--line); border-radius: 6px; min-height: 36px; padding: 8px 12px; background: #fff; color: var(--ink); text-decoration: none; }
    .top { display: flex; justify-content: space-between; gap: 16px; align-items: start; margin-bottom: 20px; }
    .links { display: flex; gap: 8px; flex-wrap: wrap; justify-content: end; }
    .meta { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 20px 0; }
    .meta div, .check { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 14px; }
    .meta strong { display: block; font-size: 14px; margin-bottom: 6px; }
    .meta span { color: var(--muted); overflow-wrap: anywhere; }
    .checks { display: grid; gap: 10px; }
    .check { display: flex; justify-content: space-between; align-items: start; gap: 16px; }
    .state { display: inline-flex; min-height: 28px; align-items: center; border-radius: 999px; padding: 4px 10px; font-size: 13px; text-transform: capitalize; white-space: nowrap; background: #eceff3; color: #26303d; }
    .state-ready { background: #e0f0e7; color: var(--green); }
    .state-off { background: #f4ead0; color: var(--gold); }
    .state-missing { background: #f6e1df; color: var(--red); }
    @media (max-width: 760px) {
      .top, .check { display: block; }
      .links { justify-content: start; margin-top: 14px; }
      .meta { grid-template-columns: 1fr; }
      .state { margin-top: 12px; }
    }
  </style>
</head>
<body>
  <main>
    <section class="top">
      <div>
        <h1>${escapeHtml(snapshot.profile.businessName)} System Status</h1>
        <p>Private setup checks for the live booking agent.</p>
      </div>
      <nav class="links" aria-label="Admin links">
        <a href="/admin/leads${escapeHtml(suffix)}">Leads</a>
        <a href="/admin/profile${escapeHtml(suffix)}">Setup</a>
        <a href="/api/system-status${escapeHtml(suffix)}">JSON</a>
      </nav>
    </section>

    <section class="meta" aria-label="Runtime details">
      <div><strong>Client ID</strong><span>${escapeHtml(snapshot.profile.businessId)}</span></div>
      <div><strong>Timezone</strong><span>${escapeHtml(snapshot.businessTimezone)}</span></div>
      <div><strong>Business Hours</strong><span>${escapeHtml(snapshot.businessHours.start)} to ${escapeHtml(snapshot.businessHours.end)}</span></div>
      <div><strong>Base URL</strong><span>${escapeHtml(snapshot.baseUrl)}</span></div>
    </section>

    <section class="checks" aria-label="System checks">
      ${rows}
    </section>
  </main>
</body>
</html>`;
}

function renderProfilePage(req, url) {
  const profile = businessProfile();
  const suffix = leadViewerUrlSuffix(url);
  const firstMessage = firstMessageForProfile(profile);
  const prompt = buildVapiPrompt(profile);
  const baseUrl = requestBaseUrl(req, url);
  const webhookUrl = `${baseUrl}/webhooks/voice`;
  const agentContextUrl = `${baseUrl}/api/agent-context${suffix}`;
  const leadsUrl = `${baseUrl}/admin/leads${suffix}`;
  const onboardingUrl = `${baseUrl}/admin/onboarding${suffix}`;
  const statusUrl = `${baseUrl}/admin/status${suffix}`;
  const envSnippet = profileEnvSnippet(profile);
  const services = profile.services.length ? profile.services.join(", ") : "Not set";
  const areas = profile.serviceAreas.length ? profile.serviceAreas.join(", ") : "Not set";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(profile.businessName)} Setup</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #171717;
      --muted: #5f6673;
      --paper: #fbfaf6;
      --line: #ddd8cb;
      --panel: #fff;
      --soft: #f4f0e7;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; background: var(--paper); color: var(--ink); }
    main { max-width: 1100px; margin: 0 auto; padding: 28px 22px 46px; }
    h1 { margin: 0; font-size: 30px; line-height: 1.1; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    p { color: var(--muted); line-height: 1.45; }
    a, button { border: 1px solid var(--line); border-radius: 6px; min-height: 36px; padding: 8px 12px; background: #fff; color: var(--ink); font: inherit; text-decoration: none; cursor: pointer; }
    .top { display: flex; justify-content: space-between; gap: 16px; align-items: start; margin-bottom: 22px; }
    .links { display: flex; gap: 8px; flex-wrap: wrap; justify-content: end; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .card { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 16px; }
    .wide { grid-column: 1 / -1; }
    dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 0; }
    dt { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
    dd { margin: 0; overflow-wrap: anywhere; }
    textarea, input { width: 100%; border: 1px solid var(--line); border-radius: 6px; padding: 12px; font: 14px/1.45 Consolas, monospace; color: var(--ink); background: #fff; }
    textarea { min-height: 170px; resize: vertical; }
    .short { min-height: 88px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    .hint { margin: 8px 0 0; font-size: 13px; }
    .pill { display: inline-block; border-radius: 999px; background: var(--soft); padding: 6px 10px; margin: 4px 4px 0 0; }
    @media (max-width: 760px) {
      .top, .grid { display: block; }
      .links { justify-content: start; margin-top: 14px; }
      .card { margin-bottom: 14px; }
      dl { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <section class="top">
      <div>
        <h1>${escapeHtml(profile.businessName)} Setup</h1>
        <p>Use this page to copy the current client profile into Vapi.</p>
      </div>
      <nav class="links" aria-label="Setup links">
        <a href="${escapeHtml(leadsUrl)}">Lead Viewer</a>
        <a href="${escapeHtml(onboardingUrl)}">Onboarding</a>
        <a href="${escapeHtml(statusUrl)}">System Status</a>
        <a href="${escapeHtml(agentContextUrl)}">Agent JSON</a>
      </nav>
    </section>

    <section class="grid">
      <article class="card">
        <h2>Client Profile</h2>
        <dl>
          <div><dt>Business</dt><dd>${escapeHtml(profile.businessName)}</dd></div>
          <div><dt>Client ID</dt><dd>${escapeHtml(profile.businessId)}</dd></div>
          <div><dt>Assistant</dt><dd>${escapeHtml(profile.assistantName)}</dd></div>
          <div><dt>Industry</dt><dd>${escapeHtml(profile.industry)}</dd></div>
          <div><dt>Timezone</dt><dd>${escapeHtml(businessTimeZone())}</dd></div>
          <div><dt>Services</dt><dd>${escapeHtml(services)}</dd></div>
          <div><dt>Service Areas</dt><dd>${escapeHtml(areas)}</dd></div>
        </dl>
      </article>

      <article class="card">
        <h2>Vapi Tool URLs</h2>
        <label>Server URL</label>
        <input readonly value="${escapeHtml(webhookUrl)}">
        <div class="actions">
          <button type="button" data-copy="${escapeHtml(webhookUrl)}">Copy Server URL</button>
        </div>
        <p class="hint">Use this same URL for bookAppointment and getAvailableSlots.</p>
      </article>

      <article class="card wide">
        <h2>First Message</h2>
        <textarea class="short" readonly>${escapeHtml(firstMessage)}</textarea>
        <div class="actions">
          <button type="button" data-copy="${escapeHtml(firstMessage)}">Copy First Message</button>
        </div>
      </article>

      <article class="card wide">
        <h2>System Prompt</h2>
        <textarea readonly>${escapeHtml(prompt)}</textarea>
        <div class="actions">
          <button type="button" data-copy="${escapeHtml(prompt)}">Copy Prompt</button>
        </div>
      </article>

      <article class="card wide">
        <h2>Render Env Snippet</h2>
        <textarea class="short" readonly>${escapeHtml(envSnippet)}</textarea>
        <div class="actions">
          <button type="button" data-copy="${escapeHtml(envSnippet)}">Copy Env Snippet</button>
        </div>
      </article>
    </section>
  </main>
  <script>
    document.querySelectorAll("[data-copy]").forEach((button) => {
      button.addEventListener("click", async () => {
        await navigator.clipboard.writeText(button.dataset.copy || "");
        const original = button.textContent;
        button.textContent = "Copied";
        setTimeout(() => { button.textContent = original; }, 1200);
      });
    });
  </script>
</body>
</html>`;
}

function renderOnboardingPage(req, url) {
  const profile = businessProfile();
  const suffix = leadViewerUrlSuffix(url);
  const baseUrl = requestBaseUrl(req, url);
  const previewUrl = `/api/profile-preview${suffix}`;
  const profileUrl = `${baseUrl}/admin/profile${suffix}`;
  const statusUrl = `${baseUrl}/admin/status${suffix}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Client Onboarding</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #171717;
      --muted: #5f6673;
      --paper: #fbfaf6;
      --line: #ddd8cb;
      --panel: #fff;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; background: var(--paper); color: var(--ink); }
    main { max-width: 1120px; margin: 0 auto; padding: 28px 22px 46px; }
    h1 { margin: 0; font-size: 30px; line-height: 1.1; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    p { color: var(--muted); line-height: 1.45; }
    a, button { border: 1px solid var(--line); border-radius: 6px; min-height: 36px; padding: 8px 12px; background: #fff; color: var(--ink); font: inherit; text-decoration: none; cursor: pointer; }
    label { display: block; color: var(--muted); font-size: 13px; margin: 12px 0 5px; }
    input, textarea { width: 100%; border: 1px solid var(--line); border-radius: 6px; padding: 11px; font: 14px/1.45 Arial, sans-serif; color: var(--ink); background: #fff; }
    textarea { min-height: 96px; resize: vertical; }
    .mono { font-family: Consolas, monospace; min-height: 180px; }
    .top { display: flex; justify-content: space-between; gap: 16px; align-items: start; margin-bottom: 20px; }
    .links { display: flex; gap: 8px; flex-wrap: wrap; justify-content: end; }
    .grid { display: grid; grid-template-columns: minmax(0, 420px) minmax(0, 1fr); gap: 14px; align-items: start; }
    .card { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 16px; }
    .outputs { display: grid; gap: 14px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    .status { margin: 10px 0 0; min-height: 20px; color: var(--muted); font-size: 13px; }
    @media (max-width: 860px) {
      .top, .grid { display: block; }
      .links { justify-content: start; margin-top: 14px; }
      .card { margin-bottom: 14px; }
    }
  </style>
</head>
<body>
  <main>
    <section class="top">
      <div>
        <h1>Client Onboarding</h1>
        <p>Fill this out once per client. Copy the output into Render and Vapi.</p>
      </div>
      <nav class="links" aria-label="Setup links">
        <a href="${escapeHtml(profileUrl)}">Current Setup</a>
        <a href="${escapeHtml(statusUrl)}">System Status</a>
      </nav>
    </section>

    <section class="grid">
      <form class="card" id="profile-form">
        <h2>Client Details</h2>
        <label>Business name</label>
        <input name="businessName" value="${escapeHtml(profile.businessName)}">
        <label>Assistant name</label>
        <input name="assistantName" value="${escapeHtml(profile.assistantName)}">
        <label>Industry</label>
        <input name="industry" value="${escapeHtml(profile.industry)}">
        <label>Services</label>
        <textarea name="services">${escapeHtml(profile.services.join(", "))}</textarea>
        <label>Service areas</label>
        <textarea name="serviceAreas">${escapeHtml(profile.serviceAreas.join(", "))}</textarea>
        <label>First message override</label>
        <textarea name="greeting">${escapeHtml(profile.greeting)}</textarea>
        <div class="actions">
          <button type="submit">Generate</button>
        </div>
        <p class="status" id="status"></p>
      </form>

      <section class="outputs">
        <article class="card">
          <h2>First Message</h2>
          <textarea class="mono" id="first-message" readonly></textarea>
          <div class="actions"><button type="button" data-copy-target="first-message">Copy First Message</button></div>
        </article>
        <article class="card">
          <h2>Vapi Prompt</h2>
          <textarea class="mono" id="prompt" readonly></textarea>
          <div class="actions"><button type="button" data-copy-target="prompt">Copy Prompt</button></div>
        </article>
        <article class="card">
          <h2>Render Env</h2>
          <textarea class="mono" id="env" readonly></textarea>
          <div class="actions"><button type="button" data-copy-target="env">Copy Env</button></div>
        </article>
      </section>
    </section>
  </main>
  <script>
    const form = document.getElementById("profile-form");
    const status = document.getElementById("status");
    async function generate(event) {
      if (event) event.preventDefault();
      status.textContent = "Generating...";
      const payload = Object.fromEntries(new FormData(form).entries());
      const response = await fetch("${escapeHtml(previewUrl)}", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        status.textContent = data.error || "Could not generate.";
        return;
      }
      document.getElementById("first-message").value = data.firstMessage || "";
      document.getElementById("prompt").value = data.prompt || "";
      document.getElementById("env").value = data.envSnippet || "";
      status.textContent = "Ready.";
    }
    form.addEventListener("submit", generate);
    document.querySelectorAll("[data-copy-target]").forEach((button) => {
      button.addEventListener("click", async () => {
        const target = document.getElementById(button.dataset.copyTarget);
        await navigator.clipboard.writeText(target.value || "");
        const original = button.textContent;
        button.textContent = "Copied";
        setTimeout(() => { button.textContent = original; }, 1200);
      });
    });
    generate();
  </script>
</body>
</html>`;
}

function renderLeadsPage(leads, url) {
  const profile = businessProfile();
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
    const ownerAlert = ownerNotificationLabel(lead);

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
        <div><dt>Client</dt><dd>${escapeHtml(lead.businessId || profile.businessId)}</dd></div>
        <div><dt>Phone</dt><dd>${escapeHtml(lead.phone || "Unknown")}</dd></div>
        <div><dt>Address</dt><dd>${escapeHtml(lead.address || "Unknown")}</dd></div>
        <div><dt>Urgency</dt><dd>${escapeHtml(lead.urgency || "Unknown")}</dd></div>
        <div><dt>Time</dt><dd>${escapeHtml(time)}</dd></div>
      </dl>
      ${lead.summary ? `<p class="summary">${escapeHtml(lead.summary)}</p>` : ""}
      ${lead.scheduleNote && lead.scheduleStatus !== "scheduled" ? `<p class="note">${escapeHtml(lead.scheduleNote)}</p>` : ""}
      ${ownerAlert ? `<p class="note">${escapeHtml(ownerAlert)}</p>` : ""}
      ${lead.followUpNote ? `<p class="note">${escapeHtml(lead.followUpNote)}</p>` : ""}
      <div class="actions">
        <a href="/admin/leads/${encodeURIComponent(lead.id)}${escapeHtml(suffix)}">Details</a>
        ${call ? `<a href="${escapeHtml(call)}">Call</a>` : ""}
        ${sms ? `<a href="${escapeHtml(sms)}">Text</a>` : ""}
        ${whatsapp ? `<a href="${escapeHtml(whatsapp)}" target="_blank" rel="noreferrer">WhatsApp</a>` : ""}
        ${lead.calendarLink ? `<a href="${escapeHtml(lead.calendarLink)}" target="_blank" rel="noreferrer">Calendar</a>` : ""}
        <button type="button" data-notify-owner>Notify owner</button>
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
  <title>${escapeHtml(profile.businessName)} Lead Follow-Up</title>
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
      <h1>${escapeHtml(profile.businessName)} Lead Follow-Up</h1>
      <p class="sub">Call leads from ${escapeHtml(profile.assistantName)}, ready for owner follow-up. <a href="/admin/profile${escapeHtml(suffix)}">Setup</a> <a href="/admin/status${escapeHtml(suffix)}">System Status</a> <a href="/admin/events${escapeHtml(suffix)}">Events</a> <a href="/api/leads.csv${escapeHtml(suffix)}">Export CSV</a> <a href="/api/backup.json${escapeHtml(suffix)}">Backup JSON</a></p>
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
    document.querySelectorAll("[data-notify-owner]").forEach((button) => {
      button.addEventListener("click", async () => {
        const lead = button.closest(".lead");
        button.disabled = true;
        button.textContent = "Sending...";
        const response = await fetch("/leads/notify-owner" + suffix, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: lead.dataset.id }),
        });
        if (response.ok) location.reload();
        else {
          button.disabled = false;
          button.textContent = "Notify owner";
          alert("Could not notify owner.");
        }
      });
    });
  </script>
</body>
</html>`;
}

function renderLeadDetailPage(lead, url) {
  const profile = businessProfile();
  const suffix = leadViewerUrlSuffix(url);
  const publicItem = publicLead(lead);
  const time = publicItem.bookedTime || publicItem.requestedTime || "Needs follow-up";
  const call = phoneHref(publicItem.phone, "tel");
  const sms = phoneHref(publicItem.phone, "sms");
  const whatsapp = phoneHref(publicItem.phone, "whatsapp");
  const ownerAlert = ownerNotificationLabel(publicItem);
  const raw = JSON.stringify(lead.raw || {}, null, 2);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(publicItem.name || "Lead")} - ${escapeHtml(profile.businessName)}</title>
  <style>
    :root { color-scheme: light; --ink: #171717; --muted: #5f6673; --paper: #fbfaf6; --line: #ddd8cb; --green: #2f6f4e; --blue: #245c88; --red: #a13f3f; --gold: #8a6b1f; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; background: var(--paper); color: var(--ink); }
    main { max-width: 1000px; margin: 0 auto; padding: 28px 22px 46px; }
    h1 { margin: 0; font-size: 30px; line-height: 1.1; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    a, button { border: 1px solid var(--line); border-radius: 6px; min-height: 36px; padding: 8px 12px; background: #fff; color: var(--ink); font: inherit; text-decoration: none; cursor: pointer; }
    .top { display: flex; justify-content: space-between; gap: 16px; align-items: start; margin-bottom: 20px; }
    .links, .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .sub { color: var(--muted); margin: 8px 0 0; }
    .status { display: inline-flex; min-height: 28px; align-items: center; border-radius: 999px; padding: 4px 10px; font-size: 13px; text-transform: capitalize; background: #eceff3; color: #26303d; }
    .status-booked { background: #e0f0e7; color: var(--green); }
    .status-contacted { background: #e3edf6; color: var(--blue); }
    .status-needs_follow_up, .status-new, .status-needs_review { background: #f4ead0; color: var(--gold); }
    .status-lost { background: #f6e1df; color: var(--red); }
    .card { border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 18px; margin-top: 12px; }
    dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin: 0; }
    dt { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
    dd { margin: 0; overflow-wrap: anywhere; }
    .note { border-left: 3px solid var(--blue); padding-left: 10px; color: var(--muted); line-height: 1.45; }
    .groups { display: grid; gap: 12px; margin-top: 16px; }
    .group-label { margin: 0 0 6px; color: var(--muted); font-size: 12px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #f4f0e7; border: 1px solid var(--line); border-radius: 8px; padding: 12px; font-size: 13px; }
    @media (max-width: 760px) {
      .top { display: block; }
      .links { margin-top: 14px; }
      dl { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <section class="top">
      <div>
        <h1>${escapeHtml(publicItem.name || "Unknown caller")}</h1>
        <p class="sub">${escapeHtml(publicItem.service || "Service request")} · ${escapeHtml(formatDate(publicItem.createdAt))}</p>
      </div>
      <nav class="links" aria-label="Lead links">
        <a href="/admin/leads${escapeHtml(suffix)}">Back to leads</a>
        <a href="/admin/events${escapeHtml(suffix)}">Events</a>
      </nav>
    </section>

    <section class="card">
      <h2>Lead Details <span class="status status-${escapeHtml(publicItem.status)}">${escapeHtml(statusLabel(publicItem.status))}</span></h2>
      <dl>${detailRows([
        ["Client", publicItem.businessId || profile.businessId],
        ["Phone", publicItem.phone],
        ["Address", publicItem.address],
        ["Urgency", publicItem.urgency],
        ["Requested time", time],
        ["Call ID", publicItem.callId],
        ["Source", publicItem.source],
        ["Calendar", publicItem.calendarStatus || publicItem.scheduleStatus],
        ["Owner alert", ownerAlert],
      ])}</dl>
      <div class="groups">
        <div>
          <p class="group-label">Contact</p>
          <div class="actions">
            ${call ? `<a href="${escapeHtml(call)}">Call</a>` : ""}
            ${sms ? `<a href="${escapeHtml(sms)}">Text</a>` : ""}
            ${whatsapp ? `<a href="${escapeHtml(whatsapp)}" target="_blank" rel="noreferrer">WhatsApp</a>` : ""}
            ${publicItem.calendarLink ? `<a href="${escapeHtml(publicItem.calendarLink)}" target="_blank" rel="noreferrer">Calendar</a>` : ""}
            <button type="button" id="notify-owner">Notify owner</button>
          </div>
        </div>
        <div>
          <p class="group-label">Lead status</p>
          <div class="actions">
            <button type="button" data-action="needs_follow_up">Follow up</button>
            <button type="button" data-action="contacted">Contacted</button>
            <button type="button" data-action="booked">Booked</button>
            <button type="button" data-action="lost">Lost</button>
          </div>
        </div>
      </div>
    </section>

    ${(publicItem.summary || publicItem.scheduleNote || publicItem.followUpNote) ? `<section class="card">
      <h2>Notes</h2>
      ${publicItem.summary ? `<p>${escapeHtml(publicItem.summary)}</p>` : ""}
      ${publicItem.scheduleNote ? `<p class="note">${escapeHtml(publicItem.scheduleNote)}</p>` : ""}
      ${publicItem.followUpNote ? `<p class="note">${escapeHtml(publicItem.followUpNote)}</p>` : ""}
    </section>` : ""}

    <section class="card">
      <h2>Raw Intake</h2>
      <pre>${escapeHtml(raw)}</pre>
    </section>
  </main>
  <script>
    const suffix = window.location.search || "";
    const button = document.getElementById("notify-owner");
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Sending...";
      const response = await fetch("/leads/notify-owner" + suffix, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: ${JSON.stringify(publicItem.id)} }),
      });
      if (response.ok) location.reload();
      else {
        button.disabled = false;
        button.textContent = "Notify owner";
        alert("Could not notify owner.");
      }
    });
    document.querySelectorAll("[data-action]").forEach((actionButton) => {
      actionButton.addEventListener("click", async () => {
        const note = prompt("Add a follow-up note", "");
        actionButton.disabled = true;
        const response = await fetch("/leads/status" + suffix, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: ${JSON.stringify(publicItem.id)}, status: actionButton.dataset.action, note }),
        });
        if (response.ok) location.reload();
        else {
          actionButton.disabled = false;
          alert("Could not update lead.");
        }
      });
    });
  </script>
</body>
</html>`;
}

function renderEventsPage(events, url) {
  const profile = businessProfile();
  const suffix = leadViewerUrlSuffix(url);
  const rows = events
    .map(publicEvent)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 100)
    .map((event) => `<tr>
      <td>${escapeHtml(formatDate(event.createdAt))}</td>
      <td>${escapeHtml(event.businessId || profile.businessId)}</td>
      <td>${escapeHtml(event.provider || "Unknown")}</td>
      <td>${escapeHtml(event.type || "Unknown")}</td>
      <td>${escapeHtml(event.callId || "")}</td>
      <td>${escapeHtml(event.summary || "")}</td>
    </tr>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(profile.businessName)} Events</title>
  <style>
    :root { color-scheme: light; --ink: #171717; --muted: #5f6673; --paper: #fbfaf6; --line: #ddd8cb; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; background: var(--paper); color: var(--ink); }
    header { background: #fff; border-bottom: 1px solid var(--line); }
    .wrap { max-width: 1120px; margin: 0 auto; padding: 24px; }
    h1 { margin: 0; font-size: 30px; line-height: 1.1; }
    .sub { margin: 8px 0 0; color: var(--muted); }
    table { width: 100%; border-collapse: collapse; margin-top: 22px; background: #fff; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    th, td { padding: 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th { background: #f4f0e7; font-size: 13px; color: var(--muted); }
    tr:last-child td { border-bottom: 0; }
    .empty { border: 1px dashed var(--line); border-radius: 8px; padding: 36px; margin-top: 22px; text-align: center; color: var(--muted); background: #fff; }
    @media (max-width: 760px) {
      .wrap { padding: 18px; }
      table, thead, tbody, tr, th, td { display: block; }
      thead { display: none; }
      td { border-bottom: 0; padding: 8px 12px; }
      tr { border-bottom: 1px solid var(--line); padding: 8px 0; }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <h1>${escapeHtml(profile.businessName)} Event Log</h1>
      <p class="sub">Recent Vapi and Twilio webhook activity. <a href="/admin/leads${escapeHtml(suffix)}">Leads</a> <a href="/admin/status${escapeHtml(suffix)}">System Status</a> <a href="/api/events${escapeHtml(suffix)}">JSON</a></p>
    </div>
  </header>
  <main class="wrap">
    ${rows ? `<table>
      <thead><tr><th>Time</th><th>Client</th><th>Provider</th><th>Type</th><th>Call ID</th><th>Summary</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>` : `<div class="empty">No events saved yet.</div>`}
  </main>
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

async function notifyOwnerForLead(id) {
  const lead = await findLeadById(id);
  if (!lead) return { ok: false, error: "lead_not_found" };

  const notification = await sendOwnerNotification(lead);
  const updatedLead = await recordOwnerNotification(lead, notification);
  return {
    ok: notification.mode !== "error",
    notification,
    lead: publicLead(updatedLead || lead),
  };
}

async function buildProtectedBackup() {
  const [leads, events] = await Promise.all([
    readJsonFile(leadsFile),
    readJsonFile(eventsFile),
  ]);

  return {
    ok: true,
    exportedAt: new Date().toISOString(),
    profile: publicBusinessProfile(businessProfile()),
    leads: leads.map(publicLead),
    events: events.map(publicEvent),
  };
}

async function updateStoredLead(id, updates) {
  return enqueueJsonWrite(leadsFile, async () => {
    const leads = await readJsonFile(leadsFile);
    const index = leads.findIndex((lead) => lead.id === id);
    if (index === -1) return null;

    leads[index] = {
      ...leads[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    await writeJsonFile(leadsFile, leads);
    return leads[index];
  });
}

function normalizeLead(input = {}) {
  const parameters = input.parameters || input.arguments || input;
  const profile = businessProfile();
  return {
    businessId: parameters.businessId || input.businessId || profile.businessId,
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
    appointmentStartIso: parameters.appointmentStartIso || parameters.startIso || "",
    appointmentEndIso: parameters.appointmentEndIso || parameters.endIso || "",
    scheduleStatus: parameters.scheduleStatus || "",
    scheduleReason: parameters.scheduleReason || "",
    scheduleNote: parameters.scheduleNote || "",
    businessTimezone: parameters.businessTimezone || "",
    calendarStatus: parameters.calendarStatus || "",
    calendarEventId: parameters.calendarEventId || "",
    calendarLink: parameters.calendarLink || "",
    ownerNotificationMode: parameters.ownerNotificationMode || "",
    ownerNotificationChannel: parameters.ownerNotificationChannel || "",
    ownerNotificationStatus: parameters.ownerNotificationStatus || "",
    ownerNotificationError: parameters.ownerNotificationError || "",
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

async function findLeadById(id) {
  if (!id) return null;
  const leads = await readJsonFile(leadsFile);
  return leads.find((lead) => lead.id === id) || null;
}

async function saveLead(input) {
  const profile = businessProfile();
  const lead = {
    id: randomUUID(),
    businessId: input.businessId || profile.businessId,
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
    appointmentStartIso: input.appointmentStartIso || "",
    appointmentEndIso: input.appointmentEndIso || "",
    scheduleStatus: input.scheduleStatus || "",
    scheduleReason: input.scheduleReason || "",
    scheduleNote: input.scheduleNote || "",
    businessTimezone: input.businessTimezone || "",
    calendarStatus: input.calendarStatus || "",
    calendarEventId: input.calendarEventId || "",
    calendarLink: input.calendarLink || "",
    ownerNotificationMode: input.ownerNotificationMode || "",
    ownerNotificationChannel: input.ownerNotificationChannel || "",
    ownerNotificationStatus: input.ownerNotificationStatus || "",
    ownerNotificationError: input.ownerNotificationError || "",
    summary: input.summary || "",
    raw: input,
  };
  return appendJson(leadsFile, lead);
}

async function saveEvent(input) {
  const profile = businessProfile();
  return appendJson(eventsFile, {
    id: randomUUID(),
    businessId: input.businessId || profile.businessId,
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

function calendarAvailabilityEnabled() {
  return process.env.CHECK_CALENDAR_AVAILABILITY !== "false";
}

function googleCalendarMockEnabled() {
  return process.env.NODE_ENV === "test" && process.env.MOCK_GOOGLE_CALENDAR === "true";
}

function mockCalendarBusyFor(lead) {
  const busyCallIds = String(process.env.MOCK_GOOGLE_CALENDAR_BUSY_CALL_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return busyCallIds.includes(lead.callId);
}

async function getGoogleAccessToken({ clientId, clientSecret, refreshToken }) {
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
  if (!tokenResponse.ok || !tokenPayload.access_token) {
    return { mode: "error", error: "google_token_refresh_failed", payload: tokenPayload };
  }

  return { mode: "live", accessToken: tokenPayload.access_token };
}

async function checkGoogleCalendarAvailability({ accessToken, calendarId, startIso, endIso }) {
  const busyResult = await fetchGoogleCalendarBusy({
    accessToken,
    calendarId,
    timeMin: startIso,
    timeMax: endIso,
  });
  if (busyResult.mode === "error") return busyResult;

  return { mode: "live", available: busyResult.busy.length === 0, busy: busyResult.busy };
}

async function fetchGoogleCalendarBusy({ accessToken, calendarId, timeMin, timeMax }) {
  const response = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      timeMin,
      timeMax,
      items: [{ id: calendarId }],
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    return { mode: "error", error: "google_freebusy_failed", payload };
  }

  const busy = payload.calendars?.[calendarId]?.busy || [];
  return { mode: "live", busy };
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function slotIntervalMinutes() {
  return parsePositiveInteger(process.env.AVAILABLE_SLOT_INTERVAL_MINUTES, 60);
}

function maxAvailableSlots() {
  return parsePositiveInteger(process.env.MAX_AVAILABLE_SLOTS, 3);
}

function availabilityRequestText(input = {}) {
  return input.day
    || input.date
    || input.when
    || input.query
    || input.requestedDate
    || input.requestedDay
    || input.requestedTime
    || input.preferredTime
    || "tomorrow";
}

function roundUpToInterval(time, interval) {
  const minutes = time.hour * 60 + time.minute;
  const roundedMinutes = Math.ceil(minutes / interval) * interval;
  return time.startOf("day").plus({ minutes: roundedMinutes });
}

function buildAvailabilityWindow(input = {}) {
  const parameters = input.parameters || input.arguments || input;
  const zone = businessTimeZone();
  const explicitStart = parameters.startIso || parameters.windowStartIso;
  const explicitEnd = parameters.endIso || parameters.windowEndIso;

  if (explicitStart && explicitEnd) {
    const start = DateTime.fromISO(explicitStart, { setZone: true }).setZone(zone);
    const end = DateTime.fromISO(explicitEnd, { setZone: true }).setZone(zone);
    if (start.isValid && end.isValid && end > start) {
      return { ok: true, start, end, zone };
    }
  }

  const reference = currentBusinessTime();
  const result = chrono.parse(String(availabilityRequestText(parameters)), reference.toJSDate(), { forwardDate: true })[0];
  if (!result) {
    return { ok: false, error: "unclear_availability_date", zone };
  }

  const day = DateTime.fromObject({
    year: result.start.get("year"),
    month: result.start.get("month"),
    day: result.start.get("day"),
  }, { zone });
  if (!day.isValid) {
    return { ok: false, error: "invalid_availability_date", zone };
  }

  const { start: openMinutes, end: closeMinutes } = businessHours();
  const interval = slotIntervalMinutes();
  let start = day.startOf("day").plus({ minutes: openMinutes });
  const end = day.startOf("day").plus({ minutes: closeMinutes });
  const now = currentBusinessTime();

  if (start.hasSame(now, "day") && start < now) {
    start = roundUpToInterval(now.plus({ minutes: 10 }), interval);
  }

  return { ok: true, start, end, zone };
}

function busyRangeOverlaps(start, end, busyRange) {
  const busyStart = DateTime.fromISO(busyRange.start, { setZone: true }).setZone(start.zoneName);
  const busyEnd = DateTime.fromISO(busyRange.end, { setZone: true }).setZone(start.zoneName);
  if (!busyStart.isValid || !busyEnd.isValid) return false;
  return start < busyEnd && end > busyStart;
}

function formatSlotLabel(start) {
  return `${start.toFormat("cccc")} at ${start.toFormat("h:mm a")}`;
}

function buildAvailableSlots({ start, end, busy = [] }) {
  const interval = slotIntervalMinutes();
  const duration = appointmentDurationMinutes();
  const limit = maxAvailableSlots();
  const slots = [];

  for (let slotStart = start; slotStart.plus({ minutes: duration }) <= end; slotStart = slotStart.plus({ minutes: interval })) {
    const slotEnd = slotStart.plus({ minutes: duration });
    const blocked = busy.some((range) => busyRangeOverlaps(slotStart, slotEnd, range));
    if (!blocked) {
      slots.push({
        label: formatSlotLabel(slotStart),
        startIso: slotStart.toISO(),
        endIso: slotEnd.toISO(),
      });
    }
    if (slots.length >= limit) break;
  }

  return slots;
}

function mockBusyRangesForWindow(window) {
  const busyStarts = String(process.env.MOCK_GOOGLE_CALENDAR_BUSY_STARTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return busyStarts.map((value) => {
    const start = DateTime.fromISO(value, { setZone: true }).setZone(window.zone);
    if (!start.isValid) return null;
    return {
      start: start.toISO(),
      end: start.plus({ minutes: appointmentDurationMinutes() }).toISO(),
    };
  }).filter(Boolean);
}

async function getAvailableSlots(input = {}) {
  const window = buildAvailabilityWindow(input);
  if (!window.ok) {
    return {
      ok: false,
      mode: "needs_review",
      error: window.error,
      message: "I could not read that day. Ask the caller what day works best.",
    };
  }

  if (window.end <= window.start) {
    return {
      ok: true,
      mode: "needs_review",
      businessTimezone: window.zone,
      slots: [],
      message: "No open times are available in that window.",
    };
  }

  if (process.env.SEND_LIVE_CALENDAR !== "true") {
    const slots = buildAvailableSlots({ start: window.start, end: window.end });
    return {
      ok: true,
      mode: "test",
      businessTimezone: window.zone,
      slots,
      message: slots.length ? `Open times: ${slots.map((slot) => slot.label).join(", ")}.` : "No open times are available.",
    };
  }

  if (googleCalendarMockEnabled()) {
    const busy = mockBusyRangesForWindow(window);
    const slots = buildAvailableSlots({ start: window.start, end: window.end, busy });
    return {
      ok: true,
      mode: "live",
      businessTimezone: window.zone,
      slots,
      message: slots.length ? `Open times: ${slots.map((slot) => slot.label).join(", ")}.` : "No open times are available.",
    };
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  if (!clientId || !clientSecret || !refreshToken || !calendarId) {
    return {
      ok: false,
      mode: "error",
      error: "missing_google_calendar_configuration",
      message: "Calendar is not connected. Collect the caller's preferred time and say the team will confirm.",
    };
  }

  const token = await getGoogleAccessToken({ clientId, clientSecret, refreshToken });
  if (token.mode === "error") {
    return { ok: false, ...token, message: "Calendar is not available right now. The team will confirm." };
  }

  const busyResult = await fetchGoogleCalendarBusy({
    accessToken: token.accessToken,
    calendarId,
    timeMin: window.start.toISO(),
    timeMax: window.end.toISO(),
  });
  if (busyResult.mode === "error") {
    return { ok: false, ...busyResult, message: "Calendar availability could not be confirmed. The team will confirm." };
  }

  const slots = buildAvailableSlots({ start: window.start, end: window.end, busy: busyResult.busy });
  return {
    ok: true,
    mode: "live",
    businessTimezone: window.zone,
    slots,
    message: slots.length ? `Open times: ${slots.map((slot) => slot.label).join(", ")}.` : "No open times are available.",
  };
}

function calendarFollowUpReason(calendar) {
  if (calendar.error === "missing_iso_booking_times") return "missing_iso_booking_times";
  if (calendar.error === "calendar_slot_unavailable") return "calendar_slot_unavailable";
  if (calendar.error === "google_event_create_failed") return "calendar_event_create_failed";
  return "calendar_check_failed";
}

function calendarBlocksBooking(calendar) {
  return calendar.mode === "needs_review" || calendar.mode === "error";
}

async function createCalendarBooking(lead) {
  if (lead.status !== "booked") {
    return { mode: "skipped", reason: "not_booked" };
  }

  if (process.env.SEND_LIVE_CALENDAR !== "true") {
    return { mode: "test", bookedTime: lead.bookedTime || lead.requestedTime || "" };
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const startIso = lead.appointmentStartIso || lead.raw?.appointmentStartIso || lead.raw?.startIso;
  const endIso = lead.appointmentEndIso || lead.raw?.appointmentEndIso || lead.raw?.endIso;

  if (!startIso || !endIso) {
    return { mode: "needs_review", error: "missing_iso_booking_times" };
  }

  if (googleCalendarMockEnabled()) {
    if (mockCalendarBusyFor(lead)) {
      return { mode: "needs_review", error: "calendar_slot_unavailable" };
    }
    return {
      mode: "live",
      eventId: `mock_${lead.id}`,
      htmlLink: `https://calendar.example.test/events/${lead.id}`,
    };
  }

  if (!clientId || !clientSecret || !refreshToken || !calendarId) {
    return { mode: "error", error: "missing_google_calendar_configuration" };
  }

  const token = await getGoogleAccessToken({ clientId, clientSecret, refreshToken });
  if (token.mode === "error") return token;

  if (calendarAvailabilityEnabled()) {
    const availability = await checkGoogleCalendarAvailability({
      accessToken: token.accessToken,
      calendarId,
      startIso,
      endIso,
    });
    if (availability.mode === "error") return availability;
    if (!availability.available) {
      return { mode: "needs_review", error: "calendar_slot_unavailable", busy: availability.busy };
    }
  }

  const event = {
    summary: `${lead.service || "Service call"} - ${lead.name || "New caller"}`,
    description: [
      `Name: ${lead.name || "Unknown"}`,
      `Phone: ${lead.phone || "Unknown"}`,
      `Service: ${lead.service || "Unknown"}`,
      `Address: ${lead.address || "Unknown"}`,
      `Urgency: ${lead.urgency || "Unknown"}`,
      `Scheduling: ${lead.scheduleNote || lead.scheduleStatus || "Unknown"}`,
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
        authorization: `Bearer ${token.accessToken}`,
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
  const profile = businessProfile();
  const message = [
    lead.status === "booked"
      ? `New booked job for ${profile.businessName}:`
      : `New lead needs review for ${profile.businessName}:`,
    `Name: ${lead.name || "Unknown"}`,
    `Phone: ${lead.phone || "Unknown"}`,
    `Service: ${lead.service || "Unknown"}`,
    `Address: ${lead.address || "Unknown"}`,
    `Urgency: ${lead.urgency || "Unknown"}`,
    `Time: ${lead.bookedTime || lead.requestedTime || "Needs follow-up"}`,
    lead.scheduleNote ? `Note: ${lead.scheduleNote}` : "",
  ].filter(Boolean).join("\n");

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

function ownerNotificationFields(result = {}) {
  return {
    ownerNotificationMode: result.mode || "",
    ownerNotificationChannel: result.channel || "",
    ownerNotificationStatus: result.status || "",
    ownerNotificationError: result.error || result.payload?.message || result.reason || "",
  };
}

async function recordOwnerNotification(lead, result) {
  if (!lead?.id) return lead;
  return await updateStoredLead(lead.id, ownerNotificationFields(result)) || lead;
}

async function sendCustomerConfirmation(lead) {
  if (process.env.SEND_CUSTOMER_CONFIRMATIONS !== "true") {
    return { mode: "skipped", reason: "customer_confirmations_disabled" };
  }

  if (!lead.phone || !(lead.bookedTime || lead.requestedTime)) {
    return { mode: "skipped", reason: "missing_phone_or_time" };
  }

  const businessName = businessProfile().businessName;
  const message = `Your appointment with ${businessName} is booked for ${lead.bookedTime || lead.requestedTime}. Reply here if you need to update anything.`;

  if (process.env.PREFER_CUSTOMER_WHATSAPP === "true" && process.env.TWILIO_WHATSAPP_FROM) {
    const result = await sendTwilioMessage({ to: lead.phone, body: message, channel: "whatsapp" });
    if (result.mode !== "error") return { ...result, message };
  }

  return sendTwilioMessage({ to: lead.phone, body: message, channel: "sms" });
}

function normalizedLeadValue(value) {
  return String(value || "").trim().toLowerCase();
}

function sameLeadRequest(existing, candidate) {
  const fields = [
    "name",
    "phone",
    "service",
    "address",
    "urgency",
    "requestedTime",
    "bookedTime",
    "appointmentStartIso",
    "appointmentEndIso",
  ];

  return fields.every((field) => {
    const nextValue = normalizedLeadValue(candidate[field]);
    if (!nextValue) return true;
    return normalizedLeadValue(existing[field]) === nextValue;
  });
}

function bookingToolMessage(processed) {
  if (processed.calendar?.error === "calendar_slot_unavailable") {
    return "That time is not available. Ask the caller for another preferred time.";
  }

  if (processed.lead.status === "booked") {
    return "The appointment has been saved.";
  }

  return "The owner has been notified for follow-up.";
}

async function processBooking(input) {
  const normalized = normalizeLead(input);
  const schedule = buildAppointmentSchedule(normalized);
  const candidate = {
    ...normalized,
    callId: input.callId || "",
    ...schedule,
    status: schedule.scheduleStatus === "scheduled" ? "booked" : "needs_follow_up",
  };

  const existing = await findLeadByCallId(candidate.callId);
  if (existing && existing.source === "vapi_tool" && (existing.status === "booked" || sameLeadRequest(existing, candidate))) {
    return {
      lead: existing,
      calendar: { mode: "skipped", reason: "duplicate_call" },
      ownerNotification: { mode: "skipped", reason: "duplicate_call" },
      customerConfirmation: { mode: "skipped", reason: "duplicate_call" },
    };
  }

  let lead = existing && existing.source === "vapi_tool"
    ? await updateStoredLead(existing.id, candidate)
    : await saveLead(candidate);
  if (!lead) lead = await saveLead(candidate);

  const calendar = await createCalendarBooking(lead);
  if (calendar.mode === "live") {
    lead = await updateStoredLead(lead.id, {
      calendarStatus: calendar.mode,
      calendarEventId: calendar.eventId || "",
      calendarLink: calendar.htmlLink || "",
    }) || lead;
  } else if (calendarBlocksBooking(calendar)) {
    const scheduleReason = calendarFollowUpReason(calendar);
    lead = await updateStoredLead(lead.id, {
      status: "needs_follow_up",
      scheduleStatus: "needs_follow_up",
      scheduleReason,
      scheduleNote: scheduleReasonLabel(scheduleReason),
      calendarStatus: calendar.mode,
      calendarError: calendar.error || "",
    }) || lead;
  }

  const ownerNotification = await sendOwnerNotification(lead);
  lead = await recordOwnerNotification(lead, ownerNotification);
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

    const toolResultName = toolCall.name
      || toolCall.function?.name
      || toolCall.toolName
      || toolCall.tool?.name
      || "unknown";
    const toolCallId = toolCall.id || toolCall.toolCallId || toolCall.callId || randomUUID();
    const isAvailabilityTool = [
      "getavailableslots",
      "checkavailability",
      "getavailability",
      "findavailableslots",
      "availabletimes",
      "getopentimes",
    ].includes(toolName)
      || toolName.includes("availability")
      || toolName.includes("availableslot");
    const isBookingTool = ["bookappointment", "capturelead", "savelead"].includes(toolName)
      || toolName.includes("appointment")
      || toolName.includes("booking");

    if (isAvailabilityTool) {
      const availability = await getAvailableSlots(parseToolParameters(toolCall));
      results.push({
        name: toolResultName,
        toolCallId,
        result: JSON.stringify(availability),
      });
      continue;
    }

    if (isBookingTool) {
      const processed = await processBooking({
        ...parseToolParameters(toolCall),
        callId: vapiCallId(message),
        toolCallId,
        source: "vapi_tool",
      });
      results.push({
        name: toolResultName,
        toolCallId,
        result: JSON.stringify({
          ok: true,
          leadId: processed.lead.id,
          status: processed.lead.status,
          scheduleStatus: processed.lead.scheduleStatus,
          scheduleReason: processed.lead.scheduleReason,
          appointmentStartIso: processed.lead.appointmentStartIso,
          appointmentEndIso: processed.lead.appointmentEndIso,
          calendarMode: processed.calendar?.mode || "",
          calendarError: processed.calendar?.error || "",
          message: bookingToolMessage(processed),
        }),
      });
    } else {
      results.push({
        name: toolResultName,
        toolCallId,
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

function twiml(res, body) {
  res.writeHead(200, {
    "content-type": "text/xml; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function renderVoiceFallbackTwiml(req, url) {
  const profile = businessProfile();
  const baseUrl = requestBaseUrl(req, url);
  const recordingUrl = `${baseUrl}/webhooks/twilio/recording${webhookUrlSuffix(url)}`;
  const message = [
    `Thanks for calling ${profile.businessName}.`,
    "Our booking assistant is unavailable for a moment.",
    "Please leave your name, phone number, what you need help with, your address or ZIP code, and your preferred appointment time after the tone.",
    "The team will follow up.",
  ].join(" ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${escapeHtml(message)}</Say>
  <Record action="${escapeHtml(recordingUrl)}" method="POST" transcribe="true" transcribeCallback="${escapeHtml(recordingUrl)}" maxLength="120" timeout="8" playBeep="true" />
  <Say voice="alice">Thanks. We received your message. Goodbye.</Say>
  <Hangup />
</Response>`;
}

async function handleTwilioRecording(body = {}) {
  const transcript = body.TranscriptionText || body.transcriptionText || "";
  const recordingUrl = body.RecordingUrl || body.recordingUrl || "";
  const from = body.From || body.from || "";
  const callId = body.CallSid || body.callSid || "";
  const summary = transcript
    || (recordingUrl ? `Fallback voicemail recording: ${recordingUrl}` : "Fallback voicemail received.");

  const existing = await findLeadByCallId(callId);
  if (existing) {
    return { ok: true, leadId: existing.id, duplicate: true };
  }

  const lead = await saveLead(normalizeLead({
    source: "twilio_voice_fallback",
    status: "needs_follow_up",
    phone: from,
    summary,
    callId,
    raw: body,
  }));
  const notification = await sendOwnerNotification(lead);
  await recordOwnerNotification(lead, notification);
  return { ok: true, leadId: lead.id, notification };
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function csv(res, filename, body) {
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
  });
  res.end(body);
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

    if (req.method === "GET" && (url.pathname === "/profile" || url.pathname === "/admin/profile")) {
      if (!leadViewerKey()) {
        return html(res, 503, renderLeadViewerDisabled());
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return html(res, 401, renderUnauthorizedLeadViewer());
      }

      return html(res, 200, renderProfilePage(req, url));
    }

    if (req.method === "GET" && (url.pathname === "/onboarding" || url.pathname === "/admin/onboarding")) {
      if (!leadViewerKey()) {
        return html(res, 503, renderLeadViewerDisabled());
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return html(res, 401, renderUnauthorizedLeadViewer());
      }

      return html(res, 200, renderOnboardingPage(req, url));
    }

    if (req.method === "GET" && (url.pathname === "/status" || url.pathname === "/admin/status")) {
      if (!leadViewerKey()) {
        return html(res, 503, renderLeadViewerDisabled());
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return html(res, 401, renderUnauthorizedLeadViewer());
      }

      return html(res, 200, renderSystemStatusPage(req, url));
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

    if (req.method === "GET" && url.pathname.startsWith("/admin/leads/")) {
      if (!leadViewerKey()) {
        return html(res, 503, renderLeadViewerDisabled());
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return html(res, 401, renderUnauthorizedLeadViewer());
      }

      const id = decodeURIComponent(url.pathname.replace("/admin/leads/", ""));
      const lead = await findLeadById(id);
      if (!lead) return html(res, 404, renderNotFoundLeadViewer());

      return html(res, 200, renderLeadDetailPage(lead, url));
    }

    if (req.method === "GET" && (url.pathname === "/events" || url.pathname === "/admin/events")) {
      if (!leadViewerKey()) {
        return html(res, 503, renderLeadViewerDisabled());
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return html(res, 401, renderUnauthorizedLeadViewer());
      }

      const events = await readJsonFile(eventsFile);
      return html(res, 200, renderEventsPage(events, url));
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

    if (req.method === "GET" && url.pathname.startsWith("/api/leads/")) {
      if (!leadViewerKey()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const id = decodeURIComponent(url.pathname.replace("/api/leads/", ""));
      const lead = await findLeadById(id);
      if (!lead) return json(res, 404, { ok: false, error: "lead_not_found" });

      return json(res, 200, { ok: true, lead: publicLead(lead) });
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      if (!leadViewerKey()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const events = await readJsonFile(eventsFile);
      return json(res, 200, {
        ok: true,
        events: events
          .map(publicEvent)
          .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
          .slice(0, 100),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/backup.json") {
      if (!leadViewerKey()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      return json(res, 200, await buildProtectedBackup());
    }

    if (req.method === "GET" && url.pathname === "/api/leads.csv") {
      if (!leadViewerKey()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const leads = await readJsonFile(leadsFile);
      return csv(res, "leads.csv", leadsCsv(leads));
    }

    if (req.method === "GET" && url.pathname === "/api/agent-context") {
      if (!leadViewerKey()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const profile = businessProfile();
      return json(res, 200, {
        ok: true,
        profile: publicBusinessProfile(profile),
        firstMessage: firstMessageForProfile(profile),
        prompt: buildVapiPrompt(profile),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/system-status") {
      if (!leadViewerKey()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      return json(res, 200, systemStatusSnapshot(req, url));
    }

    if (req.method === "POST" && url.pathname === "/api/profile-preview") {
      if (!leadViewerKey()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const profile = profileFromInput(await readJson(req));
      return json(res, 200, {
        ok: true,
        profile: publicBusinessProfile(profile),
        firstMessage: firstMessageForProfile(profile),
        prompt: buildVapiPrompt(profile),
        envSnippet: profileEnvSnippet(profile),
        businessProfileJson: businessProfileJson(profile),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/availability") {
      if (!leadViewerKey()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const availability = await getAvailableSlots(Object.fromEntries(url.searchParams.entries()));
      return json(res, availability.ok === false ? 400 : 200, availability);
    }

    if (req.method === "POST" && url.pathname === "/api/availability") {
      if (!leadViewerKey()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const body = await readJson(req);
      const availability = await getAvailableSlots(body);
      return json(res, availability.ok === false ? 400 : 200, availability);
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

    if (req.method === "POST" && url.pathname === "/leads/notify-owner") {
      if (!leadViewerKey()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const body = await readJson(req);
      const result = await notifyOwnerForLead(body.id);
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

    if ((req.method === "GET" || req.method === "POST") && url.pathname === "/webhooks/twilio/voice-fallback") {
      if (!isWebhookAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized_webhook" });
      }

      return twiml(res, renderVoiceFallbackTwiml(req, url));
    }

    if (req.method === "POST" && url.pathname === "/webhooks/twilio/recording") {
      if (!isWebhookAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized_webhook" });
      }

      await handleTwilioRecording(await readFormOrJson(req));
      return twiml(res, `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thanks. We received your message. Goodbye.</Say>
  <Hangup />
</Response>`);
    }

    if (req.method === "POST" && url.pathname === "/webhooks/voice") {
      if (!isWebhookAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized_webhook" });
      }

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
