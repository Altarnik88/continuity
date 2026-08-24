# Continuity

[English](README.md) · [Русский](README.ru.md)

**A local control plane for long-running coding-agent work: memory that survives chats, a task database, and a parallel swarm that starts on launch.**

Continuity is a downloadable Node.js product for a Git repository. It does three jobs that coding sessions usually mix together and then lose:

1. **Remember the project truth** — goals, failed attempts, lessons, playbooks, evidence, independent verification, freshness, and whether the *user* accepted the result.
2. **Slice work into a database** — ready tasks, path leases, and a standing order that does not wait for a new chat.
3. **Run 5–20 sub-agents in parallel** — isolated ownership, independent verification, restart, and stop. Words from an executor are never treated as proof. Only the user may accept.

You download it when a later chat, a different model, or a replacement executor must continue without guessing — and when more than one actor must work on the same repository without colliding or marking the work done for you.

Runtime: Node.js 22 or 24 (`package.json` engines: `>=22 <25`) and Git. MIT License. Distributed from [Altarnik88/continuity](https://github.com/Altarnik88/continuity), not from a package registry.

Product version is `package.json` (`3.0.0`). `--version` prints that value. Store schema is **v3** and is not the product version.

## Why

Long agent work fails in two independent ways.

**Memory failure.** A new chat does not know the goal, the failed approaches, the last evidence, or the exact next step. Historical PASS is trusted against a moved Git HEAD. The implementer “verifies” their own work. Someone other than the user marks the feature accepted.

**Management failure.** Two agents edit the same files. Ready work is guessed instead of derived. A Coordinator process is implied but never actually run. An executor report is treated as a test result. A replacement actor continues the previous Attempt. Required criteria disappear into a backlog.

Do **not** download it as a Git replacement, issue tracker, secret store, hosted-model marketplace, daemon, or automatic proof of correctness. If the edit is one obvious change, just make the edit. If the next actor was not in the room, use Continuity.

## Quick start

`--version` works without installing dependencies:

```bash
git clone https://github.com/Altarnik88/continuity.git
cd continuity
npm install
node continuity/scripts/continuity.mjs --version
npm start
node continuity/scripts/launch.mjs --once
```

`npm start` (same as `npm run launch`) opens the control surface on port 43147 and immediately starts memory plus orchestration. In Cursor or Grok, `/continuity` makes the host agent the **Conductor**: it recovers memory, fills the task database, and dispatches 5–20 isolated sub-agents across analysis, implementation, blind verification, security, and review. At size 10+ it appoints a Manager. `launch.mjs --once` runs that swarm headlessly until the current wave is idle. User acceptance stays pending until you click **Accept** or call accept yourself.

From the Git repository Continuity should remember:

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" doctor
```

If `doctor` reports `journal=uninitialized`, edit `continuity/assets/init-v3.template.json` so the goal and criterion are the user's, then `init --schema 3 --file` that template. Then `inspect` and `inspect ready --json`. If `plan.missing` is nonempty, stop assigning work.

Coordinator is optional. It never accepts for the user:

```bash
node continuity/scripts/coordinator.mjs doctor --root .
```

Recipe flags, required `--exit-code` on `record verify`, and `--evidence` on succeeded `record result` are in the docs below. Do not copy incomplete command lines.

[MIT License](LICENSE). Copyright (c) 2026 Altarnik88.

## Docs

| Doc | Read it for |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layers, write/read path, layout, FAQ |
| [INSTALL.md](INSTALL.md) | Clone, profiles, installer, first minutes |
| [COORDINATOR.md](COORDINATOR.md) | Agent management CLI, packets, resume |
| [SECURITY.md](SECURITY.md) | Secrets boundary, hash-chain limits |
