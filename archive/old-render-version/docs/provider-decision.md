# Provider Decision

## Decision

Use Vapi for the first MVP.

## Why

Vapi is built for phone agents.

It supports:

- inbound and outbound calls
- Twilio/SIP connection
- tool calls
- webhooks
- appointment workflows
- fast dashboard setup

## Backup

Retell.

Use Retell if Vapi is too expensive, unreliable, or slow to configure.

## Custom Later

OpenAI Realtime API.

Use this later if we need deeper control, lower platform dependency, or custom call handling.

## Current Stack

```text
Voice agent: Vapi
Phone: Twilio Voice
Messaging: Twilio WhatsApp
Fallback: SMS
Backend: Render
Calendar: Google Calendar
Database: simple file/DB first, Postgres later
```

