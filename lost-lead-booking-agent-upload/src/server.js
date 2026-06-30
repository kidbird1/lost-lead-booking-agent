import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import pg from "pg";

const port = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || new URL("../data/", import.meta.url);
const leadsFile = process.env.DATA_DIR ? join(process.env.DATA_DIR, "leads.json") : new URL("../data/leads.json", import.meta.url);
const eventsFile = process.env.DATA_DIR ? join(process.env.DATA_DIR, "events.json") : new URL("../data/events.json", import.meta.url);
const fileWriteQueues = new Map();
const rateLimitBuckets = new Map();
const ownerAlertInFlight = new Set();
const operatorAlertInFlight = new Set();
const mockOwnerAlertFailures = new Set();
const { Pool } = pg;
let dbPool;
let dbReadyPromise;
let ownerAlertWorkerBusy = false;
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

function deploymentInfo() {
  const commit = process.env.RENDER_GIT_COMMIT
    || process.env.GIT_COMMIT
    || process.env.SOURCE_VERSION
    || "";
  return {
    version: process.env.APP_VERSION || process.env.npm_package_version || "0.1.0",
    commit,
    shortCommit: commit ? commit.slice(0, 7) : "",
    branch: process.env.RENDER_GIT_BRANCH || process.env.GIT_BRANCH || "",
    environment: process.env.NODE_ENV || "development",
    serviceName: process.env.RENDER_SERVICE_NAME || "",
  };
}

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
  if (postgresEnabled()) {
    await ensureDatabase();
  }
}

function postgresEnabled() {
  return Boolean(String(process.env.DATABASE_URL || "").trim());
}

function databasePool() {
  if (!postgresEnabled()) return null;
  if (!dbPool) {
    dbPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
    });
  }
  return dbPool;
}

async function ensureDatabase() {
  if (dbReadyPromise) return dbReadyPromise;
  const pool = databasePool();
  if (!pool) return null;

  dbReadyPromise = pool.query(`
    create table if not exists clients (
      id text primary key,
      business_name text not null default '',
      lead_viewer_token_hash text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      data jsonb not null default '{}'::jsonb
    );

    create table if not exists leads (
      id uuid primary key,
      business_id text not null,
      call_id text,
      status text not null default 'new',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      data jsonb not null default '{}'::jsonb
    );

    create index if not exists leads_business_id_created_at_idx on leads (business_id, created_at desc);
    create index if not exists leads_call_id_idx on leads (call_id);

    create table if not exists events (
      id uuid primary key,
      business_id text not null,
      provider text,
      type text,
      call_id text,
      created_at timestamptz not null default now(),
      data jsonb not null default '{}'::jsonb
    );

    create index if not exists events_business_id_created_at_idx on events (business_id, created_at desc);
    create index if not exists events_call_id_idx on events (call_id);

    create table if not exists owner_notifications (
      id uuid primary key,
      lead_id uuid,
      business_id text not null,
      channel text,
      status text,
      created_at timestamptz not null default now(),
      data jsonb not null default '{}'::jsonb
    );

    create table if not exists integrations (
      id uuid primary key,
      business_id text not null,
      provider text not null,
      status text not null default 'configured',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      data jsonb not null default '{}'::jsonb
    );
  `);
  return dbReadyPromise;
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

async function readLeads() {
  if (!postgresEnabled()) return readJsonFile(leadsFile);
  await ensureDatabase();
  const result = await databasePool().query("select data from leads order by created_at asc");
  return result.rows.map((row) => row.data);
}

async function readEvents() {
  if (!postgresEnabled()) return readJsonFile(eventsFile);
  await ensureDatabase();
  const result = await databasePool().query("select data from events order by created_at asc");
  return result.rows.map((row) => row.data);
}

async function insertLead(lead) {
  if (!postgresEnabled()) return appendJson(leadsFile, lead);
  await ensureDatabase();
  await databasePool().query(
    `insert into leads (id, business_id, call_id, status, created_at, updated_at, data)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      lead.id,
      lead.businessId || "",
      lead.callId || "",
      lead.status || "new",
      lead.createdAt || new Date().toISOString(),
      lead.updatedAt || lead.createdAt || new Date().toISOString(),
      JSON.stringify(lead),
    ],
  );
  return lead;
}

async function insertEvent(event) {
  if (!postgresEnabled()) return appendJson(eventsFile, event);
  await ensureDatabase();
  await databasePool().query(
    `insert into events (id, business_id, provider, type, call_id, created_at, data)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      event.id,
      event.businessId || "",
      event.provider || "",
      event.type || "",
      event.callId || event.raw?.message?.call?.id || "",
      event.createdAt || new Date().toISOString(),
      JSON.stringify(event),
    ],
  );
  return event;
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
    ownerPhone: configured.ownerPhone || process.env.OWNER_PHONE_NUMBER || "",
    ownerWhatsApp: configured.ownerWhatsApp || process.env.OWNER_WHATSAPP_NUMBER || "",
    bookingLink: configured.bookingLink || process.env.BOOKING_LINK || "",
    timezone: configured.timezone || process.env.BUSINESS_TIMEZONE || defaultBusinessTimezone,
    businessHoursStart: configured.businessHoursStart || process.env.BUSINESS_HOURS_START || "08:00",
    businessHoursEnd: configured.businessHoursEnd || process.env.BUSINESS_HOURS_END || "18:00",
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
    ownerPhone: source.ownerPhone || "",
    ownerWhatsApp: source.ownerWhatsApp || "",
    bookingLink: source.bookingLink || "",
    timezone: source.timezone || businessTimeZone(),
    businessHoursStart: source.businessHoursStart || process.env.BUSINESS_HOURS_START || "08:00",
    businessHoursEnd: source.businessHoursEnd || process.env.BUSINESS_HOURS_END || "18:00",
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
  const lines = [
    `BUSINESS_ID=${profile.businessId || slugFromValue(profile.businessName)}`,
    `BUSINESS_NAME=${profile.businessName}`,
    `ASSISTANT_NAME=${profile.assistantName}`,
    `BUSINESS_INDUSTRY=${profile.industry}`,
    `BUSINESS_SERVICES=${profile.services.join(", ")}`,
    `BUSINESS_SERVICE_AREAS=${profile.serviceAreas.join(", ")}`,
    `BUSINESS_TIMEZONE=${profile.timezone || businessTimeZone()}`,
    `BUSINESS_HOURS_START=${profile.businessHoursStart || process.env.BUSINESS_HOURS_START || "08:00"}`,
    `BUSINESS_HOURS_END=${profile.businessHoursEnd || process.env.BUSINESS_HOURS_END || "18:00"}`,
    `DEFAULT_APPOINTMENT_MINUTES=${appointmentDurationMinutes()}`,
    `BUSINESS_PROFILE_JSON=${businessProfileJson(profile).replace(/\s+/g, " ")}`,
  ];
  if (profile.ownerPhone) lines.push(`OWNER_PHONE_NUMBER=${profile.ownerPhone}`);
  if (profile.ownerWhatsApp) lines.push(`OWNER_WHATSAPP_NUMBER=${profile.ownerWhatsApp}`);
  if (profile.bookingLink) lines.push(`BOOKING_LINK=${profile.bookingLink}`);
  return lines.join("\n");
}

function publicBusinessProfile(profile = businessProfile()) {
  return {
    businessId: profile.businessId || slugFromValue(profile.businessName),
    businessName: profile.businessName,
    assistantName: profile.assistantName,
    industry: profile.industry,
    ownerName: profile.ownerName || "",
    bookingLink: profile.bookingLink || "",
    timezone: profile.timezone || businessTimeZone(),
    businessHoursStart: profile.businessHoursStart || process.env.BUSINESS_HOURS_START || "08:00",
    businessHoursEnd: profile.businessHoursEnd || process.env.BUSINESS_HOURS_END || "18:00",
    services: profile.services,
    serviceAreas: profile.serviceAreas,
    intakeFields: profile.intakeFields,
    neverSay: profile.neverSay,
    greeting: firstMessageForProfile(profile),
    bookingRules: profile.bookingRules,
  };
}

function configuredClientProfiles() {
  let configured = {};
  if (process.env.CLIENTS_JSON) {
    try {
      configured = JSON.parse(process.env.CLIENTS_JSON);
    } catch {
      configured = {};
    }
  }
  const rawClients = Array.isArray(configured.clients)
    ? configured.clients
    : Array.isArray(configured)
      ? configured
      : [];

  return rawClients
    .map((client) => ({
      ...profileFromInput(client),
      assistantId: client.assistantId || client.vapiAssistantId || "",
      phoneNumber: client.phoneNumber || client.vapiPhoneNumber || client.twilioPhoneNumber || "",
      leadViewerToken: client.leadViewerToken || "",
    }))
    .filter((client) => client.businessId);
}

function generatePrivateToken() {
  return randomBytes(24).toString("hex");
}

function privateTokenHash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function storedClientData(profile, input = {}) {
  return {
    ...publicBusinessProfile(profile),
    ownerPhone: profile.ownerPhone || "",
    ownerWhatsApp: profile.ownerWhatsApp || "",
    assistantId: input.assistantId || input.vapiAssistantId || "",
    phoneNumber: input.phoneNumber || input.vapiPhoneNumber || input.twilioPhoneNumber || "",
  };
}

async function listStoredClients() {
  if (!postgresEnabled()) return [];
  await ensureDatabase();
  const result = await databasePool().query(
    "select id, business_name, lead_viewer_token_hash, created_at, updated_at, data from clients order by updated_at desc"
  );
  return result.rows.map((row) => ({
    id: row.id,
    businessName: row.business_name,
    hasLeadViewerToken: Boolean(row.lead_viewer_token_hash),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    profile: row.data || {},
  }));
}

function clientProfileFromStoredRow(row) {
  if (!row) return null;
  const data = row.data || {};
  return {
    ...profileFromInput(data),
    businessId: row.id,
    businessName: row.business_name || data.businessName || defaultBusinessName,
    ownerPhone: data.ownerPhone || "",
    ownerWhatsApp: data.ownerWhatsApp || "",
    assistantId: data.assistantId || "",
    phoneNumber: data.phoneNumber || "",
  };
}

async function saveStoredClient(input = {}) {
  if (!postgresEnabled()) {
    return { ok: false, error: "database_not_configured" };
  }

  const profile = profileFromInput(input);
  const leadViewerToken = String(input.leadViewerToken || "").trim() || generatePrivateToken();
  const data = storedClientData(profile, input);
  await ensureDatabase();
  await databasePool().query(
    `insert into clients (id, business_name, lead_viewer_token_hash, data, updated_at)
     values ($1, $2, $3, $4::jsonb, now())
     on conflict (id) do update
       set business_name = excluded.business_name,
           lead_viewer_token_hash = excluded.lead_viewer_token_hash,
           data = excluded.data,
           updated_at = now()`,
    [
      profile.businessId,
      profile.businessName,
      privateTokenHash(leadViewerToken),
      JSON.stringify(data),
    ]
  );

  return {
    ok: true,
    profile,
    publicProfile: publicBusinessProfile(profile),
    leadViewerToken,
  };
}

async function storedClientFromToken(key) {
  if (!key || !postgresEnabled()) return null;
  await ensureDatabase();
  const result = await databasePool().query(
    "select id, business_name, data from clients where lead_viewer_token_hash = $1 limit 1",
    [privateTokenHash(key)]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...clientProfileFromStoredRow(row), leadViewerToken: "" };
}

