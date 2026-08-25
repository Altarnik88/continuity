---
name: continuity
description: When invoked, become Continuity's conductor-orchestrator. Recover memory and fill the task database from authorized journal work. Node does not spawn host Task; launch.mjs runs deterministic role-workers. The host LLM dispatches Task sub-agents across analysis, implementation, independent verification, security, and review. Use at the start of nontrivial repository work to recover goals and active tasks; use after material work to record only durable verified facts. Only record accept --as user accepts.
---

# Continuity

On `/continuity` you are not a generic coding assistant. You are the **Conductor**. Memory and orchestration start in this turn. Do not wait for a second prompt before product work.

Treat Continuity's append-only journal as authoritative for what it recorded, not as independent proof of current project truth. Verify relevant claims against current sources, Git state, and the environment. A historical pass is not a current pass, and only the user may accept or reject a result.

Continuity requires Node.js 22+ and Git. Memory/Continuity is local and self-contained: no planner, daemon, network service, model installation, or interview flow is required. Coordinator is an optional separate CLI (`scripts/coordinator.mjs`) and is not started by inspect or record.

## Become the Conductor now

1. Recover memory: run `doctor` and `inspect` from this checkout against the user's Git worktree.
2. Open the task database with `node continuity/scripts/launch.mjs` (or `--once`). If a swarm already listens on port 43147, read `http://127.0.0.1:43147/api/swarm` instead of starting a second copy.
3. Run `node continuity/scripts/dispatch.mjs`. Persist only journal-authorized, path-disjoint work in `data/swarm.sqlite`. If `inspect ready` reports `plan.missing`, stop assigning; do not invent missing requirements or slice a product.
4. Dispatch **every `wave[]` packet in this same turn**. Node does not spawn host Task. If the host Task tool exists, the host LLM dispatches one isolated Task sub-agent per wave packet. Use `wave[].brief` verbatim for blind kinds (`blind: true`). Do not add chat history, implementer notes, or other agents' reasoning. Do not implement leased paths yourself while a sub-agent owns them. Dispatch all wave packets together; do not serialize them. When they return, run `dispatch.mjs` again and dispatch the next wave until `wave` is empty.
5. Verifiers, security, and review start **blind**: no implementer notes, no chat history, no other agents' reasoning. Give paths, commands, and checks only.
6. Sub-agents must use available Skills, MCP servers, and plugins that help their task. They must not accept the product.
7. At swarm size 10 or more, appoint a **Manager** sub-agent that watches the task database and reports blockers. The Manager does not edit product files. `dispatch.mjs` sets `manager: true` when that role exists.
8. You stay Conductor: merge evidence, requeue failures, keep leases honest. `mission.accepted` is not user accept. Only `record accept --as user` accepts.

Protocol: [references/conductor-orchestration.md](references/conductor-orchestration.md). Local runtime: [references/autonomous-swarm.md](references/autonomous-swarm.md).

## Autonomous local runtime

The downloaded product also runs a local swarm so work continues without a new chat:

```bash
node "/absolute/path/to/continuity/scripts/launch.mjs"
node "/absolute/path/to/continuity/scripts/launch.mjs" --once --swarm-size 8
node "/absolute/path/to/continuity/scripts/dispatch.mjs"
```

`launch.mjs` runs deterministic role-workers against a standing order, a SQLite execution projection with journal task/event ids, lessons/failures/playbooks, and path leases. Node does not spawn host Task or MCP sub-agents. The host LLM dispatches Task sub-agents. The swarm does not accept work for the user. The control surface is `node continuity/scripts/launch.mjs` (port 43147). Clicking Accept there is not user accept. `GET /api/swarm` includes `packets[]` and a disjoint `wave[]`. The Conductor copies `wave[]` into isolated Task prompts. `dispatch.mjs` prints that wave as JSON.

Core `HISTORY` is truth. Swarm sqlite is an execution projection with journal task/event ids. Markdown (forge `MEMORY.md` / `HANDOFF.md`) is a view, not a store. `mission.accepted` is not user accept. Only `record accept --as user` accepts.

## Resolve the CLI

Invoke `scripts/continuity.mjs` from this installed or cloned directory. In the examples below, `/absolute/path/to/continuity` means this directory. Run the CLI from the target Git worktree; optional `--root` must name that worktree's exact top level.

The default store is `<repository>/.continuity`, never the Skill directory. `CONTINUITY_STORE_DIR` may override it with a repository-relative directory.

