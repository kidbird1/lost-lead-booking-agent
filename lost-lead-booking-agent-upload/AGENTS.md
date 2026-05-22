# Lost Lead Booking Agent - Agent Map

## Product

Build an agent-as-a-service for home service businesses.

Simple promise:

> You miss calls. We answer them. You get more booked jobs.

## Read First

1. `docs/product-brief.md`
2. `docs/buyer-profile.md`
3. `docs/agent-roles.md`
4. `skills/index.md`
5. `protocols/guardrails.md`
6. `protocols/security.md`
7. `tasks/backlog.md`
8. `protocols/secrets.md`
9. `knowledge/README.md`
10. `memory/decisions.md`

## Working Rule

Do not build a giant platform first.

Build one small working flow:

```text
Call comes in -> AI answers -> asks questions -> books appointment -> texts owner -> saves lead
```

## Default Tech Direction

- Hosting: Render
- Phone/SMS: Twilio
- Voice agent: Vapi, Retell, Synthflow, or ElevenLabs
- Calendar: Google Calendar
- Database: Postgres, Supabase, or simple Google Sheet for MVP
- Backend: small API service
- Frontend: basic admin dashboard only after the call flow works

## Agent Behavior

Every agent should:

- work on one slice at a time
- load the matching skill before work
- write down decisions in `memory/decisions.md`
- update `tasks/backlog.md`
- avoid touching secrets directly
- ask before adding paid services or risky automation
- keep the MVP small

## Always

- solve a money problem
- keep humans in approval loops for risky actions
- log important actions
- use environment variables for secrets
- build the smallest working flow first

## Never

- hardcode API keys
- send real customer SMS without approval
- promise emergency response
- build broad platform features before the booking flow works
- let an agent act without fallback rules
