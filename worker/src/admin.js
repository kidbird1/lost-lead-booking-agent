// The admin page: connections, clients, recent calls, problems. One page, nothing else.

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function ping(url, headers) {
  try {
    const res = await fetch(url, { headers });
    return res.ok ? { ok: true } : { ok: false, note: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, note: String(e.message || e) };
  }
}

export async function connectionChecks(env) {
  const checks = [];
  const add = (name, ok, note = "") => checks.push({ name, ok, note });

  const db = await env.DB.prepare("SELECT COUNT(*) AS n FROM clients").first().catch((e) => ({ error: e.message }));
  add("Database (D1)", !db.error, db.error || `${db.n} clients`);

  if (env.VAPI_API_KEY) {
    const r = await ping("https://api.vapi.ai/assistant?limit=1", { authorization: `Bearer ${env.VAPI_API_KEY}` });
    add("Vapi API key", r.ok, r.note || "connected");
  } else add("Vapi API key", false, "not set");
  add("Vapi webhook secret", Boolean(env.VAPI_SERVER_SECRET), env.VAPI_SERVER_SECRET ? "set" : "not set: calls will be rejected");

  const last = await env.DB.prepare("SELECT MAX(created_at) AS t FROM leads").first().catch(() => ({}));
  add("Last call received", Boolean(last?.t), last?.t ? `${last.t} UTC` : "none yet");

  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
    const r = await ping(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}.json`, {
      authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
    });
    add("Twilio account", r.ok, r.note || "connected");
  } else add("Twilio account", false, "not set");
  add("WhatsApp sender", Boolean(env.TWILIO_WHATSAPP_FROM), env.TWILIO_WHATSAPP_FROM || "not set");
  add("WhatsApp template", Boolean(env.WHATSAPP_TEMPLATE_SID), env.WHATSAPP_TEMPLATE_SID ? "set" : "not set: fine for sandbox, needed for real clients");
  add("SMS backup number", Boolean(env.TWILIO_SMS_FROM), env.TWILIO_SMS_FROM || "not set");
  add("Your WhatsApp (operator)", Boolean(env.OPERATOR_WHATSAPP), env.OPERATOR_WHATSAPP ? "set" : "not set: no daily report");
  add("Live sending", env.SEND_LIVE === "true", env.SEND_LIVE === "true" ? "ON: messages really go out" : "OFF: test mode, messages only logged");
  return checks;
}

const badge = (status) => {
  const tone = { sent: "ok", active: "ok", inside: "ok", test: "info", pending: "warn", setup: "info", unknown: "info", skipped: "warn", outside: "warn", failed: "bad", gave_up: "bad", paused: "warn" }[status] || "info";
  return `<span class="badge ${tone}">${esc(status)}</span>`;
};

export async function adminPage(env, url) {
  const checks = await connectionChecks(env);
  const clients = (await env.DB.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM leads l WHERE l.client_id = c.id AND l.created_at > datetime('now','-7 day')) AS leads_7d
    FROM clients c ORDER BY c.business_name`).all()).results;
  const leads = (await env.DB.prepare("SELECT * FROM leads ORDER BY id DESC LIMIT 50").all()).results;
  const events = (await env.DB.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 15").all()).results;
  const names = Object.fromEntries(clients.map((c) => [c.id, c.business_name]));
  const msg = url.searchParams.get("msg");
  const err = url.searchParams.get("err");

  const checkRows = checks.map((c) => `<li class="${c.ok ? "ok" : "bad"}"><b>${c.ok ? "●" : "○"} ${esc(c.name)}</b><span>${esc(c.note)}</span></li>`).join("");

  const clientRows = clients.map((c) => `<tr>
    <td><b>${esc(c.business_name)}</b><br><small>${esc(c.id)}</small></td>
    <td>${badge(c.status)}</td>
    <td>${esc(c.phone_number || "—")}</td>
    <td>${esc(c.owner_whatsapp || "")}${c.owner_sms ? `<br><small>SMS ${esc(c.owner_sms)}</small>` : ""}</td>
    <td>${c.leads_7d}</td>
    <td>${c.status === "pending"
      ? `<form method="post" action="/admin/clients/${esc(c.id)}/approve"><input name="vapi_phone_id" placeholder="spare Vapi number id (optional)"><button>Approve</button></form>`
      : `<form method="post" action="/admin/clients/${esc(c.id)}/${c.status === "paused" ? "resume" : "pause"}"><button>${c.status === "paused" ? "Resume" : "Pause"}</button></form>`}</td>
  </tr>`).join("") || `<tr><td colspan="6" class="empty">No clients yet. Add one below.</td></tr>`;

  const leadRows = leads.map((l) => `<tr>
    <td><small>${esc(l.created_at)}</small></td>
    <td>${esc(names[l.client_id] || l.client_id)}</td>
    <td><b>${esc(l.name || "—")}</b><br><a href="tel:${esc(l.callback || l.caller_number)}">${esc(l.callback || l.caller_number || "")}</a></td>
    <td>${esc(l.service || "")}<br><small>${esc(l.urgency || "")} ${l.best_time ? "· " + esc(l.best_time) : ""}</small>${l.area_status ? `<br>${badge(l.area_status)} <small>${esc(l.area_place || "")}</small>` : ""}</td>
    <td>${badge(l.alert_status)} <small>${esc(l.alert_channel || "")}</small>${l.alert_error ? `<br><small class="err">${esc(l.alert_error)}</small>` : ""}</td>
    <td><details><summary>View</summary><p>${esc(l.summary)}</p><pre>${esc(l.transcript)}</pre></details>
      <form method="post" action="/admin/leads/${l.id}/resend"><button>Resend</button></form></td>
  </tr>`).join("") || `<tr><td colspan="6" class="empty">No calls yet.</td></tr>`;

  const eventRows = events.map((e) => `<li><small>${esc(e.created_at)}</small> <b>${esc(e.kind)}</b> ${esc(e.detail)}</li>`).join("") || "<li>Nothing unusual.</li>";

  const field = (name, label, hint = "", req = false) =>
    `<label>${label}${req ? " *" : ""}<input name="${name}" ${req ? "required" : ""} placeholder="${esc(hint)}"></label>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Missed Call Agent</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--muted:#667;--line:#e3e5ea;--ok:#127a3e;--bad:#b42318;--warn:#a15c00;--info:#3557c4}
@media (prefers-color-scheme:dark){:root{--bg:#111316;--card:#1a1d22;--ink:#e8eaee;--muted:#9aa0aa;--line:#2b2f36;--ok:#4cc27a;--bad:#ff6b5e;--warn:#f0a43a;--info:#7d9bff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:20px 16px 60px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 12px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-top:16px;overflow-x:auto}
.checks{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:8px}
.checks li{display:flex;flex-direction:column;padding:8px 10px;border:1px solid var(--line);border-radius:8px}.checks li span{color:var(--muted);font-size:13px}
.checks li.ok b{color:var(--ok)}.checks li.bad b{color:var(--bad)}
table{width:100%;border-collapse:collapse;min-width:640px}td,th{text-align:left;padding:8px 6px;border-top:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted);text-transform:uppercase}
small{color:var(--muted)}.err{color:var(--bad)}.empty{color:var(--muted);text-align:center;padding:20px}
.badge{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid currentColor}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.info{color:var(--info)}
.banner{padding:10px 14px;border-radius:8px;margin-top:12px;border:1px solid}.banner.good{color:var(--ok)}.banner.bad{color:var(--bad)}
button{font:inherit;padding:4px 12px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--ink);cursor:pointer}
form.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}label{display:flex;flex-direction:column;font-size:13px;color:var(--muted)}
input{font:inherit;margin-top:3px;padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink)}
pre{white-space:pre-wrap;font-size:12px;max-height:260px;overflow:auto}ul.events{margin:0;padding-left:18px}
</style></head><body><main>
<h1>Missed Call Agent</h1><small>Vapi answers → this Worker saves it → owner gets WhatsApp.</small>
${msg ? `<div class="banner good">${esc(msg)}</div>` : ""}${err ? `<div class="banner bad">${esc(err)}</div>` : ""}
<section><h2>Connections</h2><ul class="checks">${checkRows}</ul></section>
<section><h2>Clients</h2><table><tr><th>Business</th><th>Status</th><th>Agent number</th><th>Owner</th><th>Calls 7d</th><th></th></tr>${clientRows}</table></section>
<section><h2>Recent calls</h2><table><tr><th>When (UTC)</th><th>Client</th><th>Caller</th><th>Job</th><th>Owner alert</th><th></th></tr>${leadRows}</table></section>
<section><h2>Add or update a client</h2>
<form class="grid" method="post" action="/admin/clients">
${field("id", "Short id", "acme-roofing", true)}${field("business_name", "Business name", "Acme Roofing", true)}
${field("owner_whatsapp", "Owner WhatsApp", "+15615551234")}${field("owner_sms", "Owner SMS backup", "+15615551234")}
${field("industry", "Trade", "plumber, hvac, electrician, locksmith, mechanic, solar, roofer, cleaner, pest")}${field("services", "Services", "leaks, repairs, new roofs")}
${field("service_areas", "Service area", "Boca Raton, Delray Beach")}${field("hours", "Hours", "Mon-Sat 8am-6pm")}
${field("home_base", "Home base (center of service area)", "Boca Raton, FL 33487")}${field("radius", "Radius", "30")}
${field("country", "Country code", "US")}${field("timezone", "Time zone", "America/New_York")}
${field("assistant_name", "Agent name", "Riley")}${field("area_code", "Phone area code", "561")}
${field("notes", "Notes for the agent", "We do free inspections")}${field("vapi_assistant_id", "Existing Vapi assistant id (optional)", "")}
<label>&nbsp;<button>Save client</button></label></form>
<p><small>Saving again with the same id updates the agent. It does not make a second phone number.</small></p></section>
<section><h2>Problems log</h2><ul class="events">${eventRows}</ul></section>
</main></body></html>`;
}
