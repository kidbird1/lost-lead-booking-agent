-- 2026-10-18: service-area check + trade details.
ALTER TABLE leads ADD COLUMN area_status TEXT;   -- inside | outside | unknown | NULL (not checked)
ALTER TABLE leads ADD COLUMN area_place TEXT;
ALTER TABLE leads ADD COLUMN details TEXT;
CREATE TABLE IF NOT EXISTS area_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT,
  client_id TEXT,
  location TEXT,
  status TEXT,
  place TEXT,
  km REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS area_checks_call ON area_checks (call_id);
