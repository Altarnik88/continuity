# Contributing

Continuity is distributed from GitHub, not from a package registry. Changes land as ordinary GitHub pull requests against this repository.

## What this product is

A local Node.js control plane for a Git worktree: an append-only journal, inspect/record CLIs, an optional sequential Coordinator, and an optional Node swarm (`launch.mjs`) whose sqlite store is an execution projection. Node does not spawn host Task. Only `record accept --as user` accepts.

Do not send pull requests that publish to npm, add telemetry, persist GitHub `secrets`, or claim a native IDE marketplace listing.

## Prerequisites

- Node.js 22 or 24 (`package.json` engines: `>=22 <25`)
- Git
- No runtime `npm install` is required to run the CLIs. Install locked dependencies only when you run the test gate:

```bash
npm ci --ignore-scripts
npm run check
```

`npm run check` is the same combined gate CI runs after protocol and coordinator suites.

## How to change the tree

1. Open an issue or start from an existing one. Security issues go to [private advisories](https://github.com/Altarnik88/continuity/security/advisories/new), not public issues. See [SECURITY.md](../SECURITY.md).
2. Keep diffs scoped. Inventory is strict: a new **root** tracked file must be listed in `scripts/package-inventory.mjs` (`REPO_METADATA_EXACT`) or it fails as `unclassified tracked path`. Community files under `.github/` (CONTRIBUTING, Code of Conduct, issue/PR templates, Dependabot) are required metadata; deleting them fails validate.
3. If you add a file that should ship in GitHub release zips (the same list `npm pack --dry-run` uses; this package is private and is not published to npm), update `DISTRIBUTABLE_FILES`, `package.json` `files`, `scripts/release-profiles.mjs`, and `scripts/test-validate-package.mjs` PKG-015 together. Cyrillic is allowed only in `LOCALIZED_PUBLIC_FILES` (`README.md` and `README.ru.md`).
4. Do not record secrets, personal data, raw logs, raw diffs, command output, or private absolute paths in docs, tests, or the journal.
5. Keep the truth axes distinct: an attempt or report is not evidence; execution is not independent verification; verification is not freshness; freshness is not user acceptance.

## Pull requests

Use the pull-request template. Say what changed, how you ran `npm run check` (or why a subset was enough), and which docs you updated. CI pins GitHub Actions by full commit SHA; do not switch those pins to floating tags.

## Conduct

[Code of conduct](CODE_OF_CONDUCT.md).
