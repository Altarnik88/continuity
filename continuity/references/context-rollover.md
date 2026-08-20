# Context rollover

Do not wait for a full context window.

When the environment reports a trustworthy used ratio, stop assigning new packets at 65%. Keep the remaining ~30–35% for a focused check or handoff.

When no exact metric exists, use the conservative heuristic: one complex packet, or one medium packet, or 2–4 small tasks.

## Stop sequence

1. Stop assigning new work.
2. Finish the current atomic step if that is safe.
3. Run the task's focused check.
4. If the task is done, record authorizing evidence and close.
5. If finishing would be unsafe, record `partial`.
6. Release the assignment if it is still `held`. `record context` also ends a still-held lease (`handed_off`); `record release` after that is stale and no-effect.
7. Record `context_handoff`.
8. End the actor session. `handoff` itself is read-only.
9. Continue with a **new actor**, a **new run**, and a **new Attempt**. `record start` after a partial handoff needs explicit `--task`.

## ContextHandoff contents

Required: task, packet if any, last completed step, actual state, changed allowed paths, evidence ids, approaches used, errors, failed hypotheses, limitations, exact next step.

Forbidden: raw diffs, secrets, unbounded logs, private absolute paths.

The new actor must not inherit or close the previous Attempt. Continue with a new `--actor-id` and `--run-id`. Historical PASS is not a fresh PASS: inspect recomputes freshness from live Git and does not write. Acceptance stays pending until `--as user`. Full loop: [project-execution.md](project-execution.md).
