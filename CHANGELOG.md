# Changelog

## Unreleased

- CI jobs time out at 25 minutes (Windows Node 24 sat on a 15-minute knife-edge). Pull requests run the matrix once; `push` runs it on `main`. Concurrent runs of the same ref cancel in progress.
- Full install profile is Memory + Coordinator + Swarm (Memory already includes the Continuity CLI). Public copy splits journal ready-work from the swarm sqlite projection. `package.json` says Node does not spawn host Task.
- `dispatch.mjs` tells the host LLM to dispatch Task; it does not say Node will spawn Task. `launch.mjs` has no `--root` (cwd is the swarm root). Full profile and `npm run check` include Swarm. Engines stay `>=22 <25` in INSTALL and Skill install notes. Cyrillic public text is allowed only in `README.md` and `README.ru.md`.
- Competitor comparison is not a product file. It is not in the GitHub tree, pack, or release zips.
- Community files under `.github/` are required metadata (CONTRIBUTING, Code of Conduct, issue/PR templates, Dependabot). CoC reports go to private security advisories first.
- `actions/checkout` pinned at v7.0.1 and `actions/setup-node` at v7.0.0 (Node 24 action runtime) to drop the Node 20 deprecation warning on those actions.
- README and INSTALL split clone-the-tooling from Memory CLI against a target repo. `--version` needs no `npm install`. `npm start` does not start the Memory CLI and does not spawn host Task.
- Local swarm wording: Node role-workers plus `127.0.0.1:43147`; the host LLM still dispatches Task. Skill text no longer says the Memory CLI has “no network service” while documenting that port.
- `record next` folds `next_action.status_changed`. Inspect NEXT and sealed-epoch resume text keep only planned or in-progress next actions; a closed next action does not delete the historical failure.
- Folded evidence keeps the Git HEAD from `workspaceAtRecord`. A later journal write on a clean tree does not revive authorizing evidence from a previous commit.
- Swarm path leases are case-folded (`Forge/` overlaps `forge/`). The Integrator roster role is gone; there is no merge queue.
- `mission.title` copies the journal `goalId` or stays empty. `mission.accepted` is an inspect copy, not user accept.
- After `waiting_accept`, dispatch does not invent function work. Ready verification/security on an existing scope may remain; empty ready stays `wave: []`.
- Coordinator CLI takes host `--context-used 0..1`. At 0.65 it pauses assign and records context.
- `supervisor.mjs` writes `data/host-packet.json` from inspect ready and read-only leases. It does not accept.
- Swarm handoff writes machine `ContextHandoff` fields first. `MEMORY.md` is marked `untrusted-view`.
- Live swarm repair stops after 2 hypothesis failures or 3 no-progress attempts. `repairTaskId` is not reopened forever.
- Hot HISTORY seals into `.continuity/epochs/` when a write would exceed 8 MiB. Fold still reads sealed segments plus hot HISTORY. Next-step stays on the anchor.
- `/continuity` makes the host agent the Conductor: recover memory, fill the task database from authorized journal work, and have the host LLM dispatch isolated Task sub-agents across analysis, implementation, blind verification, security, and review. `launch.mjs` is deterministic Node role-workers plus a sqlite execution projection and the control surface. Node does not spawn host Task.
- `dispatch.mjs` prints a path-disjoint `wave[]` so the host LLM can dispatch isolated Task sub-agents without path collisions. Blind security/review workers read leased source files instead of trusting implementer notes.
- Swarm roster covers analyst, security, reviewer, and (at size 10+) a Manager who watches leases and does not edit product files. Conductor and Manager never take product leases.
- `GET /api/swarm` includes dispatch `packets[]` so the host LLM can dispatch Cursor/Grok Task sub-agents from the same sqlite execution projection. Blind packets omit implementer context.
- `npm start` is an alias for `npm run launch`. From the target repo cwd (or this clone when that is the target), `launch.mjs` starts the Node role-workers and control surface without a second prompt.
- Local swarm: SQLite execution projection with journal task/event ids, deterministic `launch.mjs` role-workers, path leases, standing order on launch, and a local control surface. The host LLM dispatches Task sub-agents; Node does not spawn host Task.
- Swarm memory records lessons, failures, and playbooks. User accept is only `record accept --as user`. The HTTP control-surface Accept control is not user accept. `mission.accepted` is not user accept.
- Pulse is not the user product. `planPulse` is a test fixture. The default wave does not build Pulse under `forge/`. Markdown (`forge/MEMORY.md`, `forge/HANDOFF.md`) is a view, not a store.
- Package validation inventories a Git worktree from `git ls-files --cached`, so ignored or untracked local notes (including `.superpowers/`) are not scanned as public product text.
- `.superpowers/` is gitignored.
- Coordinator closes only the completed packet's open attempt (`taskId` + `runId`), not every attempt that shares the executor run id.

