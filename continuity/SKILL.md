---
name: continuity
description: Inspect, initialize, validate, diagnose, and update bounded, source-backed project continuity across coding sessions. Use at the start of nontrivial repository work to recover goals, constraints, active tasks, evidence age, source drift, and Git drift; use after material work to record only durable verified facts and explicit user acceptance.
---

# Continuity

Treat Continuity's append-only journal as authoritative for what it recorded, not as independent proof of current project truth. Verify relevant claims against current sources, Git state, and the environment. A historical pass is not a current pass, and only the user may accept or reject a result.

Continuity requires Node.js 22+ and Git. It is local and self-contained: no other Skill, planner, Coordinator, daemon, network service, model installation, or interview flow is required.

## Resolve the CLI

Invoke `scripts/continuity.mjs` from this installed or cloned directory. In the examples below, `/absolute/path/to/continuity` means this directory. Run the CLI from the target Git worktree; optional `--root` must name that worktree's exact top level.

The default store is `<repository>/.continuity`, never the Skill directory. `CONTINUITY_STORE_DIR` may override it with a repository-relative directory.

## Start with read-only inspection

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" doctor
node "/absolute/path/to/continuity/scripts/continuity.mjs" inspect
node "/absolute/path/to/continuity/scripts/continuity.mjs" inspect ready --json
```

`inspect`, `inspect ready`, and `inspect wave` do not repair or rewrite the projection. Use `rebuild` only when an operator intentionally repairs a missing, stale, or invalid projection. If `inspect ready` reports `plan.missing`, stop assigning work; do not invent missing requirements.

## Initialize only an empty store

Provide a ready goal, criteria, and plan from the user or from any planning tool that is acting on the user's intent. External planning tools are optional inputs, not dependencies. Review and edit the bundled v3 template so that input is represented accurately, then run:

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" init --schema 3 --file "/absolute/path/to/continuity/assets/init-v3.template.json"
```

`init` refuses an initialized store. Older store locations are not imported automatically.

## Record nontrivial work

Use recipes instead of hand-writing full events:

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" record task --title "Name the work" --priority core --class function
node "/absolute/path/to/continuity/scripts/continuity.mjs" record assign --task <id> --assignee <actor-id> --as coordinator --actor-id <writer-id> --run-id <run>
node "/absolute/path/to/continuity/scripts/continuity.mjs" record start --task <id> --approach "One sentence" --as subagent --actor-id <id> --run-id <run>
node "/absolute/path/to/continuity/scripts/continuity.mjs" record evidence --expected "check passes" --actual "exit 0" --kind command --exit-code 0
node "/absolute/path/to/continuity/scripts/continuity.mjs" record verify --as subagent --actor-id <verifier-id> --run-id <verifier-run> --result <id> --found 1 --executed 1 --passed 1 --failed 0
node "/absolute/path/to/continuity/scripts/continuity.mjs" record accept --as user --result <id>
node "/absolute/path/to/continuity/scripts/continuity.mjs" record reject --as user --result <id> --next "Different next step"
```

`--as` selects actor kind. `--actor-id` and `--run-id` identify the writer. Default identities are not independent and cannot self-verify. `record assign` requires a separate `--assignee`.

Keep these truth axes distinct:

- an attempt or report is not evidence;
- successful execution is not independent verification;
- verification is not freshness;
- freshness is not user acceptance.

Authorizing evidence is a linked `command` or `test` observation with exit code `0`. A report without `--exit-code` is an `agent_report` and cannot authorize success. Independent verification requires a different actor and run plus explicit counts. Acceptance and rejection require `--as user`; rejection also requires `--next`.

Read-only, trivial, no-op, or inconclusive tasks should not write continuity data. Never record secrets, personal data, raw logs, raw diffs, command output, or private absolute paths.

## Optional external planning and coordination

Continuity owns its authoritative journal. It validates recorded goals, criteria, TaskAccumulator, WorkPacket and assignment records, actors, context rollover, attempts, evidence, failures, backlog, and handoff state, and derives the ready set from that state.

An optional Coordinator in the agent environment consumes `inspect ready` and `inspect wave`, selects available models and actors, distributes validated packets, launches executors and independent verifiers, integrates results, and replans when required. It writes the journal only through this helper. Continuity itself launches no planner, Coordinator, daemon, network client, model, executor, verifier, or interview; it may invoke required local Git commands to read repository state. Neither a planner nor a Coordinator is a runtime dependency. Graphify is an optional navigation adapter and never a source of truth or acceptance authority.

The identifier `project-memory.coordinator.v1` is retained only as a stable compatibility identifier for the existing Coordinator protocol.

## Diagnose and recover

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" validate
node "/absolute/path/to/continuity/scripts/continuity.mjs" doctor
node "/absolute/path/to/continuity/scripts/continuity.mjs" history --tail 10
```

Do not edit the store or delete a lock silently. Follow [security-workflow.md](references/security-workflow.md) before checkpoint or lock recovery.

## Reference guides

- [Installation and clean-copy checks](references/installation.md)
- [Project execution](references/project-execution.md)
- [Coordinator contract](references/coordination.md)
- [Task accumulation](references/task-accumulator.md)
- [Scheduling](references/scheduling.md)
- [Context rollover](references/context-rollover.md)
- [Independent verification](references/verification-swarm.md)
- [Snapshot schema](references/schema.md)
