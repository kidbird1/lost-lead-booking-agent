# Security Review

## Current Safe Defaults

- live messaging is off
- live calendar booking is off
- `.env` is ignored
- lead data is local and ignored by git
- no real API keys are committed
- no real customer data is in docs

## Sensitive Data

Treat these as sensitive:

- caller name
- phone number
- address
- call transcript
- recording URL
- API keys
- calendar event data

## Before Live Pilot

- [ ] put real secrets only in Render env vars
- [ ] test with fake customer data first
- [ ] confirm WhatsApp/SMS consent language
- [ ] avoid call recording unless needed
- [ ] add privacy note to pilot agreement
- [ ] confirm emergency fallback language
- [ ] use a test calendar before client calendar

## Never

- commit `.env`
- paste keys into chat
- send bulk WhatsApp/SMS without consent
- store call recordings by default
- promise emergency service


## Phase 1 Hardening (this change)

- `/webhooks/voice` (Vapi) now requires a matching `x-vapi-secret` (or
  `x-vapi-signature`) header against `VAPI_SERVER_SECRET`, checked with a
  constant-time comparison. Missing/wrong header -> 401, no processing, an
  `auth_rejected` event is logged.
- `/webhooks/twilio/voice-fallback` and `/webhooks/twilio/recording` now
  validate the real `X-Twilio-Signature` header against `TWILIO_AUTH_TOKEN`
  using Twilio's own request-signing algorithm (the `twilio` npm package's
  `validateRequest`). Missing/invalid signature -> 401, `auth_rejected`
  event logged.
- Both checks fall back to the older `WEBHOOK_SHARED_SECRET` shared-secret
  check ONLY when the provider-specific secret (`VAPI_SERVER_SECRET` /
  `TWILIO_AUTH_TOKEN`) is not configured, so local/dev setups keep working.
  **Set both in production** - see `.env.example`.
- End-of-call-report processing is now wrapped in the existing
  per-tenant-per-call lock (`withCallProcessingLock`), closing a race
  window where two near-simultaneous identical webhooks could both pass the
  "does this lead already exist" check before either saved.
- Tenants now carry a `status` field (`onboarding` / `active` / `past_due`
  / `suspended` / `offboarded`). Suspended/offboarded tenants get no
  assistant, no lead, no notification, and no further spend - see
  `docs/tenant-status.md`.

### Before Live Pilot (updated)

- [ ] set `VAPI_SERVER_SECRET` in Render AND in the Vapi assistant's Server
      URL secret field (same value both places)
- [ ] confirm `TWILIO_AUTH_TOKEN` is set in Render (enables real Twilio
      signature checks instead of the legacy shared secret)
- [ ] run `npm run smoke` locally and confirm it passes before every deploy
- [ ] run `npm run smoke:db` against a real Postgres before flipping any
      tenant to Postgres-backed storage
