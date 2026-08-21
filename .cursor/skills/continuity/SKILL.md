---
name: continuity
description: Inspect, initialize, validate, diagnose, and update bounded, source-backed project continuity across coding sessions. Use at the start of nontrivial repository work to recover goals, constraints, active tasks, evidence age, source drift, and Git drift; use after material work to record only durable verified facts and explicit user acceptance.
---

# Continuity

This file is a Cursor discovery pointer. The canonical Skill is [`continuity/SKILL.md`](../../../continuity/SKILL.md). Invoke the CLIs from this checkout. Do not fork journal logic. Do not require any other Skill.

```bash
node continuity/scripts/continuity.mjs doctor
node continuity/scripts/continuity.mjs inspect
node continuity/scripts/continuity.mjs inspect ready --json
node continuity/scripts/coordinator.mjs doctor --root .
```

Keep attempt/report, evidence, execution, independent verification, freshness, and user acceptance distinct. Only `--as user` may accept or reject a result.

Read `AGENTS.md` and `continuity/SKILL.md` for the protocol.
