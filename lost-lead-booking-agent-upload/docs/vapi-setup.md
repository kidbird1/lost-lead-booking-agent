# Vapi Setup

## Goal

Connect Vapi to our Render backend.

## Server URL

After deploying to Render:

```text
https://YOUR-RENDER-APP.onrender.com/webhooks/voice
```

Use this as the assistant Server URL in Vapi.

## Tools

Create these tools:

```text
Name: bookAppointment
Description: Save a qualified caller as a booked appointment or follow-up lead.
```

Parameters:

```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "phone": { "type": "string" },
    "service": { "type": "string" },
    "address": { "type": "string" },
    "urgency": { "type": "string" },
    "requestedTime": { "type": "string" },
    "bookedTime": { "type": "string" },
    "appointmentStartIso": { "type": "string" },
    "appointmentEndIso": { "type": "string" },
    "summary": { "type": "string" }
  },
  "required": ["name", "phone", "service", "summary"]
}
```

Tool server URL:

```text
https://YOUR-RENDER-APP.onrender.com/webhooks/voice
```

```text
Name: getAvailableSlots
Description: Check open appointment times on the business calendar.
```

Parameters:

```json
{
  "type": "object",
  "properties": {
    "requestedTime": {
      "type": "string",
      "description": "Natural day or time from the caller, like tomorrow, Thursday, or Friday morning."
    },
    "startIso": {
      "type": "string",
      "description": "Optional ISO window start."
    },
    "endIso": {
      "type": "string",
      "description": "Optional ISO window end."
    }
  },
  "required": []
}
```

Tool server URL:

```text
https://YOUR-RENDER-APP.onrender.com/webhooks/voice
```

## Assistant Prompt

```text
You are the booking assistant for [Business Name].

Your job is to help callers book home service appointments.

Ask for:
- name
- phone number
- service needed
- address or ZIP code
- urgency
- preferred appointment time

If the caller is a good fit and gives enough information, call the bookAppointment tool.

If the caller is outside service area, urgent, upset, or unclear, collect details and call the bookAppointment tool with a summary and no bookedTime.

When the caller asks what times are open, or before offering exact appointment options, call getAvailableSlots.
Offer no more than three open times.
If no times are open, ask for another day.

Only send appointmentStartIso and appointmentEndIso when the appointment time is exact.
Use ISO 8601 with timezone.

Never quote exact prices.
Never promise emergency arrival.
Never diagnose dangerous issues.
If life or safety is at risk, tell the caller to contact emergency services.
```

## Local Testing

Use Vapi CLI forwarding or ngrok.

Example:

```text
vapi listen --forward-to localhost:3000/webhooks/voice
```

Then point Vapi to the public tunnel URL.
