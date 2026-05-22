# Cost Estimate

Question:
What does the first stack cost to run?

Short answer:
The MVP is mostly usage-based. The biggest variable is voice minutes.

Recommended MVP stack:

- Render backend
- Twilio Voice
- Vapi or Retell
- Twilio WhatsApp
- SMS fallback
- Google Calendar
- Render Postgres or Supabase

Rough costs:

```text
Render web service: $7-$25/month
Render Postgres: $0-$19/month early
Twilio local number: about $1.15/month
Twilio inbound voice: about $0.0085/min
Twilio outbound voice: about $0.014/min
Twilio WhatsApp: $0.005/message + Meta fees
Twilio SMS fallback: starts around $0.0083/message, plus carrier fees
Vapi: $0.05/min platform fee + model/provider costs
Retell: $0.07-$0.31/min all-in range
OpenAI Realtime custom v2: token-based, usually model cost + Twilio phone cost
Google Calendar API: no additional cost
```

Simple estimate:

For 100 calls/month at 3 minutes each:

```text
300 call minutes
Voice AI layer: about $15-$93 depending on provider
Twilio inbound voice: about $2.55
Phone number: about $1.15
Messages: usually a few dollars
Hosting/database: about $7-$44 early
```

Expected MVP operating cost:

```text
Low: about $30-$50/month
Normal: about $60-$150/month
Higher usage: scales with call minutes
```

Sources:

- https://vapi.ai/pricing
- https://www.retellai.com/pricing
- https://developers.openai.com/api/docs/pricing
- https://www.twilio.com/en-us/pricing/current-rates
- https://www.twilio.com/en-us/voice/pricing/us
- https://www.twilio.com/en-us/whatsapp/pricing
- https://render.com/pricing
- https://developers.google.com/calendar/api/guides/quota

Next action:
Pick Vapi or Retell, then run a small test call and measure real cost per booked job.

