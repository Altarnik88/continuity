## Continuity

Adapt this section to the repository-level instruction format supported by your coding agent. It assumes the single `continuity/` directory is already installed or cloned and that the agent can resolve its `scripts/continuity.mjs` path.

- At the start of nontrivial repository work, run read-only `doctor`, `inspect`, and `inspect ready --json` from the target worktree.
- Treat continuity data as navigation, not authority. Recheck relevant sources, Git state, and the environment. A historical pass is not current evidence.
- If `plan.missing` is nonempty, stop assigning work. Do not invent missing requirements.
- Keep attempt/report, evidence, execution, independent verification, freshness, and user acceptance distinct.
- Authorizing evidence requires a linked command or test observation with exit code `0`. An actor report is not evidence.
- Independent verification requires a different actor and run with explicit counts. Only `--as user` may accept or reject a result.
- Read-only, trivial, no-op, and inconclusive work should not write continuity data.
- After a write, run `validate` and `inspect`. Never edit the store or delete a lock silently.
- The Coordinator and Graphify adapters are optional. Neither is required for ordinary Continuity use or authorized to establish truth.
- Follow `continuity/references/project-execution.md` and `continuity/references/security-workflow.md` for the complete protocol.
