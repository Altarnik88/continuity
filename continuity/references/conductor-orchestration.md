# Conductor orchestration

When `/continuity` is invoked, the host agent **is** the Conductor. Memory and the task database are in force immediately. This document is the dispatch protocol for host Task sub-agents.

`scripts/launch.mjs` runs deterministic role-workers: SQLite execution projection with journal task/event ids, path leases, and a control surface. Node does not spawn host Task. The host LLM dispatches Task sub-agents. The Conductor may attach to that runtime and dispatch those Task sub-agents against the same database.

Core `HISTORY` is truth. Swarm sqlite is an execution projection with journal task/event ids. Markdown (forge `MEMORY.md` / `HANDOFF.md`) is a view, not a store. Clicking Accept on the HTTP control surface is not user accept. `mission.accepted` is not user accept. Only `record accept --as user` accepts. Coordinator does not accept for the user and does not edit `HISTORY` files.

## Standing order

Develop the product. Do not wait for a new chat. Keep goals, failures, and playbooks. Persist journal-authorized work in `data/swarm.sqlite`. If `inspect ready` reports `plan.missing`, stop assigning; do not invent missing requirements or slice a product. The host LLM may dispatch Task sub-agents in parallel. Never lease overlapping paths to two live agents. Cover analysis, implementation, independent verification, security, and review. An attempt is not evidence. Only `record accept --as user` accepts.

## Roles

| Role | When | Owns | Must not |
| --- | --- | --- | --- |
| Conductor | always (host agent) | mission, dispatch, leases, merge | accept for the user; implement behind a lease it assigned to someone else |
| Manager | swarm size ≥ 10 | watch the task database, report blockers | edit product files |
| Analyst | size ≥ 6 | analysis artifacts only | implement or accept |
| Executor | remaining slots | assigned implementation paths | touch any other path |
| Verifier | always at least one | tests / checks | see implementer reasoning |
| Security | size ≥ 7 | security notes for leased paths | rewrite features |
| Reviewer | size ≥ 8 | independent review artifact | reuse writer context |
| Archivist | always | handoff and memory files | accept |

## Parallel dispatch

In **one** Conductor turn, the host LLM dispatches every ready Task whose paths do not overlap:

1. Read ready tasks and current leases (`GET /api/swarm` or `data/swarm.sqlite`).
2. Take a maximal set of ready tasks with disjoint `paths`.
3. The host LLM dispatches that many Task sub-agents together (multiple host Task calls in the same message). Node does not spawn those Task workers.
4. Each prompt names **only** that task's id, title, paths, and checks.
5. Blind roles (`test`, `security`, `review`) receive no chat transcript, no writer notes, and no other agents' output. They may read the leased files and run commands.
6. Sub-agents should use any installed Skill, MCP server, or plugin that helps the assigned task (tests, browsers, security scanners, docs). They still may not leave their paths.
7. When a sub-agent returns, record memory (lesson, failure, or playbook). Requeue fail-closed work. Do not treat a self-report as verification.
8. Repeat until no ready work remains, then wait for the user. Status `waiting_accept` and `mission.accepted` are not user accept. Only `record accept --as user` accepts.

Default swarm size is 8 (analyst + security + reviewer + verifiers + executors). Clamp to 5–20.

## Blind evaluation

A verifier, security agent, or reviewer that can see the implementer's explanation is not independent. Strip:

- prior chat
- "I implemented it by…"
- diffs pasted by the writer
- other agents' reasoning

Leave:

- task id and title
- exact paths
- commands to run
- the user-visible criterion

## Manager

At size ≥ 10 the Conductor appoints one Manager. The Manager reads the task database and agent list, reports stalled leases and failed deps, and never writes product files. `launch.mjs` role-workers for Conductor and Manager stay in `watching` status. Those Node workers are not host Task sub-agents. The host agent remains accountable for dispatch.

## Local runtime packets

`GET /api/swarm` includes `packets` for ready and running tasks and `wave` for the maximal disjoint host-Task set. Each packet has `id`, `kind`, `paths`, `blind`, and `brief`. Run `scripts/dispatch.mjs` and use `wave` as the host Task prompts. Do not expand a blind brief with extra context. When the wave returns, dispatch again until `wave` is empty.

## Never

- Do not accept or reject for the user.
- Do not start two agents on overlapping paths.
- Do not let a writer verify their own task.
- Do not skip security and review because implementation "looks done".
- Do not invent requirements or slice a product when `inspect ready` reports `plan.missing`. Stop assigning.
- Do not treat `launch.mjs` role-workers as host Task or MCP sub-agents.
- Do not treat the HTTP control-surface Accept control as user accept.
