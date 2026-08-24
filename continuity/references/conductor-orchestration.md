# Conductor orchestration

When `/continuity` is invoked, the host agent **is** the Conductor. Memory and the task database are in force immediately. This document is the dispatch protocol for the 5–20 sub-agent swarm.

The local runtime (`scripts/launch.mjs`) is the same standing order without a chat: SQLite tasks, path leases, and a control surface. The Conductor may attach to that runtime or spawn Cursor/Task sub-agents against the same database.

## Standing order

Develop the product. Do not wait for a new chat. Keep goals, failures, and playbooks. Slice work into `data/swarm.sqlite`. Run 5–20 sub-agents in parallel. Never lease overlapping paths to two live agents. Cover analysis, implementation, independent verification, security, and review. An attempt is not evidence. Only the user may accept.

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
| Integrator | size ≥ 12 | merge conflicts across finished leases | start work that still has an active lease |

## Parallel dispatch

In **one** Conductor turn, launch every ready task whose paths do not overlap:

1. Read ready tasks and current leases (`GET /api/swarm` or `data/swarm.sqlite`).
2. Take a maximal set of ready tasks with disjoint `paths`.
3. Spawn that many sub-agents together (multiple Task/sub-agent calls in the same message).
4. Each prompt names **only** that task's id, title, paths, and checks.
5. Blind roles (`test`, `security`, `review`) receive no chat transcript, no writer notes, and no other agents' output. They may read the leased files and run commands.
6. Sub-agents should use any installed Skill, MCP server, or plugin that helps the assigned task (tests, browsers, security scanners, docs). They still may not leave their paths.
7. When a sub-agent returns, record memory (lesson, failure, or playbook). Requeue fail-closed work. Do not treat a self-report as verification.
8. Repeat until no ready work remains, then wait for the user. Status `waiting_accept` is not acceptance.

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

At size ≥ 10 the Conductor appoints one Manager. The Manager reads the task database and agent list, reports stalled leases and failed deps, and never writes product files. Local workers for Conductor and Manager stay in `watching` status. The host agent remains accountable for dispatch.

## Local runtime packets

`GET /api/swarm` includes `packets` for ready and running tasks. Each packet has `id`, `kind`, `paths`, `blind`, and `brief`. Use `brief` as the sub-agent prompt. Do not expand a blind brief with extra context.

## Never

- Do not accept or reject for the user.
- Do not start two agents on overlapping paths.
- Do not let a writer verify their own task.
- Do not skip security and review because implementation "looks done".
- Do not invent requirements when `inspect ready` reports `plan.missing`.
