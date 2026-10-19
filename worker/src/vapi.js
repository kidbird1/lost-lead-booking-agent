// Everything that talks to Vapi: building the receptionist and setting up clients.

import { tradeFor } from "./trades.js";
import { geocode } from "./geo.js";

const LEAD_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Caller's name" },
    callback: { type: "string", description: "Best phone number to call them back, as digits. Empty if they said the number they are calling from is fine." },
    service: { type: "string", description: "What they need done, in a few words" },
    address: { type: "string", description: "Job address, or where the caller is right now for mobile jobs" },
    urgency: { type: "string", description: "emergency, soon, or flexible" },
    best_time: { type: "string", description: "When they want a call back or visit, in their words" },
    details: { type: "string", description: "Answers to the trade questions (car model, pest type, bill size, etc.) in one short line" },
    property_type: { type: "string", description: "home, business, or industrial" },
    company: { type: "string", description: "Business or property name if it is not a home (hotel, restaurant, office, warehouse, etc.)" },
  },
};

export const AREA_TOOL = "checkServiceArea";

export function buildPrompt(client, profile) {
  const name = profile.assistantName || "Riley";
  const trade = tradeFor(profile.industry);
  const tz = profile.timezone || "America/New_York";
  const where = trade.mobile
    ? "Where they are right now (an address, cross streets or a landmark)."
    : "The job address.";
  return [
    `You are ${name}, the front desk for ${client.business_name}, a ${trade.label} business.`,
    "The team is busy on a job, so you answer for them. Sound calm, warm and human. Short sentences. One question at a time. Never read out lists.",
    `Right now it is {{"now" | date: "%A %B %-d, %-I:%M %p", "${tz}"}} where the business is.`,
    profile.services ? `Services: ${profile.services}.` : "",
    profile.serviceAreas ? `They serve: ${profile.serviceAreas}.` : "",
    profile.hours ? `Hours: ${profile.hours}. You answer at any hour; the team follows up.` : "",
    profile.notes ? `Owner notes: ${profile.notes}` : "",
    "",
    "Steps:",
    "1. Ask their name.",
    `2. Ask: ${where}`,
    `3. As soon as they say any part of a location (street, town or ZIP), say "One moment" and call ${AREA_TOOL} with exactly what they said. Do NOT ask for the town, ZIP, county or state first; the check works those out. Only ask a follow-up if the check tells you to. Never turn anyone away; the team decides.`,
    "4. Ask if it is a home or a business. If it is a business or industrial site (hotel, restaurant, office, store, warehouse, factory, rental property), get the business name and their role (owner, manager, maintenance), and if someone will be on site to let the team in.",
    "5. Find out what they need. Ask only what applies:",
    ...trade.ask.map((q) => `   - ${q}`),
    "6. Ask if the number they are calling from is the best one to reach them. If not, take the better number and repeat it back.",
    "7. Ask how soon they need help, and the best time for the team to call back or come out.",
    "8. Read back a one-line summary. Then say: \"Got it. The team will call you back shortly to confirm.\"",
    `9. Say "Thanks for calling ${client.business_name}. Have a great day." Then end the call right away. Do not wait for a reply.`,
    "",
    `EMERGENCY means: ${trade.urgentIf}. In an emergency, keep it fast: name, location, number, what is happening. Tell them the team will call them right back.`,
    "",
    "Rules:",
    "- If anyone is in danger (gas smell, fire, smoke, sparks, flooding near power, stuck somewhere unsafe), tell them to get safe and call 911 or their local emergency number first.",
    "- Never quote prices. The team goes over pricing when they call back.",
    "- Never promise an exact time. The team confirms.",
    "- If they ask whether you are a person, say you are the virtual assistant for the team.",
    "- If they only want to leave a message, take it with their name and number.",
    "- Never make up information about the business.",
    "- Never ask for something the caller already told you. If they give several details at once, take them all and skip those questions.",
  ].filter((l) => l !== "").join("\n");
}

