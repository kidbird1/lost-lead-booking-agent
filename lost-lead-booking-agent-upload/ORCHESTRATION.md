# Orchestration

## Simple Method

Use Codex as the orchestrator.

Give each sub-agent one small job.

Do not ask one agent to build everything.

## Pipeline

```text
Product Agent
-> Voice Agent
-> Backend Agent
-> Integrations Agent
-> QA Agent
-> Sales Agent
```

## First Build Order

1. Lock the exact call flow.
2. Build backend endpoints.
3. Connect voice provider webhook.
4. Connect calendar booking.
5. Connect SMS notifications.
6. Deploy to Render.
7. Test with fake calls.
8. Sell one pilot.

## Example Codex Prompt

```text
Read AGENTS.md first.

You are the Backend Agent.

Build only the backend MVP for the Lost Lead Booking Agent.

Do not build a dashboard yet.

Use environment variables for secrets.

Needed behavior:
- receive a call/lead webhook
- save lead details
- create a calendar booking
- send owner SMS
- return success/failure JSON

Update tasks/backlog.md and memory/decisions.md when done.
```

## Rule

Each agent should leave the project easier for the next agent.

