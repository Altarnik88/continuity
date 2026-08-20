# Snapshot schema

Public schema v1 structure and portable bounds are defined in [snapshot-v1.schema.json](snapshot-v1.schema.json); start from [the bundled template](../assets/snapshot-v1.template.json). The helper is authoritative and adds security checks that portable JSON Schema patterns do not express. It refreshes `schemaVersion`, strict UTC `updatedAt`, and `workspace` from the live checkout before validation. All strings must be bounded single-line text without Unicode control, format, bidi, line-separator, or paragraph-separator characters.

Required content fields:

- `project`: `{ "name": string, "identity": string }`
- `stableGoals`, `implementationBoundaries`, `operatingRules`, `unresolvedItems`, `nextSteps`: bounded arrays of concise strings
- `activeWork`, `decisions`: arrays of `{ "summary": string, "status": string, "sourceRefs": string[] }`
- `recentWork`: array of `{ "summary": string, "status": string, "checkedAt": ISO-date, "sourceRefs": string[] }`
- `validationEvidence`: array of `{ "name": string, "status": string, "scope": string, "checkedAt": ISO-date, "sourceRefs": string[] }`
- `sourceRefs`: array of `{ "path": repo-relative-path, "purpose": string, "contentSha256": sha256 }`

Limits: 64 KiB input and exact compact `CURRENT.json` bytes, 8 MiB total history, 1 MiB per source file, 50 entries per array, 2,000 characters per string, and 100 history entries per `history` call. Unknown fields are rejected so unsafe payloads cannot hide outside the schema. Dates must use exact `YYYY-MM-DDTHH:mm:ss.sssZ` form and represent a real UTC instant.

`CURRENT.json` additionally contains:

- `schemaVersion: 1`
- `updatedAt`: checkpoint time
- `workspace`: captured Git `head`, `branch`, dirty flag, status fingerprint, partial-fingerprint flag, and capture time. Continuity-store changes are excluded. Dirty-path content/target state participates in the bounded fingerprint; the partial flag is true if status or content hashing reaches a cap.

All source paths are persisted with forward slashes as safe repository-relative paths whose resolved existing ancestors and targets remain inside the repository. At checkpoint they must be tracked, non-ignored, present in committed `HEAD`, clean in index and worktree, and normalized-content-identical to `HEAD:path`. `source hash` performs those checks and accepts Windows backslash input. Top-level refs carry SHA-256 of bounded UTF-8 text normalized to LF, so CRLF conversion does not create false drift. Before the first commit, `init` and empty `sourceRefs` work; source refs do not. `inspect` later reports missing, stale, or unreadable sources. A missing ref is drift to investigate, not permission to trust the old claim.

History events contain a monotonic sequence, timestamp, previous event hash, snapshot hash, event hash, and the complete bounded snapshot. A newline commits an event. `validate`, `inspect`, and `history` check the bounded chain and derive the latest state from it; a non-newline trailing fragment is uncommitted and ignored read-only. `CURRENT.json` is only a cache/projection. Checkpoint truncates an uncommitted tail, reconciles the projection under the exclusive lock, appends and fsyncs the next committed event, then atomically refreshes the projection.

Existing `HISTORY.ndjson` and `CURRENT.json` must be regular files with exactly one hard link. The helper also verifies its owned lock and projection-temporary files before mutation; linked, reparse, or aliased store targets fail closed.

The journal fails closed at 8 MiB. Schema v1 has no automatic rollover, archive, upgrade, reconciliation, or unlimited retention. Public v1 permits mutations only in the primary worktree to preserve one canonical linear journal; divergent linked-worktree journals are not merged.
