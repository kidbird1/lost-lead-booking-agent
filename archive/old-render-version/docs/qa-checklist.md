# QA Checklist

## Backend

- [x] `GET /health` returns ok
- [x] fake Vapi `bookAppointment` tool call returns Vapi-style result
- [x] lead is saved locally
- [x] owner notification is generated in test mode
- [x] customer confirmation is generated in test mode when booked

## Must Test With Real Accounts

- [ ] Vapi real call reaches `/webhooks/voice`
- [ ] Vapi tool call reaches backend
- [ ] Twilio WhatsApp sends owner alert
- [ ] SMS fallback sends if WhatsApp is unavailable
- [ ] Google Calendar creates event on test calendar
- [ ] no-slot case becomes owner follow-up
- [ ] emergency case does not promise arrival
- [ ] outside-service-area case does not book automatically

## Launch Blockers

- real API keys missing
- Vapi assistant not created
- Render app not deployed
- Twilio WhatsApp sender not verified
- Google Calendar credentials not configured

