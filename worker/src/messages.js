import { vapi } from "./vapi.js";
// Sending WhatsApp (and SMS backup) through Twilio.

const MAX_ATTEMPTS = 5;

export async function twilioSend(env, { to, body, channel, template }) {
  const from = channel === "whatsapp" ? env.TWILIO_WHATSAPP_FROM : env.TWILIO_SMS_FROM;
  const toAddr = channel === "whatsapp" && !to.startsWith("whatsapp:") ? `whatsapp:${to}` : to;

  if (env.SEND_LIVE !== "true") {
    console.log(`[test mode] ${channel} to ${toAddr}:\n${body}`);
    return { ok: true, mode: "test" };
  }
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !from) {
    return { ok: false, error: `twilio ${channel} not configured` };
  }

  const form = new URLSearchParams({ From: from, To: toAddr });
  if (template && channel === "whatsapp") {
    form.set("ContentSid", template.sid);
    form.set("ContentVariables", JSON.stringify(template.vars));
  } else {
    form.set("Body", body);
  }

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: `twilio ${res.status}: ${data.message || "send failed"}` };
  return { ok: true, mode: "live", sid: data.sid };
}

function isUrgent(lead) {
  return /emergenc|urgent|asap|right now|immediate/i.test(lead.urgency || "");
}

function addressBadge(lead) {
  if (lead.address_verified === "verified") return " ✅ verified";
  if (lead.address_verified === "not_found") return " ⚠️ not found on map: confirm with the caller";
  if (lead.address_verified === "street_only") return " (street found, house number not checked)";
  return lead.area_place ? ` (${lead.area_place})` : "";
}

function leadText(lead, client) {
  return [
    isUrgent(lead) ? `🚨 URGENT: call back now. Missed call for ${client.business_name}` : `📞 Missed call caught for ${client.business_name}`,
    `Name: ${lead.name || "not given"}`,
    `Call back: ${lead.callback || lead.caller_number || "not given"}`,
    /business|commercial|industrial/i.test(lead.property_type || "") ? `🏢 Commercial: ${lead.company || lead.property_type}` : "",
    `Job: ${lead.service || "not given"}`,
    lead.details ? `Details: ${lead.details}` : "",
    `Address: ${lead.address_matched || lead.address || "not given"}${addressBadge(lead)}`,
    lead.address_matched || lead.address ? `Map: https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lead.address_matched || lead.address)}` : "",
    lead.area_status === "outside" ? "⚠️ Outside your usual area. Your call whether to take it." : "",
    `Urgency: ${lead.urgency || "not given"}`,
    `Best time: ${lead.best_time || "not given"}`,
    lead.summary ? `\n${lead.summary}` : "",
  ].filter(Boolean).join("\n");
}

// Template variables must match the approved WhatsApp template (see RUN-GUIDE.md).
function leadTemplate(env, lead, client) {
  if (!env.WHATSAPP_TEMPLATE_SID) return null;
  const v = (x) => (x || "not given").slice(0, 200);
  return {
    sid: env.WHATSAPP_TEMPLATE_SID,
    vars: {
      1: v(client.business_name), 2: v(lead.name), 3: v(lead.callback || lead.caller_number),
      4: v(lead.service), 5: v(lead.address), 6: v(lead.urgency), 7: v(lead.best_time),
    },
  };
}

// Try WhatsApp first, then SMS. Records the result on the lead.
export async function alertOwner(env, leadId) {
  const lead = await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(leadId).first();
  if (!lead) return;
  const client = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(lead.client_id).first();
  if (!client) return;

  const body = leadText(lead, client);
  const errors = [];
  let result = null;
  let channel = null;

  if (client.owner_whatsapp) {
    result = await twilioSend(env, { to: client.owner_whatsapp, body, channel: "whatsapp", template: leadTemplate(env, lead, client) })
      .catch((e) => ({ ok: false, error: String(e) }));
    channel = "whatsapp";
    if (!result.ok) errors.push(`whatsapp: ${result.error}`);
  }
  if ((!result || !result.ok) && client.owner_sms) {
    result = await twilioSend(env, { to: client.owner_sms, body, channel: "sms" })
      .catch((e) => ({ ok: false, error: String(e) }));
    channel = "sms";
    if (!result.ok) errors.push(`sms: ${result.error}`);
  }

  const attempts = lead.alert_attempts + 1;
  let status = result?.ok ? (result.mode === "test" ? "test" : "sent") : "failed";
  if (!result) errors.push("owner has no WhatsApp or SMS number");
  if (status === "failed" && attempts >= MAX_ATTEMPTS) status = "gave_up";

  await env.DB.prepare(
    "UPDATE leads SET alert_status = ?, alert_channel = ?, alert_error = ?, alert_attempts = ? WHERE id = ?",
  ).bind(status, channel, errors.join(" | ") || null, attempts, leadId).run();

  if (status === "gave_up") {
    await alertOperator(env, `⚠️ Could not reach the owner of ${client.business_name} after ${attempts} tries.\n\n${body}\n\nErrors: ${errors.join(" | ")}`);
  }
}

