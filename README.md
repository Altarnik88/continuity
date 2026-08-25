# Continuity

[English](README.md) · [Русский](README.ru.md)

[![CI](https://github.com/Altarnik88/continuity/actions/workflows/ci.yml/badge.svg)](https://github.com/Altarnik88/continuity/actions/workflows/ci.yml)

**A local control plane for long-running coding-agent work: a journal that survives chats, a task database, and an optional Node swarm (role-workers, sqlite, local HTTP control surface) started by `launch.mjs`. The host LLM still dispatches Task sub-agents.**

Continuity is a downloadable Node.js product for a Git repository. It does three jobs that coding sessions usually mix together and then lose:

1. **Remember the project truth** — goals, failed attempts, lessons, playbooks, evidence, independent verification, freshness, and whether the *user* accepted the result. Core `HISTORY.ndjson` is journal truth. `CURRENT.json` is a rebuildable projection. Swarm sqlite is an execution projection with journal task/event ids. Markdown (forge `MEMORY.md` / `HANDOFF.md`) is an untrusted view, not a store.
2. **Slice authorized work into a database** — ready tasks, path leases, and a standing order that does not wait for a new chat. If `inspect ready` reports `plan.missing`, stop assigning; do not invent missing requirements.
3. **Keep two runtimes distinct** — `launch.mjs` runs deterministic Node role-workers, a sqlite execution projection, and the HTTP control surface on `127.0.0.1:43147`. The host LLM dispatches isolated Task / Cursor-Grok sub-agents. Node does not spawn host Task. Words from an executor are never treated as proof. Only `record accept --as user` accepts.

You download it when a later chat, a different model, or a replacement executor must continue without guessing — and when more than one actor must work on the same repository without colliding or marking the work done for you.

Runtime: Node.js 22 or 24 (`package.json` engines: `>=22 <25`) and Git. MIT License. Distributed from [Altarnik88/continuity](https://github.com/Altarnik88/continuity), not from a package registry. This is not a native IDE marketplace listing.

Product version is `package.json` (`3.0.0`). `--version` prints that value. Store schema is **v3** and is not the product version.

How Continuity sits next to Cursor, Claude Code, Copilot, Devin, CrewAI, and similar products: [COMPETITORS.md](COMPETITORS.md) ([Русский](COMPETITORS.ru.md)).

## Why

Long agent work fails in two independent ways.

**Memory failure.** A new chat does not know the goal, the failed approaches, the last evidence, or the exact next step. Historical PASS is trusted against a moved Git HEAD. The implementer “verifies” their own work. Someone other than the user marks the feature accepted.

**Management failure.** Two agents edit the same files. Ready work is guessed instead of derived. A Coordinator process is implied but never actually run. An executor report is treated as a test result. A replacement actor continues the previous Attempt. Required criteria disappear into a backlog.

Do **not** download it as a Git replacement, issue tracker, secret store, hosted-model marketplace, background daemon, or automatic proof of correctness. If the edit is one obvious change, just make the edit. If the next actor was not in the room, use Continuity.

## Quick start

`--version` and the Memory CLI need no `npm install`. `devDependencies` are only for the test and validate gate.

### A. Clone the Continuity tooling

```bash
git clone https://github.com/Altarnik88/continuity.git
cd continuity
node continuity/scripts/continuity.mjs --version
```

### B. Run the Memory CLI against a target Git repository

Run from the Git repository Continuity should remember, or pass that tree as `--root` to `continuity.mjs`. Invoke the scripts by absolute path if that repository is not this clone:

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" doctor
```

If `doctor` reports `journal=uninitialized`, copy `continuity/assets/init-v3.template.json`, edit the copy so the goal and criterion are the user's, then `init --schema 3 --file` that copy. Then `inspect` and `inspect ready --json`. If `plan.missing` is nonempty, stop assigning work; do not invent a product slice.

### C. Optional: Node swarm and control surface

`launch.mjs` / `npm start` use the **current working directory** as the swarm root (`launch.mjs` has no `--root`). `cd` to the **target** repository first:

```bash
node "/absolute/path/to/continuity/scripts/launch.mjs"
# same as: npm start   (only if cwd is this clone)
node "/absolute/path/to/continuity/scripts/launch.mjs" --once
```

`npm start` (same as `npm run launch`) starts `launch.mjs`: deterministic Node role-workers, a SQLite execution projection, and the HTTP control surface on `127.0.0.1:43147`. That process does not start the Memory CLI, does not spawn host Task, and does not accept for the user. In Cursor or Grok, `/continuity` makes the host agent the **Conductor**: it recovers memory and fills the task database from authorized journal work; the host LLM then dispatches isolated Task sub-agents across analysis, implementation, blind verification, security, and review. At size 10+ it appoints a Manager. `launch.mjs --once` runs the Node role-workers headlessly until the current wave is idle. Clicking **Accept** on the control surface is not user accept. `mission.accepted` is not user accept. Only `record accept --as user` accepts.

Coordinator is optional. It never accepts for the user and never edits `HISTORY` files:

```bash
node "/absolute/path/to/continuity/scripts/coordinator.mjs" doctor --root .
```

Recipe flags, required `--exit-code` on `record verify`, and `--evidence` on succeeded `record result` are in the docs below. Do not copy incomplete command lines.

Developers running the repo test gate: `npm ci --ignore-scripts` then `npm run check`. That is not required to use the CLIs.

[MIT License](LICENSE). Copyright (c) 2026 Altarnik88.

## Docs

| Doc | Read it for |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layers, write/read path, layout, FAQ |
| [INSTALL.md](INSTALL.md) | Clone, profiles, installer, first minutes |
| [COORDINATOR.md](COORDINATOR.md) | Agent management CLI, packets, resume |
| [SECURITY.md](SECURITY.md) | Secrets boundary, hash-chain limits, how to report |
| [COMPETITORS.md](COMPETITORS.md) | Comparison with adjacent products (2026-08-25) |
| [CHANGELOG.md](CHANGELOG.md) | Unreleased and shipped changes |
| [RELEASE.md](RELEASE.md) | Profile zips and GitHub publication |
| [CONTRIBUTING](.github/CONTRIBUTING.md) | How to change this repository |
| [Code of conduct](.github/CODE_OF_CONDUCT.md) | Community standards |
