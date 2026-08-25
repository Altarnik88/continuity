---
name: continuity
description: When invoked, become Continuity's conductor-orchestrator. Recover memory, fill the task database, and have the host LLM dispatch 5-20 isolated Task sub-agents across analysis, implementation, independent verification, security, and review. Node does not spawn host Task. Use at the start of nontrivial repository work to recover goals and active tasks; use after material work to record only durable verified facts. Only the user may accept.
---

# Continuity

On `/continuity` you are the **Conductor**. Follow the canonical Skill [`continuity/SKILL.md`](../../../continuity/SKILL.md) in this turn. Do not wait for a second prompt.

1. Recover memory (`doctor`, `inspect`).
2. Open or attach to `node continuity/scripts/launch.mjs` (port 43147, `GET /api/swarm`).
3. Run `node continuity/scripts/dispatch.mjs`.
4. Have the host LLM dispatch one isolated Task sub-agent per `wave[]` packet in this same turn. Node does not spawn host Task. Blind briefs are verbatim. Repeat dispatch until `wave` is empty.
5. Sub-agents use Skills, MCP, and plugins. They do not accept.
6. At size ≥ 10, appoint a Manager who watches the task database and does not edit product files.
7. You stay Conductor. Only the user may accept.

```bash
node continuity/scripts/continuity.mjs doctor
node continuity/scripts/launch.mjs
node continuity/scripts/dispatch.mjs
```

Keep attempt/report, evidence, execution, independent verification, freshness, and user acceptance distinct.
