// Everything that talks to Vapi: building the receptionist and setting up clients.

const LEAD_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Caller's name" },
    callback: { type: "string", description: "Best phone number to call them back" },
    service: { type: "string", description: "What they need done, in a few words" },
    address: { type: "string", description: "Job address or area" },
    urgency: { type: "string", description: "emergency, this week, or no rush" },
    best_time: { type: "string", description: "When they want a call back or visit, in their words" },
  },
};

export function buildPrompt(client, profile) {
  const name = profile.assistantName || "Riley";
  return [
    `You are ${name}, the front desk for ${client.business_name}${profile.industry ? `, a ${profile.industry} company` : ""}.`,
    "The team is busy on a job, so you answer for them. Sound calm, warm and human. Short sentences. One question at a time.",
    profile.services ? `Services: ${profile.services}.` : "",
    profile.serviceAreas ? `Service area: ${profile.serviceAreas}. If they are outside it, still take their details.` : "",
    profile.hours ? `Hours: ${profile.hours}.` : "",
    profile.notes ? `Owner notes: ${profile.notes}` : "",
    "",
    "Get these, in a natural order:",
    "1. Their name.",
    "2. The best number to call them back. Ask if the number they are calling from is fine.",
    "3. What they need done.",
    "4. The job address or area.",
    "5. How urgent it is.",
    "6. The best time for the team to call back or come out.",
    "",
    "Then read back a one-line summary and say: \"Got it. The team will call you back shortly to confirm.\"",
    `Then say "Thanks for calling ${client.business_name}. Have a great day." and end the call.`,
    "",
    "Rules:",
    "- Never quote prices. Say the team will go over pricing when they call back.",
    "- Never promise an exact appointment time. The team confirms.",
    "- If someone is in danger (gas smell, fire, sparks, flooding near power), tell them to get safe and call 911 first, then take their details and mark it an emergency.",
    "- If they ask if you are a person, say you are the virtual assistant for the team.",
    "- If they only want to leave a message, take it with their name and number.",
  ].filter((l) => l !== "").join("\n");
}

export function buildAssistant(env, client, profile, origin) {
  const assistant = {
    name: `${client.business_name} desk`.slice(0, 40),
    firstMessage: profile.greeting || `Thanks for calling ${client.business_name}, this is ${profile.assistantName || "Riley"}. How can I help you today?`,
    model: {
      provider: "openai",
      model: env.VAPI_MODEL || "gpt-4o-mini",
      temperature: 0.4,
      messages: [{ role: "system", content: buildPrompt(client, profile) }],
    },
    endCallFunctionEnabled: true,
    maxDurationSeconds: 600,
    silenceTimeoutSeconds: 30,
    serverMessages: ["end-of-call-report"],
    server: { url: `${origin}/vapi`, secret: env.VAPI_SERVER_SECRET },
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
  if (!input.owner_whatsapp && !input.owner_sms) throw new Error("owner_whatsapp or owner_sms is required");

  // Blank fields keep their old value, so an update only needs what changed.
  const existing = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first();
  const old = existing ? JSON.parse(existing.profile || "{}") : {};
  const pick = (key, field) => String(input[key] || "").trim() || old[field] || "";
  const profile = {
    assistantName: pick("assistant_name", "assistantName"), greeting: pick("greeting", "greeting"),
    industry: pick("industry", "industry"), services: pick("services", "services"),
    serviceAreas: pick("service_areas", "serviceAreas"), hours: pick("hours", "hours"), notes: pick("notes", "notes"),
  };
  const client = {
    id, business_name: input.business_name,
    owner_whatsapp: input.owner_whatsapp || existing?.owner_whatsapp || null,
    owner_sms: input.owner_sms || existing?.owner_sms || null,
    vapi_assistant_id: input.vapi_assistant_id || existing?.vapi_assistant_id || null,
    vapi_phone_id: input.vapi_phone_id || existing?.vapi_phone_id || null,
    phone_number: input.phone_number || existing?.phone_number || null,
  };

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
    } else if (!client.vapi_phone_id) {
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
