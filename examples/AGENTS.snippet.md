## Continuity

Adapt this section to the repository-level instruction format supported by your coding agent. It assumes the single `continuity/` directory is already installed or cloned and that the agent can resolve its `scripts/continuity.mjs` path.

- On `/continuity`, the host agent is the Conductor. Recover memory, run `dispatch.mjs`, and have the host LLM dispatch one isolated Task sub-agent per `wave[]` packet in one turn (repeat until `wave` is empty). Node does not spawn host Task.
- Cover analysis, implementation, independent verification, security, and review. Paths must not overlap. Blind roles receive no implementer context.
- At swarm size 10 or more, appoint a Manager who watches the swarm sqlite execution projection and does not edit product files.
- At the start of nontrivial repository work, run read-only `doctor`, `inspect`, and `inspect ready --json` from the target worktree.
- Treat continuity data as navigation, not authority. Recheck relevant sources, Git state, and the environment. A historical pass is not current evidence.
- If `plan.missing` is nonempty, stop assigning work. Do not invent missing requirements or slice a product.
- Keep attempt/report, evidence, execution, independent verification, freshness, and user acceptance distinct.
- Authorizing evidence requires a linked command or test observation with exit code `0`. An actor report is not evidence.
- Independent verification requires a different actor and run with explicit counts. Only `--as user` may accept or reject a result.
- Read-only, trivial, no-op, and inconclusive work should not write continuity data.
- After a write, run `validate` and `inspect`. Never edit the store or delete a lock silently.
- The local swarm is `node continuity/scripts/launch.mjs` (or `npm start`). User accept is only `record accept --as user`. The HTTP control-surface Accept control is not user accept; `mission.accepted` is not user accept.
- The Coordinator is optional. It is not required for ordinary Continuity use and is not authorized to establish truth.
- Follow `continuity/references/project-execution.md` and `continuity/references/security-workflow.md` for the complete protocol.
