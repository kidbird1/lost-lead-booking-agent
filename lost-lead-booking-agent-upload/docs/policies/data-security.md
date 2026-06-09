# Data Security Policy

## Sensitive Data

Treat these as sensitive:

- API keys
- Tokens
- Phone numbers
- Customer names
- Addresses
- Call transcripts
- Calendar details
- Webhook secrets

## Agent Rules

- Use env vars for secrets.
- Do not hardcode credentials.
- Do not paste real tokens into docs or chat.
- Keep client data scoped by client ID and viewer token.
- Log enough to debug without exposing secrets.

## Human Approval

Ask before:

- Enabling live messages
- Connecting a real calendar
- Storing call recordings
- Exporting client data
- Changing production secrets

## Success Metric

Each client can only access their own lead data, and no secret appears in committed files.
