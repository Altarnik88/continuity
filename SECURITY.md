# Security policy

## Report a vulnerability

Report vulnerabilities privately through [Continuity security advisories](https://github.com/Altarnik88/continuity/security/advisories/new). Do not open a public issue containing exploit details, secrets, personal data, private repository content, or a real Continuity store.

If private reporting is unavailable, open a minimal public issue asking the maintainer to arrange a private channel. Include no reproduction steps, affected paths, logs, or technical details in that issue.

In a private report, include only the minimum reproducible information: affected version, platform, Node.js version, a sanitized description, expected and observed behavior, and a synthetic reproducer. Replace real repository names, paths, hashes, branches, lock metadata, snapshots, journal events, logs, and identifiers with clearly fake values. Do not send sensitive material until the maintainer provides an appropriate transfer method.

There is no guaranteed response time. Avoid destructive testing against repositories or data you do not own.

## Data and secret boundary

Continuity stores concise, sanitized project facts. Do not record credentials, private keys, tokens, cookies, authorization or session headers, connection strings, environment-file assignments, personal contact or address data, customer payloads, raw database rows, raw diffs, logs, stack dumps, command output, or absolute local paths.

Structural validation and pattern guards are defense in depth. They are not a secret scanner, privacy classifier, data-loss-prevention system, access-control boundary, sanitizer, or proof that content is safe. A successful lint, dry run, checkpoint, or validation never replaces manual review. Repository access and filesystem permissions remain the operator's responsibility.

Continuity is local and fail-closed. It is not a secret scanner, DLP, or tamper-proof audit database. Pattern guards miss encoded secrets. It hash-chains the journal, rejects path traversal, refuses silent journal edits, refuses automatic legacy import and journal merge, and does not start a daemon. Optional `launch.mjs` may listen on `127.0.0.1:43147` for the control surface until that process exits.

Coordinator writes run state under `.continuity/coordinator/runs`, beside the journal, not into it. Deleting run state does not rewrite recorded Continuity events.

`HISTORY.ndjson` is hash-chained for integrity checking, but an actor able to rewrite both the repository and checker can rebuild the chain. `CURRENT.json` is a disposable projection, not an independent authority or backup. Keep normal repository backups and follow the explicit lock-recovery procedure in the bundled [security workflow](continuity/references/security-workflow.md).
