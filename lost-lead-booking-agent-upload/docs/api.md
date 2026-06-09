# API

## Health

```text
GET /health
```

Returns:

```json
{ "ok": true, "service": "lost-lead-booking-agent" }
```

## Vapi Webhook

```text
POST /webhooks/voice
```

Handles:

- `assistant-request`
- `tool-calls`
- `end-of-call-report`
- normal event logging

## Manual Lead

```text
POST /leads
```

Example:

```json
{
  "name": "Jane Caller",
  "phone": "+15555550123",
  "service": "roof leak",
  "address": "123 Main St",
  "urgency": "urgent",
  "requestedTime": "Friday afternoon",
  "summary": "Caller needs a roof leak inspection."
}
```

## Lead Viewer

```text
GET /admin/leads?token=YOUR_LEAD_VIEWER_TOKEN
```

Client setup page:

```text
GET /admin/profile?token=YOUR_LEAD_VIEWER_TOKEN
```

Shows the current business profile, Vapi first message, Vapi system prompt, tool server URL, and Render env snippet.

Client onboarding form:

```text
GET /admin/onboarding?token=YOUR_LEAD_VIEWER_TOKEN
```

System status page:

```text
GET /admin/status?token=YOUR_LEAD_VIEWER_TOKEN
```

Shows private setup checks for Twilio, WhatsApp, calendar, lead viewer protection, and business profile config without exposing secrets.

Profile preview API:

```text
POST /api/profile-preview?token=YOUR_LEAD_VIEWER_TOKEN
```

Returns generated Vapi prompt, first message, env snippet, and business profile JSON from submitted client details.

Also supported for compatibility:

```text
GET /leads?key=YOUR_LEADS_VIEW_KEY
```

Shows saved Vapi/Twilio leads in a protected follow-up page. The owner can filter leads, call/text/WhatsApp the caller, and mark each lead as follow-up, contacted, booked, or lost.

Requires one of these Render environment variables:

```text
LEAD_VIEWER_TOKEN=
LEADS_VIEW_KEY=
ADMIN_TOKEN=
CLIENTS_JSON=
```

`ADMIN_TOKEN` can view internal operator pages across clients.

`CLIENTS_JSON` can hold pilot client profiles with per-client `leadViewerToken` values. A client token only returns records for that client's `businessId`.

The JSON lead list is available at:

```text
GET /api/leads?token=YOUR_LEAD_VIEWER_TOKEN
```

The CSV lead export is available at:

```text
GET /api/leads.csv?token=YOUR_LEAD_VIEWER_TOKEN
```

The generated Vapi prompt and first message are available at:

```text
GET /api/agent-context?token=YOUR_LEAD_VIEWER_TOKEN
```

The private setup status JSON is available at:

```text
GET /api/system-status?token=YOUR_LEAD_VIEWER_TOKEN
```

Open appointment slots are available at:

```text
GET /api/availability?token=YOUR_LEAD_VIEWER_TOKEN&requestedTime=Friday
```

This returns up to `MAX_AVAILABLE_SLOTS` open times from the connected calendar.

Lead status updates use:

```text
POST /leads/status?token=YOUR_LEAD_VIEWER_TOKEN
```

## Booking

```text
POST /bookings
```

For live calendar booking, include:

```json
{
  "name": "Jane Caller",
  "phone": "+15555550123",
  "service": "roof leak",
  "address": "123 Main St",
  "urgency": "urgent",
  "bookedTime": "Friday 2 PM",
  "appointmentStartIso": "2026-05-22T14:00:00-04:00",
  "appointmentEndIso": "2026-05-22T15:00:00-04:00",
  "summary": "Caller needs a roof leak inspection."
}
```

## Test Mode

Default:

```text
SEND_LIVE_MESSAGES=false
SEND_LIVE_CALENDAR=false
```

No real messages or calendar bookings are sent in test mode.

## Storage

By default, leads are saved in the app `data` folder for the MVP.

For a more durable Render setup, mount a persistent disk and set:

```text
DATA_DIR=/var/data
```

The app will then store `leads.json` and `events.json` in that directory.
