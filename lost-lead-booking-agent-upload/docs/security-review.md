# Security Review

## Current Safe Defaults

- live messaging is off
- live calendar booking is off
- `.env` is ignored
- lead data is local and ignored by git
- no real API keys are committed
- no real customer data is in docs

## Sensitive Data

Treat these as sensitive:

- caller name
- phone number
- address
- call transcript
- recording URL
- API keys
- calendar event data

## Before Live Pilot

- [ ] put real secrets only in Render env vars
- [ ] test with fake customer data first
- [ ] confirm WhatsApp/SMS consent language
- [ ] avoid call recording unless needed
- [ ] add privacy note to pilot agreement
- [ ] confirm emergency fallback language
- [ ] use a test calendar before client calendar

## Never

- commit `.env`
- paste keys into chat
- send bulk WhatsApp/SMS without consent
- store call recordings by default
- promise emergency service

