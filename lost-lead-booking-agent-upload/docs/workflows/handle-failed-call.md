# Handle Failed Call Workflow

## Trigger

A Vapi call, webhook, or tool call fails.

## Inputs

- Call ID
- Client ID
- Event log
- Vapi call log
- Render logs if needed

## Agent Tasks

- Open `/admin/events` with an operator token.
- Find the call ID and provider event.
- Check whether a lead was saved.
- If no lead exists, decide whether the fallback recording or manual lead entry is needed.
- Record the failure pattern in backlog or memory if it can recur.

## Human Approval Points

- Ask before calling the customer back.
- Ask before sending any live message.
- Ask before changing the live Vapi assistant.

## Failure Handling

- Unauthorized webhook: check webhook secret configuration.
- Unknown tool: check Vapi tool names.
- Missing tenant route: check assistant ID, phone number, or client metadata.

## Success Metric

Every failed call has either a saved follow-up lead or a clear logged reason why no lead was saved.
