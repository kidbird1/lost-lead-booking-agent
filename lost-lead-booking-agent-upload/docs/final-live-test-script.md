# Final Live Test Script

Use this before marking a tenant pilot-ready.

## Caller Script

```text
I need roof repair.
My name is [Name].
My phone number is [Phone].
I'm in [Service Area].
I'd like [Day] at [Exact Time].
```

Example:

```text
I need roof repair.
My name is Christopher.
My phone number is 2678064105.
I'm in Delray Beach.
I'd like Thursday at 1 PM.
```

## Expected Agent Behavior

- Asks short follow-up questions if needed.
- Calls `bookAppointment`.
- Says:

```text
I saved your appointment request. The team will confirm.
```

## Pass Criteria

- Tool call succeeds in Vapi.
- Exactly one lead is created.
- Lead is under the correct client ID.
- Owner alert queues or sends.
- Lead appears in the lead viewer.
- `/admin/issues` has no critical issue for the call.

## Fail Criteria

- No lead created.
- Duplicate lead created.
- Wrong client ID.
- Owner alert error.
- Agent promises confirmed calendar booking while calendar is off.
- Agent promises emergency arrival.

