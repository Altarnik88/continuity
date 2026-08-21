# Project execution

Use this loop for nontrivial implementation. Read-only queries, trivial edits, and no-op work may inspect but should not write continuity data.

The preferred store uses schema v3 recipes. This build supports schema v3 only; v1/v2 stores are frozen at git tag `legacy-v1v2-final`.

## Truth axes

These states are independent:

| Axis | Meaning |
|------|---------|
| Attempt and report | `record start` opens an Attempt. `record report` records the actor's account, not evidence. |
| Evidence | A linked `command` or `test` observation with exit code `0` can authorize success. An `agent_report` cannot. |
| Execution | A succeeded Result says the work executed successfully. It does not say the result was independently verified. |
| Verification | `record verify` needs a different actor and run plus explicit found, executed, passed, and failed counts and `--exit-code`. |
| Freshness | Inspect recomputes freshness from live Git state and evidence. A historical pass can become stale. |
| Acceptance | Only `record accept --as user` or `record reject --as user --next "…"` changes acceptance. |

`--as` labels actor kind (`user`, `coordinator`, `subagent`, `tool`, `migration`). It does not launch a process. Omitting `--as` defaults to kind `coordinator`. That default is a label, not a running Coordinator.

A Coordinator is optional and is not launched by Continuity. Continuity has no daemon, network client, interview mode, or top-level `coordinate` command.

## Resolve the CLI

Invoke the bundled `scripts/continuity.mjs` from the installed or cloned Skill directory. The examples use `/absolute/path/to/continuity` for that directory. Run them from the target Git worktree; optional `--root` must name its exact top level.

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" --version
```

The default runtime store is `<repository>/.continuity`. The Skill directory is not a project root and must not receive project data.

## Start with inspection

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" doctor
node "/absolute/path/to/continuity/scripts/continuity.mjs" inspect
node "/absolute/path/to/continuity/scripts/continuity.mjs" inspect ready --json
```

Treat the output as a map, then check relevant claims against current sources, Git, and the environment. Preserve unrelated work.

`doctor` on an uninitialized store does not create one. `inspect`, `inspect ready`, and `inspect wave` are read-only even when `CURRENT.json` is missing, stale, or invalid. Use `rebuild` only for an intentional projection repair. If `plan.missing` is nonempty, stop assigning until authorized project, goal, criteria, and task data exist.

## Initialize an empty store

Node.js 22+ and Git are required. Review the template and replace its example goal and criterion with explicit user-backed values:

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" init --schema 3 --file "/absolute/path/to/continuity/assets/init-v3.template.json"
node "/absolute/path/to/continuity/scripts/continuity.mjs" inspect ready --json
```

`init` refuses an existing store. Older store locations are not imported automatically.

## Plan and assign

`--as` is actor kind. `--actor-id` and `--run-id` identify the writer. Default identities are not independent and cannot self-verify. `record assign --assignee` names the actor who owns the assignment, which may differ from the writer.

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" record task --title "Name the work" --priority core --size S --class function --as coordinator --actor-id <writer-id> --run-id <run>
node "/absolute/path/to/continuity/scripts/continuity.mjs" inspect wave --json
node "/absolute/path/to/continuity/scripts/continuity.mjs" record packet --task <task-id> --as coordinator --actor-id <writer-id> --run-id <run>
node "/absolute/path/to/continuity/scripts/continuity.mjs" record assign --task <task-id> --assignee <executor-id> --as coordinator --actor-id <writer-id> --run-id <run>
```

There is no `record register`. Persist actors with `record --file` as `agent.registered`, then `record packet`, `record assign`, and `record verify` with a different actor and run. v3 recipes: `task`, `start`, `evidence`, `result`, `fail`, `accept`, `reject`, `assign`, `packet`, `release`, `report`, `verify`, `context`, `backlog`. `migrate` remains in usage and fails closed for this v3-only build.

A core task without `--class function` or `--class connector` remains unclassified and is not ready before the Build-First gate. The ready set also enforces dependencies, blockers, cycles, size, priority, capability, and path ownership. See [scheduling.md](scheduling.md).

## Execute and record evidence

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" record start --task <task-id> --approach "One sentence" --as subagent --actor-id <executor-id> --run-id <executor-run>
node "/absolute/path/to/continuity/scripts/continuity.mjs" record report --execution partial --as subagent --actor-id <executor-id> --run-id <executor-run>
node "/absolute/path/to/continuity/scripts/continuity.mjs" record evidence --expected "check passes" --actual "exit 0" --kind command --exit-code 0 --as subagent --actor-id <executor-id> --run-id <executor-run>
node "/absolute/path/to/continuity/scripts/continuity.mjs" record result --expected "check passes" --actual "what happened" --as subagent --actor-id <executor-id> --run-id <executor-run> --evidence <evidence-id>
```

An executor report is not evidence. Evidence without `--exit-code` is recorded as `agent_report` and cannot authorize success. A nonzero exit code is a failed observation. Succeeded `record result` requires `--evidence` unless exactly one authorizing evidence exists for the task's current attempt. Record bounded summaries and references, never raw command output, logs, diffs, secrets, personal data, or private absolute paths.

## Verify independently

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" record verify --as subagent --actor-id <verifier-id> --run-id <verifier-run> --result <result-id> --found 1 --executed 1 --passed 1 --failed 0 --exit-code 0
```

The verifier actor and run must differ from the executor. Explicit counts prevent skipped or missing checks from becoming a pass. Verification does not freeze freshness and does not accept the result. See [verification-swarm.md](verification-swarm.md).

## Failure, rollover, and release

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" record fail --why "what broke" --impact "what is stuck" --next "different next step"
node "/absolute/path/to/continuity/scripts/continuity.mjs" record context --next "Exact next step"
node "/absolute/path/to/continuity/scripts/continuity.mjs" handoff
node "/absolute/path/to/continuity/scripts/continuity.mjs" record release --assignment <assignment-id>
```

A retry is a new Attempt with a changed approach or hypothesis. `handoff` is read-only. A successor uses a new actor id, run id, and Attempt; it does not inherit or close the previous Attempt. Release only a still-held assignment. See [context-rollover.md](context-rollover.md).

## Record user acceptance

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" record accept --as user --result <result-id>
node "/absolute/path/to/continuity/scripts/continuity.mjs" record reject --as user --result <result-id> --next "Different next step"
```

Neither an executor, verifier, nor Coordinator may accept work for the user. A rejected result records a linked next action. Fresh, independently verified work still remains pending until the user acts.

## Finish safely

After a write, run `validate` and `inspect`. Do not edit journal or projection files by hand. Follow [security-workflow.md](security-workflow.md) for locks, checkpoints, and recovery.
