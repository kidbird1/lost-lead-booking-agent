# Google Calendar Setup

## Goal

Let the backend create appointments on the business calendar.

## Current State

Calendar code exists.

Live booking is off by default:

```text
SEND_LIVE_CALENDAR=false
```

## Required Env Vars

```text
SEND_LIVE_CALENDAR=true
CHECK_CALENDAR_AVAILABILITY=true
AVAILABLE_SLOT_INTERVAL_MINUTES=60
MAX_AVAILABLE_SLOTS=3
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
GOOGLE_CALENDAR_ID=
```

## Time Format

The Vapi tool should send exact ISO times when booking live:

```json
{
  "appointmentStartIso": "2026-05-22T14:00:00-04:00",
  "appointmentEndIso": "2026-05-22T15:00:00-04:00"
}
```

If the agent only has a vague time like "Friday afternoon", the backend will mark it for review instead of creating a calendar event.

## Safety Rule

Do not enable live calendar booking until test bookings work on a test calendar.