export async function retryFailedAlerts(env) {
  const { results } = await env.DB.prepare(
    "SELECT id FROM leads WHERE alert_status = 'failed' AND alert_attempts < ? ORDER BY id LIMIT 25",
  ).bind(MAX_ATTEMPTS).all();
  for (const row of results) await alertOwner(env, row.id);
}

export async function alertOperator(env, body) {
  if (!env.OPERATOR_WHATSAPP) return console.log(`[operator] ${body}`);
  const r = await twilioSend(env, { to: env.OPERATOR_WHATSAPP, body, channel: "whatsapp" }).catch((e) => ({ ok: false, error: String(e) }));
  if (!r.ok) console.error("operator alert failed:", r.error);
}

export async function sendDailySummary(env) {
  const { results } = await env.DB.prepare(`
    SELECT c.business_name, c.status,
      (SELECT COUNT(*) FROM leads l WHERE l.client_id = c.id AND l.created_at > datetime('now', '-1 day')) AS calls,
      (SELECT COUNT(*) FROM leads l WHERE l.client_id = c.id AND l.created_at > datetime('now', '-1 day')
         AND l.alert_status IN ('failed', 'gave_up')) AS failed
    FROM clients c ORDER BY c.business_name`).all();
  if (!results.length) return;
  const lines = results.map((r) => `• ${r.business_name}${r.status !== "active" ? ` (${r.status})` : ""}: ${r.calls} calls${r.failed ? `, ${r.failed} alerts FAILED` : ""}`);
  const total = results.reduce((n, r) => n + r.calls, 0);
  const quiet = await quietClients(env);
  const quietText = quiet.length ? `\n\n🔕 No calls in 3 days (check their call forwarding): ${quiet.join(", ")}` : "";
  await alertOperator(env, `Daily report: ${total} missed calls caught in the last 24 h.\n\n${lines.join("\n")}${quietText}`);
}

// Watchdog: calls that reached Vapi but never made it to us, or ended in an error.
// Runs every 10 minutes. Each problem call is reported to you once.
export async function watchVapiCalls(env) {
  if (!env.VAPI_API_KEY) return;
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const calls = await vapi(env, "GET", `/call?limit=100&createdAtGt=${encodeURIComponent(since)}`).catch((e) => {
    console.error("watchdog:", e.message);
    return [];
  });
  const { results: clients } = await env.DB.prepare("SELECT id, business_name, vapi_assistant_id FROM clients").all();
  const byAssistant = Object.fromEntries(clients.map((c) => [c.vapi_assistant_id, c]));
  const problems = [];
  for (const c of calls) {
    if (!c.endedAt || Date.now() - Date.parse(c.endedAt) < 3 * 60 * 1000) continue; // give the report time to arrive
    const client = byAssistant[c.assistantId];
    if (!client) continue;
    const seen = await env.DB.prepare("SELECT 1 FROM events WHERE kind = 'watchdog' AND detail LIKE ?").bind(`%${c.id}%`).first();
    if (seen) continue;
    const lead = await env.DB.prepare("SELECT 1 FROM leads WHERE call_id = ?").bind(c.id).first();
    const errored = /error|fail|unavailable|insufficient|invalid/i.test(c.endedReason || "");
    if (!lead || errored) {
      const why = errored ? `ended with "${c.endedReason}"` : "never reached our server";
      problems.push(`• ${client.business_name}: call ${why}`);
      await env.DB.prepare("INSERT INTO events (kind, detail) VALUES ('watchdog', ?)").bind(`${client.id}: call ${c.id} ${why}`).run();
    }
  }
  if (problems.length) await alertOperator(env, `⚠️ Call problems found:\n${problems.join("\n")}\n\nOpen the admin page or Vapi logs.`);
}

// Clients whose phones went quiet: forwarding may be broken.
async function quietClients(env) {
  const { results } = await env.DB.prepare(`
    SELECT c.business_name FROM clients c
    WHERE c.status = 'active' AND c.created_at < datetime('now', '-3 day')
      AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.client_id = c.id AND l.created_at > datetime('now', '-3 day'))`).all();
  return results.map((r) => r.business_name);
}
