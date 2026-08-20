# Continuity

Continuity is a local, source-backed continuity Skill for coding agents. It preserves a bounded record of project goals, constraints, work, evidence, verification, freshness, and user acceptance across sessions without turning old notes into current truth. Its append-only journal is authoritative for what Continuity recorded; live sources, Git state, and the user remain authoritative for the project itself.

The complete distributable Skill is the [`continuity/`](continuity/) directory. It is self-contained: it needs Node.js 22+ and Git, but no other Skill, planner, Coordinator, background process, network service, model installation, or global runtime copy.

## Install

Clone [Altarnik88/continuity](https://github.com/Altarnik88/continuity), then choose one path:

1. Copy the single `continuity/` directory into the skills directory documented by your coding agent. Keep the installed directory name `continuity`.
2. Leave the checkout where it is and invoke the local CLI directly with Node.js.

Installation layouts differ between coding agents, so this repository does not claim a universal discovery path or native integration with a particular agent. See [the installation guide](continuity/references/installation.md) for copy commands and clean-install checks.

## Quickstart

Run these commands from the Git repository you want Continuity to inspect. Replace `/absolute/path/to/continuity` with the installed or cloned Skill directory.

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" --version
node "/absolute/path/to/continuity/scripts/continuity.mjs" doctor
node "/absolute/path/to/continuity/scripts/continuity.mjs" inspect
node "/absolute/path/to/continuity/scripts/continuity.mjs" inspect ready --json
```

These commands are read-only. To create a new v3 store, review and edit the bundled template first, then run:

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" init --schema 3 --file "/absolute/path/to/continuity/assets/init-v3.template.json"
```

The default runtime store is `<repository>/.continuity`. The Skill installation directory is code, not project data.

## Architecture

- `HISTORY.ndjson` is the bounded, append-only, hash-chained journal.
- `CURRENT.json` is a rebuildable projection, not an independent authority.
- Input may come directly from the user or from any planning tool that supplies a ready goal, criteria, and plan. External planners are optional inputs, not dependencies.
- Continuity owns the authoritative journal and validates its goals, criteria, TaskAccumulator, derived ready set, WorkPacket and assignment records, actors, context rollover, attempts, evidence, failures, backlog, and handoff state.
- `inspect`, `inspect ready`, and `inspect wave` are read-only and recompute freshness from live Git state and evidence.
- Execution, verification, freshness, and user acceptance are separate states. None implies another.
- An optional Coordinator in the agent environment consumes Continuity outputs, selects available models and actors, distributes packets, launches executors and independent verifiers, integrates their results, and replans when required.
- Graphify support is optional navigation metadata. It never authorizes evidence, verification, freshness, or acceptance.

Continuity itself launches no planner, Coordinator, daemon, network client, model, executor, or verifier, and runs no interview flow. It may invoke required local Git commands to read repository state. A Coordinator writes continuity state only through the helper's validated commands.

## Security and limitations

Continuity rejects unsafe structures and several recognizable secret or private-data patterns, but it is not a secret scanner, privacy classifier, authorization system, or tamper-proof database. Record concise sanitized facts, review every write, preserve unrelated work, and keep normal repository backups. See [SECURITY.md](SECURITY.md) and the [security workflow](continuity/references/security-workflow.md).

Schema v1 has bounded retention and no automatic migration or journal merge. The v3 event protocol is richer, but callers still need to supply honest goals, evidence, identities, and acceptance. Older store locations are not imported automatically.

## Protocol references

- [Skill instructions](continuity/SKILL.md)
- [Installation](continuity/references/installation.md)
- [Project execution](continuity/references/project-execution.md)
- [Coordinator contract](continuity/references/coordination.md)
- [Snapshot schema](continuity/references/schema.md)
- [Security workflow](continuity/references/security-workflow.md)

The runtime retains `project-memory.coordinator.v1` as a stable compatibility identifier. It is a protocol value, not the product name or an external dependency.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm run audit:dev
```

Licensed under the [MIT License](LICENSE).
