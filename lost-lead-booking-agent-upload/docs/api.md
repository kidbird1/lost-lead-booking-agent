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

