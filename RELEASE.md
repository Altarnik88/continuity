# Release

Canonical source tree: this Git repository. Do not ship three hand-copied source trees.

## Build

```bash
node scripts/package-release.mjs dist
```

Produces:

- `continuity-full-1.0.0.zip`
- `continuity-memory-1.0.0.zip`
- `continuity-coordinator-1.0.0.zip`
- `SHA256SUMS`
- `release-manifest.json`

The manifest records profile file inventories, SHA256, source commit, a fixed build timestamp for determinism, the protocol compatibility id, and the Node/platform matrix.

## Profiles

- Memory includes Core, Continuity, protocol, CLI, assets, docs, and the memory smoke.
- Coordinator includes the runtime, protocol client, adapters, CLI, config template, doctor, and the coordinator smoke. It does not include the Core journal implementation.
- Full includes both.

## Supported runtimes

Node.js 22 and 24. Windows, Linux, and macOS.

## GitHub publication

Local artifacts are not a GitHub Release. Publishing requires an explicit operator approval after the exact diff, commit list, and verification matrix are shown.
