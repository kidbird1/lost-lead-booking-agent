# Security

## Sensitive Data

Treat these as sensitive:

- API keys
- phone numbers
- call transcripts
- customer names
- addresses
- calendar details
- webhook secrets

## Secret Storage

Use:

- local `.env`
- Render environment variables

Do not use:

- committed files
- markdown docs
- chat messages

## Live Action Rules

Ask before:

- sending real SMS
- calling real numbers
- connecting a real client calendar
- changing Render production settings
- storing call recordings

## MVP Security Standard

The MVP must have:

- `.env.example`
- no committed secrets
- test mode
- basic input validation
- clear fallback behavior
- minimal customer data storage

