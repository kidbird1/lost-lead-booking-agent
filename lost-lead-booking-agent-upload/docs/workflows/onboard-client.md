# Onboard Client Workflow

## Trigger

A new paid pilot or test client needs a booking agent.

## Inputs

- Business name
- Industry
- Services
- Service area
- Business hours and timezone
- Owner phone and WhatsApp
- Optional booking link
- Vapi assistant or phone number

## Agent Tasks

- Open `/admin/onboarding` with an operator token.
- Generate the client setup packet.
- Create or update the client config in `CLIENTS_JSON` for pilots.
- Copy the generated first message, system prompt, and tool URL into Vapi.
- Confirm the client has a private lead viewer token.

## Human Approval Points

- Approve live SMS or WhatsApp before enabling it.
- Approve any real calendar connection.
- Approve the final Vapi prompt before the first live call.

## Failure Handling

- If required client details are missing, stop setup and ask the owner.
- If Vapi tool calls fail, keep the client in test mode.
- If owner alerts are not configured, save leads and show the missing setup on `/admin/status`.

## Success Metric

The client can run one test call that saves exactly one lead and shows it in their private lead viewer.
