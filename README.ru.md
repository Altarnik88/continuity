# Continuity

[English](README.md) · [Русский](README.ru.md)

**Локальный control plane для долгой работы coding-агентов: память, которая переживает чаты, база нарезанных задач и параллельный рой, который стартует при запуске.**

Continuity — скачиваемый Node.js-продукт для Git-репозитория. Он делает три работы, которые сессии обычно смешивают и потом теряют:

1. **Помнить истину проекта** — цели, неудачные попытки, уроки, лучшие решения, evidence, независимую verification, freshness и то, принял ли *пользователь* результат. Истина — Core `HISTORY`. Swarm sqlite — проекция исполнения с id задач/событий журнала. Markdown (forge `MEMORY.md` / `HANDOFF.md`) — вид, не хранилище.
2. **Нарезать только уполномоченную работу в базу задач** — ready-задачи, аренда путей и standing order, который не ждёт новый чат. Если `inspect ready` сообщает `plan.missing`, не назначайте работу и не выдумывайте требования.
3. **Не смешивать два runtime** — `launch.mjs` гоняет детерминированные Node role-workers, sqlite-проекцию и HTTP-панель. Host LLM распараллеливает изолированные Task / Cursor-Grok субагенты. Node не порождает host Task. Слова исполнителя никогда не считаются доказательством. Принимает только `record accept --as user`.

Скачивайте, когда следующий чат, другая модель или сменный исполнитель должны продолжить без догадок — и когда больше одного актора работают в одном репозитории без пересечения файлов и без права пометить работу принятой за вас.

Runtime: Node.js 22 или 24 (`package.json` engines: `>=22 <25`) и Git. Лицензия MIT. Распространяется с [Altarnik88/continuity](https://github.com/Altarnik88/continuity), не из package registry.

Версия продукта — `package.json` (`3.0.0`). `--version` печатает это значение. Схема хранилища — **v3**, это не версия продукта.

## Зачем

Долгая агентная работа ломается двумя независимыми способами.

**Сбой памяти.** Новый чат не знает цель, провалившиеся подходы, последние evidence и точный следующий шаг. Исторический PASS доверяют сдвинутому Git HEAD. Исполнитель «проверяет» сам себя. Кто-то кроме пользователя помечает фичу принятой.

**Сбой управления.** Два агента правят одни файлы. Ready-работа угадывается, а не выводится. Процесс Coordinator подразумевается, но не запускается. Отчёт исполнителя принимают за результат теста. Сменный актор продолжает предыдущий Attempt. Обязательные критерии уходят в backlog.

**Не** скачивайте это как замену Git, issue tracker, хранилище секретов, marketplace хостовых моделей, daemon или автоматическое доказательство корректности. Если правка одна и очевидная — просто сделайте её. Если следующего актора не было в комнате — используйте Continuity.

## Быстрый старт

`--version` работает без установки зависимостей:

```bash
git clone https://github.com/Altarnik88/continuity.git
cd continuity
npm install
node continuity/scripts/continuity.mjs --version
npm start
node continuity/scripts/launch.mjs --once
```

`npm start` (то же, что `npm run launch`) запускает `launch.mjs`: детерминированные Node role-workers, sqlite-проекцию исполнения и HTTP-панель на порту 43147. Этот процесс не порождает host Task. В Cursor или Grok `/continuity` делает главного агента **дирижёром**: он поднимает память, наполняет базу задач из журнала, а host LLM распараллеливает изолированные Task-субагенты на анализ, разработку, слепую проверку, безопасность и ревью. С размера 10 назначается управляющий. `launch.mjs --once` гоняет Node role-workers без UI до конца текущей волны. Кнопка **Принять** на панели — не user accept. `mission.accepted` — не user accept. Принимает только `record accept --as user`.

Из Git-репозитория, который Continuity должен помнить:

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" doctor
```

Если `doctor` сообщает `journal=uninitialized`, отредактируйте `continuity/assets/init-v3.template.json`, чтобы цель и критерий были пользовательскими, затем `init --schema 3 --file` этого шаблона. Потом `inspect` и `inspect ready --json`. Если `plan.missing` непустой, не назначайте работу и не выдумывайте срез продукта.

Coordinator необязателен. Он никогда не принимает результат за пользователя и не правит файлы `HISTORY`:

```bash
node continuity/scripts/coordinator.mjs doctor --root .
```

Флаги рецептов, обязательный `--exit-code` у `record verify` и `--evidence` у успешного `record result` — в документах ниже. Не копируйте неполные командные строки.

[Лицензия MIT](LICENSE). Copyright (c) 2026 Altarnik88.

## Документы

| Документ | Зачем читать |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Слои, write/read path, раскладка, FAQ |
| [INSTALL.md](INSTALL.md) | Клон, профили, installer, первые минуты |
| [COORDINATOR.md](COORDINATOR.md) | CLI управления агентами, пакеты, resume |
| [SECURITY.md](SECURITY.md) | Граница секретов, пределы hash-chain |
