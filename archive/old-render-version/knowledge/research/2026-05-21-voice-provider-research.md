# Voice Provider Research

Question:
What voice stack should we use first for the missed-call booking agent?

Short answer:
Use a voice-agent platform first, not a fully custom voice stack.

Best option:
Vapi or Retell for the first MVP.

Why:
They are built for phone agents, webhooks, tool calls, call logs, and appointment workflows. They are faster to ship than wiring raw Twilio Media Streams to a realtime model ourselves.

OpenAI Realtime API is strong, but better as a custom v2 path after the MVP works.

Provider notes:

- Vapi supports phone calls, tools, APIs, databases, appointment scheduling, and Twilio SIP integration.
- Retell has pay-as-you-go pricing, webhooks/API access, transcripts, simulation testing, and built-in safety/PII features.
- ElevenLabs has native Twilio integration and strong voice quality.
- Synthflow connects directly to Twilio and is no-code friendly.
- OpenAI Realtime supports SIP, so a Twilio SIP trunk can connect phone calls directly to OpenAI.

Risks:

- Voice platforms can get expensive per minute.
- WhatsApp/SMS compliance still sits on us.
- Phone-agent reliability matters more than model quality.
- Custom OpenAI/Twilio setup gives more control but takes longer.

Sources:

- https://docs.vapi.ai/
- https://vapi.ai/pricing
- https://www.retellai.com/pricing
- https://platform.openai.com/docs/guides/realtime-sip
- https://www.twilio.com/docs/voice/media-streams
- https://elevenlabs.io/docs/conversational-ai/guides/twilio/native-integration
- https://docs.synthflow.ai/integrate-twilio

Next action:
Pick Vapi or Retell for the first prototype, then build the call flow.

