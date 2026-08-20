# Continuity and Coordinator contract

Compatibility identifier: `project-memory.coordinator.v1`
Contract version: `1`

The identifier is retained as a stable compatibility value for existing protocol consumers. It is not the product name or a dependency on another Skill.

Continuity owns goals, criteria, TaskAccumulator, decisions, actors, attempts, results, evidence, verification, freshness, user acceptance, failures, blockers, conflicts, lessons, context handoff, backlog, the append-only journal, and the rebuilt projection.

Coordinator owns the dependency graph, ready set, work packets, agent selection, load balancing, waves, file ownership, context replacement, integration, independent verification launch, and repair/replan policy.

Continuity does not run a daemon, network client, interview, or Graphify process. There is no top-level `coordinate` command. Coordinator never writes journal bytes except through this helper, and it launches nothing.

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
| Context rollover | `record context` | `context_handoff.recorded` |
| Release assignment | `record release --assignment <id>` | `assignment.released` |
| Independent verification | `record verify --as <verifier-kind>` | `verification.recorded` |
| Park optional work | `record backlog` | `backlog.parked` |
| Final handoff | `handoff` | read-only |

Rejected writes leave the journal unchanged.

`--as` selects `actor.kind` only. `--actor-id` and `--run-id` select the writer `actor.id` and `runId`. `record assign` requires `--assignee` for the owned actor; writer `--actor-id` is not the assignee. Omitting writer identity still defaults to `actor-<kind>` and `run-cli`; those defaults are not independent identities and cannot self-verify. A complete `record --file <draft.json>` draft remains valid. Independent verification is described in [project-execution.md](project-execution.md).

Multi-event recipes preflight every draft against the projected intermediate states before the first append. After a successful preflight, the validated events append sequentially; this is not a single transactional append guarantee.

## Required cycle

1. Coordinator reads `inspect ready`.
2. Continuity returns the active goal, required criteria, available tasks, dependencies, previous attempts, failed/forbidden approaches, blockers, ownership, live freshness, required capabilities, and the exact next action per task.
3. Coordinator forms WorkPackets (`inspect wave` or local `buildWorkPackets`).
4. Coordinator records `assign --assignee` for one actor.
5. The actor records `start`, then a structured `report` / `result` / `fail`.
6. Continuity validates and appends. Executor text is not authorizing evidence.
7. Coordinator records `verify` with a different actor when required.
8. Continuity rebuilds the projection on write. Read-only inspect does not repair a missing projection; use `rebuild`.
9. Coordinator builds the next wave from the new ready set.

## Honest plan gaps

`inspect ready` includes `plan.sufficient` and `plan.missing`. Missing `project`, `goal`, `criteria`, or `taskAccumulator` is reported. Continuity does not interview, invent a product goal, or start a specification session.

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

## Graphify

Graphify remains an optional navigation adapter. It is not a TaskAccumulator, scheduler, capability registry, evidence source, or acceptance authority.
