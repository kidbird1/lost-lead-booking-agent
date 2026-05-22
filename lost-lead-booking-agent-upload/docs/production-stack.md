# Production Stack

## Hosting

Render.

Runs 24/7 backend.

## Phone

Twilio Voice.

Used for:

- incoming calls
- missed-call forwarding
- call webhooks

## Messaging

Twilio WhatsApp and/or Twilio SMS.

Use WhatsApp for:

- customer confirmation
- follow-up
- owner alerts

Use SMS as fallback when WhatsApp is not available.

## Calendar

Google Calendar.

Used for:

- checking availability
- booking jobs
- updating appointments

## Database

Start simple.

Options:

- Render Postgres
- Supabase
- Google Sheet for very first demo

Stores:

- leads
- calls
- bookings
- message status
- owner settings

## Voice Agent

Options:

- OpenAI Realtime API
- Google Gemini Live API
- Vapi
- Retell
- Synthflow
- ElevenLabs
- Grok / xAI only if production voice APIs fit phone-agent needs

Use whichever is fastest to connect to Twilio and webhooks.

See `docs/voice-provider-options.md`.

Current MVP direction:

```text
Vapi first.
Retell as backup.
OpenAI Realtime later if we need custom control.
```

## MVP Flow

```text
Customer calls
Twilio receives call
Voice agent answers
Backend receives call data
Calendar booking is created
Customer gets WhatsApp/SMS confirmation
Owner gets WhatsApp/SMS summary
Lead is saved
```