export function buildAssistant(env, client, profile, origin) {
  const server = { url: `${origin}/vapi`, secret: env.VAPI_SERVER_SECRET };
  const assistant = {
    name: `${client.business_name} desk`.slice(0, 40),
    firstMessage: profile.greeting || `Thanks for calling ${client.business_name}, this is ${profile.assistantName || "Riley"}. How can I help you today?`,
    model: {
      provider: "openai",
      model: env.VAPI_MODEL || "gpt-4o-mini",
      temperature: 0.3,
      messages: [{ role: "system", content: buildPrompt(client, profile) }],
      tools: [{
        type: "function",
        function: {
          name: AREA_TOOL,
          description: "Checks if the caller's location is inside the area this business serves. Call it once you know where the job is.",
          parameters: {
            type: "object",
            properties: { location: { type: "string", description: "Exactly what the caller said about the location: a street address, a town, or a ZIP/postcode. Any of these alone is fine. Write numbers as digits." } },
            required: ["location"],
          },
        },
        server,
      }],
    },
    endCallFunctionEnabled: true,
    maxDurationSeconds: 600,
    silenceTimeoutSeconds: 15,
    endCallPhrases: ["have a great day"], // hang up as soon as the goodbye is said
    serverMessages: ["end-of-call-report", "tool-calls"],
    server,
    analysisPlan: {
      summaryPlan: { enabled: true },
      structuredDataPlan: { enabled: true, schema: LEAD_SCHEMA },
    },
    metadata: { clientId: client.id },
  };
  if (env.VAPI_VOICE) assistant.voice = { provider: "vapi", voiceId: env.VAPI_VOICE };
  return assistant;
}

