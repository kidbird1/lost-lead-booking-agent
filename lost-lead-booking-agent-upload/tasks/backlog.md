# Backlog

## Phase 1 - Define

- [x] Run Research Agent on voice provider options
- [x] Run Research Agent on Twilio WhatsApp requirements
- [x] Run Research Agent on missed-call/home-service buyer pain
- [x] Pick first niche: roofer, HVAC, plumber, or cleaner
- [x] Define exact call script
- [x] Define booking rules
- [x] Define owner notification format
- [x] Define MVP success metric
- [x] Choose WhatsApp vs SMS behavior
- [x] Choose voice provider
- [x] Write ordered 24/7 Agent-as-a-Service production plan

## Phase 2 - Build

- [x] Create backend API
- [x] Add file-based lead store
- [x] Add Twilio webhook endpoint
- [x] Add Twilio WhatsApp notification path
- [x] Add SMS fallback notification path
- [x] Add voice-agent webhook endpoint
- [x] Add live Google Calendar booking path
- [ ] Configure Google Calendar credentials
- [x] Add SMS notifications
- [x] Add Render deployment
- [x] Add Greptile review workflow docs
- [x] Add protected lead viewer endpoint
- [x] Add protected lead follow-up page
- [x] Add business-hours scheduling guard
- [x] Connect live calendar availability
- [x] Add available-slot lookup tool
- [x] Add reusable business profile config
- [x] Add protected profile setup page
- [x] Build client onboarding form
- [x] Add protected CSV lead export
- [x] Add GitHub handoff docs for future LLM continuation
- [x] Add protected system status page
- [x] Add configurable data directory for persistent storage
- [x] Add lightweight business ID metadata for future multi-client routing
- [x] Add protected single-lead detail page
- [x] Add optional webhook secret protection
- [x] Add owner follow-up history on leads
- [x] Add pilot readiness summary to system status
- [x] Add complete client onboarding setup output
- [x] Add first multi-client token isolation for pilot lead viewers
- [x] Add basic rate limits for admin/API/webhook paths
- [x] Add AI-native workflow and policy docs
- [x] Add Postgres storage foundation with JSON fallback
- [x] Add persistent bounded retries for failed owner alerts

## Phase 3 - Test

- [x] Run fake Vapi tool call
- [x] Confirm test appointment path is created
- [x] Confirm lead is saved
- [x] Test fallback when no appointment slot exists
- [x] Buy and assign Vapi phone number
- [x] Add Vapi end-call tool and timeout limits
- [x] Complete real phone call test
- [x] Confirm lead follow-up page loads locally
- [x] Prevent duplicate lead records from Vapi end-of-call fallback
- [x] Confirm after-hours appointment requests are flagged for follow-up
- [x] Confirm busy calendar slots are flagged for follow-up
- [x] Confirm available-slot lookup returns open times
- [x] Confirm generated agent context uses business profile
- [x] Confirm protected profile setup page renders
- [x] Confirm onboarding preview generates Vapi prompt
- [x] Confirm branch `codex/business-profile-config` merged to `main` (PR #6)
- [x] Confirm Render `/health` responds after deploy
- [x] Confirm local `npm run check` and `npm run smoke` on `main`
- [ ] Confirm live `/admin/onboarding?token=...` with real `LEAD_VIEWER_TOKEN`
- [ ] Confirm live `/admin/profile?token=...` with real `LEAD_VIEWER_TOKEN`
- [x] Run one live Vapi test call and confirm exactly one lead in viewer
- [x] Parse spoken times like "Friday, nine in the morning" into schedulable slots (local smoke)
- [x] Confirm protected CSV lead export includes saved leads
- [x] Confirm protected system status page renders
- [x] Confirm protected single-lead detail page and API render saved lead context
- [x] Confirm onboarding preview returns client ID, lead link, Vapi tool URL, owner setup, booking link, and test checklist
- [x] Confirm client A token cannot view client B leads in smoke test
- [x] Confirm tenant-scoped Issues HTML uses the selected business title and excludes other tenant IDs
- [x] Persist owner notification status for transcript-only Vapi fallback leads
- [x] Confirm transient owner alert failures recover inside the correct tenant
- [x] Confirm permanent owner alert failures stop at the limit and remain tenant-scoped issues
- [x] Confirm Postgres smoke script skips safely without DATABASE_URL
- [ ] Manually confirm the authenticated Demo Roofing production Issues page
- [ ] Deploy spoken-time parsing to Render and re-test a call like Stevenson's phrasing
- [ ] Confirm customer WhatsApp/SMS sends
- [ ] Confirm owner WhatsApp/SMS sends

## Phase 4 - Sell

- [x] Build demo script
- [x] Build one-page offer
- [x] Make first outreach list template
- [ ] Make first real outreach list
- [ ] Run first pilot

## Knowledge / Workflow

- [x] Capture Ras Mic agentic engineering workflow transcript and project notes
- [x] Save agentic engineering workflow as a reusable project skill
