# Autonomous swarm

Continuity now has a second runtime next to Memory and the optional Coordinator: a **parallel swarm**.

On launch it does not wait for a new chat. It loads the standing order, slices the product into a SQLite task database, and runs 5–20 sub-agents at once across analysis, implementation, tests, security, and review. Path leases keep them off each other's files. The Conductor and Manager only watch. Failures become memory. Only the user may accept.

In Cursor or Grok, `/continuity` is the same standing order with a live host Conductor: it reads `GET /api/swarm` `packets[]` and dispatches isolated sub-agents, including blind verifiers.

```bash
npm start
node continuity/scripts/launch.mjs
node continuity/scripts/launch.mjs --once --swarm-size 8
```

`npm start` / `npm run launch` starts the standing order and the control surface.

## What is stored

- `data/swarm.sqlite` — mission, agents, tasks, path leases, lessons, failures, playbooks
- `data/memory.ndjson` — append-only copy of the same lessons so a killed process is not the last copy
- `forge/` — the product the swarm is building, including `MEMORY.md` after the continuation wave
- `.continuity/` — the original append-only journal, if you initialized Memory in this repository

The first wave builds Pulse, including `ANALYSIS.md`, `SECURITY.md`, and `REVIEW.md`. The next wave writes product memory, a changelog, and risk metrics. When those tasks are done, status is `waiting_accept`. That is not acceptance. Only an explicit user accept flips `accepted`. Relaunching the same root reloads sqlite and the memory log; it does not invent a new standing order. At swarm size 10 or more the roster includes a Manager.

The swarm does not edit `HISTORY.ndjson`. Memory remains the long-term journal. The swarm is the execution plane that was missing: parallel work, a task database, and a standing order that survives a new session.