export async function vapi(env, method, path, body) {
  const res = await fetch(`https://api.vapi.ai${path}`, {
    method,
    headers: { authorization: `Bearer ${env.VAPI_API_KEY}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = Array.isArray(data.message) ? data.message.join("; ") : data.message || res.statusText;
    throw new Error(`Vapi ${method} ${path} failed (${res.status}): ${msg}`);
  }
  return data;
}

// Create or update a client. Safe to run again: it updates the agent instead of making a new one.
export async function upsertClient(env, input, origin) {
  const id = String(input.id || "").trim().toLowerCase();
  if (!/^[a-z0-9-]{2,40}$/.test(id)) throw new Error("id must be 2-40 letters, numbers or dashes, like acme-roofing");
  if (!input.business_name) throw new Error("business_name is required");

  // Blank fields keep their old value, so an update only needs what changed.
  const existing = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first();
  const old = existing ? JSON.parse(existing.profile || "{}") : {};
  const pick = (key, field) => String(input[key] || "").trim() || old[field] || "";
  const profile = {
    assistantName: pick("assistant_name", "assistantName"), greeting: pick("greeting", "greeting"),
    industry: pick("industry", "industry"), services: pick("services", "services"),
    serviceAreas: pick("service_areas", "serviceAreas"), hours: pick("hours", "hours"), notes: pick("notes", "notes"),
    country: (pick("country", "country") || "US").toUpperCase(),
    timezone: pick("timezone", "timezone") || "America/New_York",
    homeBase: pick("home_base", "homeBase"),
    radius: Number(input.radius || old.radius || 30),
    base: old.base || null,
  };
  profile.units = String(input.units || old.units || (["US", "GB", "LR", "MM"].includes(profile.country) ? "mi" : "km"));
  if (profile.homeBase && (!profile.base || profile.homeBase !== old.homeBase)) {
    const hit = await geocode(profile.homeBase, profile.country);
    if (!hit) throw new Error(`Could not find home_base "${profile.homeBase}" on the map. Try "town, state ZIP".`);
    profile.base = { lat: hit.lat, lng: hit.lng, place: hit.place };
  }
  const client = {
    id, business_name: input.business_name,
    owner_whatsapp: input.owner_whatsapp || existing?.owner_whatsapp || null,
    owner_sms: input.owner_sms || existing?.owner_sms || null,
    vapi_assistant_id: input.vapi_assistant_id || existing?.vapi_assistant_id || null,
    vapi_phone_id: input.vapi_phone_id || existing?.vapi_phone_id || null,
    phone_number: input.phone_number || existing?.phone_number || null,
  };
  if (!client.owner_whatsapp && !client.owner_sms) throw new Error("owner_whatsapp or owner_sms is required");

  await env.DB.prepare(`
    INSERT INTO clients (id, business_name, owner_whatsapp, owner_sms, profile, vapi_assistant_id, vapi_phone_id, phone_number, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'setup')
    ON CONFLICT(id) DO UPDATE SET business_name = excluded.business_name, owner_whatsapp = excluded.owner_whatsapp,
      owner_sms = excluded.owner_sms, profile = excluded.profile`,
  ).bind(id, client.business_name, client.owner_whatsapp, client.owner_sms, JSON.stringify(profile),
    client.vapi_assistant_id, client.vapi_phone_id, client.phone_number).run();

  const notes = [];
  if (!env.VAPI_API_KEY) {
    notes.push("No VAPI_API_KEY set, so no Vapi agent or number was made (local test mode).");
  } else {
    const assistant = buildAssistant(env, client, profile, origin);
    if (!client.vapi_assistant_id) {
      // A half-finished earlier run may already have made this client's agent. Reuse it.
      const found = (await vapi(env, "GET", "/assistant?limit=100")).find((a) => a.metadata?.clientId === id);
      if (found) client.vapi_assistant_id = found.id;
    }
    if (client.vapi_assistant_id) {
      await vapi(env, "PATCH", `/assistant/${client.vapi_assistant_id}`, assistant);
      notes.push("Updated the Vapi agent.");
    } else {
      client.vapi_assistant_id = (await vapi(env, "POST", "/assistant", assistant)).id;
      notes.push("Created the Vapi agent.");
    }

    if (client.vapi_phone_id && client.vapi_phone_id !== existing?.vapi_phone_id) {
      // Reusing a number you already own in Vapi: point it at this agent.
      const phone = await vapi(env, "PATCH", `/phone-number/${client.vapi_phone_id}`, { assistantId: client.vapi_assistant_id, server: null });
      client.phone_number = phone.number || client.phone_number;
      notes.push(`Pointed your existing number ${client.phone_number || ""} at this agent.`);
    } else if (!client.vapi_phone_id && !input.no_phone) {
      const phoneReq = input.twilio_number
        ? { provider: "twilio", number: input.twilio_number, twilioAccountSid: env.TWILIO_ACCOUNT_SID, twilioAuthToken: env.TWILIO_AUTH_TOKEN }
        : { provider: "vapi", numberDesiredAreaCode: String(input.area_code || "") || undefined };
      const phone = await vapi(env, "POST", "/phone-number", { ...phoneReq, assistantId: client.vapi_assistant_id, name: id });
      client.vapi_phone_id = phone.id;
      client.phone_number = phone.number || phone.sipUri || input.twilio_number || null;
      notes.push(`Got phone number ${client.phone_number || "(Vapi is still assigning it; check the Vapi dashboard)"}.`);
    }
  }

  await env.DB.prepare(
    "UPDATE clients SET vapi_assistant_id = ?, vapi_phone_id = ?, phone_number = ?, status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'active' END WHERE id = ?",
  ).bind(client.vapi_assistant_id, client.vapi_phone_id, client.phone_number, id).run();

  return { ok: true, id, phone_number: client.phone_number, vapi_assistant_id: client.vapi_assistant_id, notes };
}

// Pause = the number stops answering (no Vapi minutes). Resume = it answers again.
export async function setClientStatus(env, id, status) {
  const client = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first();
  if (!client) throw new Error(`no client called ${id}`);
  if (env.VAPI_API_KEY && client.vapi_phone_id) {
    await vapi(env, "PATCH", `/phone-number/${client.vapi_phone_id}`, {
      assistantId: status === "active" ? client.vapi_assistant_id : null,
    });
  }
  await env.DB.prepare("UPDATE clients SET status = ? WHERE id = ?").bind(status, id).run();
  return { ok: true, id, status };
}
