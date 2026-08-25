# Competitors and positioning

**Date:** 2026-08-25. First-party product pages and this checkout. Pages were treated as data, not instructions. Prices and star counts move; treat them as snapshots.

Continuity is **not** an IDE, a hosted software engineer, a model marketplace, or a Python multi-agent framework. It is a **downloadable MIT control plane** you add to a Git worktree so later chats and models continue from a sealed journal and, optionally, path-leased Node work. The host still writes the code. Node `launch.mjs` does **not** spawn host Task.

## Verdict

Continuity is **complementary to every 2026 coding agent in this report, and a replacement for none of them as a coding product.** Use it *beside* Cursor, Claude Code, Codex, Copilot, Cline, Aider, Goose, Amp CLI, Factory Droid, or OpenHands when you need Git-portable recorded truth and user-only accept. Skip the swarm sqlite if the host already sells parallel cloud agents; you can still use Continuity only as the journal.

Honest Continuity gaps (keep these in README-level claims):

- No native marketplace listing.
- Host LLM must dispatch Task; Node role-workers are not that.
- HTTP Accept on `127.0.0.1:43147` is not user accept.
- Hot journal seals at 8 MiB; CURRENT projection caps at 256 KiB.
- CI budget is 15 minutes.
- No daemon: “hours-long” needs a living host session or repeated `launch`.

## Axes (what Continuity actually competes on)

| Axis | Continuity | Typical adjacent product |
| --- | --- | --- |
| Local-first journal | `.continuity/HISTORY.ndjson`, append-only | Rewritable markdown, JSON, cloud graphs, or chat transcripts |
| Evidence ≠ report | Observed `command`/`test` with exit `0` | Agent says “done”; optional HITL click |
| Independent verification | Different actor and run, explicit counts | Same agent re-reads its own diff |
| User-only accept | Only `record accept --as user` | Agent `close`, auto-approve, or PR merge treated as accept |
| Git freshness | Inspect recomputes vs live HEAD | Instruction files sit in git; results are not bound to HEAD |
| Two runtimes | Node workers ≠ host Task | In-process LLM loops sold as “agents” |
| Isolation | Path leases in sqlite | Docker/VM, optional git worktree, or shared cwd |
| Canon vs projection | HISTORY truth; sqlite projection; forge markdown is a view | One store that is both memory and task board |

“Swarm” is overloaded. LangChain Swarm is specialist **handoff**. OpenClaw Swarm is **fan-out from a gateway**. Continuity swarm is **disjoint path leases + host Task `wave[]` + sqlite projection**.

## Memory layer

Instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, Copilot instructions, Cline/Roo rules, Aider `CONVENTIONS.md`) are **standing prompts**, not journals. Skills (`SKILL.md`) are **procedures**. Task graphs (Beads, Task Master, spec-kit, BMAD stories) let agents usually mark `done`.

