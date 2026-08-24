# Agent instructions

This checkout is Continuity. Use the Continuity Memory CLI from this worktree. Use the Coordinator CLI only when the user wants agent management. Do not require any other Skill. Do not fork journal logic.

## Resolve the CLIs

```bash
node continuity/scripts/continuity.mjs
node continuity/scripts/coordinator.mjs
```

The canonical Skill is `continuity/SKILL.md`. Files under `.cursor/skills` and `.grok/skills` are discovery pointers only.

Run the Memory CLI from the target Git worktree. Optional `--root` must name that worktree's exact top level. The store is `<repository>/.continuity`, never the Skill directory.

## Start with read-only inspection

```bash
node continuity/scripts/continuity.mjs doctor
node continuity/scripts/continuity.mjs inspect
node continuity/scripts/continuity.mjs inspect ready --json
```

`inspect`, `inspect ready`, and `inspect wave` do not repair the projection. If `inspect ready` reports `plan.missing`, stop assigning work; do not invent missing requirements.

## Truth axes

Keep these distinct:

- an attempt or report is not evidence;
- successful execution is not independent verification;
- verification is not freshness;
- freshness is not user acceptance.

Authorizing evidence is a linked `command` or `test` observation with exit code `0`. Independent verification requires a different actor and run plus explicit counts. Only `--as user` may accept or reject a result. Rejection also requires `--next`.

## Record only durable verified facts

Read-only, trivial, no-op, or inconclusive work should not write continuity data. Never record secrets, personal data, raw logs, raw diffs, command output, or private absolute paths. After a write, run `validate` and `inspect`. Never edit the store or delete a lock silently.

## Optional Coordinator

Coordinator is optional. Memory never starts it.

```bash
node continuity/scripts/coordinator.mjs doctor --root .
node continuity/scripts/coordinator.mjs plan --root .
```

Coordinator must not accept work for the user and must not treat executor reports as proof.

Follow `continuity/SKILL.md`, `continuity/references/project-execution.md`, and `continuity/references/security-workflow.md`.

## Cursor Cloud specific instructions

Continuity is a pure Node.js CLI product (`continuity/scripts/continuity.mjs` and `continuity/scripts/coordinator.mjs`). There is no server or web UI. The only dependency is the dev-only `ajv` (installed by the startup update script via `npm ci`). Node `>=22 <25` is required.

Use the nvm-managed Node when running any npm script, not the default `node` on `PATH`. The default `node` is the exec-daemon shim (`/exec-daemon/node`) which has no co-located `npm`, so `npm run validate` / `npm run check` fail with `package validation failed: npm CLI is not available next to Node` (the validator resolves npm via `process.execPath`). Prepend the nvm bin first, e.g.:

```bash
export PATH="$(dirname "$(nvm which 22 2>/dev/null || bash -lc 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm which 22')")":$PATH
```

Commands (run from repo root, with the nvm Node on `PATH`):

- Lint / package validation: `npm run validate`
- Tests: `npm test` (core), or `npm run check` for the full suite (validate + test + test:package + test:forward + test:protocol + test:coordinator + test:release). `npm run check` takes ~2.5 min.
- Install smokes (as in CI): `node continuity/scripts/smokes/memory.mjs`, `.../coordinator.mjs`, `.../full.mjs`.
- Dev dependency audit: `npm run audit:dev`.

The CLI writes its store to `<repo>/.continuity`. `doctor` is read-only and never creates a store. To exercise the CLI, run it against a throwaway git repo (`git init` a temp dir) so you do not create a `.continuity` store inside this checkout: `doctor` → `init --schema 3 --file continuity/assets/init-v3.template.json` → `record task ...` → `inspect ready`.
