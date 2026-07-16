// Move tenants out of the CLIENTS_JSON env var and into Postgres, where they
// belong once you're past a single-tenant pilot. Safe to re-run: each
// client is upserted by businessId (POST /api/clients uses "insert ...
// on conflict (id) do update"), so running this twice just re-syncs data.
//
// Usage:
//   BASE_URL=https://your-app.onrender.com \
//   ADMIN_TOKEN=your-admin-token \
//   CLIENTS_JSON="$(cat clients.json)" \
//   node scripts/migrate-clients-json.mjs
//
// Or point at a file instead of an env var:
//   node scripts/migrate-clients-json.mjs --file clients.json
//
// clients.json shape (array, or { clients: [...] }):
// [
//   {
//     "businessId": "joes-plumbing",
//     "businessName": "Joe's Plumbing",
//     "assistantName": "Riley",
//     "industry": "plumbing",
//     "services": ["drain cleaning", "leak repair"],
//     "serviceAreas": ["33487"],
//     "assistantId": "asst_xxx",
//     "phoneNumber": "+15551234567",
//     "ownerPhone": "+15557654321",
//     "ownerWhatsApp": "+15557654321",
//     "status": "active"
//   }
// ]

import { readFile } from "node:fs/promises";

function arg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function loadClients() {
  const filePath = arg("file");
  const raw = filePath
    ? await readFile(filePath, "utf8")
    : process.env.CLIENTS_JSON;

  if (!raw) {
    throw new Error("Provide clients via --file <path> or the CLIENTS_JSON env var.");
  }

  const parsed = JSON.parse(raw);
  const clients = Array.isArray(parsed) ? parsed : Array.isArray(parsed.clients) ? parsed.clients : [];
  if (!clients.length) {
    throw new Error("No clients found in input. Expected an array or { clients: [...] }.");
  }
  return clients;
}

async function main() {
  const baseUrl = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    throw new Error("Set ADMIN_TOKEN to the same value configured on the server.");
  }

  const clients = await loadClients();
  console.log(`Migrating ${clients.length} client(s) from CLIENTS_JSON to Postgres at ${baseUrl} ...`);

  const results = [];
  for (const client of clients) {
    if (!client.businessId && !client.businessName) {
      results.push({ ok: false, error: "missing businessId/businessName", client });
      continue;
    }
    try {
      const response = await fetch(`${baseUrl}/api/clients?token=${encodeURIComponent(adminToken)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "active", ...client }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        results.push({ ok: false, error: payload.error || `http_${response.status}`, businessId: client.businessId });
        continue;
      }
      results.push({ ok: true, businessId: payload.profile.businessId, leadViewerToken: payload.leadViewerToken });
    } catch (error) {
      results.push({ ok: false, error: error.message, businessId: client.businessId });
    }
  }

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  console.log(`\nMigrated ${succeeded.length}/${clients.length} client(s).`);
  for (const r of succeeded) {
    console.log(`  ok   ${r.businessId}  (lead viewer token: ${r.leadViewerToken ? "issued" : "unchanged"})`);
  }
  for (const r of failed) {
    console.log(`  FAIL ${r.businessId || "(unknown)"}  ${r.error}`);
  }

  if (failed.length) {
    console.log("\nSome clients failed to migrate. Fix the input and re-run - this script is safe to re-run.");
    process.exit(1);
  }

  console.log("\nAll clients migrated. Once verified, remove CLIENTS_JSON from your Render environment.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
