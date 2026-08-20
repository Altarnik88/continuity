# Installation

Continuity requires Node.js 22+ and Git. The complete distributable unit is the single `continuity/` directory. It has no runtime package-install step and does not require another Skill, a background process, a network service, a model installation, or a global copy.

The repository is [Altarnik88/continuity](https://github.com/Altarnik88/continuity). It is distributed under the repository [MIT License](../../LICENSE), not through a package registry.

## Get the source

```bash
git clone https://github.com/Altarnik88/continuity.git
cd continuity
node continuity/scripts/continuity.mjs --version
```

The version command must work without installing dependencies.

## Path 1: copy the Skill directory

Consult your coding agent's documentation to find its skills directory. Discovery paths and reload behavior are agent-specific; this project does not claim one universal location or native integration with any particular agent.

Copy only the repository's `continuity/` directory and keep the destination directory name `continuity`. Do not overwrite an existing destination without reviewing or backing it up.

PowerShell:

```powershell
$source = Resolve-Path '.\continuity'
$skillsRoot = Resolve-Path 'C:\path\documented-by-your-agent\skills'
$destination = Join-Path $skillsRoot 'continuity'
if (Test-Path -LiteralPath $destination) { throw "Destination already exists: $destination" }
Copy-Item -LiteralPath $source -Destination $destination -Recurse
node (Join-Path $destination 'scripts\continuity.mjs') --version
```

POSIX shell:

```bash
skills_root=/path/documented-by-your-agent/skills
test ! -e "$skills_root/continuity"
cp -R continuity "$skills_root/continuity"
node "$skills_root/continuity/scripts/continuity.mjs" --version
```

Follow the coding agent's own instructions to reload or rediscover installed Skills. A successful copy proves only that the files and CLI are present; it does not prove native discovery by that agent.

## Path 2: run the local CLI directly

Keep the cloned repository in an operator-chosen location. From the target Git worktree, invoke the wrapper by absolute path:

```bash
node "/absolute/path/to/clone/continuity/scripts/continuity.mjs" doctor
node "/absolute/path/to/clone/continuity/scripts/continuity.mjs" inspect
node "/absolute/path/to/clone/continuity/scripts/continuity.mjs" inspect ready --json
```

`doctor` and the inspect commands are read-only. The wrapper discovers the target repository top level from the current directory. Optional `--root` must name that exact top level.

The default runtime store is `<target-repository>/.continuity`, not the clone or installed Skill directory. `CONTINUITY_STORE_DIR` may select another repository-relative directory. Older store locations are not read or imported automatically.

## Initialize a new store

Do this only after `doctor` reports an uninitialized store. Review and edit a copy of the template so its goal and criteria reflect explicit user intent:

```bash
node "/absolute/path/to/continuity/scripts/continuity.mjs" init --schema 3 --file "/absolute/path/to/continuity/assets/init-v3.template.json"
```

`init` refuses an initialized store. If `inspect ready --json` reports `plan.missing`, supply the missing authorized project, goal, criteria, or tasks before assigning work. Continuity does not run an interview or invent requirements.

## Clean temp-copy acceptance

The following checks exercise a fresh clone and an isolated copy without touching an existing Skill installation or creating a Continuity store.

PowerShell:

```powershell
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("continuity-" + [guid]::NewGuid())
$copyRoot = Join-Path ([IO.Path]::GetTempPath()) ("continuity-copy-" + [guid]::NewGuid())
git clone --depth 1 https://github.com/Altarnik88/continuity.git $testRoot
New-Item -ItemType Directory -Path $copyRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $testRoot 'continuity') -Destination (Join-Path $copyRoot 'continuity') -Recurse
node (Join-Path $copyRoot 'continuity\scripts\continuity.mjs') --version
Push-Location $testRoot
node (Join-Path $copyRoot 'continuity\scripts\continuity.mjs') doctor
Pop-Location
```

POSIX shell:

```bash
test_root="$(mktemp -d)"
copy_root="$(mktemp -d)"
git clone --depth 1 https://github.com/Altarnik88/continuity.git "$test_root"
cp -R "$test_root/continuity" "$copy_root/continuity"
node "$copy_root/continuity/scripts/continuity.mjs" --version
(cd "$test_root" && node "$copy_root/continuity/scripts/continuity.mjs" doctor)
```

Acceptance requires:

- `continuity/SKILL.md` exists and declares `name: continuity`;
- `continuity/scripts/continuity.mjs --version` exits successfully without dependency installation;
- `doctor` runs read-only from a Git worktree and reports its actual store state;
- the copied `continuity/` directory is sufficient by itself;
- no runtime store appears after the read-only checks.

Remote clone success, coding-agent discovery, and a released Git ref must be tested against the actual published repository. Local source checks cannot prove those external states.

## Update or uninstall

An installed copy and a runtime store are different things. To update, stage a fresh `continuity/` directory, review it, and replace only the installed `continuity` directory according to the coding agent's documented procedure. To uninstall, remove only that installed directory.

Do not remove `<target-repository>/.continuity` unless the user separately intends to delete project continuity data. Never remove a broader skills root or repository metadata directory as part of an update.

## Troubleshooting

- **`current location is not inside a Git worktree`** — run from the target repository, or pass its exact top level with `--root`.
- **`journal=uninitialized`** — inspect is safe; initialize only if a new store is intended.
- **Projection missing, stale, or invalid** — inspect remains read-only; run `rebuild` only as an explicit repair.
- **Lock conflict** — follow [security-workflow.md](security-workflow.md); never delete a lock silently.
- **Linked worktree mutation refused** — make store writes from the primary worktree.