async function storedClientByBusinessId(businessId) {
  if (!businessId || !postgresEnabled()) return null;
  await ensureDatabase();
  const result = await databasePool().query(
    "select id, business_name, data from clients where id = $1 limit 1",
    [businessId],
  );
  return clientProfileFromStoredRow(result.rows[0]);
}

function normalizeRoutingText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeRoutingPhone(value) {
  return String(value || "").replace(/[^\d+]/g, "");
}

function clientMatchesRouting(client, hints = {}) {
  if (!client) return false;
  const businessId = normalizeRoutingText(hints.businessId);
  const assistantId = normalizeRoutingText(hints.assistantId);
  const phoneNumber = normalizeRoutingPhone(hints.phoneNumber);
  const clientPhone = normalizeRoutingPhone(client.phoneNumber);

  return Boolean(
    businessId && normalizeRoutingText(client.businessId) === businessId
    || assistantId && normalizeRoutingText(client.assistantId) === assistantId
    || phoneNumber && clientPhone && clientPhone === phoneNumber
  );
}

function configuredClientFromRouting(hints = {}) {
  return configuredClientProfiles().find((client) => clientMatchesRouting(client, hints)) || null;
}

async function storedClientFromRouting(hints = {}) {
  if (!postgresEnabled()) return null;
  if (hints.businessId) {
    const direct = await storedClientByBusinessId(hints.businessId);
    if (direct) return direct;
  }

  await ensureDatabase();
  const result = await databasePool().query("select id, business_name, data from clients");
  return result.rows
    .map(clientProfileFromStoredRow)
    .find((client) => clientMatchesRouting(client, hints)) || null;
}

function firstNonEmpty(...values) {
  return values.find((value) => String(value || "").trim()) || "";
}

function routingHintsFromVapiMessage(message = {}) {
  const metadata = message.metadata || message.call?.metadata || message.assistant?.metadata || {};
  const assistantId = firstNonEmpty(
    message.assistantId,
    message.assistant?.id,
    message.call?.assistantId,
    message.call?.assistant?.id,
    metadata.assistantId,
    metadata.vapiAssistantId,
  );
  const phoneNumber = firstNonEmpty(
    message.phoneNumber?.number,
    message.phoneNumber?.id,
    message.phoneNumberId,
    message.call?.phoneNumber?.number,
    message.call?.phoneNumber?.id,
    message.call?.phoneNumberId,
    metadata.phoneNumber,
    metadata.vapiPhoneNumber,
  );
  const businessId = firstNonEmpty(
    metadata.businessId,
    metadata.clientId,
    message.businessId,
    message.clientId,
    message.call?.businessId,
    message.call?.clientId,
  );

  return { businessId, assistantId, phoneNumber };
}

async function resolveClientProfile(hints = {}) {
  return await storedClientFromRouting(hints)
    || configuredClientFromRouting(hints)
    || null;
}

async function clientProfileByBusinessId(businessId) {
  return await storedClientByBusinessId(businessId)
    || configuredClientProfiles().find((client) => client.businessId === businessId)
    || null;
}

async function profileForBusinessId(businessId) {
  return await clientProfileByBusinessId(businessId) || businessProfile();
}

function adminKey() {
  return process.env.ADMIN_TOKEN || "";
}

function leadViewerConfigured() {
  return Boolean(leadViewerKey() || adminKey() || postgresEnabled() || configuredClientProfiles().some((client) => client.leadViewerToken));
}

function requestAccessContext(req, url) {
  if (req.accessContext) return req.accessContext;
  const requestKey = url.searchParams.get("token") || url.searchParams.get("key");
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  const key = requestKey || bearer;

  if (adminKey() && key === adminKey()) {
    return { ok: true, scope: "admin", profile: businessProfile(), businessId: "" };
  }

  if (leadViewerKey() && (requestKey === leadViewerKey() || auth === `Bearer ${leadViewerKey()}`)) {
    return { ok: true, scope: "legacy", profile: businessProfile(), businessId: "" };
  }

  const client = configuredClientProfiles().find((item) => item.leadViewerToken && item.leadViewerToken === key);
  if (client) {
    return { ok: true, scope: "client", profile: client, businessId: client.businessId };
  }

  return { ok: false, scope: "none", profile: businessProfile(), businessId: "" };
}

async function requestAccessContextAsync(req, url) {
  const current = requestAccessContext(req, url);
  if (current.ok) return current;

  const requestKey = url.searchParams.get("token") || url.searchParams.get("key");
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  const key = requestKey || bearer;
  const client = await storedClientFromToken(key);
  if (client) {
    return { ok: true, scope: "client", profile: client, businessId: client.businessId };
  }

  return current;
}

async function applyAdminClientScope(req, url) {
  const access = requestAccessContext(req, url);
  const businessId = String(url.searchParams.get("clientId") || "").trim();
  if (access.scope !== "admin" || !businessId) return { ok: true };

  const profile = await clientProfileByBusinessId(businessId);
  if (!profile) return { ok: false, error: "client_not_found" };

  req.accessContext = {
    ...access,
    profile,
    businessId: profile.businessId,
    adminClientScope: true,
  };
  return { ok: true };
}

function activeProfileForRequest(req, url) {
  return requestAccessContext(req, url).profile;
}

function filterRecordsForRequest(items, req, url) {
  const access = requestAccessContext(req, url);
  if (!access.businessId) return items;
  return items.filter((item) => (item.businessId || item.raw?.businessId || "") === access.businessId);
}

