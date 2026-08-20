# Security and checkpoint workflow

The helper is best-effort defense-in-depth, not a secret scanner, privacy classifier, authorization boundary, tamper-proof store, or substitute for review. The caller remains responsible for the complete snapshot and source choices. Pattern guards cannot detect every form of PII, path, identifier, ordering information, encoded value, or raw record.

## Allowed

- Sanitized summaries and decisions.
- Repository-relative source pointers and content hashes.
- Git SHAs and branch names.
- Validation name, status, date, and precise scope.
- Non-sensitive next steps and blockers.

## Prohibited snapshot content

- Passwords, private keys, Bearer/API/session tokens, common provider-key prefixes, cookies, authorization/session headers, credentialed connection strings, or `.env` assignments.
- Personal email addresses, phone numbers, customer contact/address data, order identifiers/payloads, raw database rows, or record dumps.
- Raw diffs/patches, multiline logs, stdout/stderr, stack dumps, or other raw command output.
- Absolute paths, traversal paths, hidden extra fields, oversized strings, or oversized snapshots.

These categories are policy boundaries, not a claim of complete mechanical detection. The helper rejects structural violations, Unicode control/format and rendered-line injection characters, and common sensitive patterns it recognizes. When a guard triggers, the complete snapshot is rejected with a generic non-echo error. A successful `lint` or dry run does not prove policy compliance. Summarize the durable fact safely at the source, run `lint --file` and `checkpoint --dry-run`, then review the exact JSON yourself.

## Exclusive writer rule

Only the coordinating/main agent writes a checkpoint. The helper resolves its exclusive lock with Git and mutates only the primary worktree; linked worktrees may inspect and validate but cannot `init` or checkpoint. A conflict fails clearly. The helper removes only a lock it acquired in the current process; it never guesses that an existing lock is stale and never silently deletes one.

If a writer was interrupted, first prove that no checkpoint process is running, inspect the lock metadata without recording it in continuity data, and confirm the repository/common Git directory. Remove the lock only as an explicit operator action after those checks, then run `doctor`, `validate`, and a dry run before retrying. The journal remains authoritative if `CURRENT.json` replacement was blocked or interrupted; readers report projection state without mutation, and the next checkpoint repairs it under lock. A partial non-newline journal tail is ignored by readers and truncated only by checkpoint under lock. Schema v1 intentionally provides no automatic stale-lock deletion, rollover, journal merge, or upgrade. Do not use a union merge driver for the hash-chained journal.

## Close sequence

1. Rerun material validations against current sources/environment.
2. Summarize only durable facts within the schema.
3. Hash current committed, clone-available UTF-8 sources after LF normalization. Checkpoint rejects refs that are ignored, untracked, staged, dirty, absent from `HEAD`, or content-different from `HEAD:path`.
4. Run `checkpoint` once.
5. Run `validate`, then `inspect`.
6. Commit Continuity store changes only when repository Git policy and task authority require it.

Before store reads or writes, the helper rejects linked/reparse store ancestors or files and existing journal/projection files whose hard-link count is not exactly one. It also verifies containment within the canonical repository and checks owned lock/temporary files before mutation. These checks reduce accidental escape and aliasing risk but do not make a caller-controlled filesystem or Git repository trustworthy.
