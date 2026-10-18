// Missed Call Agent: Vapi answers the missed call -> this Worker saves the lead -> owner gets a WhatsApp.

import { alertOwner, alertOperator, retryFailedAlerts, sendDailySummary } from "./messages.js";
import { upsertClient, setClientStatus, vapi } from "./vapi.js";
import { adminPage, connectionChecks } from "./admin.js";

const DAILY_CRON = "0 13 * * *";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/health") return json({ ok: true });
      if (url.pathname === "/vapi" && req.method === "POST") return await handleVapi(req, env, ctx);
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return await handleAdmin(req, env, url);
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ ok: false, error: String(err.message || err) }, 500);
    }
  },

  async scheduled(event, env) {
    if (event.cron === DAILY_CRON) await sendDailySummary(env);
    else await retryFailedAlerts(env);
  },
};

// ---------- Vapi webhook ----------

async function handleVapi(req, env, ctx) {
  if (!env.VAPI_SERVER_SECRET || !safeEqual(req.headers.get("x-vapi-secret") || "", env.VAPI_SERVER_SECRET)) {
    await logEvent(env, "vapi_rejected", "Webhook with a wrong or missing secret.");
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const body = await req.json();
  const msg = body.message || body;
  if (msg.type !== "end-of-call-report") return json({ ok: true, ignored: msg.type });

  const call = msg.call || {};
  const assistantId = call.assistantId || msg.assistant?.id || "";
  const phoneId = call.phoneNumberId || msg.phoneNumber?.id || "";
  const client = await env.DB.prepare(
    "SELECT * FROM clients WHERE (vapi_assistant_id = ? AND ? <> '') OR (vapi_phone_id = ? AND ? <> '') LIMIT 1",
  ).bind(assistantId, assistantId, phoneId, phoneId).first();

  if (!client) {
    await logEvent(env, "unknown_client", `Call ${call.id || "?"} from assistant ${assistantId || "?"} / number ${phoneId || "?"} matches no client.`);
    ctx.waitUntil(alertOperator(env, `⚠️ A call came in that matches no client (assistant ${assistantId || "?"}). Check the admin page.`));
    return json({ ok: true, routed: false });
  }
  if (client.status !== "active") {
    await logEvent(env, "paused_client_call", `${client.id} is ${client.status}; call not saved.`);
    return json({ ok: true, skipped: client.status });
  }

  const data = msg.analysis?.structuredData || {};
  const summary = msg.analysis?.summary || msg.summary || "";
  const transcript = msg.artifact?.transcript || msg.transcript || "";
  const caller = call.customer?.number || msg.customer?.number || "";
  if (!summary && !transcript && !caller) return json({ ok: true, skipped: "empty call" });

  const row = await env.DB.prepare(`
    INSERT INTO leads (client_id, call_id, caller_number, name, callback, service, address, urgency, best_time,
      summary, transcript, duration_s, ended_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(call_id) DO NOTHING RETURNING id`,
  ).bind(
    client.id, call.id || crypto.randomUUID(), caller,
    str(data.name), str(data.callback) || caller, str(data.service), str(data.address), str(data.urgency), str(data.best_time),
    summary || (transcript ? "" : "Caller hung up before giving details. Call them back."),
    transcript.slice(0, 20000), Math.round(Number(msg.durationSeconds) || 0) || null, msg.endedReason || null,
  ).first();

  if (!row) return json({ ok: true, duplicate: true });
  ctx.waitUntil(alertOwner(env, row.id));
  return json({ ok: true, leadId: row.id });
}

// ---------- Admin (your control room) ----------

async function handleAdmin(req, env, url) {
  if (!env.ADMIN_PASSWORD || !safeEqual(basicPassword(req), env.ADMIN_PASSWORD)) {
    return new Response("Login required", { status: 401, headers: { "www-authenticate": 'Basic realm="Missed Call Agent"' } });
  }
  const origin = req.headers.get("origin");
  if (req.method === "POST" && origin && origin !== url.origin) return new Response("Bad origin", { status: 403 });

  const isForm = (req.headers.get("content-type") || "").includes("form");
  const done = (result) => (isForm ? Response.redirect(`${url.origin}/admin?msg=${encodeURIComponent(result.notes?.join(" ") || "Done.")}`, 303) : json(result));
  const fail = (err) => (isForm ? Response.redirect(`${url.origin}/admin?err=${encodeURIComponent(err.message)}`, 303) : json({ ok: false, error: err.message }, 400));
  const input = async () => (isForm ? Object.fromEntries(await req.formData()) : req.json());

  const p = url.pathname;
  try {
    if (req.method === "GET" && p === "/admin") return html(await adminPage(env, url));
    if (req.method === "GET" && p === "/admin/status") return json(await statusJson(env));
    if (req.method === "GET" && p === "/admin/vapi-numbers") {
      const numbers = await vapi(env, "GET", "/phone-number");
      return json(numbers.map((n) => ({ id: n.id, number: n.number, assistantId: n.assistantId, name: n.name })));
    }
    if (req.method === "POST" && p === "/admin/clients")return done(await upsertClient(env, await input(), url.origin));

    let m = p.match(/^\/admin\/clients\/([a-z0-9-]+)\/(pause|resume)$/);
    if (req.method === "POST" && m) return done(await setClientStatus(env, m[1], m[2] === "pause" ? "paused" : "active"));

    m = p.match(/^\/admin\/leads\/(\d+)\/resend$/);
    if (req.method === "POST" && m) {
      await env.DB.prepare("UPDATE leads SET alert_attempts = 0 WHERE id = ?").bind(Number(m[1])).run();
      await alertOwner(env, Number(m[1]));
      return done({ ok: true, notes: [`Resent alert for lead ${m[1]}.`] });
    }
  } catch (err) {
    return fail(err);
  }
  return new Response("Not found", { status: 404 });
}

// Machine-readable status, so an operator agent (Claude, Codex) can check on things.
async function statusJson(env) {
  const clients = (await env.DB.prepare(`
    SELECT c.id, c.business_name, c.status, c.phone_number,
      (SELECT COUNT(*) FROM leads l WHERE l.client_id = c.id AND l.created_at > datetime('now', '-7 day')) AS leads_7d,
      (SELECT MAX(created_at) FROM leads l WHERE l.client_id = c.id) AS last_lead
    FROM clients c ORDER BY c.business_name`).all()).results;
  const failing = (await env.DB.prepare(
    "SELECT id, client_id, alert_status, alert_error, created_at FROM leads WHERE alert_status IN ('failed','gave_up') ORDER BY id DESC LIMIT 20",
  ).all()).results;
  const events = (await env.DB.prepare("SELECT kind, detail, created_at FROM events ORDER BY id DESC LIMIT 20").all()).results;
  return { ok: true, connections: await connectionChecks(env), clients, failing_alerts: failing, recent_events: events };
}

// ---------- helpers ----------

export async function logEvent(env, kind, detail) {
  await env.DB.prepare("INSERT INTO events (kind, detail) VALUES (?, ?)").bind(kind, detail).run().catch(console.error);
}

function basicPassword(req) {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return "";
  try {
    const decoded = atob(h.slice(6));
    return decoded.slice(decoded.indexOf(":") + 1);
  } catch {
    return "";
  }
}

function safeEqual(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

const str = (v) => (v == null ? "" : String(v).trim().slice(0, 500));
const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });
const html = (body) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
