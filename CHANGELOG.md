# Changelog

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
