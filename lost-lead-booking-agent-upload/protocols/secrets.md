# Secrets Protocol

Never commit real API keys.

Use environment variables.

Expected secrets:

```text
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
TWILIO_WHATSAPP_FROM=
VOICE_AGENT_API_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
DATABASE_URL=
OWNER_PHONE_NUMBER=
OWNER_WHATSAPP_NUMBER=
```

For local development, use `.env`.

For Render, add secrets in the Render dashboard.

Agents may create `.env.example`, but not `.env` with real keys.
