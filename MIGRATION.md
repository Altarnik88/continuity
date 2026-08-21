# Migration

Preferred new stores are schema v3.

- Schema v1 snapshot stores still exist in the helper. `checkpoint` is the v1 path, not the v3 path.
- Schema v2 event stores exist. This build does not render v2 inspect.
- `migrate` is present on the Continuity CLI and reports that migration support is not available. It does not write.
- Legacy `.codex/project-memory` locations are not imported automatically.
- `project-memory.coordinator.v1` remains the Coordinator protocol identifier.
- `continuity/scripts/project-memory.mjs` is a compatibility alias for `continuity.mjs`.

Coordinator run state lives under `.continuity/coordinator/runs` and is not a journal. Deleting it does not rewrite recorded Continuity events. Do not merge two journals.
