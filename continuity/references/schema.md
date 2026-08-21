# Snapshot schema

This build supports schema v3 only. Public v1 snapshot JSON Schema and v2 event-contract files are frozen at git tag `legacy-v1v2-final` and are not read by this helper.

Start from [the bundled v3 init template](../assets/init-v3.template.json). The Memory CLI (`scripts/continuity.mjs`) is authoritative: it validates bounded JSON, hash-chains `HISTORY.ndjson`, and rebuilds `CURRENT.json`. Portable JSON Schema is not used for v3 writes.

`init --schema 3 --file` refuses an already-initialized store. A v1 or v2 journal, or a v1/v2 CLI invocation, fails closed with a message that names tag `legacy-v1v2-final`. The helper never silently folds an old store as v3.

Authorizing evidence remains a linked `command` or `test` observation with exit code `0`. Only `--as user` may accept or reject a result.
