# Business Profile

## Goal

Make the booking agent reusable for different businesses without changing code.

One deployed service can be configured for one client by changing Render environment variables.

## Basic Env Vars

```text
BUSINESS_NAME="Blue Sky Plumbing"
ASSISTANT_NAME=Riley
BUSINESS_INDUSTRY=plumbing
BUSINESS_SERVICES="drain cleaning, leak repair, water heater service"
BUSINESS_SERVICE_AREAS="33487, 33485"
```

## Full JSON Option

Use `BUSINESS_PROFILE_JSON` when the profile needs more detail.

```json
{
  "businessName": "Blue Sky Plumbing",
  "assistantName": "Riley",
  "industry": "plumbing",
  "services": ["drain cleaning", "leak repair", "water heater service"],
  "serviceAreas": ["33487", "33485"],
  "intakeFields": [
    "service needed",
    "caller name",
    "phone number",
    "address or ZIP code",
    "preferred day or time"
  ],
  "neverSay": [
    "Do not quote exact prices.",
    "Do not promise emergency arrival.",
    "Do not diagnose dangerous problems."
  ]
}
```

## Agent Context

After setting the profile, open:

```text
GET /api/agent-context?token=YOUR_LEAD_VIEWER_TOKEN
```

This returns:

- the public business profile
- the first Vapi message
- the full Vapi system prompt

Copy those into Vapi for the client.

For a copy-friendly setup page, open:

```text
GET /admin/profile?token=YOUR_LEAD_VIEWER_TOKEN
```

This page shows the profile, prompt, first message, webhook URL, and Render env snippet.

## Scale Rule

For the MVP, use one Render service per client.

Later, move profiles into a database and route by phone number.
