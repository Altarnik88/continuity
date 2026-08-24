# Autonomous swarm

Continuity now has a second runtime next to Memory and the optional Coordinator: a **parallel swarm**.

On launch it does not wait for a new chat. It loads the standing order, slices the product into a SQLite task database, and runs 5–20 sub-agents at once. Path leases keep them off each other's files. Failures become memory. Only the user may accept.

```bash
node continuity/scripts/launch.mjs
node continuity/scripts/launch.mjs --once --swarm-size 8
npm run launch
```

`npm run launch` starts the standing order and the control surface.

## What is stored

- `data/swarm.sqlite` — mission, agents, tasks, path leases, lessons, failures, playbooks
- `forge/` — the product the swarm is building
- `.continuity/` — the original append-only journal, if you initialized Memory in this repository

The swarm does not edit `HISTORY.ndjson`. Memory remains the long-term journal. The swarm is the execution plane that was missing: parallel work, a task database, and a standing order that survives a new session.