## 3.0.0

- This build supports schema v3 only. v1/v2 stores fail closed naming git tag `legacy-v1v2-final` and are never silently read as v3.
- Legacy commands `checkpoint`, `snapshot`, `lint`, `source`, `event`, `migrate`, `graphify`, and `--schema 1` / `--schema 2` fail closed. They do not write.
- Coordinator no longer substitutes a no-op `process.exit(0)` executor. Empty or malformed `focusedChecks` fail closed: recorded failure, no authorizing evidence, no result. A bare `record task` does not attach a check; persist one JSON argv string in `task.focusedVerification` via `record --file`.
- Work-packet batching keeps one argv per packet: tasks with differing `focusedVerification` are not batched.
- Coordinator run status is `completed` only when the wave is exhausted, `partial` when work ran and ready work remains, and `blocked` when nothing launched.
- Coordinator slots shape the wave only; execution is sequential.
- Coordinator verify binds to the `resultId` echoed from that write, not `unverified[0]`. Missing echo fails closed.
- Coordinator release requires the `assignmentId` from `record assign`. Resume with open attempts is `blocked` (`open-attempts-require-rollover`).
- Record recipes echo a JSON line with subject ids (`assignmentId`, `evidenceId`, `resultId`).
- `record verify` requires `--exit-code` observed from the verification run. The CLI never fabricates 0. Rejection is no-effect.
- Succeeded `record result` requires `--evidence` unless exactly one authorizing evidence exists for the current attempt. Ambiguity lists candidate ids and is no-effect.
- Default evidence limitation is self-reported: the CLI did not execute or observe the command. The false hashed/truncated-output claim is gone.
- One product version from `package.json` at runtime: Memory CLI, Coordinator CLI, and the package all report `3.0.0`.
- Store schema remains v3 and is printed separately from `--version`.
- `npm run check` runs protocol and coordinator suites with the rest of the local gate.
- Short bilingual READMEs point at ARCHITECTURE, INSTALL, COORDINATOR, and SECURITY.
- Operator handoff is `handoff --task <id>`.
- `record evidence --run` executes the current Node.js binary under the existing sandbox and records `provenance: observed` plus sha256 and length of truncated output, never raw logs.
- Self-reported `--exit-code` is `provenance: claimed`. Using `--run` and `--exit-code` together is a no-effect rejection.
- `inspect` shows evidence provenance.

## 1.0.0

- Project Memory Core remains the journal owner (`HISTORY.ndjson` / `CURRENT.json`).
- Continuity remains the read/continuity CLI.
- Coordinator is now a real foreground runtime (`continuity/scripts/coordinator.mjs`) with persistent run state.
- Shared protocol package `continuity.protocol` keeps compatibility id `project-memory.coordinator.v1`.
- Live `local-process` adapter plus a test-only `fake` adapter.
- Three distribution profiles: full, memory, coordinator.
- Installer: `node scripts/install.mjs --profile <full|memory|coordinator>`.
- Product docs: ARCHITECTURE, PROTOCOL, INSTALL, COORDINATOR, ADAPTERS, MIGRATION, RELEASE.

User acceptance is still only `record accept --as user` or `record reject --as user --next "…"`.