| Product | Official URL | Memory model | Evidence / accept | vs Continuity memory |
| --- | --- | --- | --- | --- |
| Cursor Rules / `AGENTS.md` / Skills | [cursor.com/docs/rules](https://cursor.com/docs/rules) | Git-tracked rules; Team Rules from the dashboard | Human via PR/chat; no typed accept gate | Complementary instructions, not a ledger |
| Cursor Automations Memories | [cursor.com/docs/cloud-agent/automations](https://cursor.com/docs/cloud-agent/automations) | Cloud markdown agents can rewrite/delete | None; docs warn of poisoning | Opposite of user-only accept |
| Claude Code `CLAUDE.md` + auto memory | [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory) | Git markdown + machine-local `MEMORY.md`; Claude writes auto memory | Human edits; `/verify` is a skill, not a journal | Strong IDE memory; no evidence axes |
| GitHub Copilot instructions | [docs.github.com … custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions) | `.github/copilot-instructions.md`, `AGENTS.md` | Humans commit files | Prompt layer |
| GitHub Copilot Memory | [docs.github.com … copilot-memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory) | Hosted facts; citations re-checked vs branch; 28-day unused expiry | Owners can delete; Copilot creates | Closest hosted *freshness* fragment; not accept |
| Continue.dev | [github.com/continuedev/continue](https://github.com/continuedev/continue) | `.continue/rules`; **acquired by Cursor**, repo read-only | Human rules | Do not treat as a 2026 memory product |
| Cline Memory Bank | [docs.cline.bot … memory-bank](https://docs.cline.bot/best-practices/memory-bank) | Opt-in git markdown methodology | Agent and human rewrite | Process, not typed evidence |
| Roo Code | [docs.roocode.com/sunset](https://docs.roocode.com/sunset) | Was `.roo/rules/` | Auto-approve existed | **Sunset 2026-05-15** |
| Aider conventions + repo map | [aider.chat/docs/usage/conventions](https://aider.chat/docs/usage/conventions.html) | Read-only markdown + live tree-sitter map | Human `/read` and git commits | Stronger live **code map**; no journal |
| Windsurf / Devin Desktop memories | [docs.windsurf.com … memories](https://docs.windsurf.com/windsurf/cascade/memories) | Local memories not in git; Devin Local does not persist Cascade memories | Cascade auto-writes | Rules/`AGENTS.md` preferred in their own docs |
| OpenAI Codex `AGENTS.md` + Memories | [developers.openai.com/codex/guides/agents-md](https://developers.openai.com/codex/guides/agents-md) | Git `AGENTS.md` chain; experimental `~/.codex/memories/` | Human files; Codex may generate memories | Chronicle can send screenshots to OpenAI (their docs) |
| Superpowers | [github.com/obra/superpowers](https://github.com/obra/superpowers) | `SKILL.md` library; “evidence over claims” as **prompts** | Human design sign-off in brainstorming | Overlapping *discipline*, no store |
| Mem0 / Zep / Letta | [mem0.ai](https://mem0.ai/) · [getzep.com](https://www.getzep.com/product/agent-memory/) · [letta.com](https://www.letta.com/) | SaaS or self-host conversational memory; Letta Code also has git-backed MemFS | App/API; Letta dream updates may skip the user | Semantic recall Continuity does not claim; MemFS is agent-owned git notes, not `--as user` |
| ByteRover | [docs.byterover.dev](https://docs.byterover.dev/) | Local markdown context tree under `.brv/`; **background daemon** | Human/agent curate files; no typed evidence | Closest local coding-agent memory; **daemon ≠ Continuity** |
| LangMem | [langchain-ai.github.io/langmem](https://langchain-ai.github.io/langmem/) | Library: manage/search tools on a LangGraph store | Agent create/update/delete | In-process recall, not a worktree journal |
| Graphiti | [github.com/getzep/graphiti](https://github.com/getzep/graphiti) | Temporal context graphs (Zep’s OSS engine) | API/app | Semantic/temporal graph vs append-only HISTORY |
| Cognee | [cognee.ai](https://www.cognee.ai/) | Graph+vector `remember`/`recall`; optional MCP | Agent/API | Complementary recall; not a sealed journal |
| Qwen Code memory | [qwenlm.github.io memory](https://qwenlm.github.io/qwen-code-docs/en/users/features/memory/) | `QWEN.md`/`AGENTS.md` plus auto-memory under `~/.qwen/` | Agent writes; human `/forget` | Host memory; team-memory is notes, not observed runs |
| SpecStory | [specstory.com](https://specstory.com/) | Local-first chat capture | Humans share transcripts | Continuity refuses raw chat logs in the store |
| Augment Code Memories | [augmentcode.com Memory Review](https://www.augmentcode.com/blog/how-we-built-memory-review) | Workspace long-term memory; agent proposes drafts | User approve / edit / discard in chat | HITL memory gate, not observed `command`/`test` |
| Kiro steering / memory | [kiro.dev/ide](https://kiro.dev/ide/) | Steering files + session memory in an AWS IDE | Human steers; agents may run on events | Spec-driven host; not a portable journal |
| Beads | [github.com/steveyegge/beads](https://github.com/steveyegge/beads) | Embedded Dolt; JSONL is export | Agents `bd close` | Issue graph, not user-only accept |
| Task Master AI | [docs.task-master.dev](https://docs.task-master.dev/introduction) | `.taskmaster/tasks.json` | Agent can set `done` | `testStrategy` is text, not an observed run |
| BMAD Method | [github.com/bmad-code-org/BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) | Git markdown process | Human “keeps decisions”; auto loop exists | Artifacts, not typed observations |
| GitHub spec-kit | [github.com/github/spec-kit](https://github.com/github/spec-kit) | `specs/` + slash commands | Human steers `/speckit-*` | Spec-driven SDLC, not a journal |

**Where Continuity memory is stronger:** typed truth axes; user-only accept; append-only journal; Memory CLI is not a daemon; MIT and local.

**Where it is weaker:** no IDE auto-load; no semantic search; no chat capture; heavier process tax; Aider’s repo map is a better live tree view.

## Orchestration / swarm layer

| Product | Official URL | Runtime | Isolation | Done-ness | vs Continuity swarm |
| --- | --- | --- | --- | --- | --- |
| CrewAI | [crewai.com](https://crewai.com) | OSS local Python; AMP hosted | Roles/tools, not path leases | Manager LLM / HITL | In-process “agents”; MIT OSS vs commercial AMP |
| AutoGen / Magentic-One | [microsoft.github.io/autogen](https://microsoft.github.io/autogen/stable/) | Local library; Docker advised | Shared workspace unless you containerize | Orchestrator self-declares complete | Maintenance-mode library; ledgers ≠ HISTORY |
| Microsoft Agent Framework | [github.com/microsoft/agent-framework](https://github.com/microsoft/agent-framework) | Local or Foundry | Unverified leases | Plan review HITL | Successor to AutoGen + SK |
| LangGraph | [docs.langchain.com LangGraph](https://docs.langchain.com/oss/python/langgraph/) | Local; paid deploy | Shared graph state | `interrupt()` resume by caller | Checkpointer is state, not dual-canon |
| LangChain Swarm | [github.com/langchain-ai/langgraph-swarm-py](https://github.com/langchain-ai/langgraph-swarm-py) | Local | Handoff, not parallel file owners | Last-active agent | **Name collision** with Continuity swarm |
| OpenHands | [openhands.dev](https://www.openhands.dev/pricing) | Local + Cloud | **Container**, not leases | Human PR / conversation | Closest OSS *control center shape*; MIT core, `enterprise/` not MIT |
| Devin | [devin.ai](https://devin.ai) | Hosted VMs | Cloud sandbox | Human merges PRs; agent self-QA | Proprietary SWE, not a local journal |
| Factory Missions | [factory.ai](https://factory.ai) | Local CLI or cloud containers | Git / worktree (CLI worktree not fully verified here) | User approves **plan**; validators judge code | Closest published **role split** (orchestrator / worker / validator); still not `--as user` |
| Amp (orbs) | [ampcode.com](https://ampcode.com) | Local CLI + hosted machines | Machine isolation | Human reviews orb diffs | Hours-long on Amp infra |
| Goose | [github.com/aaif-goose/goose](https://github.com/aaif-goose/goose) | Local CLI/desktop | Optional session worktrees | Operator in session | Apache-2.0 (docs that say MIT are wrong) |
| Claude Code Agent / teams | [code.claude.com/docs/en/sub-agents](https://code.claude.com/docs/en/sub-agents) | Local CLI | Optional `isolation: worktree`; teams often share cwd | Interactive session | Host **does** spawn Agent/Task (honest opposite of Continuity Node) |
| Cursor Cloud Agents / Bugbot | [cursor.com/docs/cloud-agent](https://cursor.com/docs/cloud-agent) | Hosted microVMs | Per-agent VM | You merge the PR | Honest hosted Task; not a local journal |
| Aider architect/editor | [aider.chat/docs/usage/modes.html](https://aider.chat/docs/usage/modes.html) | Local CLI | One process, two models | User confirms architect plan | Sequential, not a fake swarm |
| MetaGPT / ChatDev | [FoundationAgents/MetaGPT](https://github.com/FoundationAgents/MetaGPT) · [OpenBMB/ChatDev](https://github.com/OpenBMB/ChatDev) | Local Python / local UI | Shared generated tree | Pipeline completion | “Software company” **is** the demo metaphor |
| SWE-agent | [swe-agent.com](https://swe-agent.com) | Local / Codespaces | Per-instance env | Batch/eval | Research ACI, not leases |
| Ruflo (ex Claude Flow) | [github.com/ruvnet/ruflo](https://github.com/ruvnet/ruflo) | Local + MCP daemon | Unverified | Unverified | High marketing load; daemon |
| OpenClaw Swarm | [docs.openclaw.ai/tools/swarm](https://docs.openclaw.ai/tools/swarm) | Local Gateway; **installs a daemon** | Session isolation + caps | Collector fail-closed; parent script decides | Local fan-out; **daemon ≠ Continuity** |
| Temporal | [temporal.io/solutions/ai](https://temporal.io/solutions/ai) | Self-host or Cloud | Your activities | Signals HITL | Durable **infra** (Event History ≈ canon); not a coding swarm |
| Google ADK / Bedrock AgentCore | [adk.dev](https://adk.dev) · AWS docs | Local or Google/AWS hosted | Fan-out / session microVM | Tool confirmation / return-of-control | Cloud account owns the agent |
| AutoGPT | [agpt.co](https://agpt.co) | Cloud; OSS Docker | Blocks/graph | Dashboard / unattended classic | License split: classic MIT vs platform Polyform |
| Warp Agent CLI / Oz | [warp.dev/agent-cli](https://www.warp.dev/agent-cli) | Terminal CLI + cloud subagents | Session mux / cloud workers | You steer inspectable sessions | Commercial harness; not a journal |
| Plandex | [plandex.ai](https://plandex.ai/) | Local terminal plans; Docker; **Cloud winding down** | Diff sandbox until you apply | You apply the plan | Stronger *plan/apply* host; agent can auto-debug |
| Jules | [jules.google](https://jules.google/) | Async Gemini agent in a Google Cloud VM | Cloud VM | You approve the PR | Hosted SWE; merge ≠ Continuity accept |
| Trae (ByteDance) | [trae.ai](https://www.trae.ai/) / [docs subagents](https://docs.trae.ai/ide/subagents) | VS Code–based IDE; SOLO + Markdown subagents | IDE sandbox / permission modes | IDE permission modes | Host with subagents; not path leases |
| Zed Agent Panel | [zed.dev Agent Panel](https://zed.dev/docs/ai/agent-panel) | Editor-native agent; optional parallel threads | Editor project | Tool permissions allow / deny / confirm | Complementary editor; no HISTORY |
| CodeRabbit | [coderabbit.ai](https://www.coderabbit.ai/) | PR / IDE / CLI review agent | Git host / local CLI | Humans merge; “Learnings” from replies | Review layer beside Continuity, not a substitute |
| Copilot cloud agent | [docs.github.com cloud-agent](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent) | Ephemeral GitHub Actions env; ~59-minute cap | Actions VM | You iterate then merge a PR | Honest hosted Task; skip Continuity sqlite if this is the fleet |
| Linear coding sessions | [linear.app coding-sessions](https://linear.app/docs/coding-sessions) | Issue → Claude Code or Codex in a Linear sandbox | Cloud sandbox | Human reviews the diff in Linear | Host wrapping other hosts |
| Antigravity | [antigravity.google](https://antigravity.google/docs/artifacts) | Google agent harness (desktop + CLI); async subagents | Vendor sandbox/desktop | Artifacts for HITL (plans/diffs) | Complementary Google host; artifacts ≠ observed exit 0 |

**Closest cousins, not clones:** Factory Missions (validators), Claude Code worktrees, Cursor Cloud VMs, OpenClaw fan-out, OpenHands canvas, Temporal durable history, Plandex plan/apply, Warp Oz.

## Coding-agent products (hosts)

Continuity **does not replace** these products. They write code; Continuity records whether the *user* accepted observed evidence.

| Product | Official URL | What they sell | vs Continuity |
| --- | --- | --- | --- |
| Cursor | [cursor.com](https://cursor.com) | IDE + Cloud Agents / Bugbot | Complementary host |
| Claude Code | [code.claude.com](https://code.claude.com) | Local CLI; Agent / teams | Complementary host; **does** spawn Agent/Task |
| GitHub Copilot | [github.com/features/copilot](https://github.com/features/copilot) | IDE chat, CLI, cloud agent, Memory | Complementary host |
| OpenAI Codex | [developers.openai.com/codex](https://developers.openai.com/codex) | CLI / IDE / cloud | Complementary host |
| Windsurf / Devin Desktop | [windsurf.com](https://windsurf.com) | IDE; Devin Local | Complementary host |
| Devin | [devin.ai](https://devin.ai) | Hosted SWE VMs | Complementary hosted engineer |
| Cline | [cline.bot](https://cline.bot) | VS Code agent | Complementary host |
| Aider | [aider.chat](https://aider.chat) | Local CLI | Complementary host |
| OpenHands | [openhands.dev](https://www.openhands.dev) | Local + Cloud control center | Complementary OSS host |
| Amp | [ampcode.com](https://ampcode.com) | CLI + hosted machines | Complementary host |
| Factory Droid | [factory.ai](https://factory.ai) | CLI / cloud Missions | Complementary host |
| Goose | [github.com/aaif-goose/goose](https://github.com/aaif-goose/goose) | Local CLI/desktop | Complementary host |
| Kiro | [kiro.dev](https://kiro.dev) | AWS spec-driven IDE + CLI | Complementary host |
| Gemini CLI | [github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) | Local Google CLI | Complementary **enterprise** host; consumer traffic moved to Antigravity (2026-06-18) |
| Antigravity | [antigravity.google](https://antigravity.google/docs/artifacts) | Google agent-first CLI/desktop | Complementary host |
| Jules | [jules.google](https://jules.google/) | Async cloud VM + GitHub PR | Complementary hosted agent |
| Tabnine | [tabnine.com](https://www.tabnine.com/) | Enterprise IDE + CLI (Tricentis) | Complementary host; context engine ≠ journal |
| OpenCode | [opencode.ai](https://opencode.ai/) | OSS terminal / desktop / IDE agent | Complementary host |
| Qwen Code | [qwenlm.github.io/qwen-code-docs](https://qwenlm.github.io/qwen-code-docs/en/users/overview/) | Apache-2.0 CLI (Gemini CLI lineage) | Complementary host with a local memory story |
| Warp Agent | [warp.dev/agent-cli](https://www.warp.dev/agent-cli) | Terminal-native agent + Oz | Complementary host |
| Zed | [zed.dev](https://zed.dev) | Editor + Agent Panel | Complementary host |
| Augment Code | [augmentcode.com](https://www.augmentcode.com) | IDE agent + Context Engine | Complementary host |
| Trae | [trae.ai](https://www.trae.ai/) | ByteDance AI IDE | Complementary host |
| Plandex | [plandex.ai](https://plandex.ai/) | Local plan/execute CLI | Complementary host (OSS; Cloud shut) |
| GitHub Copilot CLI | [docs.github.com Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli) | Local terminal agent; session store | Complementary host; transcripts ≠ HISTORY |
| Linear Agent | [linear.app/docs/linear-agent](https://linear.app/docs/linear-agent) | Issues + coding sandboxes | Complementary issue host wrapping other hosts |
| Graphite Agent | [graphite.com](https://graphite.com/) | PR review/stacking; Cursor Cloud Agents in-product | Complementary review/merge host; Cursor acquisition, still sold |
| CodeRabbit | [coderabbit.ai](https://www.coderabbit.ai/) | Review agent | Complementary review, not a control plane |
| Claude Cowork | [anthropic.com/claude-cowork](https://www.anthropic.com/product/claude-cowork) | Knowledge-work agent | Complementary; not a coding product |
| Manus | [manus.im](https://manus.im/) | General cloud agent | Adjacent; not a coding-agent host in Continuity’s sense |

This snapshot is not every LLM wrapper. It covers first-party pages that sell a coding agent, agent memory, or multi-agent coding runtime as of 2026-08-25.

Dead or pivoted in this snapshot:

- **Roo Code** — sunset 2026-05-15.
- **Continue** as a standalone product — Cursor acquisition; repo read-only.
- **Cody Free/Pro**, **Copilot Workspace** (sunset 2025), **Codeium** brand, Sweep-as-GitHub-bot.
- **Amazon Q Developer** IDE plugins — AWS [end-of-support](https://aws.amazon.com/blogs/devops/amazon-q-developer-end-of-support-announcement/): new signups blocked 2026-05-15; plugins EOS 2027-04-30; successor is Kiro.
- **Gemini CLI (consumer)** — Google [stopped serving](https://developers.googleblog.com/en/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) individual/Pro/Ultra on 2026-06-18; successor is Antigravity. Enterprise Gemini CLI continues.
- **Plandex Cloud** — shut (local/self-host remains).
- **Mentat CLI** — archived. The mentat.ai bot is **unverified** without a logged-in first-party confirmation.
- **Graphite** — Cursor acquisition; still sold at graphite.com.

Teams already standardized on Devin Cloud, Copilot cloud agent, Jules, Amp orbs, Factory Missions, Warp Oz, Linear coding sessions, Antigravity, or OpenHands Canvas may skip Continuity’s swarm and still use only the journal — or skip Continuity entirely.

## Sources

Sub-agent reviews of vendor docs on 2026-08-25 plus this repository’s `README.md`, `ARCHITECTURE.md`, and `continuity/SKILL.md`. Unverified items (Cursor IDE chat Memories in current official docs, some cloud list prices, Factory `--worktree` CLI page, Zed Delta beyond homepage teaser, Mentat bot liveness, Warp Agent Memory GA, OpenCode “does not store code”) are omitted from hard claims here.
