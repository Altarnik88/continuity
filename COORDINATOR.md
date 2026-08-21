# Coordinator

Coordinator is a foreground execution runtime. It is optional. Memory/Continuity works without it.

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

`--help` prints that usage. There is no per-command `--help`. `--version` prints `continuity-coordinator 1.0.0`. Other flags: `--root`, `--config <file>`, `--run <id>`, `--adapter <name>`, `--slots <1..8>`, `--json`. Default config is `continuity/assets/coordinator.config.json`. Default adapter is `local-process`.

It never starts a daemon, watcher, service, or login task.

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

## Resume

`resume` reloads recorded run state. It does not close another actor's Attempt. A successor uses a new actor id, run id, and Attempt.
