# Production Agents

This folder contains the worker-agent prompts for building the company.

Use this chat as the Orchestrator.

Create new chats only when a task is clear.

Each worker chat should:

1. read `AGENTS.md`
2. load its assigned skill
3. follow guardrails and security
4. complete one narrow task
5. update `tasks/backlog.md` and `memory/run-log.md`

## Agent List

1. `agents/research-agent.md`
2. `agents/product-agent.md`
3. `agents/voice-agent.md`
4. `agents/backend-agent.md`
5. `agents/integrations-agent.md`
6. `agents/security-agent.md`
7. `agents/qa-agent.md`
8. `agents/sales-agent.md`
