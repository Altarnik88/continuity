# Architecture

Continuity is three layers in one repository. They share a versioned protocol. They do not share write authority.

## Layers

1. **Project Memory Core** owns long-term recorded truth. The append-only journal `.continuity/HISTORY.ndjson` is authoritative for what was written. `.continuity/CURRENT.json` is a rebuildable projection, not a second source of truth.
2. **Continuity** is the read/continuity plane. It orients a new chat, recomputes freshness from live Git, and emits bounded handoff. It does not launch actors.
3. **Coordinator** is the execution plane. It consumes ready work through the protocol, launches adapters, and writes back only through the Continuity CLI.

Core never selects a model, launches a process, or accepts work for the user. Coordinator never edits the journal or projection files.

## Profiles

| Profile | Contains | Works without |
| --- | --- | --- |
| Memory | Core + Continuity + protocol + CLI | Coordinator |
| Coordinator | Coordinator runtime + protocol client + adapters | Journal implementation |
| Full | All of the above | Nothing extra for local CLI use |

Coordinator-only installs require a compatible Memory/Continuity CLI. Point `memoryCli` at that CLI in the Coordinator config file (`--config <file>`), or use the bundled CLI in the Full profile.

## Write path

Every durable write goes through `continuity/scripts/continuity.mjs`. Rejected writes leave the journal unchanged. Executor prose is stored as a report and is not authorizing evidence.

## Identity

`project-memory.coordinator.v1` is the stable protocol identifier. It is not the product name.
