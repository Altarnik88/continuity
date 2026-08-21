# Install

Continuity is distributed from this repository. It is not published to a package registry. There is no runtime `npm install` step.

Product version is `package.json`, currently `3.0.0`. `--version` prints that value (`continuity 3.0.0` / `continuity-coordinator 3.0.0`) without installing dependencies. Store schema is **v3** and is not that string.

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

From another Git repository:

```bash
node "/absolute/path/to/clone/continuity/scripts/continuity.mjs" doctor
node "/absolute/path/to/clone/continuity/scripts/coordinator.mjs" doctor --root "/absolute/path/to/that/repo"
```

`doctor` is read-only. On an uninitialized repository Continuity reports `journal=uninitialized` and does not create a store. `inspect` requires an existing `HISTORY.ndjson`. Optional `--root` must name the target worktree top level. Default store: `<repo>/.continuity`. `CONTINUITY_STORE_DIR` may select another repository-relative directory. Older `.codex/project-memory` locations are not imported automatically. `continuity/scripts/project-memory.mjs` is a compatibility alias for the Memory CLI.

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

## Generic agent copy

Copy only `continuity/` and keep the destination directory name `continuity`. Consult the coding agent's own documentation for its skills directory. This repository does not claim native integration with any particular product. PowerShell and POSIX copy recipes live in [continuity/references/installation.md](continuity/references/installation.md).

## Cursor and Grok Build

Copy or check out this repository. Continuity is usable from those tools in this checkout; this is not a native marketplace listing.

- **Grok Build** reads root `AGENTS.md` and `.grok/skills` (and `.grok/rules` when present).
- **Cursor** reads `.cursor/skills` and `.cursor/rules`.

Those files point at the canonical Skill `continuity/SKILL.md` and the CLIs in this checkout. They do not replace copying `continuity/` for a generic agent install.

## First minutes

Run from the Git repository Continuity should remember.

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" --version
node "/absolute/path/to/continuity/scripts/continuity.mjs" doctor
```

If `doctor` reports `journal=uninitialized`, edit `continuity/assets/init-v3.template.json` so the goal and criterion are the user's, then:

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" init --schema 3 --file "/absolute/path/to/continuity/assets/init-v3.template.json"
node "/absolute/path/to/continuity/scripts/continuity.mjs" doctor
node "/absolute/path/to/continuity/scripts/continuity.mjs" inspect
node "/absolute/path/to/continuity/scripts/continuity.mjs" record task --title "Name the work" --priority core --size S --class function --as coordinator --actor-id actor-writer --run-id run-plan-01
node "/absolute/path/to/continuity/scripts/continuity.mjs" inspect ready --json
```

`--as coordinator` is only the writer kind. After the template, `inspect ready --json` reports `plan.missing: ["taskAccumulator"]` until a task exists. If `plan.missing` is nonempty, stop assigning work.

A coordinator packet needs exactly one Node.js argv. `task.focusedVerification` is a text list, so encode that argv as one JSON string, for example `["-e","process.exit(0)"]`. There is no `--focused-verification` flag. Persist the field with `record --file` on a valid `task.planned` draft. A bare `record task` leaves the list empty; `coordinator run` then fail-closes (recorded failure, no evidence, no result). It does not treat a missing check as success.

To manage agents on that same repository (Full or Coordinator profile), after the task carries that one JSON argv check:

```bash
node "/absolute/path/to/continuity/scripts/coordinator.mjs" doctor --root .
node "/absolute/path/to/continuity/scripts/coordinator.mjs" plan --root .
node "/absolute/path/to/continuity/scripts/coordinator.mjs" run --root . --config "/absolute/path/to/continuity/assets/coordinator.config.json"
```

Coordinator will not accept the result. Ask the user to `record accept --as user` or `record reject --as user --next "…"`.

Recipe flags, `--exit-code`, and `--evidence` are in [continuity/references/project-execution.md](continuity/references/project-execution.md) and [continuity/SKILL.md](continuity/SKILL.md). Do not copy incomplete verify or result command lines.

## First doctor

From the Git repository you want remembered:

```bash
node /absolute/path/to/continuity/scripts/continuity.mjs doctor
node /absolute/path/to/continuity/scripts/coordinator.mjs doctor --root .
```

Uninitialized stores report `journal=uninitialized` and are not created by `doctor`. Coordinator `doctor` is read-only. It never starts a daemon.
