# Test Client Call Workflow

## Trigger

A client setup packet is ready and Vapi has been configured.

## Inputs

- Client ID
- Private lead viewer link
- Vapi phone number or test call path
- Expected service area
- Test caller scenario

## Agent Tasks

- Open the client's private lead viewer.
- Place one test call.
- Ask for an appointment request with a clear time.
- Confirm the agent says the team will confirm.
- Confirm one new lead appears.
- Confirm owner notification status on the lead.

## Human Approval Points

- Do not call real customers.
- Do not enable customer confirmations unless Mike approves.
- Do not mark the client live until the owner has seen a successful test lead.

## Failure Handling

- If no lead appears, check `/admin/events`.
- If two leads appear, check duplicate-call handling.
- If owner alert fails, use `debug-owner-alert.md`.

## Success Metric

One call creates one lead for the correct client, with a visible owner notification result.
