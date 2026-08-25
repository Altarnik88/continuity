# Continuity and Coordinator contract

Compatibility identifier: `project-memory.coordinator.v1`
Contract version: `1`

The identifier is retained as a stable compatibility value for existing protocol consumers. It is not the product name or a dependency on another Skill.

Input may come directly from the user or from any planning tool that supplies a ready goal, criteria, and plan grounded in the user's intent. A planning tool is optional and is not a Continuity dependency. Missing input remains an explicit plan gap.

Continuity owns the authoritative append-only journal and the validated state recorded or derived from it: goals, criteria, TaskAccumulator and dependency data, decisions, derived ready sets and waves, WorkPacket and assignment records, actors, context rollover, attempts, results, evidence, verification, freshness, user acceptance, failures, blockers, conflicts, lessons, backlog, handoff, and the rebuildable projection.

An optional Coordinator in the agent environment consumes those outputs. It chooses from available models and actors, distributes validated WorkPackets, launches executors and independent verifiers, manages load and file ownership in the execution environment, integrates results, and applies repair or replan policy.

The Memory CLI does not launch a planner, Coordinator, daemon, network client, model, executor, verifier, or interview. It may invoke required local Git commands to read repository state. There is no top-level `coordinate` command on the Memory CLI. The optional Coordinator runtime is `scripts/coordinator.mjs`. A Coordinator never writes journal bytes directly; every continuity write goes through this helper.

## Operations

All writes go through `record <recipe>` or `record --file`. All reads are `inspect`, `inspect ready`, `inspect wave`, `handoff`, `validate`, `doctor`, `history`. `rebuild` is the projection-repair write, not a query. `inspect ready` and `inspect wave` remain read-only even when the projection is missing, stale, or invalid.

| Need | Command | Effect |
|------|---------|--------|
| Plan a core task | `record task --title <text> --priority core --class function` | `task.planned` |
| Ready tasks and next actions | `inspect ready [--json]` | read-only |
| Next wave | `inspect wave --json [--file agents.json]` | read-only |
| Persist a packet | `record packet --task <id>` | `work_package.recorded` |
| Assign a packet | `record assign --task <id> --assignee <actor-id>` | `assignment.recorded` |
| Start work | `record start` | `attempt.started` |
| Executor report | `record report` | `attempt.reported` (not evidence) |
| Partial/fail/block | `record fail` / `record result --execution partial` | existing v3 events |
| Close a planned next action | `record next --subject <id> --execution succeeded` | `next_action.status_changed` |
| Context rollover | `record context` | `context_handoff.recorded` |
| Release assignment | `record release --assignment <id>` | `assignment.released` |
| Independent verification | `record verify --as <verifier-kind>` | `verification.recorded` |
| Park optional work | `record backlog` | `backlog.parked` |
| Final handoff | `handoff` | read-only |

Rejected writes leave the journal unchanged.

`--as` selects `actor.kind` only. `--actor-id` and `--run-id` select the writer `actor.id` and `runId`. `record assign` requires `--assignee` for the owned actor; writer `--actor-id` is not the assignee. Omitting writer identity still defaults to `actor-<kind>` and `run-cli`; those defaults are not independent identities and cannot self-verify. A complete `record --file <draft.json>` draft remains valid. Independent verification is described in [project-execution.md](project-execution.md).

Multi-event recipes preflight every draft against the projected intermediate states before the first append. After a successful preflight, the validated events append sequentially; this is not a single transactional append guarantee.

## Required cycle

1. The user or an optional planning tool supplies a ready goal, criteria, and plan through validated helper input.
2. Coordinator reads `inspect ready` when external coordination is in use.
3. Continuity returns the active goal, required criteria, available tasks, dependencies, previous attempts, failed/forbidden approaches, blockers, ownership, live freshness, required capabilities, and the exact next action per task.
4. Continuity derives candidate WorkPackets through `inspect wave` or local `buildWorkPackets`; Coordinator selects and distributes a packet.
5. Coordinator selects an available actor/model, records `assign --assignee` through the helper, and actually launches the executor in the agent environment.
6. The actor records `start`, then a structured `report` / `result` / `fail` through the helper.
7. Continuity validates and appends. Executor text is not authorizing evidence.
8. Coordinator launches a different eligible actor/run for independent verification when required, then records `verify` through the helper.
9. Coordinator integrates the verified result or replans after failure. Continuity rebuilds the projection on write and derives the next ready set and wave. Read-only inspect does not repair a missing projection; use `rebuild`.

## Honest plan gaps

`inspect ready` includes `plan.sufficient` and `plan.missing`. Missing `project`, `goal`, `criteria`, or `taskAccumulator` is reported. The user or any chosen planning tool may provide the missing ready input. Continuity does not interview, invent a product goal, or start a specification session.

`interview.offered` is always `false`.

## Mutual protection

- Only `actor.kind=user` (`--as user` on a recipe path) may set acceptance.
- Coordinator cannot turn its own words into authorizing evidence.
- A subagent cannot verify or accept its own Result.
- Attempt/`report` ≠ evidence. Assignment ≠ done. `succeeded` ≠ verification passed. Passed ≠ fresh. Fresh ≠ accepted.
- A historical PASS is not a current PASS. Freshness is live Git plus evidence, recomputed at inspect.
- Actor replacement requires a new Attempt.
- Conflicting claims stay as Conflict.
- Invalid assignment or backlog hide of a required criterion has a proven no-effect.
