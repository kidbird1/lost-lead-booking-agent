# Pilot Onboarding Checklist

Use this once per tenant.

## 1. Collect Client Info

- Business name
- Industry
- Services
- Service area
- Business hours
- Timezone
- Owner phone
- Owner WhatsApp
- Existing booking link, if any
- Emergency policy

## 2. Create Client

1. Open `/admin/onboarding?token=ADMIN_TOKEN`.
2. Fill the client profile.
3. Add Vapi assistant ID.
4. Add Vapi phone number or ID if available.
5. Click **Save Client**.
6. Copy the private lead viewer token/link.

## 3. Configure Vapi

- First message from onboarding.
- System prompt from onboarding.
- Tool/server URL:

```text
https://lost-lead-booking-agent.onrender.com/webhooks/voice?webhook_secret=WEBHOOK_SHARED_SECRET
```

## 4. Run Test Call

Use the final test-call script.

Confirm:

- Lead saves under the correct client.
- Owner alert queues/sends.
- Lead appears in viewer.
- No duplicate lead is created.
- Agent says the team will confirm.

## 5. Handoff

- Give owner the private lead viewer link.
- Explain lead statuses.
- Explain owner alert behavior.
- Explain that calendar booking is optional.

## 6. Monitor

After launch, check:

- `/admin/issues?token=ADMIN_TOKEN`
- `/admin/leads?token=ADMIN_TOKEN`
- `/admin/events?token=ADMIN_TOKEN`

