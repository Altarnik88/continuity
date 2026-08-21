# TaskAccumulator

The accumulator is derived from the v3 projection. Replay of `HISTORY.ndjson` restores it.

## Required fields

| Field | Notes |
|-------|--------|
| `id` | `taskId` |
| `title` | |
| `goalId` | must reference the final goal |
| `criterionIds` | at least one existing criterion |
| `sourceContext` | falls back to `scope` |
| `priority` | `blocker` \| `core` \| `verification` \| `backlog` |
| `size` | `XS` \| `S` \| `M` \| `L` \| `XL` |
| `complexity` | `low` \| `medium` \| `high` \| `unknown` |
| `risk` | `routine` \| `significant` \| `critical` |
| `requiredCapabilities` | capability profiles, not vendor names |
| `dependencies` | unfinished dependency ids block readiness |
| `ownershipScope` | repository-relative paths or modules |
| `acceptanceCriteria` | per-task |
| `focusedVerification` | finite checks for this task only; coordinator packets need exactly one Node.js argv encoded as a JSON string, for example `["-e","process.exit(0)"]` |
| `status` | execution enum |
| `actor` | current assignment actor, if any |
| `evidenceLinks` | |
| `attemptLinks` | |
| `createdAt` | |
| `freshness` | derived from linked evidence |
| `recommendedNextAction` | exact next verb |

Priority, size, complexity, and risk are independent. They are never folded into one score.

## Weights

`XS=1`, `S=2`, `M=4`, `L=8`. `XL` has no assignable weight and must be split before assignment.

## Priority rules

`blocker` outranks `core`, then `verification`. `backlog` is parking, not a hidden ready queue.

A required criterion (`waivableByUser: false`) cannot be parked if it would leave no remaining active task and is not already satisfied by a succeeded, independently passed Result with fresh authorizing command/test evidence.

## Classes and Build-First

Before the Build-First gate, only `function`, `connector`, `blocker`, and `handoff` are directly allowed. Every other class, including `unclassified`, fails closed.

The gate passes only after a succeeded Result for a `core` `function` or `connector` task has linked authorizing, passed command/test evidence. Failed or partial Results and executor reports cannot pass it.

`enablesTaskIds` is valid only for `wrapper` and `infrastructure`. Before the gate, such a task is allowed only when the field names an unfinished core product task.

## Recipe fields

`record task` accepts `--title` plus optional `--priority`, `--size`, `--complexity`, `--risk`, and `--class`. Omitting `--class` persists `unclassified`. `--class` is valid only on `record task`; unknown values are rejected with no journal effect. Structured `--file` drafts remain for the remaining fields, including `focusedVerification`. There is no `--focused-verification` flag.
