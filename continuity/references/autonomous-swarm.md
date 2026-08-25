# Autonomous swarm

Continuity has a second runtime next to Memory and the optional Coordinator: a **parallel swarm**.

`launch.mjs` does not wait for a new chat. It loads the standing order and runs deterministic role-workers against a SQLite execution projection. Node does not spawn host Task or MCP sub-agents. Path leases keep role-workers off each other's files. The host LLM, acting as Conductor, dispatches Task sub-agents. Failures become memory. `mission.accepted` is not user accept. Only `record accept --as user` accepts.

In Cursor or Grok, `/continuity` is the same standing order with a live host Conductor: it reads `GET /api/swarm` `packets[]` and the host LLM dispatches isolated Task sub-agents, including blind verifiers.

```bash
npm start
node continuity/scripts/launch.mjs
node continuity/scripts/launch.mjs --once --swarm-size 8
```

`npm start` / `npm run launch` starts the standing order and the control surface. That process is Node role-workers, not host Task.

## What is stored

- `data/swarm.sqlite` — execution projection: mission, agents, tasks, path leases, lessons, failures, playbooks
- `data/memory.ndjson` — append-only copy of the same lessons so a killed process is not the last copy
- `forge/` — product workspace; `MEMORY.md` and `HANDOFF.md` are views, not stores
- `.continuity/` — Core journal. `HISTORY` is truth

When authorized journal work is done, status may be `waiting_accept`. That is not acceptance. `mission.accepted` is not user accept. Only `record accept --as user` accepts. Relaunching the same root reloads sqlite and the memory log; it does not invent a new standing order. At swarm size 10 or more the roster includes a Manager.

If `inspect ready` reports `plan.missing`, stop assigning; do not invent missing requirements.

The swarm does not edit `HISTORY.ndjson`. Core `HISTORY` is truth. Swarm sqlite is an execution projection. Markdown (forge `MEMORY.md` / `HANDOFF.md`) is a view, not a store.
