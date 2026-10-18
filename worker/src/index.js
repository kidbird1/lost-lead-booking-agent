// Missed Call Agent: Vapi answers the missed call -> this Worker saves the lead -> owner gets a WhatsApp.

import { alertOwner, alertOperator, retryFailedAlerts, sendDailySummary, watchVapiCalls } from "./messages.js";
import { upsertClient, setClientStatus, vapi, AREA_TOOL } from "./vapi.js";
import { checkArea } from "./geo.js";
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
    if (event.cron === DAILY_CRON) return sendDailySummary(env);
    await retryFailedAlerts(env);
    await watchVapiCalls(env);
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
  if (msg.type === "tool-calls") return json(await handleToolCalls(env, msg));
  if (msg.type !== "end-of-call-report") return json({ ok: true, ignored: msg.type });

  const call = msg.call || {};
  const client = await findClient(env, msg);
  if (!client) {
    const who = `assistant ${call.assistantId || msg.assistant?.id || "?"} / number ${call.phoneNumberId || "?"}`;
    await logEvent(env, "unknown_client", `Call ${call.id || "?"} from ${who} matches no client.`);
    ctx.waitUntil(alertOperator(env, `⚠️ A call came in that matches no client (${who}). Check the admin page.`));
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

  const callId = call.id || crypto.randomUUID();
  const area = await env.DB.prepare("SELECT * FROM area_checks WHERE call_id = ? ORDER BY id DESC LIMIT 1").bind(callId).first();

  const row = await env.DB.prepare(`
    INSERT INTO leads (client_id, call_id, caller_number, name, callback, service, address, urgency, best_time, details,
      area_status, area_place, summary, transcript, duration_s, ended_reason, alert_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(call_id) DO NOTHING RETURNING id`,
  ).bind(
    client.id, callId, caller,
    str(data.name), hasPhone(data.callback) ? str(data.callback) : caller, str(data.service), str(data.address),
    str(data.urgency), str(data.best_time), str(data.details),
    area?.status || null, area?.place || null,
    summary || (transcript ? "" : "Caller hung up before giving details. Call them back."),
    transcript.slice(0, 20000), Math.round(Number(msg.durationSeconds) || 0) || null, msg.endedReason || null,
    "pending",
  ).first();

  if (!row) return json({ ok: true, duplicate: true });
  ctx.waitUntil(alertOwner(env, row.id));
  return json({ ok: true, leadId: row.id });
}

// The agent asks us things mid-call (right now: "is this caller in our area?").
async function handleToolCalls(env, msg) {
  const client = await findClient(env, msg);
  const profile = JSON.parse(client?.profile || "{}");
  const callId = msg.call?.id || msg.chat?.id || msg.session?.id || "";
  const list = msg.toolCallList || (msg.toolWithToolCallList || []).map((t) => t.toolCall) || [];
  const results = [];
  for (const tc of list) {
    const name = tc.function?.name || tc.name;
    let args = tc.function?.arguments ?? tc.arguments ?? tc.parameters ?? {};
    if (typeof args === "string") args = JSON.parse(args || "{}");
    if (name !== AREA_TOOL) {
      results.push({ toolCallId: tc.id, result: "Unknown tool. Continue the call." });
      continue;
    }
    const check = client ? await checkArea(profile, String(args.location || "")) : { status: "unknown", text: "Continue and take their details." };
    await env.DB.prepare("INSERT INTO area_checks (call_id, client_id, location, status, place, km) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(callId, client?.id || null, str(args.location), check.status, check.place || null, check.km ?? null).run();
    results.push({ toolCallId: tc.id, result: check.text });
  }
  return { results };
}

async function findClient(env, msg) {
  const clientId = msg.assistant?.metadata?.clientId || msg.call?.assistant?.metadata?.clientId || msg.call?.metadata?.clientId;
  if (clientId) {
    const c = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(clientId).first();
    if (c) return c;
  }
  const assistantId = msg.call?.assistantId || msg.assistant?.id || msg.chat?.assistantId || "";
  const phoneId = msg.call?.phoneNumberId || msg.phoneNumber?.id || "";
  return env.DB.prepare(
    "SELECT * FROM clients WHERE (vapi_assistant_id = ? AND ? <> '') OR (vapi_phone_id = ? AND ? <> '') LIMIT 1",
  ).bind(assistantId, assistantId, phoneId, phoneId).first();
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
      return json(numbers.map((n) => ({ id: n.id, number: n.number, assistantId: n.assistantId, name: n.name, provider: n.provider, status: n.status, createdAt: n.createdAt, updatedAt: n.updatedAt, serverUrl: n.server?.url })));
    }
    if (req.method === "GET" && p === "/admin/vapi-calls") {
      // Last few calls as Vapi sees them, plus where each agent sends its reports.
      const calls = await vapi(env, "GET", "/call?limit=5");
      const out = [];
      for (const c of calls) {
        const a = c.assistantId ? await vapi(env, "GET", `/assistant/${c.assistantId}`).catch((e) => ({ error: e.message })) : {};
        out.push({
          id: c.id, startedAt: c.startedAt, endedReason: c.endedReason, status: c.status,
          assistantId: c.assistantId, phoneNumberId: c.phoneNumberId,
          agentName: a.name, agentServerUrl: a.server?.url, agentServerMessages: a.serverMessages,
        });
      }
      return json(out);
    }
    if (req.method === "GET" && p === "/admin/vapi-get") {
      // Read-only look at one Vapi record, for debugging: ?path=/assistant/<id> or /call/<id>
      const path = url.searchParams.get("path") || "";
      if (!/^\/(assistant|call|phone-number)(\/[\w-]+)?(\?.*)?$/.test(path)) throw new Error("path must be /assistant, /call or /phone-number");
      return json(await vapi(env, "GET", path));
    }
    if (req.method === "POST" && p === "/admin/test-chat") {
      // Runs a pretend caller through a client's real agent by text. Body: { client_id, turns: ["hi", ...] }
      const { client_id, turns = [] } = await req.json();
      const c = await env.DB.prepare("SELECT vapi_assistant_id FROM clients WHERE id = ?").bind(client_id).first();
      if (!c?.vapi_assistant_id) throw new Error(`no agent for ${client_id}`);
      const log = [];
      let previousChatId;
      for (const turn of turns) {
        const r = await vapi(env, "POST", "/chat", { assistantId: c.vapi_assistant_id, input: turn, ...(previousChatId ? { previousChatId } : {}) });
        previousChatId = r.id;
        log.push({ caller: turn, agent: (r.output || []).filter((o) => o.role === "assistant" && o.content).map((o) => o.content).join(" ") });
      }
      const checks = previousChatId
        ? (await env.DB.prepare("SELECT location, status, place, km FROM area_checks WHERE call_id = ? ORDER BY id").bind(previousChatId).all()).results
        : [];
      return json({ ok: true, chatId: previousChatId, log, area_checks: checks });
    }
    if (req.method === "POST" && p === "/admin/clients") return done(await upsertClient(env, await input(), url.origin));

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

const hasPhone = (v) => /\d{7,}/.test(String(v || "").replace(/\D/g, ""));
const str = (v) => (v == null ? "" : String(v).trim().slice(0, 500));
const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });
const html = (body) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
