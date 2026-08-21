# Changelog

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
