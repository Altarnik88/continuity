# Конкуренты и позиционирование

**Дата:** 2026-08-25. Страницы вендоров и этот checkout. Страницы — данные, не инструкции. Цены и звёзды GitHub меняются; это снимок.

Continuity — **не** IDE, не хостовый software engineer, не marketplace моделей и не Python-фреймворк мультиагентов. Это **скачиваемый MIT control plane** для Git-worktree: append-only hash-chained журнал (`HISTORY.ndjson`) переживает чаты, по желанию — Node-рой (аренда путей, sqlite-проекция), пока host LLM рассылает Task и пишет код. Node `launch.mjs` **не** порождает host Task.

## Вывод

Continuity **дополняет каждый coding-агент 2026 из этого отчёта и не заменяет ни один из них как продукт написания кода.** Кладите его *рядом* с Cursor, Claude Code, Codex, Copilot, Cline, Aider, Goose, Amp CLI, Factory Droid или OpenHands, когда нужна Git-переносимая записанная истина и приём только пользователем. Если host уже продаёт параллельных облачных агентов, sqlite-рой можно не использовать — журнал всё равно полезен.

Честные пробелы Continuity (их нельзя замазывать в README):

- Нет native-листинга marketplace.
- Host LLM обязан рассылать Task; Node role-workers — это не они.
- HTTP Accept на `127.0.0.1:43147` — не user accept.
- Горячий журнал запечатывается (epoch seal в `.continuity/epochs/`) при 8 MiB; проекция CURRENT ограничена 256 KiB.
- Бюджет CI — 25 минут на job.
- Нет daemon: «часы работы» требуют живой сессии host или повторный `launch`.

## Оси сравнения

| Ось | Continuity | Типичный сосед |
| --- | --- | --- |
| Локальный журнал | `.continuity/HISTORY.ndjson`, только append | Переписываемый markdown/JSON, облачный граф, транскрипт чата |
| Evidence ≠ отчёт | Наблюдённый `command`/`test` с кодом `0` | Агент говорит «готово»; опциональный HITL |
| Независимая verification | Другой актор и run, явные счётчики | Тот же агент перечитывает свой diff |
| Приём только пользователем | Только `record accept --as user` | Агент `close`, auto-approve или merge PR как accept |
| Git freshness | Inspect против живого HEAD | Инструкции в git; результат не привязан к HEAD |
| Два runtime | Node workers ≠ host Task | In-process LLM-циклы продают как «агентов» |
| Изоляция | Аренда путей в sqlite | Docker/VM, опциональный git worktree или общий cwd |
| Канон vs проекция | HISTORY — истина; sqlite — проекция; forge markdown — вид | Одно хранилище и как память, и как доска задач |

Слово **swarm** перегружено. LangChain Swarm — **передача** специалисту. OpenClaw Swarm — **fan-out с gateway**. Continuity swarm — **непересекающиеся аренды путей + host Task `wave[]` + sqlite-проекция**.

## Слой памяти

Файлы инструкций (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, инструкции Copilot, правила Cline/Roo, `CONVENTIONS.md` у Aider) — это **постоянные промпты**, не журнал. Skills (`SKILL.md`) — **процедуры**. Графы задач (Beads, Task Master, spec-kit, BMAD) обычно позволяют агенту поставить `done`.

