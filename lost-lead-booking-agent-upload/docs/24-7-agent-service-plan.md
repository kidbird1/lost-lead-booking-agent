# 24/7 Agent-as-a-Service Plan

## Product

We run an AI receptionist for home-service businesses.

```text
Customer calls
-> correct tenant's Vapi agent answers
-> agent collects the job details
-> backend saves one lead
-> owner receives WhatsApp or SMS
-> failures retry automatically
-> operator is alerted only when human action is needed
```

Render hosts the always-on backend. WhatsApp is the operator interface; it does not replace the backend.

## Buyer and Success

- Buyer: small home-service business already receiving calls.
- Pain: missed calls become lost jobs.
- Agent job: answer, qualify, save, and notify 24/7.
- Human review: emergencies, unclear requests, final booking confirmation, and exhausted failures.
- Success metric: missed calls converted into qualified leads or appointment requests.

## Current Grade — 6/10

### Working

- [x] Live Render service and Vapi call flow
- [x] Postgres lead and event storage
- [x] Multiple tenant profiles and routing
- [x] Tenant-specific private lead access
- [x] Owner WhatsApp/SMS notification path
- [x] Duplicate-call protection for normal webhook flow
- [x] Operator clients and Issues pages
- [x] Local tenant-isolation smoke tests
- [x] Owner-alert retry code and tests on PR #25

### Why It Is Not Yet 24/7 Production Grade

- Retry code is not deployed yet.
- Critical failures do not proactively notify the operator.
- Duplicate prevention is not atomic in Postgres.
- Provider webhook signatures are not fully verified.
- Database backup restoration has not been tested.
- Two real tenants have not completed the final live isolation test.

## Build Order

Work from top to bottom. Do not start deferred features until the definition of done passes.

### 1. Ship Reliable Owner Alerts

- [ ] Finish review of PR #25 without CodeRabbit.
- [ ] Merge and deploy owner-alert retry changes.
- [ ] Confirm the deployed commit in `/health`.
- [ ] Verify retry state without sending an unapproved live message.

### 2. Wake the Operator Only When Needed

- [ ] Use the existing WhatsApp setup as the operator alert destination.
- [ ] Alert on exhausted owner notifications, unknown tenant routes, database failures, and repeated webhook failures.
- [ ] Deduplicate operator alerts so one failure does not create message spam.
- [ ] Add a daily summary: calls, leads, successful alerts, failures, and unresolved issues.
- [ ] Keep live outbound alerts disabled until explicitly approved.

### 3. Prevent Duplicate or Misrouted Leads

- [ ] Make lead creation idempotent and atomic by tenant plus provider call ID.
- [ ] Safely handle simultaneous webhook retries.
- [ ] Keep unknown routes from saving under a default tenant.
- [ ] Test two tenants receiving calls at nearly the same time.

### 4. Harden External Access

- [ ] Verify Vapi webhook authenticity using the strongest supported method.
- [ ] Verify Twilio webhook signatures.
- [ ] Prefer authorization headers over tokens in URLs.
- [ ] Keep tenant tokens hashed and tenant-scoped.
- [ ] Add safe request-size and malformed-payload limits.

### 5. Add Recovery and Monitoring

- [ ] Monitor the public health endpoint from outside Render.
- [ ] Alert when the service or database is unavailable.
- [ ] Confirm Render Postgres backups are enabled.
- [ ] Perform and document one backup restoration test.
- [ ] Confirm deployment rollback instructions work.
- [ ] Confirm restart recovery for pending owner-alert retries.

### 6. Make Tenant Onboarding Repeatable

- [ ] Use one onboarding checklist for business profile, services, service area, hours, owner contact, and Vapi routing.
- [ ] Generate one private lead-viewer link per tenant.
- [ ] Run normal-call, duplicate-call, after-hours, emergency, and failed-alert tests.
- [ ] Do not mark a tenant live until the owner sees one successful test lead.
- [ ] Record the deployed tenant configuration without storing secrets in documentation.

### 7. Prove the Basic Service

- [ ] Complete Demo Roofing production Issues-page verification.
- [ ] Add a second test tenant with separate routing and access.
- [ ] Run one live approved test call for each tenant.
- [ ] Confirm no lead, event, issue, or export crosses tenant boundaries.
- [ ] Run the service for seven days with no unresolved critical issue.
- [ ] Onboard the first paying pilot manually.

## Definition of Done

The basic service is ready when:

- two tenants can receive calls without mixed data;
- one provider call creates exactly one lead;
- owner alerts recover from temporary failures;
- permanent failures notify the operator once;
- the service and database are externally monitored;
- backups and restoration are tested;
- onboarding follows one repeatable checklist; and
- normal operation requires no daily action from Mike.

## Intentionally Deferred

Deferred means “not needed for the basic paid service yet,” not “never.”

- Custom mobile app: use WhatsApp instead.
- Telegram: optional later, after WhatsApp operation is proven.
- CRM integration: the lead viewer and exports are enough for initial pilots.
- Automated billing: invoice the first pilots manually, then add Stripe Link after the core service is reliable and the billing workflow is defined.
- Customer self-service dashboard.
- Advanced analytics and reporting.
- Complex calendar and dispatch automation.
- Broad integrations marketplace.

## Working Rule

Complete one checked slice, test it, update this file, and then move to the next unchecked item. Never send live calls or messages, change production secrets, or connect financial accounts without explicit approval.
