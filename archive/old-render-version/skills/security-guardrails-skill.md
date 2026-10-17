# Security Guardrails Skill

## Use When

Any work touches API keys, phone numbers, SMS, calendars, customer data, payments, or production.

## Always

- use `.env.example` for placeholders
- store real keys only in local `.env` or Render secrets
- limit what each API key can do when possible
- validate webhook signatures when provider supports it
- keep customer data minimal
- log only what is needed
- ask before sending real calls or SMS
- separate test mode from live mode

## Never

- commit real secrets
- paste API keys into chat or docs
- expose customer phone numbers in public files
- send marketing SMS without consent
- store call recordings unless we have a clear reason
- ignore opt-out requests
- automate emergency promises

## Security Checklist

```text
Secrets in env vars:
Webhook validation:
Customer data minimized:
SMS consent/fallback:
Test mode available:
Production risk:
```

