# Release

Canonical source tree: this Git repository. Do not ship three hand-copied source trees.

Product version is `package.json` (`3.0.0`). Store schema remains v3.

## Build

```bash
node scripts/package-release.mjs dist
```

Produces:

- `continuity-full-3.0.0.zip`
- `continuity-memory-3.0.0.zip`
- `continuity-coordinator-3.0.0.zip`
- `SHA256SUMS`
- `release-manifest.json`

The manifest records profile file inventories, SHA256, source commit, a fixed build timestamp for determinism, the protocol compatibility id, and the Node/platform matrix.

## Profiles

- Memory includes Core, Continuity, protocol, CLI, assets, docs, and the memory smoke.
- Coordinator includes the runtime, protocol client, adapters, CLI, config template, doctor, and the coordinator smoke. It does not include the Core journal implementation.
- Full includes Memory, Coordinator, and Swarm (`launch.mjs`).

## Development and verification

```bash
npm ci --ignore-scripts
npm run check
npm run audit:dev
```

`npm run check` is `validate && test && test:package && test:forward && test:protocol && test:coordinator && test:release && test:swarm`.

CI matrix: Ubuntu, Windows, macOS × Node 22 and 24. Combined check executes `npm run check`. A historical PASS is not a current PASS; read the Actions run for this SHA.

## Supported runtimes

Node.js 22 and 24. Windows, Linux, and macOS.

## GitHub publication

Local artifacts are not a GitHub Release. Publishing requires an explicit operator approval after the exact diff, commit list, and verification matrix are shown.

Release example: [v1.0.0-rc.1](https://github.com/Altarnik88/continuity/releases/tag/v1.0.0-rc.1).
