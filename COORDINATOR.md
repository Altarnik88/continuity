# Coordinator

Coordinator is a foreground execution runtime. It is optional. Memory/Continuity works without it.

`--version` prints `continuity-coordinator` plus the `package.json` product version (currently `3.0.0`). That string is not store schema v3.

```text
usage: coordinator.mjs <doctor|plan|run|resume|status|cancel>
node continuity/scripts/coordinator.mjs --help
node continuity/scripts/coordinator.mjs --version
node continuity/scripts/coordinator.mjs doctor
node continuity/scripts/coordinator.mjs plan --root <repo>
node continuity/scripts/coordinator.mjs run --root <repo> --config <file>
node continuity/scripts/coordinator.mjs resume --run <id>
node continuity/scripts/coordinator.mjs status --run <id>
node continuity/scripts/coordinator.mjs cancel --run <id>
```

`--help` prints that usage. There is no per-command `--help`. Other flags: `--root`, `--config <file>`, `--run <id>`, `--adapter <name>`, `--slots <1..8>`, `--json`. Default config is `continuity/assets/coordinator.config.json`. Default adapter is `local-process`.

`--run` here is the Coordinator run id. It is not a Memory `record evidence` flag.

Execution is sequential (`spawnSync`). `doctor` and `plan` report `execution: sequential`. `--slots` shapes how many independent packets `inspect wave` may return; it is not a concurrency limit.

`doctor` reports `daemon=false`. If `liveProofRequired` is true (the default), a test-only `fake` adapter is refused.

A packet's `focusedChecks` must contain exactly one argv array for the current Node.js binary (or a JSON string of that array, because task `focusedVerification` is a text list). Example: `["-e","process.exit(0)"]`. Empty or malformed checks fail closed: the packet records `failure.recorded` and does not write evidence or a result. The coordinator never substitutes a no-op `process.exit(0)`.

It never starts a daemon, watcher, service, or login task.

## What a WorkPacket carries

Each packet for an actor includes wave id, packet id, actor/run identity, goal, dependencies, allowed and forbidden paths, required capabilities, risk ceiling, context budget, acceptance criteria, focused checks, known failures, prohibited approaches, and the structured report format.

A report is stored. It is still not authorizing evidence. Coordinator must attach a `command` or `test` observation with `--exit-code 0` through the Memory CLI, then launch a different verifier. Succeeded results need `--evidence` when the current attempt is ambiguous. See [project-execution.md](continuity/references/project-execution.md).

## Coordinated execution

1. Memory store already has a goal, criterion, and at least one ready core task.
2. `coordinator.mjs plan --root <repo>` reads ready/wave and records run state.
3. `coordinator.mjs run` registers executor and verifier, records packet and assignment through the Memory CLI, launches `local-process` (or another configured live adapter), waits for a structured report, records evidence/result, launches a **different** verifier, records `verify`.
4. `status` / `resume` / `cancel` observe or continue that run.
5. User acceptance stays `pending` until the user writes `--as user`.

## What it does

- reads `inspect ready` and `inspect wave`
- builds WorkPackets with ownership isolation
- selects capable actors from the adapter registry
- launches executors through a runtime adapter
- records attempts, reports, command/test evidence, and results through the Continuity CLI
- launches a different verifier actor
- persists CoordinatorRun state under `.continuity/coordinator/runs`
- stops after the ready wave is complete; user acceptance stays pending

## What it cannot do

- edit `HISTORY.ndjson` or `CURRENT.json`
- accept or reject work for the user
- treat an executor report as proof
- let an actor verify its own Result
- hide a required Criterion in backlog
- continue an Attempt under a new actor identity
- silently fall back to an unknown or paid runtime

## Ownership, waves, resume

Packets with overlapping path ownership are not launched in parallel. A free slot can take the next independent ready packet; the engine does not have to wait for an entire wave if a slot opens.

Around 65% context used, Coordinator must not assign a new packet; it finishes a safe step, records partial/result, writes a bounded handoff, and starts a **new** Attempt with a new actor and run. See [context-rollover.md](continuity/references/context-rollover.md).

`resume` reloads recorded run state under `.continuity/coordinator/runs/<id>.json`. It does not close another actor's Attempt. If the run still has open Attempts, resume is `blocked` with `stopReason=open-attempts-require-rollover` and points at context-rollover: finish or hand off, then continue with a **new actor**, **new run**, and **new Attempt**. A successor must not inherit the previous Attempt.

Adapters are documented in [ADAPTERS.md](ADAPTERS.md).
