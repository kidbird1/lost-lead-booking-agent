# Voice Agent Booking Skill

## Use When

Designing the AI phone agent.

## Agent Job

Answer missed calls, collect job details, book appointments, and notify the owner.

## Always

- identify the business name
- ask for name, phone, address, service needed, urgency
- confirm service area
- offer available appointment times
- repeat appointment details before confirming
- send owner summary
- use fallback when unsure

## Never

- promise exact pricing
- promise emergency arrival
- diagnose dangerous problems
- argue with callers
- keep talking if caller asks for a human
- book outside service area unless owner approves

## Fallback

If unsure, say:

```text
I want to make sure we handle this correctly. I will send your details to the owner so they can follow up.
```

## Output

```text
Call script:
Questions:
Booking rules:
Fallback rules:
Owner summary format:
Customer confirmation text:
```

