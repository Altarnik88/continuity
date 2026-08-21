# Independent verification swarm

Executor words are not evidence. `attempt.reported` cannot be authorizing.

After a Result exists, an operator or an optional external Coordinator selects a registered actor capable for the task and its risk that differs from both the Result actor and the Attempt owner. Its run must also differ from the executor run when run ids exist. Prefer a different model family when one is eligible; family difference is not itself evidence. In a coordinated flow, Coordinator actually launches the independent verifier in the agent environment, then records the verify recipe through this helper. Continuity validates the record but launches no planner, Coordinator, daemon, network client, model, executor, or verifier; it may invoke required local Git commands to read repository state.

## Capability lanes

- `mechanical` — deterministic commands and comparisons
- `integration` — user journeys and module interaction
- `deep_reasoning` — invariants and architectural contradictions
- `security_critical` — security, concurrency, migrations, no-effect

## VerificationReport

`record verify` writes `verification.recorded` with: verifier actor, result id, criterion, method, expected, actual, command/source, exit code, bounded output reference, commit/worktree context, verification time, limitations, freshness policy, and `passed` / `failed` / `inconclusive`.

The recipe requires explicit `found`, `executed`, `passed`, and `failed` counts; it never invents a successful set. A pass requires `found >= 1`, `executed >= 1`, `passed >= 1`, and `failed === 0`; `skipped` and skip reasons remain explicit. The same checks apply to raw event drafts. Same actor or same run is a no-effect rejection.

`--as` chooses only the verifier kind. Supply a different `--actor-id` and `--run-id` than the Result actor and Attempt owner. Defaults `actor-<kind>` and `run-cli` cannot self-verify. `record verify` requires explicit `--found`, `--executed`, `--passed`, `--failed`, and `--exit-code` observed from the verification run. A complete `verification.recorded` draft through `record --file <draft.json>` remains valid; the event actor and report verifier must match.

## Truth axes

These axes stay independent:

- attempt/`report` ≠ evidence
- `succeeded` ≠ verified
- verification ≠ freshness
- freshness ≠ user acceptance
- a historical PASS is not a current PASS

Verification passed does not set freshness; freshness is recomputed from live Git (HEAD, dirty worktree) and evidence at inspect. `inspect ready` / `inspect wave` remain read-only. Acceptance stays `pending` until `record accept --as user`.
