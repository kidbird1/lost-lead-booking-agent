# Tenant Status Lifecycle

Every tenant (client) has a `status` field stored in `clients.data.status`
(Postgres) or on the client object in `CLIENTS_JSON` (env/dev mode). It
drives whether Vapi calls are answered at all for that tenant.

## States

- `onboarding` ??? tenant is being set up. Calls are allowed (so you can test
  before they've paid) but they are not yet a paying customer.
- `active` ??? normal paying tenant. Full service.
- `past_due` ??? a Stripe invoice failed. Calls are still allowed during a
  grace period (see Phase 3 plan: 7 days) before auto-suspension.
- `suspended` ??? calls are blocked. No assistant is returned, no lead is
  created, no owner notification is sent, no Vapi/Twilio spend occurs.
- `offboarded` ??? same enforcement as `suspended`, plus the tenant is queued
  for data deletion after the retention window.

Unknown/missing status values are normalized to `active` to avoid silently
locking out an existing tenant because of a typo ??? see
`normalizeTenantStatus()` in `src/server.js`.

## Where it's enforced

`handleVapiWebhook()` in `src/server.js` checks `tenantProfile.status`
immediately after resolving which tenant a call belongs to, before any
assistant is returned or lead is created. This is the kill switch: flipping
a tenant to `suspended` (via `POST /api/clients` with `{ "status":
"suspended" }`, once that endpoint is wired for updates, or directly via
`PATCH` in Phase 3) takes effect on the very next call - no redeploy needed.

## What's NOT done yet (later phases)

- A polished, tenant-facing "this service is temporarily unavailable"
  spoken message for suspended tenants. Right now Vapi just gets an
  `{ error }` response and won't connect the caller to a live agent. Full
  dynamic-assistant support (Phase 2 of the master plan) will let this be a
  real spoken message instead.
- Automatic status transitions from Stripe events (`past_due` on failed
  invoice, `suspended` after the grace period) - that's Phase 3.