function canAccessRecord(record, req, url) {
  return filterRecordsForRequest([record], req, url).length === 1;
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

function pilotReadinessSummary(checks) {
  const blockers = checks.filter((check) => check.status === "missing");
  const optional = checks.filter((check) => check.status === "off");

  if (blockers.length) {
    return {
      status: "needs_setup",
      label: "Needs setup before pilot",
      summary: `${blockers.length} required setup item${blockers.length === 1 ? "" : "s"} need attention before live testing.`,
      nextActions: blockers.map((check) => `${check.label}: ${check.detail}`),
      blockers,
      optional,
    };
  }

  if (optional.length) {
    return {
      status: "ready_with_notes",
      label: "Ready with optional items off",
      summary: "The core booking flow can run. Some optional safety or delivery features are turned off.",
      nextActions: optional.slice(0, 4).map((check) => `${check.label}: ${check.detail}`),
      blockers,
      optional,
    };
  }

  return {
    status: "ready",
    label: "Ready for pilot",
    summary: "Core booking, lead capture, owner alerts, and calendar checks are ready.",
    nextActions: ["Run one live Vapi call and confirm the lead, owner alert, and calendar result."],
    blockers,
    optional,
  };
}

async function configuredClientCount() {
  if (!postgresEnabled()) return configuredClientProfiles().length;
  try {
    await ensureDatabase();
    const result = await databasePool().query("select count(*)::int as count from clients");
    return Number(result.rows[0]?.count || 0);
  } catch {
    return configuredClientProfiles().length;
  }
}

function systemStatusSnapshot(req, url, options = {}) {
  const profile = activeProfileForRequest(req, url);
  const messagingLive = envIsTrue("SEND_LIVE_MESSAGES");
  const calendarLive = envIsTrue("SEND_LIVE_CALENDAR");
  const twilioCoreReady = envIsSet("TWILIO_ACCOUNT_SID") && envIsSet("TWILIO_AUTH_TOKEN");
  const smsReady = twilioCoreReady && envIsSet("TWILIO_PHONE_NUMBER");
  const whatsappReady = twilioCoreReady && envIsSet("TWILIO_WHATSAPP_FROM");
  const ownerReady = envIsSet("OWNER_WHATSAPP_NUMBER") || envIsSet("OWNER_PHONE_NUMBER");
  const operatorAlertsReady = operatorAlertsEnabled()
    && messagingLive
    && envIsSet("OPERATOR_WHATSAPP_NUMBER")
    && whatsappReady;
  const googleReady = googleCalendarMockEnabled() || envIsSet("GOOGLE_CLIENT_ID")
    && envIsSet("GOOGLE_CLIENT_SECRET")
    && envIsSet("GOOGLE_REFRESH_TOKEN")
    && envIsSet("GOOGLE_CALENDAR_ID");
  const clientCount = Number.isFinite(options.clientCount)
    ? options.clientCount
    : configuredClientProfiles().length;
  const { start, end } = businessHours();

  const snapshot = {
    ok: true,
    service: "lost-lead-booking-agent",
    ready: leadViewerConfigured()
      && Boolean(profile.businessName && profile.assistantName)
      && (!messagingLive || (ownerReady && (smsReady || whatsappReady)))
      && (!calendarLive || googleReady),
    deployment: deploymentInfo(),
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
        status: readinessStatus(leadViewerConfigured()),
        detail: "Admin and client pages require a private token.",
      },
      {
        key: "admin_auth",
        label: "Operator admin auth",
        status: envIsSet("ADMIN_TOKEN") ? "ready" : "off",
        detail: envIsSet("ADMIN_TOKEN")
          ? "ADMIN_TOKEN can access internal operator pages."
          : "Set ADMIN_TOKEN before managing many clients from one service.",
      },
      {
        key: "client_routing",
        label: "Client routing",
        status: clientCount ? "ready" : "off",
        detail: clientCount
          ? `${clientCount} client profile${clientCount === 1 ? "" : "s"} configured for tenant routing.`
          : "Optional for single-client pilot. Save clients in onboarding for tenant routing.",
      },
      {
        key: "rate_limits",
        label: "Rate limits",
        status: "ready",
        detail: "Basic per-IP request limits are enabled for admin, API, and webhook paths.",
      },
      {
        key: "business_profile",
        label: "Business profile",
        status: readinessStatus(Boolean(profile.businessName && profile.assistantName)),
        detail: `${profile.businessName} / ${profile.assistantName}`,
      },
      {
        key: "data_storage",
        label: "Lead storage",
        status: postgresEnabled() || envIsSet("DATA_DIR") ? "ready" : "off",
        detail: postgresEnabled()
          ? "DATABASE_URL is set. Leads and events use Postgres."
          : envIsSet("DATA_DIR")
            ? "DATA_DIR is set for an external JSON data path."
            : "Using the app data folder. Set DATABASE_URL before multi-client production.",
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
        key: "operator_alerts",
        label: "Operator WhatsApp alerts",
        status: operatorAlertsReady ? "ready" : "off",
        detail: operatorAlertsReady
          ? "Critical failures use the configured operator WhatsApp destination."
          : operatorAlertsEnabled()
            ? "Operator alerts are enabled but live WhatsApp messaging is not fully configured."
            : "ENABLE_OPERATOR_ALERTS is off. Critical failures remain visible on the Issues page.",
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
  snapshot.pilotReadiness = pilotReadinessSummary(snapshot.checks);
  return snapshot;
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
    "Say: \"I saved your appointment request. The team will confirm.\"",
    "Do not promise a confirmed calendar booking unless live calendar booking is enabled and the backend confirms it.",
    "Do not say there was trouble saving unless the tool fails.",
    "If the caller says no, that's it, thank you, or goodbye, say the goodbye sentence first, then call end_call_tool.",
    "",
    "Never:",
    ...profile.neverSay.map((rule) => `- ${rule}`),
    "",
    `Goodbye sentence: "Thanks for calling ${profile.businessName}. Have a great day."`,
  ].join("\n");
}

function businessTimeZone(profile = null) {
  const configured = profile?.timezone || process.env.BUSINESS_TIMEZONE || defaultBusinessTimezone;
  return DateTime.now().setZone(configured).isValid ? configured : defaultBusinessTimezone;
}

function currentBusinessTime(profile = null) {
  const zone = businessTimeZone(profile);
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

function businessHours(profile = null) {
  return {
    start: parseClockMinutes(profile?.businessHoursStart || process.env.BUSINESS_HOURS_START, 8 * 60),
    end: parseClockMinutes(profile?.businessHoursEnd || process.env.BUSINESS_HOURS_END, 18 * 60),
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

const spokenDigitWords = {
  zero: "0",
  oh: "0",
  o: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

function normalizeSpokenDigits(text = "") {
  return String(text)
    .toLowerCase()
    .split(/\s+/)
    .map((part) => {
      const token = part.replace(/[^a-z0-9]/g, "");
      if (!token) return "";
      return spokenDigitWords[token] ?? token.replace(/\D/g, "");
    })
    .join("");
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

function scheduleFromDateTime(start, end, reason = "inside_business_hours", profile = null) {
  const { start: openMinutes, end: closeMinutes } = businessHours(profile);
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

function buildAppointmentSchedule(input = {}, profile = null) {
  const parameters = input.parameters || input.arguments || input;
  const zone = businessTimeZone(profile);
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

    return scheduleFromDateTime(start, end, "inside_business_hours", profile);
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

  const reference = currentBusinessTime(profile);
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

  return scheduleFromDateTime(start, start.plus({ minutes: duration }), "inside_business_hours", profile);
}

function leadViewerKey() {
  return process.env.LEAD_VIEWER_TOKEN || process.env.LEADS_VIEW_KEY || "";
}

function webhookSharedSecret() {
  return process.env.WEBHOOK_SHARED_SECRET || process.env.VOICE_WEBHOOK_SECRET || "";
}

function leadViewerUrlSuffix(url, additions = {}) {
  const params = new URLSearchParams();
  const token = url.searchParams.get("token");
  const key = url.searchParams.get("key");
  const clientId = Object.hasOwn(additions, "clientId")
    ? additions.clientId
    : url.searchParams.get("clientId");
  if (token) params.set("token", token);
  else if (key) params.set("key", key);
  if (clientId) params.set("clientId", clientId);
  return params.size ? `?${params.toString()}` : "";
}

function isLeadViewerAuthorized(req, url) {
  return requestAccessContext(req, url).ok;
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

function requestIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
}

function rateLimitForPath(pathname) {
  const adminLimit = Number(process.env.RATE_LIMIT_ADMIN_PER_MINUTE || 600);
  const webhookLimit = Number(process.env.RATE_LIMIT_WEBHOOK_PER_MINUTE || 180);
  const defaultLimit = Number(process.env.RATE_LIMIT_DEFAULT_PER_MINUTE || 300);
  if (pathname.startsWith("/webhooks/")) return Number.isFinite(webhookLimit) && webhookLimit > 0 ? webhookLimit : 180;
  if (pathname.startsWith("/admin/") || pathname.startsWith("/api/") || pathname === "/leads") {
    return Number.isFinite(adminLimit) && adminLimit > 0 ? adminLimit : 600;
  }
  return Number.isFinite(defaultLimit) && defaultLimit > 0 ? defaultLimit : 300;
}

function isRateLimited(req, url) {
  const limit = rateLimitForPath(url.pathname);
  const windowMs = 60_000;
  const now = Date.now();
  const key = `${requestIp(req)}:${url.pathname}`;
  const bucket = rateLimitBuckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }

  bucket.count += 1;
  return bucket.count > limit;
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

function onboardingSetupOutput(profile, req, url) {
  const baseUrl = requestBaseUrl(req, url);
  const suffix = leadViewerUrlSuffix(url);
  const leadViewerLink = `${baseUrl}/admin/leads${suffix}`;
  const toolUrl = `${baseUrl}/webhooks/voice`;
  const ownerAlertLines = [
    profile.ownerWhatsApp
      ? `OWNER_WHATSAPP_NUMBER=${profile.ownerWhatsApp}`
      : "OWNER_WHATSAPP_NUMBER=optional_owner_whatsapp",
    profile.ownerPhone
      ? `OWNER_PHONE_NUMBER=${profile.ownerPhone}`
      : "OWNER_PHONE_NUMBER=optional_owner_sms",
    "ENABLE_LIVE_SMS=true only when Twilio owner alerts are ready.",
  ];
  const checklist = [
    "Open the private lead viewer link.",
    "Copy the Vapi first message and system prompt into the assistant.",
    "Set the Vapi server/tool URL to /webhooks/voice.",
    "Place one test call.",
    "Ask for an appointment request and confirm the agent says the team will confirm.",
    "Confirm exactly one lead appears in the lead viewer.",
    "Confirm the owner notification status on the lead.",
  ];

  return {
    clientId: profile.businessId || slugFromValue(profile.businessName),
    leadViewerLink,
    vapiToolUrl: toolUrl,
    ownerNotificationSetup: ownerAlertLines.join("\n"),
    bookingLink: profile.bookingLink || "",
    liveTestChecklist: checklist,
  };
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
    calendarError: lead.calendarError || "",
    calendarErrorDetail: lead.calendarErrorDetail || "",
    ownerNotificationMode: lead.ownerNotificationMode || "",
    ownerNotificationChannel: lead.ownerNotificationChannel || "",
    ownerNotificationStatus: lead.ownerNotificationStatus || "",
    ownerNotificationError: lead.ownerNotificationError || "",
    ownerNotificationAttempts: Number(lead.ownerNotificationAttempts || 0),
    ownerNotificationLastAttemptAt: lead.ownerNotificationLastAttemptAt || "",
    ownerNotificationNextRetryAt: lead.ownerNotificationNextRetryAt || "",
    summary: lead.summary || "",
    followUpNote: lead.followUpNote || "",
    followUpHistory: Array.isArray(lead.followUpHistory) ? lead.followUpHistory : [],
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
    callId: event.callId
      || event.raw?.message?.call?.id
      || event.raw?.message?.callId
      || event.raw?.CallSid
      || event.raw?.callSid
      || "",
  };
}

function issueSeverity(issue) {
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  return severityOrder[issue.severity] ?? 3;
}

function issueSortKey(issue) {
  return `${issueSeverity(issue)}:${String(issue.createdAt || "").padStart(30, "0")}`;
}

function issueForLead(lead) {
  const publicItem = publicLead(lead);
  if (publicItem.ownerNotificationMode === "error") {
    return {
      id: `owner-alert:${publicItem.id}`,
      severity: "critical",
      type: "owner_alert_failed",
      businessId: publicItem.businessId,
      createdAt: publicItem.updatedAt || publicItem.createdAt,
      title: "Owner alert failed",
      detail: publicItem.ownerNotificationError || "Check Twilio owner alert settings.",
      leadId: publicItem.id,
      callId: publicItem.callId,
    };
  }
  if (publicItem.calendarStatus === "error" || publicItem.calendarError) {
    return {
      id: `calendar:${publicItem.id}`,
      severity: "warning",
      type: "calendar_failed",
      businessId: publicItem.businessId,
      createdAt: publicItem.updatedAt || publicItem.createdAt,
      title: "Calendar action failed",
      detail: publicItem.calendarErrorDetail || publicItem.calendarError || "Calendar could not complete.",
      leadId: publicItem.id,
      callId: publicItem.callId,
    };
  }
  if (["missing_exact_clock_time", "outside_business_hours", "unclear_time"].includes(publicItem.scheduleReason)) {
    return {
      id: `schedule:${publicItem.id}`,
      severity: "info",
      type: publicItem.scheduleReason,
      businessId: publicItem.businessId,
      createdAt: publicItem.updatedAt || publicItem.createdAt,
      title: publicItem.scheduleNote || "Lead needs scheduling follow-up",
      detail: publicItem.requestedTime || publicItem.bookedTime || publicItem.summary || "Review lead details.",
      leadId: publicItem.id,
      callId: publicItem.callId,
    };
  }
  return null;
}

function issueForEvent(event) {
  const publicItem = publicEvent(event);
  if (publicItem.type === "tenant_route_failed") {
    return {
      id: `route:${publicItem.id}`,
      severity: "critical",
      type: "tenant_route_failed",
      businessId: publicItem.businessId,
      createdAt: publicItem.createdAt,
      title: "Tenant route failed",
      detail: "A Vapi webhook did not match a saved client route.",
      leadId: "",
      callId: publicItem.callId,
    };
  }
  return null;
}

function issueForClient(client) {
  const profile = client.profile || {};
  const missing = [];
  if (!profile.assistantId && !profile.phoneNumber) missing.push("Vapi route");
  if (!Array.isArray(profile.services) || !profile.services.length) missing.push("services");
  if (!Array.isArray(profile.serviceAreas) || !profile.serviceAreas.length) missing.push("service areas");
  if (!profile.ownerWhatsApp && !profile.ownerPhone) missing.push("owner contact");
  if (!missing.length) return null;
  return {
    id: `client-config:${client.id}`,
    severity: missing.includes("Vapi route") || missing.includes("owner contact") ? "warning" : "info",
    type: "client_config_missing",
    businessId: client.id || profile.businessId || "",
    createdAt: client.updatedAt || client.createdAt || "",
    title: "Client setup incomplete",
    detail: `Missing: ${missing.join(", ")}.`,
    leadId: "",
    callId: "",
  };
}

async function operatorIssues(req, url) {
  const [leads, events, clients] = await Promise.all([
    readLeads(),
    readEvents(),
    postgresEnabled()
      ? listStoredClients()
      : Promise.resolve(configuredClientProfiles().map((client) => ({
          id: client.businessId,
          businessName: client.businessName,
          profile: publicBusinessProfile(client),
        }))),
  ]);
  const visibleLeads = req && url ? filterRecordsForRequest(leads, req, url) : leads;
  const visibleEvents = req && url ? filterRecordsForRequest(events, req, url) : events;
  const access = req && url ? requestAccessContext(req, url) : { businessId: "" };
  const visibleClients = access.businessId
    ? clients.filter((client) => client.id === access.businessId || client.profile?.businessId === access.businessId)
    : clients;

  const issues = [
    ...visibleClients.map(issueForClient),
    ...visibleLeads.map(issueForLead),
    ...visibleEvents.map(issueForEvent),
  ]
    .filter(Boolean)
    .sort((a, b) => issueSortKey(a).localeCompare(issueSortKey(b)))
    .slice(0, 100);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    counts: {
      critical: issues.filter((issue) => issue.severity === "critical").length,
      warning: issues.filter((issue) => issue.severity === "warning").length,
      info: issues.filter((issue) => issue.severity === "info").length,
      total: issues.length,
    },
    issues,
  };
}

function clientSetupChecks(client) {
  const profile = client.profile || {};
  return {
    route: Boolean(profile.assistantId || profile.phoneNumber),
    ownerAlert: Boolean(profile.ownerWhatsApp || profile.ownerPhone),
    leadViewer: Boolean(client.hasLeadViewerToken || profile.leadViewerToken),
    services: Array.isArray(profile.services) && profile.services.length > 0,
    serviceArea: Array.isArray(profile.serviceAreas) && profile.serviceAreas.length > 0,
  };
}

function clientSetupStatus(checks) {
  const required = [checks.route, checks.ownerAlert, checks.leadViewer];
  if (required.every(Boolean) && checks.services && checks.serviceArea) return "ready";
  if (required.every(Boolean)) return "needs_review";
  return "missing";
}

function clientDashboardRows(clients, leads, events) {
  return clients.map((client) => {
    const profile = client.profile || {};
    const id = client.id || profile.businessId || "";
    const clientLeads = leads
      .filter((lead) => (lead.businessId || "") === id)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    const clientEvents = events.filter((event) => (event.businessId || event.raw?.businessId || "") === id);
    const issues = [
      issueForClient(client),
      ...clientLeads.map(issueForLead),
      ...clientEvents.map(issueForEvent),
    ].filter(Boolean);
    const checks = clientSetupChecks(client);

    return {
      ...client,
      id,
      businessName: client.businessName || profile.businessName || "Unnamed client",
      profile,
      setupChecks: checks,
      setupStatus: clientSetupStatus(checks),
      leadCount: clientLeads.length,
      followUpCount: clientLeads.filter((lead) => ["needs_follow_up", "needs_review", "new"].includes(lead.status)).length,
      lastLeadAt: clientLeads[0]?.createdAt || "",
      issueCount: issues.length,
      criticalIssueCount: issues.filter((issue) => issue.severity === "critical").length,
      warningIssueCount: issues.filter((issue) => issue.severity === "warning").length,
    };
  });
}

function csvCell(value) {
  let text = typeof value === "object" && value !== null
    ? JSON.stringify(value)
    : String(value ?? "");
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
    "ownerNotificationAttempts",
    "ownerNotificationLastAttemptAt",
    "ownerNotificationNextRetryAt",
    "summary",
    "followUpNote",
    "followUpHistory",
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

function latestFollowUpHistory(lead) {
  const history = Array.isArray(lead.followUpHistory) ? lead.followUpHistory : [];
  return history
    .filter((item) => item && (item.note || item.status))
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
}

function renderFollowUpHistory(lead, limit = 5) {
  const items = latestFollowUpHistory(lead).slice(0, limit);
  if (!items.length) return "";

  return `<div class="history">
    ${items.map((item) => `<p><strong>${escapeHtml(statusLabel(item.status))}</strong> ${escapeHtml(formatDate(item.at))}${item.note ? ` - ${escapeHtml(item.note)}` : ""}</p>`).join("")}
  </div>`;
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

function renderSystemStatusPage(req, url, snapshot) {
  const suffix = leadViewerUrlSuffix(url);
  const statusClass = (status) => `state state-${escapeHtml(status)}`;
  const readiness = snapshot.pilotReadiness;
  const readinessStatus = readiness.status === "needs_setup"
    ? "missing"
    : readiness.status === "ready"
      ? "ready"
      : "off";
  const nextActions = readiness.nextActions.map((action) => `<li>${escapeHtml(action)}</li>`).join("");
  const pilotSteps = [
    "Confirm Render has the needed env vars and the latest deploy is live.",
    "Confirm Vapi has the booking tool URL set to /webhooks/voice.",
    "Make one test call with a real appointment time inside business hours.",
    "Check that exactly one lead appears in the lead viewer.",
    "Check the owner alert and Google Calendar result.",
  ].map((step) => `<li>${escapeHtml(step)}</li>`).join("");
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
    .readiness { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 16px; margin: 0 0 20px; }
    .readiness-head { display: flex; justify-content: space-between; gap: 16px; align-items: start; }
    .readiness ul { margin: 12px 0 0; padding-left: 20px; color: var(--muted); line-height: 1.45; }
    .pilot-steps { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 16px; margin: 0 0 20px; }
    .pilot-steps ol { margin: 8px 0 0; padding-left: 22px; color: var(--muted); line-height: 1.5; }
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
      .top, .check, .readiness-head { display: block; }
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
        <a href="/admin/clients${escapeHtml(suffix)}">Clients</a>
        <a href="/admin/profile${escapeHtml(suffix)}">Setup</a>
        <a href="/api/system-status${escapeHtml(suffix)}">JSON</a>
      </nav>
    </section>

    <section class="readiness" aria-label="Pilot readiness">
      <div class="readiness-head">
        <div>
          <h2>Pilot Readiness</h2>
          <p><strong>${escapeHtml(readiness.label)}</strong></p>
          <p>${escapeHtml(readiness.summary)}</p>
        </div>
        <span class="${statusClass(readinessStatus)}">${escapeHtml(readiness.status.replaceAll("_", " "))}</span>
      </div>
      <ul>
        ${nextActions}
      </ul>
    </section>

    <section class="pilot-steps" aria-label="Live pilot checklist">
      <h2>Live Pilot Checklist</h2>
      <ol>
        ${pilotSteps}
      </ol>
    </section>

    <section class="meta" aria-label="Runtime details">
      <div><strong>Client ID</strong><span>${escapeHtml(snapshot.profile.businessId)}</span></div>
      <div><strong>Timezone</strong><span>${escapeHtml(snapshot.businessTimezone)}</span></div>
      <div><strong>Business Hours</strong><span>${escapeHtml(snapshot.businessHours.start)} to ${escapeHtml(snapshot.businessHours.end)}</span></div>
      <div><strong>Base URL</strong><span>${escapeHtml(snapshot.baseUrl)}</span></div>
      <div><strong>App Version</strong><span>${escapeHtml(snapshot.deployment.version)}</span></div>
      <div><strong>Deploy Commit</strong><span>${escapeHtml(snapshot.deployment.shortCommit || "not reported")}</span></div>
      <div><strong>Environment</strong><span>${escapeHtml(snapshot.deployment.environment)}</span></div>
    </section>

    <section class="checks" aria-label="System checks">
      ${rows}
    </section>
  </main>
</body>
</html>`;
}

function renderClientsPage(clients, storage, req, url) {
  const suffix = leadViewerUrlSuffix(url);
  const baseUrl = requestBaseUrl(req, url);
  const onboardingUrl = `${baseUrl}/admin/onboarding${suffix}`;
  const statusUrl = `${baseUrl}/admin/status${suffix}`;
  const apiUrl = `${baseUrl}/api/clients${suffix}`;
  const readyCount = clients.filter((client) => client.setupStatus === "ready").length;
  const issueCount = clients.reduce((total, client) => total + client.issueCount, 0);
  const leadCount = clients.reduce((total, client) => total + client.leadCount, 0);
  const followUpCount = clients.reduce((total, client) => total + client.followUpCount, 0);
  const rows = clients.length
    ? clients.map((client) => {
        const profile = client.profile || {};
        const clientId = client.id || profile.businessId || "";
        const clientSuffix = leadViewerUrlSuffix(url, { clientId });
        const clientLeadsUrl = `${baseUrl}/admin/leads${clientSuffix}`;
        const clientIssuesUrl = `${baseUrl}/admin/issues${clientSuffix}`;
        const clientSetupUrl = `${baseUrl}/admin/onboarding${clientSuffix}`;
        const services = Array.isArray(profile.services) && profile.services.length
          ? profile.services.join(", ")
          : "Not set";
        const areas = Array.isArray(profile.serviceAreas) && profile.serviceAreas.length
          ? profile.serviceAreas.join(", ")
          : "Not set";
        const ownerAlert = profile.ownerWhatsApp || profile.ownerPhone
          ? "Configured"
          : "Missing";
        const route = profile.assistantId || profile.phoneNumber ? "Configured" : "Missing";
        const leadViewer = client.setupChecks?.leadViewer ? "Configured" : "Missing";
        const setupLabel = client.setupStatus === "ready"
          ? "Ready"
          : client.setupStatus === "needs_review"
            ? "Review"
            : "Missing setup";
        const issueLabel = client.issueCount
          ? `${client.issueCount} issue${client.issueCount === 1 ? "" : "s"}`
          : "No issues";
        return `<article class="client">
          <div class="client-head">
            <div>
              <p class="eyebrow">${escapeHtml(client.id || profile.businessId || "")}</p>
              <h2>${escapeHtml(client.businessName || profile.businessName || "Unnamed client")}</h2>
              <p>${escapeHtml(profile.industry || "home services")}</p>
            </div>
            <div class="badges">
              <span class="badge badge-${escapeHtml(client.setupStatus)}">${escapeHtml(setupLabel)}</span>
              <span class="badge ${client.issueCount ? "badge-warning" : "badge-ready"}">${escapeHtml(issueLabel)}</span>
            </div>
          </div>
          <dl>
            <div><dt>Services</dt><dd>${escapeHtml(services)}</dd></div>
            <div><dt>Service Area</dt><dd>${escapeHtml(areas)}</dd></div>
            <div><dt>Vapi Route</dt><dd>${escapeHtml(route)}</dd></div>
            <div><dt>Owner Alert</dt><dd>${escapeHtml(ownerAlert)}</dd></div>
            <div><dt>Lead Viewer</dt><dd>${escapeHtml(leadViewer)}</dd></div>
            <div><dt>Total Leads</dt><dd>${escapeHtml(String(client.leadCount))}</dd></div>
            <div><dt>Need Follow-Up</dt><dd>${escapeHtml(String(client.followUpCount))}</dd></div>
            <div><dt>Last Lead</dt><dd>${escapeHtml(client.lastLeadAt ? formatDate(client.lastLeadAt) : "None yet")}</dd></div>
          </dl>
          <div class="actions">
            <a href="${escapeHtml(clientLeadsUrl)}">Leads</a>
            <a href="${escapeHtml(clientIssuesUrl)}">Issues</a>
            <a href="${escapeHtml(clientSetupUrl)}">Edit Setup</a>
          </div>
        </article>`;
      }).join("")
    : `<article class="empty">
        <h2>No clients saved yet</h2>
        <p>Use onboarding to create the first tenant profile.</p>
      </article>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Clients</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #171717;
      --muted: #5f6673;
      --paper: #fbfaf6;
      --line: #ddd8cb;
      --panel: #fff;
      --soft: #f4f0e7;
      --green: #2f6f4e;
      --gold: #8a6b1f;
      --red: #a13f3f;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; background: var(--paper); color: var(--ink); }
    main { max-width: 1060px; margin: 0 auto; padding: 28px 22px 46px; }
    h1 { margin: 0; font-size: 30px; line-height: 1.1; }
    h2 { margin: 0; font-size: 20px; }
    p { margin: 8px 0 0; color: var(--muted); line-height: 1.45; }
    a { border: 1px solid var(--line); border-radius: 6px; min-height: 36px; padding: 8px 12px; background: #fff; color: var(--ink); text-decoration: none; }
    dl { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 16px 0 0; }
    dt { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
    dd { margin: 0; overflow-wrap: anywhere; }
    .top { display: flex; justify-content: space-between; gap: 16px; align-items: start; margin-bottom: 18px; }
    .links { display: flex; gap: 8px; flex-wrap: wrap; justify-content: end; }
    .summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
    .summary div { border: 1px solid var(--line); border-radius: 8px; background: var(--soft); padding: 14px; }
    .summary strong { display: block; font-size: 24px; }
    .summary span { color: var(--muted); }
    .summary p { grid-column: 1 / -1; margin: 0; }
    .list { display: grid; gap: 12px; }
    .client, .empty { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 16px; }
    .client-head { display: flex; justify-content: space-between; gap: 16px; align-items: start; }
    .eyebrow { margin: 0 0 4px; font-size: 12px; letter-spacing: 0; text-transform: uppercase; }
    .badges, .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: end; }
    .actions { justify-content: start; margin-top: 16px; }
    .badge { display: inline-flex; min-height: 28px; align-items: center; border-radius: 999px; padding: 4px 10px; font-size: 13px; white-space: nowrap; background: #eceff3; color: #26303d; }
    .badge-ready { background: #e0f0e7; color: var(--green); }
    .badge-needs_review, .badge-warning { background: #f4ead0; color: var(--gold); }
    .badge-missing { background: #f6e1df; color: var(--red); }
    @media (max-width: 760px) {
      .top, .client-head { display: block; }
      .links { justify-content: start; margin-top: 14px; }
      .badges { justify-content: start; margin-top: 12px; }
      .summary, dl { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <section class="top">
      <div>
        <h1>Clients</h1>
        <p>Operator view for tenant setup.</p>
      </div>
      <nav class="links" aria-label="Admin links">
        <a href="${escapeHtml(onboardingUrl)}">New Client</a>
        <a href="${escapeHtml(statusUrl)}">System Status</a>
        <a href="${escapeHtml(apiUrl)}">JSON</a>
      </nav>
    </section>
    <section class="summary">
      <div><strong>${escapeHtml(String(clients.length))}</strong><span>Clients</span></div>
      <div><strong>${escapeHtml(String(readyCount))}</strong><span>Ready</span></div>
      <div><strong>${escapeHtml(String(leadCount))}</strong><span>Total leads</span></div>
      <div><strong>${escapeHtml(String(followUpCount))}</strong><span>Need follow-up</span></div>
      <div><strong>${escapeHtml(String(issueCount))}</strong><span>Open issues</span></div>
      <p>Storage: ${escapeHtml(storage === "postgres" ? "Postgres" : "Environment config")}</p>
    </section>
    <section class="list" aria-label="Clients">
      ${rows}
    </section>
  </main>
</body>
</html>`;
}

function renderProfilePage(req, url) {
  const profile = activeProfileForRequest(req, url);
  const suffix = leadViewerUrlSuffix(url);
  const firstMessage = firstMessageForProfile(profile);
  const prompt = buildVapiPrompt(profile);
  const baseUrl = requestBaseUrl(req, url);
  const webhookUrl = `${baseUrl}/webhooks/voice`;
  const agentContextUrl = `${baseUrl}/api/agent-context${suffix}`;
  const leadsUrl = `${baseUrl}/admin/leads${suffix}`;
  const onboardingUrl = `${baseUrl}/admin/onboarding${suffix}`;
  const statusUrl = `${baseUrl}/admin/status${suffix}`;
  const clientsUrl = `${baseUrl}/admin/clients${suffix}`;
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
        <a href="${escapeHtml(clientsUrl)}">Clients</a>
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
  const profile = activeProfileForRequest(req, url);
  const suffix = leadViewerUrlSuffix(url);
  const baseUrl = requestBaseUrl(req, url);
  const previewUrl = `/api/profile-preview${suffix}`;
  const clientsUrl = `/api/clients${suffix}`;
  const profileUrl = `${baseUrl}/admin/profile${suffix}`;
  const clientsPageUrl = `${baseUrl}/admin/clients${suffix}`;
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
        <p>Fill this out once per client. Generate the setup, then save the client when the database is ready.</p>
      </div>
      <nav class="links" aria-label="Setup links">
        <a href="${escapeHtml(profileUrl)}">Current Setup</a>
        <a href="${escapeHtml(clientsPageUrl)}">Clients</a>
        <a href="${escapeHtml(statusUrl)}">System Status</a>
      </nav>
    </section>

    <section class="grid">
      <form class="card" id="profile-form">
        <h2>Client Details</h2>
        <label>Client ID</label>
        <input name="businessId" value="${escapeHtml(profile.businessId)}">
        <label>Business name</label>
        <input name="businessName" value="${escapeHtml(profile.businessName)}">
        <label>Assistant name</label>
        <input name="assistantName" value="${escapeHtml(profile.assistantName)}">
        <label>Industry</label>
        <input name="industry" value="${escapeHtml(profile.industry)}">
        <label>Vapi assistant ID</label>
        <input name="assistantId" value="${escapeHtml(profile.assistantId || "")}">
        <label>Vapi phone number or ID</label>
        <input name="phoneNumber" value="${escapeHtml(profile.phoneNumber || "")}">
        <label>Timezone</label>
        <input name="timezone" value="${escapeHtml(profile.timezone || businessTimeZone())}">
        <label>Business hours start</label>
        <input name="businessHoursStart" value="${escapeHtml(profile.businessHoursStart || process.env.BUSINESS_HOURS_START || "08:00")}">
        <label>Business hours end</label>
        <input name="businessHoursEnd" value="${escapeHtml(profile.businessHoursEnd || process.env.BUSINESS_HOURS_END || "18:00")}">
        <label>Owner phone</label>
        <input name="ownerPhone" value="${escapeHtml(profile.ownerPhone || "")}">
        <label>Owner WhatsApp</label>
        <input name="ownerWhatsApp" value="${escapeHtml(profile.ownerWhatsApp || "")}">
        <label>Optional booking link</label>
        <input name="bookingLink" value="${escapeHtml(profile.bookingLink || "")}">
        <label>Services</label>
        <textarea name="services">${escapeHtml(profile.services.join(", "))}</textarea>
        <label>Service areas</label>
        <textarea name="serviceAreas">${escapeHtml(profile.serviceAreas.join(", "))}</textarea>
        <label>First message override</label>
        <textarea name="greeting">${escapeHtml(profile.greeting)}</textarea>
        <div class="actions">
          <button type="submit">Generate</button>
          <button type="button" id="save-client">Save Client</button>
        </div>
        <p class="status" id="status"></p>
      </form>

      <section class="outputs">
        <article class="card">
          <h2>Client ID</h2>
          <input id="client-id" readonly>
          <div class="actions"><button type="button" data-copy-target="client-id">Copy Client ID</button></div>
        </article>
        <article class="card">
          <h2>Private Lead Viewer Link</h2>
          <input id="lead-viewer-link" readonly>
          <div class="actions"><button type="button" data-copy-target="lead-viewer-link">Copy Lead Link</button></div>
        </article>
        <article class="card">
          <h2>Private Lead Viewer Token</h2>
          <input id="lead-viewer-token" readonly>
          <div class="actions"><button type="button" data-copy-target="lead-viewer-token">Copy Token</button></div>
        </article>
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
          <h2>Vapi Tool URL</h2>
          <input id="vapi-tool-url" readonly>
          <div class="actions"><button type="button" data-copy-target="vapi-tool-url">Copy Tool URL</button></div>
        </article>
        <article class="card">
          <h2>Owner Notification Setup</h2>
          <textarea class="mono" id="owner-notification-setup" readonly></textarea>
          <div class="actions"><button type="button" data-copy-target="owner-notification-setup">Copy Owner Setup</button></div>
        </article>
        <article class="card">
          <h2>Optional Booking Link</h2>
          <input id="booking-link" readonly>
          <div class="actions"><button type="button" data-copy-target="booking-link">Copy Booking Link</button></div>
        </article>
        <article class="card">
          <h2>Live Test Checklist</h2>
          <textarea class="mono" id="live-test-checklist" readonly></textarea>
          <div class="actions"><button type="button" data-copy-target="live-test-checklist">Copy Checklist</button></div>
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
      document.getElementById("client-id").value = data.setup?.clientId || data.profile?.businessId || "";
      document.getElementById("lead-viewer-link").value = data.setup?.leadViewerLink || "";
      document.getElementById("lead-viewer-token").value = data.leadViewerToken || "";
      document.getElementById("first-message").value = data.firstMessage || "";
      document.getElementById("prompt").value = data.prompt || "";
      document.getElementById("vapi-tool-url").value = data.setup?.vapiToolUrl || "";
      document.getElementById("owner-notification-setup").value = data.setup?.ownerNotificationSetup || "";
      document.getElementById("booking-link").value = data.setup?.bookingLink || "";
      document.getElementById("live-test-checklist").value = (data.setup?.liveTestChecklist || []).map((item, index) => String(index + 1) + ". " + item).join("\\n");
      document.getElementById("env").value = data.envSnippet || "";
      status.textContent = "Ready.";
    }
    async function saveClient() {
      status.textContent = "Saving client...";
      const payload = Object.fromEntries(new FormData(form).entries());
      const existingToken = document.getElementById("lead-viewer-token").value;
      if (existingToken) payload.leadViewerToken = existingToken;
      const response = await fetch("${escapeHtml(clientsUrl)}", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        status.textContent = data.error === "database_not_configured"
          ? "Database is not configured yet. Add DATABASE_URL in Render, then save again."
          : data.error || "Could not save client.";
        return;
      }
      document.getElementById("client-id").value = data.setup?.clientId || data.profile?.businessId || "";
      document.getElementById("lead-viewer-link").value = data.setup?.leadViewerLink || "";
      document.getElementById("lead-viewer-token").value = data.leadViewerToken || "";
      document.getElementById("first-message").value = data.firstMessage || "";
      document.getElementById("prompt").value = data.prompt || "";
      document.getElementById("vapi-tool-url").value = data.setup?.vapiToolUrl || "";
      document.getElementById("owner-notification-setup").value = data.setup?.ownerNotificationSetup || "";
      document.getElementById("booking-link").value = data.setup?.bookingLink || "";
      document.getElementById("live-test-checklist").value = (data.setup?.liveTestChecklist || []).map((item, index) => String(index + 1) + ". " + item).join("\\n");
      document.getElementById("env").value = data.envSnippet || "";
      status.textContent = "Client saved. Copy this token now; it will not be shown again after you leave this page.";
    }
    form.addEventListener("submit", generate);
    document.getElementById("save-client").addEventListener("click", saveClient);
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

function renderLeadsPage(leads, url, req) {
  const profile = req ? activeProfileForRequest(req, url) : businessProfile();
  const access = req ? requestAccessContext(req, url) : { scope: "legacy" };
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
      ${renderFollowUpHistory(lead, 2)}
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
    .history { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 10px; color: var(--muted); font-size: 13px; }
    .history p { margin: 4px 0; }
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
      <p class="sub">Call leads from ${escapeHtml(profile.assistantName)}, ready for owner follow-up. ${access.scope === "admin" ? `<a href="/admin/clients${escapeHtml(leadViewerUrlSuffix(url, { clientId: "" }))}">Clients</a> ` : ""}<a href="/admin/profile${escapeHtml(suffix)}">Setup</a> <a href="/admin/status${escapeHtml(suffix)}">System Status</a> <a href="/admin/issues${escapeHtml(suffix)}">Issues</a> <a href="/admin/events${escapeHtml(suffix)}">Events</a> <a href="/api/leads.csv${escapeHtml(suffix)}">Export CSV</a> <a href="/api/backup.json${escapeHtml(suffix)}">Backup JSON</a></p>
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

function renderLeadDetailPage(lead, url, req) {
  const profile = req ? activeProfileForRequest(req, url) : businessProfile();
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
    .history { display: grid; gap: 8px; color: var(--muted); }
    .history p { margin: 0; line-height: 1.45; }
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

    ${latestFollowUpHistory(publicItem).length ? `<section class="card">
      <h2>Follow-Up History</h2>
      ${renderFollowUpHistory(publicItem, 20)}
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

function renderEventsPage(events, url, req) {
  const profile = req ? activeProfileForRequest(req, url) : businessProfile();
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
      <p class="sub">Recent Vapi and Twilio webhook activity. <a href="/admin/leads${escapeHtml(suffix)}">Leads</a> <a href="/admin/status${escapeHtml(suffix)}">System Status</a> <a href="/admin/issues${escapeHtml(suffix)}">Issues</a> <a href="/api/events${escapeHtml(suffix)}">JSON</a></p>
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

function renderIssuesPage(issueSnapshot, url, req) {
  const profile = req ? activeProfileForRequest(req, url) : businessProfile();
  const access = req ? requestAccessContext(req, url) : { scope: "legacy" };
  const suffix = leadViewerUrlSuffix(url);
  const rows = issueSnapshot.issues
    .map((issue) => {
      const leadLink = issue.leadId ? `<a href="/admin/leads/${encodeURIComponent(issue.leadId)}${escapeHtml(suffix)}">Lead</a>` : "";
      return `<article class="issue issue-${escapeHtml(issue.severity)}">
        <div>
          <p class="meta">${escapeHtml(formatDate(issue.createdAt))} · ${escapeHtml(issue.businessId || profile.businessId)} · ${escapeHtml(issue.type)}</p>
          <h2>${escapeHtml(issue.title)}</h2>
          <p>${escapeHtml(issue.detail)}</p>
          ${issue.callId ? `<p class="meta">Call: ${escapeHtml(issue.callId)}</p>` : ""}
        </div>
        <div class="actions">
          <span>${escapeHtml(issue.severity)}</span>
          ${leadLink}
        </div>
      </article>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(profile.businessName)} Issues</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #171717;
      --muted: #5f6673;
      --paper: #fbfaf6;
      --line: #ddd8cb;
      --panel: #fff;
      --critical: #a13f3f;
      --warning: #8a6b1f;
      --info: #38658a;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; background: var(--paper); color: var(--ink); }
    header { background: #fff; border-bottom: 1px solid var(--line); }
    .wrap { max-width: 1120px; margin: 0 auto; padding: 24px; }
    h1 { margin: 0; font-size: 30px; line-height: 1.1; }
    h2 { margin: 0; font-size: 18px; }
    p { margin: 8px 0 0; color: var(--muted); line-height: 1.45; }
    a { color: var(--ink); }
    .sub { margin: 8px 0 0; color: var(--muted); }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 22px 0; }
    .summary div, .issue, .empty { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 16px; }
    .summary strong { display: block; font-size: 24px; }
    .issues { display: grid; gap: 10px; }
    .issue { display: flex; justify-content: space-between; gap: 16px; border-left-width: 4px; }
    .issue-critical { border-left-color: var(--critical); }
    .issue-warning { border-left-color: var(--warning); }
    .issue-info { border-left-color: var(--info); }
    .meta { font-size: 13px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: end; align-content: start; }
    .actions span, .actions a { border: 1px solid var(--line); border-radius: 999px; padding: 6px 10px; background: #fff; text-transform: capitalize; text-decoration: none; }
    .empty { text-align: center; color: var(--muted); }
    @media (max-width: 760px) {
      .wrap { padding: 18px; }
      .summary { grid-template-columns: 1fr 1fr; }
      .issue { display: block; }
      .actions { justify-content: start; margin-top: 12px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <h1>${escapeHtml(profile.businessName)} Issues</h1>
      <p class="sub">Production watchlist for failed routes, alert failures, scheduling follow-up, and missing setup. ${access.scope === "admin" ? `<a href="/admin/clients${escapeHtml(leadViewerUrlSuffix(url, { clientId: "" }))}">Clients</a> ` : ""}<a href="/admin/leads${escapeHtml(suffix)}">Leads</a> <a href="/admin/status${escapeHtml(suffix)}">System Status</a> <a href="/admin/events${escapeHtml(suffix)}">Events</a> <a href="/api/issues${escapeHtml(suffix)}">JSON</a></p>
    </div>
  </header>
  <main class="wrap">
    <section class="summary" aria-label="Issue counts">
      <div><strong>${escapeHtml(String(issueSnapshot.counts.total))}</strong><span>Total</span></div>
      <div><strong>${escapeHtml(String(issueSnapshot.counts.critical))}</strong><span>Critical</span></div>
      <div><strong>${escapeHtml(String(issueSnapshot.counts.warning))}</strong><span>Warnings</span></div>
      <div><strong>${escapeHtml(String(issueSnapshot.counts.info))}</strong><span>Info</span></div>
    </section>
    <section class="issues" aria-label="Issues">
      ${rows || `<div class="empty">No issues found.</div>`}
    </section>
  </main>
</body>
</html>`;
}

async function updateLeadStatus({ id, status, note }) {
  const allowedStatuses = new Set(["new", "needs_follow_up", "needs_review", "contacted", "booked", "lost"]);
  if (!id || !allowedStatuses.has(status)) {
    return { ok: false, error: "invalid_lead_status_update" };
  }

  const lead = await findLeadById(id);
  if (!lead) return { ok: false, error: "lead_not_found" };

  const trimmedNote = String(note || "").trim();
  const history = Array.isArray(lead.followUpHistory) ? lead.followUpHistory : [];
  const historyItem = {
    at: new Date().toISOString(),
    status,
    note: trimmedNote,
  };

  const updated = await updateStoredLead(id, {
    status,
    followUpNote: trimmedNote || lead.followUpNote || "",
    followUpHistory: [historyItem, ...history].slice(0, 50),
  });

  return { ok: true, lead: publicLead(updated) };
}

async function notifyOwnerForLead(id) {
  const lead = await findLeadById(id);
  if (!lead) return { ok: false, error: "lead_not_found" };

  const { notification, lead: updatedLead } = await attemptOwnerNotification(lead);
  return {
    ok: notification.mode !== "error",
    notification,
    lead: publicLead(updatedLead || lead),
  };
}

async function buildProtectedBackup(req, url) {
  const [leads, events] = await Promise.all([
    readLeads(),
    readEvents(),
  ]);
  const visibleLeads = req && url ? filterRecordsForRequest(leads, req, url) : leads;
  const visibleEvents = req && url ? filterRecordsForRequest(events, req, url) : events;

  return {
    ok: true,
    exportedAt: new Date().toISOString(),
    profile: publicBusinessProfile(req && url ? activeProfileForRequest(req, url) : businessProfile()),
    leads: visibleLeads.map(publicLead),
    events: visibleEvents.map(publicEvent),
  };
}

async function updateStoredLead(id, updates) {
  if (postgresEnabled()) {
    const current = await findLeadById(id);
    if (!current) return null;
    const next = {
      ...current,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    await ensureDatabase();
    await databasePool().query(
      `update leads
       set business_id = $2, call_id = $3, status = $4, updated_at = $5, data = $6::jsonb
       where id = $1`,
      [
        id,
        next.businessId || "",
        next.callId || "",
        next.status || "new",
        next.updatedAt,
        JSON.stringify(next),
      ],
    );
    return next;
  }

  return enqueueJsonWrite(leadsFile, async () => {
    const leads = await readLeads();
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
  const profile = input.tenantProfile || businessProfile();
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
    businessTimezone: parameters.businessTimezone || profile.timezone || "",
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

function vapiCallId(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const value = source.call?.id
      || source.callId
      || source.call_id
      || source.artifact?.callId
      || source.artifact?.call?.id
      || source.message?.call?.id
      || source.message?.callId
      || source.message?.call_id
      || source.message?.artifact?.callId
      || source.message?.artifact?.call?.id
      || "";
    if (value) return String(value);
  }
  return "";
}

async function findLeadByCallId(callId) {
  if (!callId) return null;
  const leads = await readLeads();
  return leads.find((lead) => lead.callId === callId) || null;
}

async function findRecentToolLeadForBusiness(businessId, minutes = 20) {
  if (!businessId) return null;
  const cutoff = Date.now() - (minutes * 60 * 1000);
  const leads = await readLeads();
  return leads
    .filter((lead) => lead.businessId === businessId && lead.source === "vapi_tool")
    .filter((lead) => {
      const createdAt = Date.parse(lead.createdAt || "");
      return Number.isFinite(createdAt) && createdAt >= cutoff;
    })
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
}

async function findLeadById(id) {
  if (!id) return null;
  const leads = await readLeads();
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
  return insertLead(lead);
}

async function saveEvent(input) {
  const profile = businessProfile();
  return insertEvent({
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

function buildAvailabilityWindow(input = {}, profile = null) {
  const parameters = input.parameters || input.arguments || input;
  const zone = businessTimeZone(profile);
  const explicitStart = parameters.startIso || parameters.windowStartIso;
  const explicitEnd = parameters.endIso || parameters.windowEndIso;

  if (explicitStart && explicitEnd) {
    const start = DateTime.fromISO(explicitStart, { setZone: true }).setZone(zone);
    const end = DateTime.fromISO(explicitEnd, { setZone: true }).setZone(zone);
    if (start.isValid && end.isValid && end > start) {
      return { ok: true, start, end, zone };
    }
  }

  const reference = currentBusinessTime(profile);
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

  const { start: openMinutes, end: closeMinutes } = businessHours(profile);
  const interval = slotIntervalMinutes();
  let start = day.startOf("day").plus({ minutes: openMinutes });
  const end = day.startOf("day").plus({ minutes: closeMinutes });
  const now = currentBusinessTime(profile);

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

async function getAvailableSlots(input = {}, profile = null) {
  const window = buildAvailabilityWindow(input, profile);
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

function calendarErrorDetail(calendar = {}) {
  return calendar.payload?.error?.message
    || calendar.payload?.error_description
    || calendar.payload?.error
    || calendar.error
    || "";
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
    start: { dateTime: startIso, timeZone: lead.businessTimezone || businessTimeZone() },
    end: { dateTime: endIso, timeZone: lead.businessTimezone || businessTimeZone() },
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
  const mockFailureCallIds = process.env.NODE_ENV === "test"
    ? String(process.env.MOCK_OWNER_ALERT_FAIL_ONCE_CALL_IDS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const mockAlwaysFailCallIds = process.env.NODE_ENV === "test"
    ? String(process.env.MOCK_OWNER_ALERT_ALWAYS_FAIL_CALL_IDS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  if (lead.callId && mockAlwaysFailCallIds.includes(lead.callId)) {
    return { mode: "error", error: "mock_owner_alert_failure" };
  }
  if (lead.callId && mockFailureCallIds.includes(lead.callId) && !mockOwnerAlertFailures.has(lead.callId)) {
    mockOwnerAlertFailures.add(lead.callId);
    return { mode: "error", error: "mock_owner_alert_failure" };
  }

  const profile = await profileForBusinessId(lead.businessId);
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

  const ownerWhatsApp = profile.ownerWhatsApp || process.env.OWNER_WHATSAPP_NUMBER;
  const ownerSms = profile.ownerPhone || process.env.OWNER_PHONE_NUMBER;
  let whatsappFailure = null;

  if (ownerWhatsApp) {
    let result;
    try {
      result = await sendTwilioMessage({ to: ownerWhatsApp, body: message, channel: "whatsapp" });
    } catch {
      result = { mode: "error", error: "owner_alert_transport_error", channel: "whatsapp" };
    }
    if (result.mode !== "error") return { ...result, message };
    whatsappFailure = result;
  }

  if (ownerSms) {
    let result;
    try {
      result = await sendTwilioMessage({ to: ownerSms, body: message, channel: "sms" });
    } catch {
      result = { mode: "error", error: "owner_alert_transport_error", channel: "sms" };
    }
    return { ...result, message };
  }

  if (whatsappFailure) return { ...whatsappFailure, message };
  return { mode: "test", message };
}

function ownerAlertMaxAttempts() {
  const configured = Number(process.env.OWNER_ALERT_MAX_ATTEMPTS || 5);
  return Number.isInteger(configured) && configured > 0 ? Math.min(configured, 20) : 5;
}

function ownerAlertRetryBaseMs() {
  const configured = Number(process.env.OWNER_ALERT_RETRY_BASE_SECONDS || 60) * 1000;
  const minimum = process.env.NODE_ENV === "test" ? 10 : 1000;
  return Number.isFinite(configured) && configured >= minimum ? configured : 60_000;
}

function ownerAlertWorkerIntervalMs() {
  const configured = Number(process.env.OWNER_ALERT_WORKER_INTERVAL_SECONDS || 30) * 1000;
  const minimum = process.env.NODE_ENV === "test" ? 10 : 1000;
  return Number.isFinite(configured) && configured >= minimum ? configured : 30_000;
}

function ownerAlertRetryDelayMs(attempts) {
  return Math.min(ownerAlertRetryBaseMs() * (2 ** Math.max(0, attempts - 1)), 60 * 60 * 1000);
}

function ownerNotificationFields(result = {}, lead = {}) {
  const attempts = Number(lead.ownerNotificationAttempts || 0) + 1;
  const shouldRetry = result.mode === "error" && attempts < ownerAlertMaxAttempts();
  const now = new Date();
  return {
    ownerNotificationMode: result.mode || "",
    ownerNotificationChannel: result.channel || "",
    ownerNotificationStatus: result.status || "",
    ownerNotificationError: result.error || result.payload?.message || result.reason || "",
    ownerNotificationAttempts: attempts,
    ownerNotificationLastAttemptAt: now.toISOString(),
    ownerNotificationNextRetryAt: shouldRetry
      ? new Date(now.getTime() + ownerAlertRetryDelayMs(attempts)).toISOString()
      : "",
  };
}

async function recordOwnerNotification(lead, result) {
  if (!lead?.id) return lead;
  return await updateStoredLead(lead.id, ownerNotificationFields(result, lead)) || lead;
}

function operatorAlertsEnabled() {
  return process.env.ENABLE_OPERATOR_ALERTS === "true";
}

function operatorAlertKey(event) {
  return event.operatorAlertKey || event.raw?.operatorAlertKey || "";
}

async function operatorAlertAlreadySent(key) {
  const events = await readEvents();
  return events.some((event) => operatorAlertKey(event) === key
    && (event.type === "operator_alert_sent"
      || (process.env.NODE_ENV === "test" && event.type === "operator_alert_test")));
}

async function sendOperatorAlert({ key, businessId, type, title, detail, callId = "", leadId = "" }) {
  if (!operatorAlertsEnabled()) return { mode: "disabled" };
  if (!key || operatorAlertInFlight.has(key) || await operatorAlertAlreadySent(key)) {
    return { mode: "skipped", reason: "duplicate_operator_alert" };
  }

  operatorAlertInFlight.add(key);
  try {
    const to = String(process.env.OPERATOR_WHATSAPP_NUMBER || "").trim();
    const body = [
      "Lost Lead critical alert",
      `Client: ${businessId || "unrouted"}`,
      `Type: ${type}`,
      `Problem: ${title}`,
      detail ? `Details: ${detail}` : "",
      callId ? `Call: ${callId}` : "",
      "Review the operator Issues page.",
    ].filter(Boolean).join("\n");

    let result;
    if (!to) {
      result = { mode: "error", error: "missing_operator_whatsapp_number", channel: "whatsapp" };
    } else {
      try {
        result = await sendTwilioMessage({ to, body, channel: "whatsapp" });
      } catch {
        result = { mode: "error", error: "operator_alert_transport_error", channel: "whatsapp" };
      }
    }

    const eventType = result.mode === "live"
      ? "operator_alert_sent"
      : result.mode === "test"
        ? "operator_alert_test"
        : "operator_alert_failed";
    await saveEvent({
      provider: "operator_whatsapp",
      type: eventType,
      businessId: businessId || "unrouted",
      callId,
      summary: `${title}: ${result.mode}`,
      raw: {
        operatorAlertKey: key,
        alertType: type,
        leadId,
        mode: result.mode,
        error: result.error || "",
      },
    });
    return result;
  } finally {
    operatorAlertInFlight.delete(key);
  }
}

async function attemptOwnerNotification(lead) {
  if (!lead?.id || ownerAlertInFlight.has(lead.id)) {
    return { notification: { mode: "skipped", reason: "owner_alert_in_flight" }, lead };
  }

  ownerAlertInFlight.add(lead.id);
  try {
    let notification;
    try {
      notification = await sendOwnerNotification(lead);
    } catch {
      notification = { mode: "error", error: "owner_alert_transport_error" };
    }
    const updatedLead = await recordOwnerNotification(lead, notification);
    if (notification.mode === "error"
      && Number(updatedLead?.ownerNotificationAttempts || 0) >= ownerAlertMaxAttempts()) {
      await sendOperatorAlert({
        key: `owner-alert:${lead.id}`,
        businessId: lead.businessId,
        type: "owner_alert_failed",
        title: "Owner alert failed permanently",
        detail: "Owner notification attempts were exhausted.",
        callId: lead.callId,
        leadId: lead.id,
      });
    }
    return { notification, lead: updatedLead || lead };
  } finally {
    ownerAlertInFlight.delete(lead.id);
  }
}

function ownerAlertRetryDue(lead, now = Date.now()) {
  if (lead.ownerNotificationMode !== "error") return false;
  const attempts = Number(lead.ownerNotificationAttempts || 0);
  if (attempts >= ownerAlertMaxAttempts()) return false;
  const retryAt = Date.parse(lead.ownerNotificationNextRetryAt || "");
  if (Number.isFinite(retryAt)) return retryAt <= now;
  return attempts === 0;
}

async function retryFailedOwnerNotifications() {
  if (ownerAlertWorkerBusy) return;
  ownerAlertWorkerBusy = true;
  try {
    const leads = await readLeads();
    const due = leads.filter((lead) => ownerAlertRetryDue(lead)).slice(0, 25);
    for (const lead of due) {
      await attemptOwnerNotification(lead);
    }
  } catch (error) {
    console.error("Owner alert retry worker failed", error?.name || "Error");
  } finally {
    ownerAlertWorkerBusy = false;
  }
}

function startOwnerAlertRetryWorker() {
  const worker = setInterval(() => {
    void retryFailedOwnerNotifications();
  }, ownerAlertWorkerIntervalMs());
  worker.unref();
  void retryFailedOwnerNotifications();
}

async function sendCustomerConfirmation(lead) {
  if (process.env.SEND_CUSTOMER_CONFIRMATIONS !== "true") {
    return { mode: "skipped", reason: "customer_confirmations_disabled" };
  }

  if (!lead.phone || !(lead.bookedTime || lead.requestedTime)) {
    return { mode: "skipped", reason: "missing_phone_or_time" };
  }

  const businessName = (await profileForBusinessId(lead.businessId)).businessName;
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
  const tenantProfile = input.tenantProfile || await profileForBusinessId(normalized.businessId);
  const schedule = buildAppointmentSchedule(normalized, tenantProfile);
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
      calendarErrorDetail: calendarErrorDetail(calendar),
    }) || lead;
  }

  const ownerAttempt = await attemptOwnerNotification(lead);
  const ownerNotification = ownerAttempt.notification;
  lead = ownerAttempt.lead;
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

function endOfCallLooksHandledByTool(summary = "", transcript = "") {
  const text = `${summary}\n${transcript}`.toLowerCase();
  return text.includes("saved your appointment request")
    || text.includes("bookappointment")
    || text.includes("appointment tool")
    || text.includes("completed successfully");
}

function cleanTranscriptValue(value = "") {
  return String(value)
    .replace(/\b(?:ai|assistant|user|caller):.*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.!,;:]+$/g, "")
    .trim();
}

function matchTranscriptValue(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanTranscriptValue(match[1]);
  }
  return "";
}

function cleanRequestedTime(value = "") {
  return String(value)
    .replace(/\bat\s+at\b/gi, "at")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLeadFromTranscript(transcript = "", summary = "") {
  const text = `${transcript}\n${summary}`.replace(/\s+/g, " ").trim();
  if (!text) return {};

  const name = matchTranscriptValue(text, [
    /\bmy name is\s+([^.,!?]+?)(?:\s+and\b|[.,!?]|$)/i,
    /\bit'?s\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})(?:[.,!?]|\s+i\b|$)/i,
  ]);

  const phoneText = matchTranscriptValue(text, [
    /\b(?:my\s+)?phone(?:\s+number)?\s+is\s+(.+?)(?:[.,!?]|\s+and\s+my\b|\s+ai:|\s+assistant:|\s+user:|$)/i,
  ]);
  const phoneDigits = normalizeSpokenDigits(phoneText);

  const addressText = matchTranscriptValue(text, [
    /\b(?:my\s+)?address(?:,\s*zip code)?\s+is\s+(.+?)(?:\s+and\s+my\s+phone\b|[.,!?]|\s+ai:|\s+assistant:|\s+user:|$)/i,
    /\bzip code\s+is\s+(.+?)(?:\s+and\s+my\s+phone\b|[.,!?]|\s+ai:|\s+assistant:|\s+user:|$)/i,
    /\bi'?m\s+in\s+(.+?)(?:\s+and\s+i\s+want\b|\s+i\s+want\b|\s+for\b|[.,!?]|\s+ai:|\s+assistant:|\s+user:|$)/i,
  ]);
  const addressDigits = normalizeSpokenDigits(addressText);
  const address = addressDigits.length >= 4 ? addressDigits : addressText;

  const requestedTime = cleanRequestedTime(matchTranscriptValue(text, [
    /\b(?:for|by|at)\s+((?:tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+[^.,!?]+(?:am|pm|a\.m\.|p\.m\.)?)/i,
    /\bappointment request\s+for\s+([^.,!?]+(?:am|pm|a\.m\.|p\.m\.)?)/i,
    /\b(?:date|time)\s+(?:of|is|for)\s+([^.,!?]+)/i,
  ]));

  const service = matchTranscriptValue(text, [
    /\b(?:need|needs|looking for|like|want|calling for|inquiring for)\s+(?:a|an|some)?\s*([^.,!?]+?)(?:\s+by\b|\s+for\b|\s+at\b|[.,!?]|$)/i,
    /\bwhat type of roofing service or repair you need\?\s*(?:user:|caller:)?\s*([^.,!?]+)/i,
  ]);

  return {
    name,
    phone: phoneDigits.length >= 10 ? phoneDigits.slice(-10) : phoneDigits,
    service,
    address,
    requestedTime,
    bookedTime: requestedTime,
  };
}

async function handleVapiToolCalls(message, tenantProfile = null, callId = "") {
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
      const availability = await getAvailableSlots(parseToolParameters(toolCall), tenantProfile);
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
        businessId: tenantProfile?.businessId || parseToolParameters(toolCall).businessId,
        tenantProfile,
        callId: callId || vapiCallId(message),
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
  const callId = vapiCallId(message, body);
  const routingHints = routingHintsFromVapiMessage(message);
  const tenantProfile = await resolveClientProfile(routingHints);
  const hasRoutingHint = Boolean(routingHints.businessId || routingHints.assistantId || routingHints.phoneNumber);
  const routingIsConfigured = postgresEnabled() || configuredClientProfiles().length > 0;

  if (hasRoutingHint && routingIsConfigured && !tenantProfile) {
    const routeEvent = await saveEvent({
      provider: "vapi",
      type: "tenant_route_failed",
      businessId: "unrouted",
      callId,
      raw: { type, routingHints, body },
    });
    const routeKeyHint = callId
      || routingHints.assistantId
      || routingHints.phoneNumber
      || routingHints.businessId
      || routeEvent.id;
    await sendOperatorAlert({
      key: `tenant-route:${privateTokenHash(routeKeyHint).slice(0, 24)}`,
      businessId: "unrouted",
      type: "tenant_route_failed",
      title: "Vapi call did not match a tenant",
      detail: "Review the saved Vapi assistant ID, phone number, or client metadata.",
      callId,
    });
    return {
      ok: false,
      error: "client_route_not_found",
      message: "Client route is missing. Save the client assistant ID or phone number before taking live calls.",
    };
  }

  const activeProfile = tenantProfile || businessProfile();
  await saveEvent({ provider: "vapi", type, businessId: activeProfile.businessId, raw: body });

  if (type === "assistant-request") {
    if (tenantProfile?.assistantId) {
      return { assistantId: tenantProfile.assistantId };
    }
    if (process.env.VAPI_ASSISTANT_ID) {
      return { assistantId: process.env.VAPI_ASSISTANT_ID };
    }
    return { error: "Assistant is not configured yet." };
  }

  if (type === "tool-calls") {
    return handleVapiToolCalls(message, activeProfile, callId);
  }

  if (type === "end-of-call-report") {
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
    const recentToolLead = await findRecentToolLeadForBusiness(activeProfile.businessId);
    if (!callId && recentToolLead && endOfCallLooksHandledByTool(summary, transcript)) {
      return {
        ok: true,
        type,
        skipped: true,
        reason: "recent_tool_lead_already_saved",
        leadId: recentToolLead.id,
      };
    }
    if (summary) {
      const extractedLead = extractLeadFromTranscript(transcript, summary);
      const lead = await saveLead(normalizeLead({
        ...extractedLead,
        businessId: activeProfile.businessId,
        tenantProfile: activeProfile,
        source: "vapi_end_of_call",
        status: "needs_review",
        summary,
        transcript,
        callId,
      }));
      const { notification } = await attemptOwnerNotification(lead);
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
  const { notification } = await attemptOwnerNotification(lead);
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
    req.accessContext = await requestAccessContextAsync(req, url);
    const clientScope = await applyAdminClientScope(req, url);
    if (!clientScope.ok) {
      return json(res, 404, { ok: false, error: clientScope.error });
    }
    if (isRateLimited(req, url)) {
      return json(res, 429, { ok: false, error: "rate_limited" });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, service: "lost-lead-booking-agent", deployment: deploymentInfo() });
    }

    if (req.method === "GET" && (url.pathname === "/profile" || url.pathname === "/admin/profile")) {
      if (!leadViewerConfigured()) {
        return html(res, 503, renderLeadViewerDisabled());
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return html(res, 401, renderUnauthorizedLeadViewer());
      }

      return html(res, 200, renderProfilePage(req, url));
    }

    if (req.method === "GET" && (url.pathname === "/onboarding" || url.pathname === "/admin/onboarding")) {
      if (!leadViewerConfigured()) {
        return html(res, 503, renderLeadViewerDisabled());
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return html(res, 401, renderUnauthorizedLeadViewer());
      }

      return html(res, 200, renderOnboardingPage(req, url));
    }

    if (req.method === "GET" && (url.pathname === "/status" || url.pathname === "/admin/status")) {
      if (!leadViewerConfigured()) {
        return html(res, 503, renderLeadViewerDisabled());
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return html(res, 401, renderUnauthorizedLeadViewer());
      }

      return html(res, 200, renderSystemStatusPage(req, url, systemStatusSnapshot(req, url, {
        clientCount: await configuredClientCount(),
      })));
    }

    if (req.method === "GET" && (url.pathname === "/clients" || url.pathname === "/admin/clients")) {
      const access = requestAccessContext(req, url);
      if (!access.ok || access.scope === "client") {
        return html(res, 401, renderUnauthorizedLeadViewer());
      }

      const clients = postgresEnabled()
        ? await listStoredClients()
        : configuredClientProfiles().map((client) => ({
            id: client.businessId,
            businessName: client.businessName,
            hasLeadViewerToken: Boolean(client.leadViewerToken),
            profile: publicBusinessProfile(client),
          }));
      const [leads, events] = await Promise.all([readLeads(), readEvents()]);
      return html(res, 200, renderClientsPage(
        clientDashboardRows(clients, leads, events),
        postgresEnabled() ? "postgres" : "env",
        req,
        url,
      ));
    }

    if (req.method === "GET" && (url.pathname === "/leads" || url.pathname === "/admin/leads")) {
      if (!leadViewerConfigured()) {
        return html(res, 503, renderLeadViewerDisabled());
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return html(res, 401, renderUnauthorizedLeadViewer());
      }

      const leads = filterRecordsForRequest(await readLeads(), req, url);
      return html(res, 200, renderLeadsPage(leads, url, req));
    }

    if (req.method === "GET" && url.pathname.startsWith("/admin/leads/")) {
      if (!leadViewerConfigured()) {
        return html(res, 503, renderLeadViewerDisabled());
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return html(res, 401, renderUnauthorizedLeadViewer());
      }

      const id = decodeURIComponent(url.pathname.replace("/admin/leads/", ""));
      const lead = await findLeadById(id);
      if (!lead) return html(res, 404, renderNotFoundLeadViewer());
      if (!canAccessRecord(lead, req, url)) return html(res, 404, renderNotFoundLeadViewer());

      return html(res, 200, renderLeadDetailPage(lead, url, req));
    }

    if (req.method === "GET" && (url.pathname === "/events" || url.pathname === "/admin/events")) {
      if (!leadViewerConfigured()) {
        return html(res, 503, renderLeadViewerDisabled());
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return html(res, 401, renderUnauthorizedLeadViewer());
      }

      const events = filterRecordsForRequest(await readEvents(), req, url);
      return html(res, 200, renderEventsPage(events, url, req));
    }

    if (req.method === "GET" && (url.pathname === "/issues" || url.pathname === "/admin/issues")) {
      if (!leadViewerConfigured()) {
        return html(res, 503, renderLeadViewerDisabled());
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return html(res, 401, renderUnauthorizedLeadViewer());
      }

      return html(res, 200, renderIssuesPage(await operatorIssues(req, url), url, req));
    }

    if (req.method === "GET" && url.pathname === "/api/leads") {
      if (!leadViewerConfigured()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const leads = filterRecordsForRequest(await readLeads(), req, url);
      return json(res, 200, { ok: true, leads: leads.map(publicLead) });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/leads/")) {
      if (!leadViewerConfigured()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const id = decodeURIComponent(url.pathname.replace("/api/leads/", ""));
      const lead = await findLeadById(id);
      if (!lead) return json(res, 404, { ok: false, error: "lead_not_found" });
      if (!canAccessRecord(lead, req, url)) return json(res, 404, { ok: false, error: "lead_not_found" });

      return json(res, 200, { ok: true, lead: publicLead(lead) });
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      if (!leadViewerConfigured()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const events = filterRecordsForRequest(await readEvents(), req, url);
      return json(res, 200, {
        ok: true,
        events: events
          .map(publicEvent)
          .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
          .slice(0, 100),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/issues") {
      if (!leadViewerConfigured()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      return json(res, 200, await operatorIssues(req, url));
    }

    if (req.method === "GET" && url.pathname === "/api/backup.json") {
      if (!leadViewerConfigured()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      return json(res, 200, await buildProtectedBackup(req, url));
    }

    if (req.method === "GET" && url.pathname === "/api/leads.csv") {
      if (!leadViewerConfigured()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const leads = filterRecordsForRequest(await readLeads(), req, url);
      return csv(res, "leads.csv", leadsCsv(leads));
    }

    if (req.method === "GET" && url.pathname === "/api/agent-context") {
      if (!leadViewerConfigured()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const profile = activeProfileForRequest(req, url);
      return json(res, 200, {
        ok: true,
        profile: publicBusinessProfile(profile),
        firstMessage: firstMessageForProfile(profile),
        prompt: buildVapiPrompt(profile),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/system-status") {
      if (!leadViewerConfigured()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      return json(res, 200, systemStatusSnapshot(req, url, {
        clientCount: await configuredClientCount(),
      }));
    }

    if (req.method === "GET" && url.pathname === "/api/clients") {
      const access = requestAccessContext(req, url);
      if (!access.ok || access.scope === "client") {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const clients = postgresEnabled()
        ? await listStoredClients()
        : configuredClientProfiles().map((client) => ({
            id: client.businessId,
            businessName: client.businessName,
            hasLeadViewerToken: Boolean(client.leadViewerToken),
            profile: publicBusinessProfile(client),
          }));
      const [leads, events] = await Promise.all([readLeads(), readEvents()]);
      return json(res, 200, {
        ok: true,
        storage: postgresEnabled() ? "postgres" : "env",
        clients: clientDashboardRows(clients, leads, events),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/clients") {
      const access = requestAccessContext(req, url);
      if (!access.ok || access.scope === "client") {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const body = await readJson(req);
      const saved = await saveStoredClient(body);
      if (!saved.ok) {
        return json(res, 503, saved);
      }

      const setup = onboardingSetupOutput(saved.profile, req, url);
      setup.leadViewerLink = `${requestBaseUrl(req, url)}/admin/leads?token=${encodeURIComponent(saved.leadViewerToken)}`;
      return json(res, 201, {
        ok: true,
        storage: "postgres",
        profile: saved.publicProfile,
        leadViewerToken: saved.leadViewerToken,
        firstMessage: firstMessageForProfile(saved.profile),
        prompt: buildVapiPrompt(saved.profile),
        envSnippet: profileEnvSnippet(saved.profile),
        businessProfileJson: businessProfileJson(saved.profile),
        setup,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/profile-preview") {
      if (!leadViewerConfigured()) {
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
        setup: onboardingSetupOutput(profile, req, url),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/availability") {
      if (!leadViewerConfigured()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const availability = await getAvailableSlots(Object.fromEntries(url.searchParams.entries()));
      return json(res, availability.ok === false ? 400 : 200, availability);
    }

    if (req.method === "POST" && url.pathname === "/api/availability") {
      if (!leadViewerConfigured()) {
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
      if (!leadViewerConfigured()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const body = await readJson(req);
      const lead = await findLeadById(body.id);
      if (!lead || !canAccessRecord(lead, req, url)) {
        return json(res, 404, { ok: false, error: "lead_not_found" });
      }
      const result = await updateLeadStatus(body);
      return json(res, result.ok ? 200 : 400, result);
    }

    if (req.method === "POST" && url.pathname === "/leads/notify-owner") {
      if (!leadViewerConfigured()) {
        return json(res, 503, { ok: false, error: "lead_viewer_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const body = await readJson(req);
      const lead = await findLeadById(body.id);
      if (!lead || !canAccessRecord(lead, req, url)) {
        return json(res, 404, { ok: false, error: "lead_not_found" });
      }
      const result = await notifyOwnerForLead(body.id);
      return json(res, result.ok ? 200 : 400, result);
    }

    if (req.method === "POST" && url.pathname === "/leads") {
      if (!leadViewerConfigured()) {
        return json(res, 503, { ok: false, error: "manual_leads_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const body = await readJson(req);
      const access = requestAccessContext(req, url);
      const processed = await processBooking({ ...body, businessId: access.businessId || body.businessId, source: "manual" });
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
      if (!leadViewerConfigured()) {
        return json(res, 503, { ok: false, error: "manual_bookings_disabled" });
      }

      if (!isLeadViewerAuthorized(req, url)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }

      const body = await readJson(req);
      const access = requestAccessContext(req, url);
      const processed = await processBooking({ ...body, businessId: access.businessId || body.businessId, status: "booked", source: "booking_api" });
      return json(res, 201, { ok: true, ...processed });
    }

    return json(res, 404, { ok: false, error: "not_found" });
  } catch (error) {
    console.error(error);
    return json(res, 500, { ok: false, error: "internal_server_error" });
  }
});

await ensureStore();
startOwnerAlertRetryWorker();

server.listen(port, () => {
  console.log(`Lost Lead Booking Agent listening on ${port}`);
});
