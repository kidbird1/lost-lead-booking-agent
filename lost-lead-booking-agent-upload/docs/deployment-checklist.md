# Deployment Checklist

## Already Built

- Node backend
- Vapi webhook endpoint
- Vapi tool-call handler
- test lead storage
- Twilio WhatsApp/SMS sending path
- Google Calendar live booking path
- Render blueprint
- smoke test
- call flow
- sales playbook
- onboarding questions
- security checklist

## Deploy To Render

1. Push project to GitHub or connect this folder to Render.
2. Create a Render Web Service.
3. Use:

```text
Build command: npm install
Start command: npm start
```

4. Add env vars from `.env.example`.
   For paid pilot data, create a Render Postgres database and set:

```text
DATABASE_URL=postgres://...
DATABASE_SSL=true
```

   For a simpler demo without Postgres, mount a Render persistent disk and set:

```text
DATA_DIR=/var/data
```

5. Configure admin and client access:

```text
ADMIN_TOKEN=
LEAD_VIEWER_TOKEN=
CLIENTS_JSON=
```

Use `ADMIN_TOKEN` for internal operator checks. Use `CLIENTS_JSON` when one Render service serves more than one pilot client.

6. Configure the client profile:

```text
BUSINESS_NAME=
ASSISTANT_NAME=
BUSINESS_INDUSTRY=
BUSINESS_SERVICES=
BUSINESS_SERVICE_AREAS=
```

7. For a new client, open `/admin/onboarding?token=YOUR_ADMIN_TOKEN` and generate the profile.
8. Open `/admin/profile?token=YOUR_ADMIN_TOKEN` and confirm the profile looks right.
9. Keep these off until testing:

```text
SEND_LIVE_MESSAGES=false
SEND_LIVE_CALENDAR=false
```

## Connect Vapi

1. Create Vapi assistant.
2. Open `/api/agent-context?token=YOUR_LEAD_VIEWER_TOKEN`.
3. Copy the generated `firstMessage` and `prompt` into Vapi.
4. Add `bookAppointment` tool.
5. Set server URL:

```text
https://YOUR-RENDER-APP.onrender.com/webhooks/voice
```

6. Run a test call.

## Vapi Backup Path

If Vapi is down or unavailable, point the phone provider fallback URL to:

```text
https://YOUR-RENDER-APP.onrender.com/webhooks/twilio/voice-fallback
```

This backup path asks the caller to leave their job details, saves the recording/transcript as a follow-up lead, and alerts the owner.

## Connect Twilio

Needed:

```text
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_PHONE_NUMBER
TWILIO_WHATSAPP_FROM
OWNER_PHONE_NUMBER
OWNER_WHATSAPP_NUMBER
```

Keep `SEND_LIVE_MESSAGES=false` until test payloads look right.

## Connect Google Calendar

Needed:

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
GOOGLE_CALENDAR_ID
```

Keep `SEND_LIVE_CALENDAR=false` until using a test calendar.

## Final Pre-Pilot Test

- [ ] Vapi test call reaches backend
- [ ] `bookAppointment` tool saves lead
- [ ] owner alert sends in test mode
- [ ] WhatsApp owner alert sends live
- [ ] SMS fallback sends live
- [ ] Google Calendar test event creates live
- [ ] emergency call does not book or promise arrival
- [ ] outside-area call goes to owner follow-up

## Owner Alert Retries

Failed owner notifications retry automatically using persistent lead state. Defaults:

```text
OWNER_ALERT_MAX_ATTEMPTS=5
OWNER_ALERT_RETRY_BASE_SECONDS=60
OWNER_ALERT_WORKER_INTERVAL_SECONDS=30
```

Retries use bounded exponential backoff. After the final failed attempt, the lead remains visible as a critical issue for operator review.

