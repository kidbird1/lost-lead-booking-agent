# Backend API Skill

## Use When

Building the server, webhooks, database, Render deploy, calendar, or SMS logic.

## Always

- keep endpoints simple
- validate incoming webhook data
- store lead status
- log errors without exposing secrets
- use environment variables
- return clear success/failure JSON
- make local testing easy

## Never

- hardcode API keys
- store secrets in docs
- send SMS from tests unless explicitly enabled
- assume every webhook is trusted
- skip input validation

## First Endpoints

```text
GET /health
POST /webhooks/voice
POST /leads
POST /bookings
```

## Output

```text
Files changed:
Env vars needed:
Endpoints built:
How to test:
Risks:
```