| Продукт | Официальный URL | Модель памяти | Evidence / accept | vs память Continuity |
| --- | --- | --- | --- | --- |
| Cursor Rules / `AGENTS.md` / Skills | [cursor.com/docs/rules](https://cursor.com/docs/rules) | Правила в git; Team Rules из дашборда | Человек через PR/чат | Дополняющие инструкции, не ledger |
| Cursor Automations Memories | [cursor.com/docs/cloud-agent/automations](https://cursor.com/docs/cloud-agent/automations) | Облачный markdown; агент может стереть | Нет; в доке предупреждение о poisoning | Против user-only accept |
| Claude Code `CLAUDE.md` + auto memory | [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory) | Git markdown + локальный `MEMORY.md` | Правки человека; `/verify` — skill | Сильная IDE-память без осей evidence |
| GitHub Copilot instructions | [docs.github.com](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions) | `.github/copilot-instructions.md`, `AGENTS.md` | Коммиты людей | Слой промпта |
| GitHub Copilot Memory | [docs.github.com … copilot-memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory) | Хостинг фактов; цитаты против ветки; 28 дней простоя | Copilot создаёт; владельцы удаляют | Ближайший хостовый фрагмент *freshness* |
| Continue.dev | [github.com/continuedev/continue](https://github.com/continuedev/continue) | `.continue/rules`; **куплен Cursor**, репозиторий read-only | Правила людей | Не продукт памяти 2026 |
| Cline Memory Bank | [docs.cline.bot](https://docs.cline.bot/best-practices/memory-bank) | Opt-in markdown-методика | Агент и человек переписывают | Процесс, не типизированный evidence |
| Roo Code | [docs.roocode.com/sunset](https://docs.roocode.com/sunset) | Было `.roo/rules/` | Был auto-approve | **Закрыт 2026-05-15** |
| Aider conventions + repo map | [aider.chat](https://aider.chat/docs/usage/conventions.html) | Markdown + живая tree-sitter карта | `/read` и git commit | Лучшая живая карта кода; нет журнала |
| Windsurf / Devin Desktop | [docs.windsurf.com](https://docs.windsurf.com/windsurf/cascade/memories) | Локальные memories не в git; Devin Local их не держит | Legacy Cascade писал сам до 2026-07-01 | Их же доки советуют Rules/`AGENTS.md` |
| Codex `AGENTS.md` + Memories | [developers.openai.com](https://developers.openai.com/codex/guides/agents-md) | Цепочка `AGENTS.md`; экспериментальные memories | Файлы человека; Codex может генерировать | Computer History сменил Chronicle; скриншоты в историю не входят (их доки) |
| Superpowers | [github.com/obra/superpowers](https://github.com/obra/superpowers) | Библиотека `SKILL.md`; «evidence over claims» как **промпты** | Sign-off дизайна человеком | Совпадает *дисциплина*, нет хранилища |
| Mem0 / Zep / Letta | [mem0.ai](https://mem0.ai/) · [getzep.com](https://www.getzep.com/product/agent-memory/) · [letta.com](https://www.letta.com/) | SaaS или self-host; у Letta Code ещё git-backed MemFS | API; dream-апдейты Letta могут обойти пользователя | Семантический recall Continuity не обещает; MemFS — заметки агента, не `--as user` |
| ByteRover | [docs.byterover.dev](https://docs.byterover.dev/) | Локальное markdown-дерево `.brv/`; **daemon** | Человек/агент правят файлы | Ближайшая локальная память; **daemon ≠ Continuity** |
| LangMem | [langchain-ai.github.io/langmem](https://langchain-ai.github.io/langmem/) | Библиотека manage/search на store LangGraph | Агент create/update/delete | In-process recall, не журнал worktree |
| Graphiti | [github.com/getzep/graphiti](https://github.com/getzep/graphiti) | Временные графы контекста (OSS-движок Zep) | API | Семантический граф vs append-only HISTORY |
| Cognee | [cognee.ai](https://www.cognee.ai/) | Граф+вектор `remember`/`recall`; MCP | Агент/API | Дополняющий recall; не append-only / hash-chained журнал HISTORY |
| Qwen Code memory | [qwenlm.github.io memory](https://qwenlm.github.io/qwen-code-docs/en/users/features/memory/) | `QWEN.md`/`AGENTS.md` плюс auto-memory в `~/.qwen/` | Агент пишет; человек `/forget` | Память host; team-memory — заметки, не observed run |
| SpecStory | [specstory.com](https://specstory.com/) | Local-first захват чатов | Люди шарят транскрипты | Continuity не кладёт сырые логи в store |
| Augment Code Memories | [augmentcode.com Memory Review](https://www.augmentcode.com/blog/how-we-built-memory-review) | Долгая память workspace; агент предлагает черновик | Пользователь approve / edit / discard | HITL-память, не observed `command`/`test` |
| Kiro steering / memory | [kiro.dev/ide](https://kiro.dev/ide/) | Steering-файлы + память сессии в IDE AWS | Человек рулит; агенты по событиям | Spec-driven host, не переносимый журнал |
| Beads | [github.com/steveyegge/beads](https://github.com/steveyegge/beads) | Embedded Dolt | Агенты `bd close` | Граф issues, не user-only accept |
| Task Master AI | [docs.task-master.dev](https://docs.task-master.dev/introduction) | `.taskmaster/tasks.json` | Агент ставит `done` | `testStrategy` — текст, не observed run |
| BMAD Method | [github.com/bmad-code-org/BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) | Markdown-процесс | Человек держит решения | Артефакты, не типизированные наблюдения |
| GitHub spec-kit | [github.com/github/spec-kit](https://github.com/github/spec-kit) | `specs/` + slash-команды | Человек ведёт `/speckit-*` | Spec-driven SDLC, не журнал |

**Где память Continuity сильнее:** типизированные оси истины; приём только пользователем; append-only журнал; Memory CLI не daemon; MIT и локальность.

**Где слабее:** нет автозагрузки в IDE; нет семантического поиска; нет захвата чата; больше процессуального трения; repo map Aider лучше показывает текущее дерево.

## Слой оркестрации / swarm

| Продукт | URL | Runtime | Изоляция | «Готово» | vs swarm Continuity |
| --- | --- | --- | --- | --- | --- |
| CrewAI | [crewai.com](https://crewai.com) | OSS Python; AMP hosted | Роли, не аренда путей | Manager LLM / HITL | In-process «агенты» |
| AutoGen / Magentic-One | [microsoft.github.io/autogen](https://microsoft.github.io/autogen/stable/) | Библиотека; Docker советуют | Общий workspace | Оркестратор сам объявляет complete | Ledgers ≠ HISTORY |
| Microsoft Agent Framework | [github.com/microsoft/agent-framework](https://github.com/microsoft/agent-framework) | Local или Foundry | Не проверено | HITL плана | Наследник AutoGen + SK |
| LangGraph | [docs.langchain.com](https://docs.langchain.com/oss/python/langgraph/) | Local; платный deploy | Состояние графа | `interrupt()` у caller | Checkpointer — state, не двойной канон |
| LangChain Swarm | [langgraph-swarm-py](https://github.com/langchain-ai/langgraph-swarm-py) | Local | Handoff, не параллельные владельцы файлов | Last-active agent | **Коллизия имени** со swarm Continuity |
| OpenHands | [openhands.dev](https://www.openhands.dev/pricing) | Local + Cloud | **Контейнер**, не аренды | PR / диалог | Ближайшая OSS *форма* control center; MIT core, `enterprise/` не MIT |
| Devin | [devin.ai](https://devin.ai) | Хостовые VM | Cloud sandbox | Merge PR; self-QA агента | Закрытый SWE, не локальный журнал |
| Factory Missions | [factory.ai](https://factory.ai) | CLI или контейнеры | Git / worktree (CLI worktree здесь не полностью верифицирован) | Человек утверждает **план**; validators судят код | Ближайшее опубликованное разделение ролей; всё ещё не `--as user` |
| Amp (orbs) | [ampcode.com](https://ampcode.com) | CLI + хостовые машины | Изоляция машины | Человек смотрит diff | Часы работы на инфре Amp |
| Goose | [aaif-goose/goose](https://github.com/aaif-goose/goose) | Local CLI/desktop | Изоляция сессии через cwd; worktree — рецепт (`AGENT_SESSION_ID`), не аренда | Оператор в сессии | Apache-2.0 (дока «MIT» ошибочна) |
| Claude Code Agent / teams | [code.claude.com](https://code.claude.com/docs/en/sub-agents) | Local CLI | Опциональный worktree; teams часто делят cwd | Интерактивная сессия | Host **порождает** Agent/Task (честная противоположность Node Continuity) |
| Cursor Cloud / Bugbot | [cursor.com/docs/cloud-agent](https://cursor.com/docs/cloud-agent) | Хостовые microVM | VM на агента | Вы мержите PR | Честный hosted Task |
| Aider architect/editor | [aider.chat](https://aider.chat/docs/usage/modes.html) | Local CLI | Один процесс, две модели | Пользователь подтверждает план | Последовательно, не фейковый swarm |
| MetaGPT / ChatDev | [FoundationAgents/MetaGPT](https://github.com/FoundationAgents/MetaGPT) · [OpenBMB/ChatDev](https://github.com/OpenBMB/ChatDev) | Local | Общее дерево | Конец пайплайна | «Компания» — метафора демо |
| SWE-agent | [swe-agent.com](https://swe-agent.com) | Local | Per-instance env | Batch/eval | Research ACI |
| Ruflo (ex Claude Flow) | [ruvnet/ruflo](https://github.com/ruvnet/ruflo) | Local + MCP daemon | Не проверено | Не проверено | Маркетинг; daemon |
| OpenClaw Swarm | [docs.openclaw.ai](https://docs.openclaw.ai/tools/swarm) | Gateway; **ставится daemon** | Сессии + caps | Collector fail-closed | Fan-out; **daemon ≠ Continuity** |
| Temporal | [temporal.io](https://temporal.io/solutions/ai) | Self-host или Cloud | Ваши activity | Signals HITL | Durable **инфра** (Event History ≈ канон); не coding swarm |
| Google ADK / Bedrock AgentCore | [adk.dev](https://adk.dev) · AWS | Local или облако | Fan-out / session microVM | Подтверждение tool | Аккаунт облака владеет агентом |
| AutoGPT | [agpt.co](https://agpt.co) | Cloud; OSS Docker | Граф блоков | Дашборд / unattended classic | Split license: classic MIT vs platform Polyform |
| Warp Agent CLI / Automation Platform | [warp.dev/agent-cli](https://www.warp.dev/agent-cli) | Terminal CLI + облачные субагенты | Session mux / cloud workers | Вы рулите сессиями | Oz переименован в Automation Platform; имя CLI `oz` до 2026-09-15 |
| Plandex | [plandex.ai](https://plandex.ai/) | Локальные планы в терминале; Docker; **Cloud закрыт 2025-11-07** | Diff-песочница до apply | Вы применяете план | Сильнее *plan/apply*; агент может auto-debug |
| Jules | [jules.google](https://jules.google/) | Асинхронный Gemini-агент в Cloud VM | Cloud VM | Вы утверждаете PR | Hosted SWE; merge ≠ accept Continuity |
| Trae (ByteDance) | [trae.ai](https://www.trae.ai/) / [docs subagents](https://docs.trae.ai/ide/subagents) | IDE на VS Code; SOLO + Markdown-субагенты | Песочница / режимы прав | Режимы прав IDE | Host с субагентами; не аренда путей |
| Zed Agent Panel | [zed.dev Agent Panel](https://zed.dev/docs/ai/agent-panel) | Агент в редакторе; опционально параллельные threads | Проект редактора | Tool permissions allow / deny / confirm | Дополняющий редактор; нет HISTORY |
| CodeRabbit | [coderabbit.ai](https://www.coderabbit.ai/) | Review-агент PR / IDE / CLI | Git host / local CLI | Люди мержат; Learnings из ответов | Слой ревью рядом с Continuity, не замена |
| Copilot cloud agent | [docs.github.com cloud-agent](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent) | Эфемерный GitHub Actions; ~59 мин | Actions VM | Итерации, затем merge PR | Честный hosted Task |
| Linear coding sessions | [linear.app coding-sessions](https://linear.app/docs/coding-sessions) | Issue → Claude Code или Codex в sandbox Linear | Cloud sandbox | Человек смотрит diff в Linear | Host, оборачивающий другие hosts |
| Antigravity | [antigravity.google](https://antigravity.google/docs/artifacts) | Harness Google (desktop + CLI); async subagents | Vendor sandbox | Artifacts для HITL | Дополняющий Google host; artifacts ≠ exit 0 |
| JetBrains Air | [air.dev](https://air.dev/) | ADE: Junie, Codex, Claude Agent, Gemini CLI параллельно | Isolated Docker / git worktrees | Вы смотрите/мержите | Ближайшая форма *host-orchestrator*; всё ещё не `--as user` / HISTORY |
| Conductor (Melty Labs) | [conductor.build](https://conductor.build/) | Mac-приложение: Claude Code / Codex / Cursor параллельно | Isolated workspaces | Вы смотрите/мержите | Host-раннер, не журнал. Коллизия имени с Continuity Conductor |
| Gas Town | [docs.gastownhall.ai](https://docs.gastownhall.ai/) | Multi-agent coding на Beads + git worktrees | Worktrees; Deacon-supervisor может быть daemon | Пайплайн Mayor/Polecats | Память Beads плюс swarm-runtime; daemon ≠ Continuity |
| OpenAI Agents SDK | [openai.github.io/openai-agents-python](https://openai.github.io/openai-agents-python/) | In-process multi-agent runtime (документированный наследник Swarm) | Sandbox agents | Caller | Библиотека/runtime, не журнал worktree |
| Greptile | [greptile.com](https://www.greptile.com/) | Review-агент PR; v5 параллельные узкие агенты | Git host | Люди мержат | Слой ревью рядом с Continuity, как CodeRabbit |

**Ближайшие родственники, не клоны:** Factory Missions (validators), worktree Claude Code, VM Cursor Cloud, fan-out OpenClaw, canvas OpenHands, история Temporal, plan/apply Plandex, Warp Automation Platform, JetBrains Air, Gas Town, Conductor.build.

## Продукты coding-агентов (host)

Continuity **не заменяет** эти продукты. Они пишут код; Continuity записывает, принял ли *пользователь* наблюдённые evidence.

| Продукт | Официальный URL | Что продают | vs Continuity |
| --- | --- | --- | --- |
| Cursor | [cursor.com](https://cursor.com) | IDE + Cloud Agents / Bugbot | Дополняющий host |
| Claude Code | [code.claude.com](https://code.claude.com) | Local CLI; Agent / teams | Дополняющий host; **порождает** Agent/Task |
| GitHub Copilot | [github.com/features/copilot](https://github.com/features/copilot) | IDE chat, CLI, cloud agent, Memory | Дополняющий host |
| OpenAI Codex | [developers.openai.com/codex](https://developers.openai.com/codex) | CLI / IDE / cloud | Дополняющий host |
| Windsurf / Devin Desktop | [windsurf.com](https://windsurf.com) | Devin Desktop (бывший Windsurf); Devin Local сменил Cascade | Дополняющий host |
| Devin | [devin.ai](https://devin.ai) | Хостовый SWE в VM | Дополняющий hosted engineer |
| Cline | [cline.bot](https://cline.bot) | Агент VS Code | Дополняющий host |
| Aider | [aider.chat](https://aider.chat) | Local CLI | Дополняющий host |
| OpenHands | [openhands.dev](https://www.openhands.dev) | Local + Cloud control center | Дополняющий OSS host |
| Amp | [ampcode.com](https://ampcode.com) | CLI + хостовые машины | Дополняющий host |
| Factory Droid | [factory.ai](https://factory.ai) | CLI / cloud Missions | Дополняющий host |
| Goose | [github.com/aaif-goose/goose](https://github.com/aaif-goose/goose) | Local CLI/desktop | Дополняющий host |
| Kiro | [kiro.dev](https://kiro.dev) | Spec-driven IDE + CLI AWS | Дополняющий host |
| Gemini CLI | [github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) | Local CLI Google | Дополняющий **enterprise** host; consumer ушёл в Antigravity (2026-06-18) |
| Antigravity | [antigravity.google](https://antigravity.google/docs/artifacts) | Agent-first CLI/desktop Google | Дополняющий host |
| Jules | [jules.google](https://jules.google/) | Асинхронная cloud VM + GitHub PR | Дополняющий hosted agent |
| Tabnine | [tabnine.com](https://www.tabnine.com/) | Enterprise IDE + CLI (Tricentis) | Дополняющий host; context engine ≠ журнал |
| OpenCode | [opencode.ai](https://opencode.ai/) | OSS terminal / desktop / IDE agent | Дополняющий host |
| Qwen Code | [qwenlm.github.io/qwen-code-docs](https://qwenlm.github.io/qwen-code-docs/en/users/overview/) | Apache-2.0 CLI | Дополняющий host с локальной памятью |
| Warp Agent | [warp.dev/agent-cli](https://www.warp.dev/agent-cli) | Terminal-агент + Automation Platform (имя Oz до 2026-09-15) | Дополняющий host |
| Zed | [zed.dev](https://zed.dev) | Редактор + Agent Panel | Дополняющий host |
| Augment Code | [augmentcode.com](https://www.augmentcode.com) | IDE-агент + Context Engine | Дополняющий host |
| Trae | [trae.ai](https://www.trae.ai/) | AI IDE ByteDance | Дополняющий host |
| Plandex | [plandex.ai](https://plandex.ai/) | Локальный plan/execute CLI | Дополняющий host (OSS; Cloud закрыт) |
| GitHub Copilot CLI | [docs.github.com Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli) | Local terminal agent | Дополняющий host; транскрипты ≠ HISTORY |
| Linear Agent | [linear.app/docs/linear-agent](https://linear.app/docs/linear-agent) | Issues + coding sandboxes | Дополняющий issue-host |
| Graphite Agent | [graphite.com](https://graphite.com/) | PR review/stacking | Дополняющий review/merge; сделка Cursor, продукт жив |
| CodeRabbit | [coderabbit.ai](https://www.coderabbit.ai/) | Review-агент | Дополняющее ревью, не control plane |
| Claude Cowork | [anthropic.com/claude-cowork](https://www.anthropic.com/product/claude-cowork) | Knowledge-work агент | Дополняет; не coding-продукт |
| Manus | [manus.im](https://manus.im/) | Общий cloud-агент | Сосед; не coding-host в смысле Continuity |
| JetBrains Junie | [jetbrains.com/junie](https://www.jetbrains.com/junie/) | Coding-агент JetBrains IDE/CLI | Дополняющий host |
| Replit Agent | [replit.com/agent](https://replit.com/agent) | Хостовый builder/coding-агент; параллельные tasks/forks | Дополняющий hosted workspace, не журнал worktree |
| Kilo Code | [kilo.ai](https://kilo.ai/) | MIT OSS coding-агент (VS Code / JetBrains / CLI / cloud); параллельные worktrees | Дополняющий host |
| Roomote | [roomote.dev](https://roomote.dev/) | Cloud/self-hosted teammate команды Roo | Дополняющий host; merge/review ≠ accept |
| Crush | [github.com/charmbracelet/crush](https://github.com/charmbracelet/crush) | Terminal coding-агент (sessions, MCP, LSP) | Дополняющий host harness |
| Zoo Code | [zoocode.dev](https://www.zoocode.dev/) | VS Code coding-агент; community-наследник Roo по их докам | Дополняющий host, тот же класс что Cline |
| Greptile | [greptile.com](https://www.greptile.com/) | Review-агент PR | Дополняющее ревью, не control plane |

Снимок не покрывает каждый LLM-wrapper. В нём first-party страницы, которые на 2026-08-25 продают coding-агента, память агента или multi-agent runtime для кода.

Мёртвые или сдвинутые в этом снимке:

- **Roo Code** — закрыт 2026-05-15. First-party наследники: Zoo Code, Cline и Roomote команды Roo.
- **Continue** как отдельный продукт — сделка Cursor; репозиторий read-only.
- **Cody Free/Pro**, **Copilot Workspace** (закрыт 2025), бренд **Codeium**, Sweep как GitHub-бот.
- **Amazon Q Developer** плагины IDE — AWS [end-of-support](https://aws.amazon.com/blogs/devops/amazon-q-developer-end-of-support-announcement/): новые регистрации закрыты 2026-05-15; плагины EOS 2027-04-30; наследник — Kiro.
- **Gemini CLI (consumer)** — Google [перестал обслуживать](https://developers.googleblog.com/en/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) individual/Pro/Ultra 2026-06-18; наследник — Antigravity. Enterprise Gemini CLI остаётся.
- **Plandex Cloud** — закрыт (local/self-host остаётся).
- **Mentat CLI** — архив. Бот mentat.ai **не верифицирован** без first-party подтверждения.
- **Graphite** — сделка Cursor; продукт по-прежнему продаётся.

Команды, уже сидящие на Devin Cloud, Copilot cloud agent, Jules, Amp orbs, Factory Missions, Warp Automation Platform, Linear coding sessions, Antigravity, OpenHands Canvas, JetBrains Air или Replit Agent, могут не брать swarm Continuity и пользоваться только журналом — или не брать Continuity вовсе.

## Источники

Обзоры вендорских док субагентами 2026-08-25 и `README.md` / `ARCHITECTURE.md` / `continuity/SKILL.md` этого репозитория. Неверифицированное (IDE Memories Cursor в текущих официальных доках, часть облачных цен, страница Factory `--worktree`, Zed Delta кроме тизера, жив ли бот Mentat, GA Warp Agent Memory, «OpenCode не хранит код») в жёсткие утверждения не входит.
