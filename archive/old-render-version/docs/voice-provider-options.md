# Voice Provider Options

## Important Distinction

Consumer voice chat is not enough.

We need a voice agent that can connect to phone calls, webhooks, tools, calendar, and backend actions.

## Good Production Criteria

- works with phone calls
- supports realtime conversation
- can call tools/functions
- connects to Twilio or SIP
- supports webhooks
- has logs/transcripts
- can be tested safely
- has predictable pricing

## Options To Evaluate

### OpenAI Realtime API

Strong option for custom voice agents.

Useful because it supports realtime speech and server-side tool calling.

### Google Gemini Live API

Worth evaluating for realtime voice and video agents.

Good candidate if Google tooling fits the stack.

### Vapi / Retell / Synthflow / ElevenLabs

Fastest path for MVP.

These are voice-agent platforms that often make Twilio-style phone workflows easier.

### Grok / xAI

Track as a possible future option.

Only use for this product if there is a production API that supports phone calls, tool use, logs, and webhooks.

## MVP Recommendation

Start with Vapi for the first phone-agent MVP.

Keep OpenAI Realtime API as the custom v2 path if we need deeper control.

Do not choose based on brand.

Choose based on:

- phone integration
- webhook support
- calendar/tool calls
- reliability
- cost

Current decision:

```text
MVP: Vapi
Backup: Retell
Custom v2: Twilio Voice/SIP + OpenAI Realtime
Messaging: Twilio WhatsApp with SMS fallback
```
