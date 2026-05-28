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
5. Configure the client profile:

```text
BUSINESS_NAME=
ASSISTANT_NAME=
BUSINESS_INDUSTRY=
BUSINESS_SERVICES=
BUSINESS_SERVICE_AREAS=
```

6. Open `/admin/profile?token=YOUR_LEAD_VIEWER_TOKEN` and confirm the profile looks right.
7. Keep these off until testing:

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

