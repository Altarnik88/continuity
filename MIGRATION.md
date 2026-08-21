# Migration

This build supports schema v3 only.

- `init --schema 3 --file` creates a new store from the bundled v3 template.
- v1 snapshot stores and v2 event stores are frozen at git tag `legacy-v1v2-final`. This helper refuses to read or migrate them.
- `migrate`, `checkpoint`, and other v1/v2 invocations fail closed. They do not write.
- Legacy `.codex/project-memory` locations are not imported automatically.
- `project-memory.coordinator.v1` remains the Coordinator protocol identifier.
- `continuity/scripts/project-memory.mjs` is a compatibility alias for `continuity.mjs`.

Coordinator run state lives under `.continuity/coordinator/runs` and is not a journal. Deleting it does not rewrite recorded Continuity events. Do not merge two journals.
