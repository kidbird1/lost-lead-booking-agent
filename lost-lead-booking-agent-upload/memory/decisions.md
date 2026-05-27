# Decisions

## 2026-05-21

- Product direction: AI missed-call booking agent for home service businesses.
- First promise: "You miss calls. We answer them. You get more booked jobs."
- MVP should be narrow: one call flow, one calendar, one owner notification, one lead log.
- Render is available for 24/7 hosting.
- Avoid building a large SaaS dashboard before proving the call-to-booking flow.
- Twilio is available.
- Use Twilio Voice for calls.
- Use Twilio WhatsApp for confirmations/follow-up where available, with SMS fallback.
- Skills, guardrails, and security are first-class project assets.
- Research Agent added.
- WhatsApp decision: use for confirmations/follow-up, with SMS fallback.
- Voice provider decision: Vapi for MVP; Retell backup; OpenAI Realtime as custom v2.
- First niche for MVP: home service contractors, starting with roofing/HVAC style call flow.

## 2026-05-27

- Booking reliability rule: the `bookAppointment` tool is the primary booking record.
- Vapi end-of-call reports are fallback-only and should not create a second lead when the call already saved through the booking tool.
- Scheduling rule: natural appointment times are parsed in the business timezone, and requests outside business hours are saved for owner follow-up instead of treated as confirmed bookings.
- Calendar rule: when live Google Calendar booking is enabled, the backend checks free/busy before creating the event. Busy or unconfirmed slots are saved as follow-up instead of confirmed bookings.
- Calendar tool rule: Riley should ask the backend for available Google Calendar slots before offering exact appointment times. Google Calendar remains the source of truth; Calendly can stay optional for public booking links later.
