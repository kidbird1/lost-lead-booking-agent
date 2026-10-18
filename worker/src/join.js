// Public sign-up page. A business fills it in; it waits as "pending" until you approve it.
// Each location is its own client: "Stanley Steamer of Northern Virginia" and "Stanley Steamer of Austin"
// each get their own name, greeting, service area and phone number.

import { TRADES } from "./trades.js";
import { geocode } from "./geo.js";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const COUNTRIES = [["US", "United States"], ["CA", "Canada"], ["GB", "United Kingdom"], ["AU", "Australia"], ["NZ", "New Zealand"], ["IE", "Ireland"], ["ZA", "South Africa"]];

function page(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Business Setup</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--muted:#5d6470;--line:#dfe2e8;--accent:#1f6f4a;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#111316;--card:#1a1d22;--ink:#e8eaee;--muted:#9aa0aa;--line:#2b2f36;--accent:#4cc27a;--bad:#ff6b5e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:640px;margin:0 auto;padding:28px 16px 60px}h1{font-size:24px;margin:0 0 6px}p.lead{color:var(--muted);margin:0 0 20px}
form{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;display:grid;gap:14px}
label{display:grid;gap:4px;font-weight:600;font-size:14px}label small{font-weight:400;color:var(--muted)}
input,select,textarea{font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);width:100%}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media (max-width:520px){.row{grid-template-columns:1fr}}
button{font:inherit;font-weight:600;padding:12px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
.hp{position:absolute;left:-5000px}.err{color:var(--bad);font-weight:600}.done{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}
</style></head><body><main>${body}</main></body></html>`;
}

export function joinPage(error = "", values = {}) {
  const v = (k) => esc(values[k] || "");
  const trades = Object.entries(TRADES).map(([k, t]) => `<option value="${k}" ${values.industry === k ? "selected" : ""}>${esc(t.label[0].toUpperCase() + t.label.slice(1))}</option>`).join("");
  const countries = COUNTRIES.map(([c, n]) => `<option value="${c}" ${(values.country || "US") === c ? "selected" : ""}>${n}</option>`).join("");
  return page(`
<h1>Set up your missed-call line</h1>
<p class="lead">Takes 2 minutes. When you miss a call, our receptionist answers in your business name and sends you the job on WhatsApp.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/join">
  <label>Business name, exactly as callers should hear it <small>Example: Stanley Steamer of Northern Virginia</small>
    <input name="business_name" required maxlength="80" value="${v("business_name")}"></label>
  <div class="row">
    <label>Your name<input name="contact_name" required maxlength="60" value="${v("contact_name")}"></label>
    <label>Email <small>(optional)</small><input name="contact_email" type="email" maxlength="80" value="${v("contact_email")}"></label>
  </div>
  <label>WhatsApp number where you want new jobs <small>With country code, like +15615551234</small>
    <input name="owner_whatsapp" required pattern="\\+?[0-9 ()-]{8,20}" value="${v("owner_whatsapp")}"></label>
  <div class="row">
    <label>Trade<select name="industry">${trades}</select></label>
    <label>Country<select name="country">${countries}</select></label>
  </div>
  <div class="row">
    <label>Main location <small>Town and ZIP/postcode</small><input name="home_base" required maxlength="80" placeholder="Fairfax, VA 22030" value="${v("home_base")}"></label>
    <label>How far you travel <small>miles (km outside US/UK)</small><input name="radius" type="number" min="1" max="500" value="${v("radius") || 30}"></label>
  </div>
  <label>Services you offer<input name="services" maxlength="200" placeholder="carpet cleaning, upholstery, tile and grout" value="${v("services")}"></label>
  <label>Hours<input name="hours" maxlength="80" placeholder="Mon-Sat 8am-6pm" value="${v("hours")}"></label>
  <label>Anything the receptionist should know? <small>Free estimates, commercial work, insurance, areas you skip...</small>
    <textarea name="notes" rows="3" maxlength="500">${v("notes")}</textarea></label>
  <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
  <input type="hidden" name="timezone" id="tz">
  <button>Set up my line</button>
</form>
<script>try{document.getElementById("tz").value=Intl.DateTimeFormat().resolvedOptions().timeZone}catch(e){}</script>`);
}

export function thanksPage(name) {
  return page(`<div class="done"><h1>You're in, ${esc(name)}.</h1>
<p>We're setting up your line now. You'll get a WhatsApp with your new number and a 1-minute guide to forward missed calls to it.</p></div>`);
}

// Saves the sign-up as a pending client. Returns { ok, id } or { ok: false, error }.
export async function saveSignup(env, f) {
  if (f.website) return { ok: true, id: "ignored" }; // bot filled the hidden field
  const pendingToday = await env.DB.prepare("SELECT COUNT(*) AS n FROM clients WHERE status = 'pending' AND created_at > datetime('now','-1 day')").first();
  if (pendingToday.n >= 25) return { ok: false, error: "Too many sign-ups today. Please try again tomorrow." };

  const name = String(f.business_name || "").trim();
  const whatsapp = String(f.owner_whatsapp || "").replace(/[^\d+]/g, "");
  if (!name || !f.contact_name || whatsapp.replace(/\D/g, "").length < 8) return { ok: false, error: "Please fill in the business name, your name and a WhatsApp number." };
  const country = String(f.country || "US").toUpperCase().slice(0, 2);
  const owner = whatsapp.startsWith("+") ? whatsapp : (country === "US" || country === "CA") && whatsapp.length === 10 ? `+1${whatsapp}` : `+${whatsapp}`;

  const base = await geocode(String(f.home_base || ""), country).catch(() => null);
  if (!base) return { ok: false, error: "We couldn't find your main location on the map. Try town plus ZIP or postcode." };

  // Short id from whole words, like "steamy-carpets-of-northern" (max 34 chars, room for a suffix).
  let id = "";
  for (const w of name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    if ((id ? id.length + 1 : 0) + w.length > 34) break;
    id = id ? `${id}-${w}` : w;
  }
  id = id || "client";
  if (await env.DB.prepare("SELECT 1 FROM clients WHERE id = ?").bind(id).first()) id = `${id}-${crypto.randomUUID().slice(0, 4)}`;

  const profile = {
    industry: String(f.industry || "general"), services: String(f.services || "").slice(0, 200),
    hours: String(f.hours || "").slice(0, 80), notes: String(f.notes || "").slice(0, 500),
    country, timezone: String(f.timezone || "America/New_York").slice(0, 60),
    homeBase: String(f.home_base).slice(0, 80), base: { lat: base.lat, lng: base.lng, place: base.place },
    radius: Math.min(Math.max(Number(f.radius) || 30, 1), 500),
    units: ["US", "GB"].includes(country) ? "mi" : "km",
    contact: { name: String(f.contact_name).slice(0, 60), email: String(f.contact_email || "").slice(0, 80) },
  };
  await env.DB.prepare("INSERT INTO clients (id, business_name, owner_whatsapp, profile, status) VALUES (?, ?, ?, ?, 'pending')")
    .bind(id, name, owner, JSON.stringify(profile)).run();
  return { ok: true, id, name, place: base.place };
}
