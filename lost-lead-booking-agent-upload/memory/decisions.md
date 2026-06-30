# Decisions

## 2026-05-21

- Product direction: AI missed-call booking agent for home service businesses.
- First promise: "You miss calls. We answer them. You get more booked jobs."
- MVP should be narrow: one call flow, one calendar, one owner notification, one lead log.
- Render is available for 24/7 hosting.
- Avoid building a large SaaS dashboard before proving the call-to-booking flow.
- Twilio is available.
- Use Twilio Voice for calls.
- Use Twilio WhatsApp for confirmations/follow-up where available, with SMS fallback.
- Skills, guardrails, and security are first-class project assets.
- Research Agent added.
- WhatsApp decision: use for confirmations/follow-up, with SMS fallback.
- Voice provider decision: Vapi for MVP; Retell backup; OpenAI Realtime as custom v2.
- First niche for MVP: home service contractors, starting with roofing/HVAC style call flow.

## 2026-05-27

- Booking reliability rule: the `bookAppointment` tool is the primary booking record.
- Vapi end-of-call reports are fallback-only and should not create a second lead when the call already saved through the booking tool.
- Scheduling rule: natural appointment times are parsed in the business timezone, and requests outside business hours are saved for owner follow-up instead of treated as confirmed bookings.
- Calendar rule: when live Google Calendar booking is enabled, the backend checks free/busy before creating the event. Busy or unconfirmed slots are saved as follow-up instead of confirmed bookings.
- Calendar tool rule: Riley should ask the backend for available Google Calendar slots before offering exact appointment times. Google Calendar remains the source of truth; Calendly can stay optional for public booking links later.
- Product config rule: the MVP should use a business profile instead of hardcoded industry knowledge. For now, one Render service can serve one client; later, profiles can move to a database and route by phone number.

## 2026-05-28

- Business-specific knowledge belongs in configuration, not code. The MVP uses one business profile per deployed Render service; multi-tenant profile routing can come later.
- Profile setup should be copy-friendly and protected by the same lead viewer token. Editing Render env vars from the app is deferred until after the pilot proves the setup flow.
- Client onboarding should generate prompts and env snippets without storing secrets. This keeps the MVP simple and avoids accidental config changes.

## 2026-05-29

- Handoff resume: `codex/business-profile-config` is merged to `main` via PR #6 (`41c96d9`). Render health endpoint responds OK.
- Duplicate-lead rule stays: `bookAppointment` is primary; `end-of-call-report` only saves when no lead exists for the same Vapi `call.id`.
- Local smoke test should poll `/health` on `127.0.0.1` instead of a fixed sleep, because Windows startup timing is flaky.
- Spoken US times like "nine in the morning" are normalized to numeric clock times before `chrono-node` parsing so bookings can schedule instead of stopping at `missing_exact_clock_time`.
- Lead data should be exportable as a protected CSV so the owner can back up records and future agents can migrate from JSON storage to a durable database.
- GitHub is the source of truth for project memory and saved work. ZIP exports are useful milestone backups, but continuation context should live in repo docs first.
- Live pilot setup needs a protected system status page because Twilio, WhatsApp, calendar, and token issues should be visible without exposing secret values.
- JSON storage remains the MVP default, but the data directory can be moved with `DATA_DIR` so Render can use a persistent disk before a database migration.

## 2026-06-02

- Multi-client preparation should stay light for MVP: add `BUSINESS_ID` metadata to profiles, leads, events, and exports, but do not build full multi-tenant routing until one-client pilots prove the flow.
- Lead review should support one-click inspection: each protected lead card links to a protected detail page with raw intake, owner alert status, calendar status, and resend-owner notification action.
- Webhook protection should be optional for the pilot. If `WEBHOOK_SHARED_SECRET` or `VOICE_WEBHOOK_SECRET` is set, Vapi and Twilio fallback webhooks require the configured secret; if unset, existing live calls keep working.
- Owner follow-up actions should leave a short status history on each lead so the business can see contacted/booked/lost changes over time instead of only the latest note.
- The protected system status page should show a plain-English pilot readiness summary, including blockers, optional warnings, and next actions, so setup gaps are visible without reading JSON.

## 2026-06-09

- Client onboarding should output one copyable setup packet: client ID, private lead viewer link, Vapi first message, Vapi system prompt, Vapi tool URL, owner notification setup, optional booking link, and live test checklist.
- Default booking language stays conservative: the agent saves appointment requests and says the team will confirm. It should not promise a confirmed calendar booking unless live calendar booking is enabled and working.
- Paid-pilot production work should move in small slices: first add operator auth, per-client lead viewer token isolation, rate limits, and AI-native workflows while keeping the current single-client path working.
- Storage direction: use Postgres for paid pilots and multi-tenant Agent-as-a-Service. Keep JSON as local/demo fallback only; do not use SQLite or hardcoded client data for production.

## 2026-06-29

- Tenant-scoped Issues pages must be smoke-tested at the rendered HTML level: selected business title and records only, with no other tenant ID present.
- Vapi transcript-only end-of-call fallback leads must persist the owner notification result so alert failures appear in the Issues dashboard.

## 2026-06-30

- Owner alert reliability uses persistent retry state on each lead so retries survive app restarts without adding another paid service.
- Failed alerts retry with bounded exponential backoff. Successful retries clear the error; exhausted retries remain visible as tenant-scoped critical issues.
- WhatsApp transport failures must fall back to SMS when configured. A failed WhatsApp-only alert must remain an error, never be mislabeled as test mode.
