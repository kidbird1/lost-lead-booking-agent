# Missed Call Agent — Lean Plan

**Log line:** A business misses a call, our AI picks up, gets the job details, and texts the owner on WhatsApp in under a minute.

## What we have now (too much)

- One server file of 5,000 lines.
- 12 admin web pages (leads, clients, status, issues, events, onboarding, profile...).
- 50 settings to fill in.
- Two storage systems (JSON files and Postgres).
- Google Calendar booking, slot lookup, spoken-time parsing.
- Retry workers, locks, rate limits, CSV export, backups.
- 63 planning docs, plus 8 "agent role" files.

It works, but it is too heavy for one person to run.

## The lean version (what stays)

The whole job is 4 steps:

1. **Call comes in.** The business sets "forward when I don't answer" to our Vapi number.
2. **Agent talks.** Vapi asks: name, callback number, what's wrong, address, how urgent, best time.
3. **Agent writes it up.** At hang-up, Vapi sends us a clean summary (Vapi pulls the fields out itself — no tool calls, no parsing code).
4. **Owner gets a WhatsApp.** Name, number (tap to call back), job, address, urgency, best time.

The owner books the job himself. WhatsApp **is** the dashboard. No web pages for the owner.

## What we cut

| Cut | Why |
|---|---|
| All 12 admin pages | Owner lives in WhatsApp. You get a daily summary instead. |
| Google Calendar booking | Most hard part, least needed. Owner calls back and books. Add later if clients ask. |
| Spoken-time parsing | Agent just writes "Friday morning". Owner reads it. |
| JSON storage + Postgres | Cloudflare D1: one table for leads, one for clients. |
| Retry workers, locks, rate limits | Vapi sends one report per call. One check stops doubles. |
| 63 docs + agent role files | Archived, not deleted. |

Target: **about 600 lines in 4 small files, on Cloudflare Workers (free), about 10 settings.** (Done 2026-10-17 — see RUN-GUIDE.md.)

## The "agent runs it" part (your operator)

You don't click around. You run simple commands (or ask me / Codex to):

- `add-client` — you give business name, services, area, hours, owner WhatsApp. It **creates the Vapi agent and phone number for them automatically** through the Vapi API and saves the client.
- `pause-client` / `resume-client` — stop calls for someone who didn't pay.
- **Daily WhatsApp to you:** calls per client, any failed alerts.
- **Instant WhatsApp to you** if an owner alert fails, so nothing is lost.

## One warning: WhatsApp rules

The Twilio WhatsApp **sandbox** only works for numbers that texted "join" in the last 3 days. Fine for testing, not for clients.
For real clients you need:

1. A Twilio WhatsApp sender (your own business number, approved by Meta).
2. One approved message template for the lead alert (WhatsApp blocks free-form business messages to people who haven't messaged you in 24 hours).

Plan: SMS backup is kept, so alerts still arrive while WhatsApp approval is pending.

## Running cost (rough, per month)

- Cloudflare Worker + D1 database: free plan.

- Vapi: pay per minute of calls + a phone number per client.
- Twilio: small per-message cost.

## Build order

1. New branch `lean`. Move old code to `archive/`.
2. Write the lean server: Vapi end-of-call report -> save lead -> WhatsApp owner (SMS backup).
3. Write `add-client` script that sets up the Vapi agent + number.
4. Test locally with a fake call.
5. Deploy on Cloudflare Workers. One real test call to your phone.
6. Then: sell. First outreach list of local roofers/plumbers/HVAC.
