-- One business you serve = one client row.
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,                 -- short slug, like "acme-roofing"
  business_name TEXT NOT NULL,
  owner_whatsapp TEXT,                 -- +15615551234
  owner_sms TEXT,                      -- backup if WhatsApp fails
  profile TEXT NOT NULL DEFAULT '{}',  -- JSON: industry, services, areas, hours, notes
  vapi_assistant_id TEXT,
  vapi_phone_id TEXT,
  phone_number TEXT,                   -- the number the business forwards missed calls to
  status TEXT NOT NULL DEFAULT 'active', -- active | paused | setup
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One answered call = one lead row.
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  call_id TEXT UNIQUE,                 -- stops the same call being saved twice
  caller_number TEXT,
  name TEXT,
  callback TEXT,
  service TEXT,
  address TEXT,
  urgency TEXT,
  best_time TEXT,
  summary TEXT,
  transcript TEXT,
  duration_s INTEGER,
  ended_reason TEXT,
  alert_status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | test | failed | gave_up
  alert_channel TEXT,
  alert_error TEXT,
  alert_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Things worth seeing on the admin page: rejected webhooks, unknown numbers, failures.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS leads_client_time ON leads (client_id, created_at);
CREATE INDEX IF NOT EXISTS leads_alert ON leads (alert_status);
