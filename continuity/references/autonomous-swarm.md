# Autonomous swarm

Continuity has a second runtime next to Memory and the optional Coordinator: a **parallel swarm**.

`launch.mjs` does not wait for a new chat. It loads the standing order and runs deterministic role-workers against a SQLite execution projection with journal task/event ids. Node does not spawn host Task or MCP sub-agents. Path leases keep role-workers off each other's files. The host LLM, acting as Conductor, dispatches Task sub-agents. Failures become memory. Clicking Accept on the HTTP control surface is not user accept. `mission.accepted` is not user accept. Only `record accept --as user` accepts.

In Cursor or Grok, `/continuity` is the same standing order with a live host Conductor: it reads `GET /api/swarm` `packets[]` and the host LLM dispatches isolated Task sub-agents, including blind verifiers.

```bash
npm start
node continuity/scripts/launch.mjs
node continuity/scripts/launch.mjs --once --swarm-size 8
```

`npm start` / `npm run launch` starts the standing order and the control surface. That process is Node role-workers plus sqlite and the control surface, not host Task. The host LLM dispatches Task sub-agents.

## What is stored

- `data/swarm.sqlite` — execution projection with journal task/event ids: mission, agents, tasks, path leases, lessons, failures, playbooks
- `data/memory.ndjson` — append-only copy of the same lessons so a killed process is not the last copy
- `forge/` — workspace views; `MEMORY.md` and `HANDOFF.md` are views, not stores. Pulse is not the user product; `planPulse` is a test fixture
- `.continuity/` — Core journal. `HISTORY` is truth

When authorized journal work is done, status may be `waiting_accept`. That is not acceptance. `mission.accepted` is not user accept. Only `record accept --as user` accepts. Relaunching the same root reloads sqlite and the memory log; it does not invent a new standing order. At swarm size 10 or more the roster includes a Manager.

If `inspect ready` reports `plan.missing`, stop assigning; do not invent missing requirements or slice a product.

The swarm does not edit `HISTORY` files. Coordinator does not accept for the user and does not edit `HISTORY` files. Core `HISTORY` is truth. Swarm sqlite is an execution projection with journal task/event ids. Markdown (forge `MEMORY.md` / `HANDOFF.md`) is a view, not a store.
