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

function leadText(lead, client) {
  return [
    `📞 Missed call caught for ${client.business_name}`,
    `Name: ${lead.name || "not given"}`,
    `Call back: ${lead.callback || lead.caller_number || "not given"}`,
    `Job: ${lead.service || "not given"}`,
    `Address: ${lead.address || "not given"}`,
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
  await alertOperator(env, `Daily report: ${total} missed calls caught in the last 24 h.\n\n${lines.join("\n")}`);
}
