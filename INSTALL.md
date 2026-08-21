# Install

Continuity is distributed from this repository. It is not published to a package registry.

## Choose a profile

- **full** — Memory + Continuity + Coordinator
- **memory** — journal, inspect, handoff, and the Continuity CLI only
- **coordinator** — execution runtime plus a protocol client; point it at a Memory CLI

## From a clone

```bash
git clone https://github.com/Altarnik88/continuity.git
cd continuity
node continuity/scripts/continuity.mjs --version
node continuity/scripts/coordinator.mjs --version
```

`--version` does not install dependencies.

## Verify hashes

After building or downloading release zips:

```bash
node scripts/package-release.mjs dist
```

Check `dist/SHA256SUMS` against the zip files. The installer also hashes each copied file.

## Installer

```bash
node scripts/install.mjs --profile full --dest /absolute/path/to/dest --dry-run
node scripts/install.mjs --profile memory --dest /absolute/path/to/dest
node scripts/install.mjs --profile coordinator --dest /absolute/path/to/dest
```

The installer prints the destination, refuses implicit overwrite, does not delete `.continuity` project data, supports dry-run, checks hashes, and stays offline. Use `--replace-code` only to replace code files.

Copying files proves the files are present. It does not prove a coding agent discovered them.

## First doctor

From the Git repository you want remembered:

```bash
node /absolute/path/to/continuity/scripts/continuity.mjs doctor
node /absolute/path/to/continuity/scripts/coordinator.mjs doctor --root .
```

Uninitialized stores report `journal=uninitialized` and are not created by `doctor`. Coordinator `doctor` is read-only. It never starts a daemon. `--version` prints `continuity 2.0.0` and `continuity-coordinator 1.0.0`.
