# LLM Handoff

This file exists so another AI assistant can continue the project from GitHub without needing the whole chat history.

## Read First

1. `AGENTS.md`
2. `docs/product-brief.md`
3. `memory/decisions.md`
4. `tasks/backlog.md`
5. `protocols/guardrails.md`
6. `protocols/security.md`
7. `docs/deployment-checklist.md`
8. `docs/vapi-setup.md`
9. `docs/google-calendar-setup.md`
10. `docs/api.md`

## Product

Lost Lead Booking Agent is an AI-native agent-as-a-service for home service businesses.

Simple promise:

> You miss calls. We answer them. You get more booked jobs.

The first pilot is a roofing-style business called Demo Roofing Co. The product should stay configurable so the same agent can later serve plumbers, HVAC, dentists, cleaners, and other appointment businesses.

## Live System

- Render app: `https://lost-lead-booking-agent.onrender.com`
- Health check: `https://lost-lead-booking-agent.onrender.com/health`
- Vapi webhook: `https://lost-lead-booking-agent.onrender.com/webhooks/voice`
- Protected lead viewer: `/admin/leads?token=LEAD_VIEWER_TOKEN`
- Protected CSV export: `/api/leads.csv?token=LEAD_VIEWER_TOKEN`
- Protected business profile setup: `/admin/profile?token=LEAD_VIEWER_TOKEN`
- Protected onboarding helper: `/admin/onboarding?token=LEAD_VIEWER_TOKEN`

Never put real tokens, API keys, phone numbers, transcripts, or customer data in committed docs.

## Current Stack

- Backend: Node.js native `http` server
- Storage: local JSON files for MVP
- Hosting: Render
- Voice agent: Vapi
- Messaging: Twilio SMS and Twilio WhatsApp sandbox
- Calendar: Google Calendar integration path with mockable tests
- Admin: protected lead viewer, setup page, onboarding page, CSV export
- Review workflow: local checks first; Greptile/GrepLoop is the review gate when available

## Current Git State

The current working branch at handoff was:

```text
codex/spoken-time-parsing
```

Known pushed commits on this branch:

- `386033e` - Parse spoken appointment times for reliable booking.
- `bf772c3` - Add protected lead CSV export.

If this branch is not merged yet, open or continue the PR:

```text
https://github.com/kidbird1/lost-lead-booking-agent/pull/new/codex/spoken-time-parsing
```

## What Works

- Vapi can answer a live call.
- `bookAppointment` saves lead records.
- Owner WhatsApp notification has worked through the Twilio sandbox.
- Lead viewer shows saved leads with statuses.
- CSV export exists behind the same viewer token.
- Google Calendar availability and business-hours logic exist in the code path.
- Business profile configuration exists so the app is not permanently hardcoded to roofing.

## Known Gaps

- Confirm the spoken-time parsing branch is merged and deployed to Render.
- Confirm a live call phrase like "Friday at nine in the morning" books or flags correctly.
- Confirm live owner WhatsApp/SMS sends after the latest deploy.
- Configure real Google Calendar credentials when ready.
- Move from local JSON storage to durable storage before real multi-client production.
- Add multi-client routing by Vapi phone number or business profile ID later.

## Next Best Slice

1. Merge and deploy the current branch.
2. Run one live Vapi call using a natural time phrase.
3. Confirm exactly one lead appears in the viewer.
4. Confirm CSV export works live.
5. Confirm the owner notification arrives or identify the Twilio reason.
6. Then build durable storage or real calendar booking, not both at once.

## Mike's Preferences

- Keep explanations short and simple.
- Build one useful slice at a time.
- Save meaningful work with GitHub commits.
- Update `memory/decisions.md` and `tasks/backlog.md`.
- Use Greptile/GrepLoop when available, but do not pretend it ran if it did not.
- Avoid big platform work until the booking flow is reliable.

## Security Rules

- No secrets in GitHub.
- Use Render environment variables for secrets.
- Protect admin pages with `LEAD_VIEWER_TOKEN`.
- Treat phone numbers, leads, transcripts, and call recordings as sensitive.
- Do not send live customer messages without explicit approval.
- Keep the owner in the loop for risky actions, emergencies, unclear jobs, and outside-service-area calls.
