# Deploy Release Workflow

## Trigger

A production or pilot change is ready to ship.

## Inputs

- Git diff
- Backlog item
- Local check results
- Smoke test result
- Deployment target

## Agent Tasks

- Confirm the diff only includes intended files.
- Run `npm.cmd run check`.
- Run `npm.cmd run smoke`.
- Update decisions or backlog when the change affects product behavior.
- Commit to a clear branch.
- Push and open a PR when available.
- After deploy, check `/health` and the protected admin pages.

## Human Approval Points

- Ask before changing Render production env vars.
- Ask before enabling live SMS, WhatsApp, or calendar booking.
- Ask before merging if checks fail.

## Failure Handling

- If local checks fail, fix before deploy.
- If Render health fails, roll back or pause live testing.
- If live owner alerts fail, keep the client in test mode.

## Success Metric

The release is deployed, health checks pass, and the current pilot flow still saves a lead.