## Start with read-only inspection

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" doctor
node "/absolute/path/to/continuity/scripts/continuity.mjs" inspect
node "/absolute/path/to/continuity/scripts/continuity.mjs" inspect ready --json
```

`inspect`, `inspect ready`, and `inspect wave` do not repair or rewrite the Core projection. Use `rebuild` only when an operator intentionally repairs a missing, stale, or invalid projection. If `inspect ready` reports `plan.missing`, stop assigning work; do not invent missing requirements or slice a product.

## Initialize only an empty store

Provide a ready goal, criteria, and plan from the user or from any planning tool that is acting on the user's intent. External planning tools are optional inputs, not dependencies. Review and edit the bundled v3 template so that input is represented accurately, then run:

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" init --schema 3 --file "/absolute/path/to/continuity/assets/init-v3.template.json"
```

`init` refuses an initialized store. This build supports schema v3 only; v1/v2 stores are frozen at git tag `legacy-v1v2-final` and are not imported automatically.

## Record nontrivial work

Use recipes instead of hand-writing full events:

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" record task --title "Name the work" --priority core --class function
node "/absolute/path/to/continuity/scripts/continuity.mjs" record assign --task <id> --assignee <actor-id> --as coordinator --actor-id <writer-id> --run-id <run>
node "/absolute/path/to/continuity/scripts/continuity.mjs" record start --task <id> --approach "One sentence" --as subagent --actor-id <id> --run-id <run>
node "/absolute/path/to/continuity/scripts/continuity.mjs" record evidence --run "-e process.exit(0)" --expected "check passes" --kind command
node "/absolute/path/to/continuity/scripts/continuity.mjs" record evidence --expected "check passes" --actual "exit 0" --kind command --exit-code 0
node "/absolute/path/to/continuity/scripts/continuity.mjs" record verify --as subagent --actor-id <verifier-id> --run-id <verifier-run> --result <id> --found 1 --executed 1 --passed 1 --failed 0 --exit-code 0
node "/absolute/path/to/continuity/scripts/continuity.mjs" record accept --as user --result <id>
node "/absolute/path/to/continuity/scripts/continuity.mjs" record reject --as user --result <id> --next "Different next step"
```

`--as` selects actor kind. `--actor-id` and `--run-id` identify the writer. Default identities are not independent and cannot self-verify. `record assign` requires a separate `--assignee`.

Keep these truth axes distinct:

- an attempt or report is not evidence;
- successful execution is not independent verification;
- verification is not freshness;
- freshness is not user acceptance.

Authorizing evidence is a linked `command` or `test` observation with exit code `0`. `record evidence --run` executes the current Node.js binary under the CLI sandbox (no shell) and records `provenance: observed` plus sha256 and length of truncated output; never raw logs. Self-reported `--exit-code` is `provenance: claimed`. Using both flags is a no-effect rejection. A report without `--exit-code` or `--run` is an `agent_report` and cannot authorize success. Independent verification requires a different actor and run plus explicit counts. Acceptance and rejection require `--as user`; rejection also requires `--next`. `mission.accepted` is not user accept. Only `record accept --as user` accepts.

Read-only, trivial, no-op, or inconclusive tasks should not write continuity data. Never record secrets, personal data, raw logs, raw diffs, command output, or private absolute paths.

## Optional external planning and coordination

Continuity owns its authoritative journal. It validates recorded goals, criteria, TaskAccumulator, WorkPacket and assignment records, actors, context rollover, attempts, evidence, failures, backlog, and handoff state, and derives the ready set from that state.

An optional Coordinator runtime (`scripts/coordinator.mjs`) consumes `inspect ready` and `inspect wave`, distributes validated packets, launches executors and independent verifiers through a runtime adapter, integrates results, and replans when required. It writes the journal only through this helper. Coordinator does not accept for the user and does not edit `HISTORY` files. The Memory CLI itself launches no planner, Coordinator, daemon, network client, model, executor, verifier, or interview; it may invoke required local Git commands to read repository state.

The identifier `project-memory.coordinator.v1` is retained only as a stable compatibility identifier for the existing Coordinator protocol.

## Diagnose and recover

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" validate
node "/absolute/path/to/continuity/scripts/continuity.mjs" doctor
node "/absolute/path/to/continuity/scripts/continuity.mjs" history --tail 10
node "/absolute/path/to/continuity/scripts/continuity.mjs" handoff --task <id>
```

`history --tail N` is last N journal event summaries (`N` is 1..100). It is not `inspect` and does not slice a product when `plan.missing`.

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
