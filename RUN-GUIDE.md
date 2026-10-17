# Run Guide

**Log line:** A business misses a call, Vapi answers, the Worker saves the lead, and the owner gets a WhatsApp.

Everything lives in `worker/`. The old Render version is in `archive/` (kept, not deleted).

```
Caller → business phone (no answer) → forwards to Vapi number → Vapi agent talks
       → call ends → Vapi sends report to Cloudflare Worker → saved in D1
       → owner gets WhatsApp (SMS if WhatsApp fails) → you get a daily summary
```

## Files

| File | What it does |
|---|---|
| `worker/src/index.js` | Gets the call report from Vapi, saves it, runs the admin page |
| `worker/src/messages.js` | WhatsApp/SMS to owners, retries, your daily summary |
| `worker/src/vapi.js` | The agent's script, and setting up a client in Vapi |
| `worker/src/admin.js` | The admin page (connections, clients, calls, problems) |
| `worker/scripts/client.mjs` | Operator commands: add, pause, resume, status |
| `worker/clients/*.json` | One file per client (kept off GitHub: has phone numbers) |

## One-time setup (about 20 minutes)

Run these from the `worker` folder.

1. **Log in to Cloudflare:** `npx wrangler login` (a browser opens, you sign in).
2. **Make the database:** `npx wrangler d1 create missed-call-agent`. Copy the `database_id` it prints into `wrangler.toml`.
3. **Make the tables:** `npm run db:remote`
4. **Add the secrets** (each one asks you to paste the value):
   - `npx wrangler secret put ADMIN_PASSWORD`: any long password for the admin page
   - `npx wrangler secret put VAPI_API_KEY`: Vapi dashboard → API Keys → **private** key
   - `npx wrangler secret put VAPI_SERVER_SECRET`: any long random text
   - `npx wrangler secret put TWILIO_ACCOUNT_SID`
   - `npx wrangler secret put TWILIO_AUTH_TOKEN`
5. **Fill in `[vars]` in `wrangler.toml`:** your WhatsApp sender, your own WhatsApp (`OPERATOR_WHATSAPP`), and the SMS number.
6. **Go live:** `npm run deploy`. It prints your URL, like `https://missed-call-agent.YOURNAME.workers.dev`.
7. **Open `/admin`** on that URL. The username can be anything; the password is your ADMIN_PASSWORD. Most of the Connections boxes should be green.
8. **Point the operator commands at it:** put this in `worker/.ops.env`:
   ```
   WORKER_URL=https://missed-call-agent.YOURNAME.workers.dev
   ADMIN_PASSWORD=your-password
   ```

## First real test (you as the client)

1. Copy `clients/example.json` to `clients/me.json` and put **your** WhatsApp number in it.
2. Run `node scripts/client.mjs add clients/me.json`. This creates the Vapi agent and a phone number.
3. If you're using the Twilio sandbox, text `join <your-word>` to the sandbox number from your WhatsApp first.
4. Set `SEND_LIVE = "true"` in `wrangler.toml` and run `npm run deploy`.
5. Call the agent's number and pretend to be a customer. Hang up. The WhatsApp should arrive within about a minute.

## Adding a paying client

1. Make `clients/their-business.json` (copy the example).
2. Run `node scripts/client.mjs add clients/their-business.json`. It prints their agent number.
3. They turn on **"forward when busy / no answer"** on their business phone to that number. Every carrier does this differently: search "<carrier> conditional call forwarding". Test it together on the phone.
4. Didn't pay? `node scripts/client.mjs pause their-business` and their number stops answering. `resume` turns it back on.

To change their agent (new services, new hours), edit the file and run `add` again. It updates the agent and doesn't buy a second number.

## Running it day to day

- **Every morning** you get a WhatsApp: calls caught per client, and any failed alerts.
- **If an owner alert fails 5 times**, you get a WhatsApp with the full lead so you can pass it on yourself.
- **`node scripts/client.mjs status`** prints everything as data. Claude or Codex can run this and tell you what's wrong.
- **Failed alerts** retry on their own every 10 minutes.

## WhatsApp for real clients (do this early, it takes days)

The sandbox is only for testing. For paying clients:

1. In Twilio, register a WhatsApp sender on your own business number. Meta has to approve it.
2. In Twilio Content Template Builder, make a **Utility** template like:
   `New missed call for {{1}}. Name: {{2}}. Call back: {{3}}. Job: {{4}}. Address: {{5}}. Urgency: {{6}}. Best time: {{7}}.`
3. Once it's approved, put its `HX...` id in `WHATSAPP_TEMPLATE_SID` and redeploy.

For the SMS backup in the US, register the Twilio number for **A2P 10DLC** (also takes days).

## Testing on your computer

```
npm install
npm run db:local
npm run dev                                     # local server on :8787
node scripts/client.mjs add clients/test.json   # with "vapi_assistant_id": "test-assistant"
node scripts/fake-call.mjs test-assistant       # pretend call
```
`.dev.vars` holds the local passwords (it is not on GitHub).

## Costs

- Cloudflare Workers + D1: free plan is plenty.
- Vapi: per minute of calls, plus phone numbers.
- Twilio: per message.
