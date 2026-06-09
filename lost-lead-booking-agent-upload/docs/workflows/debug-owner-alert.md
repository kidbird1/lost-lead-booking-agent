# Debug Owner Alert Workflow

## Trigger

A lead is saved but the owner alert is missing, skipped, or failed.

## Inputs

- Lead ID
- Client ID
- Owner phone and WhatsApp settings
- Twilio sender settings
- `/admin/status` output

## Agent Tasks

- Open the lead detail page.
- Read the owner notification mode, channel, status, and error.
- Check `/admin/status` for Twilio and owner setup.
- Use the protected resend-owner action only after confirming the lead belongs to the right client.

## Human Approval Points

- Ask before sending live messages.
- Ask before changing Twilio or Render production settings.

## Failure Handling

- Missing owner number: update client config.
- Missing Twilio sender: keep alerts in test mode.
- Twilio delivery issue: check Twilio logs, then record the reason in project memory.

## Success Metric

The lead shows an owner notification status that explains whether the alert was sent, skipped, or blocked.
