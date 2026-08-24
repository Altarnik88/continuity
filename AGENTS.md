# Agent instructions

This checkout is Continuity. On `/continuity` you are immediately the **Conductor**: recover memory, fill the task database, and dispatch 5–20 isolated sub-agents across analysis, implementation, blind verification, security, and review. Appoint a Manager at size 10+. Only the user may accept.

Use the Continuity Memory CLI from this worktree. Use the Coordinator CLI only when the user wants sequential agent management. Do not require any other Skill. Do not fork journal logic.

## Resolve the CLIs

```bash
node continuity/scripts/continuity.mjs
node continuity/scripts/launch.mjs
node continuity/scripts/coordinator.mjs
```

The canonical Skill is `continuity/SKILL.md`. Files under `.cursor/skills` and `.grok/skills` are discovery pointers only.

Run the Memory CLI from the target Git worktree. Optional `--root` must name that worktree's exact top level. The store is `<repository>/.continuity`, never the Skill directory.

## Start with read-only inspection

```bash
node continuity/scripts/continuity.mjs doctor
node continuity/scripts/continuity.mjs inspect
node continuity/scripts/continuity.mjs inspect ready --json
```

`inspect`, `inspect ready`, and `inspect wave` do not repair the projection. If `inspect ready` reports `plan.missing`, stop assigning work; do not invent missing requirements.

## Truth axes

Keep these distinct:

- an attempt or report is not evidence;
- successful execution is not independent verification;
- verification is not freshness;
- freshness is not user acceptance.

Authorizing evidence is a linked `command` or `test` observation with exit code `0`. Independent verification requires a different actor and run plus explicit counts. Only `--as user` may accept or reject a result. Rejection also requires `--next`.

## Record only durable verified facts

Read-only, trivial, no-op, or inconclusive work should not write continuity data. Never record secrets, personal data, raw logs, raw diffs, command output, or private absolute paths. After a write, run `validate` and `inspect`. Never edit the store or delete a lock silently.

## Optional Coordinator

Coordinator is optional. Memory never starts it.

```bash
node continuity/scripts/coordinator.mjs doctor --root .
node continuity/scripts/coordinator.mjs plan --root .
```

Coordinator must not accept work for the user and must not treat executor reports as proof.

Follow `continuity/SKILL.md`, `continuity/references/project-execution.md`, and `continuity/references/security-workflow.md`.
