# Twilio WhatsApp Research

Question:
Can we use WhatsApp in the MVP?

Short answer:
Yes, but use WhatsApp for confirmations and follow-up, not for answering phone calls.

Best option:
Twilio Voice for calls. Twilio WhatsApp for messages. SMS fallback.

Why:
Twilio WhatsApp uses the same Programmable Messaging API style, but business-initiated WhatsApp messages usually need approved templates. Freeform replies are allowed inside the WhatsApp customer service window after the user messages the business.

MVP use:

- customer appointment confirmation
- owner booked-job alert
- reminder message
- follow-up if the caller asks for updates

Requirements:

- Twilio-approved WhatsApp sender for production
- templates for business-initiated notifications
- customer opt-in/consent
- fallback to SMS
- webhook endpoint for inbound WhatsApp replies

Risks:

- WhatsApp templates can be rejected or classified as marketing.
- Bulk follow-up needs clear consent.
- SMS in the US may need A2P 10DLC registration.
- For first demo, Twilio WhatsApp Sandbox may be enough.

Sources:

- https://www.twilio.com/docs/whatsapp
- https://www.twilio.com/docs/whatsapp/api
- https://www.twilio.com/docs/sms/api/message
- https://www.twilio.com/docs/whatsapp/key-concepts
- https://www.twilio.com/docs/whatsapp/quickstart
- https://www.twilio.com/en-us/legal/messaging-policy

Next action:
Build message layer with `sendWhatsAppOrSms()` so WhatsApp can fail over to SMS.

