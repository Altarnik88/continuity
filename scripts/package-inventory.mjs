import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SKILL_PREFIX = 'continuity/';
export const CANONICAL_SKILL_MANIFEST = `${SKILL_PREFIX}SKILL.md`;
export const VENDOR_SKILL_ROOTS = Object.freeze(['.agents/skills/', '.cursor/skills/', '.grok/skills/']);
export const RUNTIME_STORE_PREFIX = '.continuity/';
export const LEGACY_RUNTIME_STORE_PREFIX = '.codex/project-memory/';
export const REPO_ONLY_PREFIXES = Object.freeze([]);
export const FORBIDDEN_PREFIXES = Object.freeze([
  '.autopilot/',
  RUNTIME_STORE_PREFIX,
  '.codex/',
]);
export const REPO_METADATA_PREFIXES = Object.freeze([
  '.agents/',
  '.cursor/',
  '.github/',
  '.grok/',
  'examples/',
  'scripts/',
  'tests/',
]);
export const PUBLIC_DIAGRAM_FILES = Object.freeze([]);
export const REPO_METADATA_EXACT = Object.freeze([
  '.gitattributes',
  '.gitignore',
  'ADAPTERS.md',
  'AGENTS.md',
  'ARCHITECTURE.md',
  'CHANGELOG.md',
  'COORDINATOR.md',
  'INSTALL.md',
  'LICENSE',
  'MIGRATION.md',
  'PROTOCOL.md',
  'README.md',
  'README.ru.md',
  'RELEASE.md',
  'SECURITY.md',
  ...PUBLIC_DIAGRAM_FILES,
  'package-lock.json',
  'package.json',
]);
export const LOCALIZED_README_FILES = Object.freeze(['README.ru.md']);
export const REQUIRED_REPO_METADATA = Object.freeze([
  '.cursor/rules/continuity.mdc',
  '.cursor/skills/continuity/SKILL.md',
  '.gitattributes',
  '.github/workflows/ci.yml',
  '.gitignore',
  '.grok/rules/continuity.md',
  '.grok/skills/continuity/SKILL.md',
  'ADAPTERS.md',
  'AGENTS.md',
  'ARCHITECTURE.md',
  'CHANGELOG.md',
  'COORDINATOR.md',
  'INSTALL.md',
  'LICENSE',
  'MIGRATION.md',
  'PROTOCOL.md',
  'README.md',
  'README.ru.md',
  'RELEASE.md',
  'SECURITY.md',
  ...PUBLIC_DIAGRAM_FILES,
  'examples/coordinator.config.json',
  'examples/snapshot.minimal.json',
  'examples/snapshot.source-backed.json',
  'examples/source-anchor.md',
  'package-lock.json',
  'package.json',
  'scripts/install.mjs',
  'scripts/package-inventory.mjs',
  'scripts/package-release.mjs',
  'scripts/release-profiles.mjs',
  'scripts/test-continuity.mjs',
  'scripts/test-coordinator.mjs',
  'scripts/test-forward-acceptance.mjs',
  'scripts/test-package-install.mjs',
  'scripts/test-package.mjs',
  'scripts/test-protocol.mjs',
  'scripts/test-release.mjs',
  'scripts/test-validate-package.mjs',
  'scripts/validate-package.mjs',
  'scripts/zip-store.mjs',
  'tests/core/v3-e2e.test.mjs',
  'tests/helpers/suite-aggregator.mjs',
]);
export const FORWARD_SKILL_ALLOWLIST = Object.freeze([]);
export const DISTRIBUTABLE_FILES = Object.freeze([
  'continuity',
  'ADAPTERS.md',
  'ARCHITECTURE.md',
  'CHANGELOG.md',
  'COORDINATOR.md',
  'INSTALL.md',
  'LICENSE',
  'MIGRATION.md',
  'PROTOCOL.md',
  'README.md',
  'README.ru.md',
  'RELEASE.md',
  'SECURITY.md',
  ...PUBLIC_DIAGRAM_FILES,
  'examples',
  'package.json',
]);
export const EXPECTED_SKILL_FILES = Object.freeze([
  `${SKILL_PREFIX}SKILL.md`,
  `${SKILL_PREFIX}assets/init-v2.template.json`,
  `${SKILL_PREFIX}assets/init-v3.template.json`,
  `${SKILL_PREFIX}assets/snapshot-v1.template.json`,
  `${SKILL_PREFIX}references/context-rollover.md`,
  `${SKILL_PREFIX}references/coordination.md`,
  `${SKILL_PREFIX}references/inspect-v1.schema.json`,
  `${SKILL_PREFIX}references/installation.md`,
  `${SKILL_PREFIX}references/project-execution.md`,
  `${SKILL_PREFIX}references/projection-v2.schema.json`,
  `${SKILL_PREFIX}references/scheduling.md`,
  `${SKILL_PREFIX}references/schema.md`,
  `${SKILL_PREFIX}references/security-workflow.md`,
  `${SKILL_PREFIX}references/snapshot-v1.schema.json`,
  `${SKILL_PREFIX}references/task-accumulator.md`,
  `${SKILL_PREFIX}references/v2-contract.schema.json`,
  `${SKILL_PREFIX}references/verification-swarm.md`,
  `${SKILL_PREFIX}scripts/continuity.mjs`,
  `${SKILL_PREFIX}scripts/lib/continuity/index.mjs`,
  `${SKILL_PREFIX}scripts/lib/core/cli-v3.mjs`,
  `${SKILL_PREFIX}scripts/lib/core/cli.mjs`,
  `${SKILL_PREFIX}scripts/lib/core/coordination/accumulator.mjs`,
  `${SKILL_PREFIX}scripts/lib/core/coordination/contract.mjs`,
  `${SKILL_PREFIX}scripts/lib/core/coordination/index.mjs`,
  `${SKILL_PREFIX}scripts/lib/core/coordination/persist-policy.mjs`,
  `${SKILL_PREFIX}scripts/lib/core/coordination/registry.mjs`,
  `${SKILL_PREFIX}scripts/lib/core/coordination/schedule.mjs`,
  `${SKILL_PREFIX}scripts/lib/core/domain-v2.mjs`,
  `${SKILL_PREFIX}scripts/lib/core/domain-v3.mjs`,
  `${SKILL_PREFIX}scripts/lib/core/input-v3.mjs`,
  `${SKILL_PREFIX}scripts/lib/core/inspect-v3.mjs`,
  `${SKILL_PREFIX}scripts/lib/core/journal-v2.mjs`,
  `${SKILL_PREFIX}scripts/lib/core/journal-v3.mjs`,
  `${SKILL_PREFIX}scripts/lib/core/legacy-v1.mjs`,
  `${SKILL_PREFIX}scripts/lib/core/recipes-v3.mjs`,
  `${SKILL_PREFIX}scripts/lib/core/store.mjs`,
  `${SKILL_PREFIX}scripts/lib/core/workspace-v3.mjs`,
  `${SKILL_PREFIX}scripts/lib/graphify/index.mjs`,
  `${SKILL_PREFIX}scripts/lib/migration/index.mjs`,
  `${SKILL_PREFIX}scripts/project-memory.mjs`,
  `${SKILL_PREFIX}assets/coordinator.config.json`,
  `${SKILL_PREFIX}scripts/coordinator.mjs`,
  `${SKILL_PREFIX}scripts/lib/protocol/adapter.mjs`,
  `${SKILL_PREFIX}scripts/lib/protocol/client.mjs`,
  `${SKILL_PREFIX}scripts/lib/protocol/compatibility.mjs`,
  `${SKILL_PREFIX}scripts/lib/protocol/index.mjs`,
  `${SKILL_PREFIX}scripts/lib/protocol/ports.mjs`,
  `${SKILL_PREFIX}scripts/lib/protocol/secrets.mjs`,
  `${SKILL_PREFIX}scripts/lib/protocol/validate.mjs`,
  `${SKILL_PREFIX}scripts/lib/coordinator/adapters/fake.mjs`,
  `${SKILL_PREFIX}scripts/lib/coordinator/adapters/index.mjs`,
  `${SKILL_PREFIX}scripts/lib/coordinator/adapters/local-process.mjs`,
  `${SKILL_PREFIX}scripts/lib/coordinator/adapters/local-worker.mjs`,
  `${SKILL_PREFIX}scripts/lib/coordinator/cli.mjs`,
  `${SKILL_PREFIX}scripts/lib/coordinator/config.mjs`,
  `${SKILL_PREFIX}scripts/lib/coordinator/engine.mjs`,
  `${SKILL_PREFIX}scripts/lib/coordinator/index.mjs`,
  `${SKILL_PREFIX}scripts/lib/coordinator/run-state.mjs`,
  `${SKILL_PREFIX}scripts/smokes/coordinator.mjs`,
  `${SKILL_PREFIX}scripts/smokes/full.mjs`,
  `${SKILL_PREFIX}scripts/smokes/memory.mjs`,
]);
export const REQUIRED_SKILL_FILES = EXPECTED_SKILL_FILES;
export const ALLOWED_GIT_MODES = Object.freeze(new Set(['100644', '100755']));
export const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_GIT_PATHS = 4096;
export const MAX_PATH_BYTES = 1024;
export const GIT_TIMEOUT_MS = 15_000;
export const NPM_PACK_TIMEOUT_MS = 60_000;
export const MAX_NPM_PACK_BYTES = 2 * 1024 * 1024;
export const IMAGE_EXTENSIONS = Object.freeze(new Set([
  '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.tif', '.tiff', '.webp',
]));
const PUBLIC_TEXT_EXTENSIONS = new Set(['.json', '.md', '.mdc', '.mjs', '.yaml', '.yml']);
const PUBLIC_TEXT_EXACT = new Set(['.gitattributes', '.gitignore', 'LICENSE']);

export class InventoryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InventoryError';
  }
}

function fail(message) {
  throw new InventoryError(message);
}

export function posixPath(file) {
  return String(file).split(path.sep).join('/');
}

export function parseSkillFrontmatterName(text) {
  const normalized = String(text).replaceAll('\r\n', '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) return null;
  for (const line of match[1].split('\n')) {
    const nameMatch = /^name:\s*(.+?)\s*$/.exec(line);
    if (nameMatch) return nameMatch[1].replace(/^['"]|['"]$/g, '').trim();
  }
  return null;
}

export function isAllowedVendorSkillManifest(file) {
  return VENDOR_SKILL_ROOTS.some((root) => file === `${root}continuity/SKILL.md`);
}

export function assertPortableGitPath(file) {
  if (typeof file !== 'string' || file.length === 0) fail('git path is empty');
  const bytes = Buffer.byteLength(file, 'utf8');
  if (bytes > MAX_PATH_BYTES) fail(`git path exceeds ${MAX_PATH_BYTES} bytes (${file})`);
  if (file.includes('\0') || /[\u0000-\u001f]/.test(file)) fail(`git path contains control characters (${file})`);
  if (file.includes('\\') || path.isAbsolute(file) || /^[A-Za-z]:/.test(file)) {
    fail(`git path is not a portable relative path (${file})`);
  }
  if (file.startsWith('/') || file.includes('//')) fail(`git path is not portable (${file})`);
  const parts = file.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    fail(`git path has unsafe components (${file})`);
  }
  return file;
}

export function classifyGitPath(file) {
  const portable = assertPortableGitPath(file);
  if (FORBIDDEN_PREFIXES.some((prefix) => portable === prefix.slice(0, -1) || portable.startsWith(prefix))) return 'forbidden';
  if (portable === SKILL_PREFIX.slice(0, -1) || portable.startsWith(SKILL_PREFIX)) return 'skill';
  if (REPO_ONLY_PREFIXES.some((prefix) => portable.startsWith(prefix))) return 'repo-only';
  if (REPO_METADATA_EXACT.includes(portable)) return 'repo-metadata';
  if (REPO_METADATA_PREFIXES.some((prefix) => portable.startsWith(prefix))) return 'repo-metadata';
  return 'unclassified';
}

export function gitProcessEnv(base = process.env) {
  const env = {
    PATH: base.PATH,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C',
  };
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'PATHEXT']) {
    if (base[key]) env[key] = base[key];
  }
  return env;
}

function runGit(root, args, { timeout = GIT_TIMEOUT_MS, maxBuffer = MAX_GIT_OUTPUT_BYTES } = {}) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'buffer',
    timeout,
    maxBuffer,
    windowsHide: true,
    shell: false,
    env: gitProcessEnv(),
  });
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') fail(`git timed out (${args.join(' ')})`);
    fail(`git failed to start (${result.error.message})`);
  }
  if (result.signal) fail(`git terminated by signal ${result.signal}`);
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString('utf8').trim() : '';
    fail(`git ${args.join(' ')} exited ${result.status}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

function decodeNulRecords(buffer, label, { allowEmpty = false } = {}) {
  if (buffer.length > MAX_GIT_OUTPUT_BYTES) fail(`${label} output exceeds ${MAX_GIT_OUTPUT_BYTES} bytes`);
  if (buffer.length === 0) {
    if (allowEmpty) return [];
    fail(`${label} returned no paths`);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
  if (!text.endsWith('\0')) fail(`${label} is missing a terminating NUL`);
  const records = text.slice(0, -1).split('\0');
  if (records.length > MAX_GIT_PATHS) fail(`${label} exceeds ${MAX_GIT_PATHS} paths`);
  if (records.some((record) => record.length === 0)) fail(`${label} contains an empty record`);
  return records;
}

const STAGE_LINE = /^([0-7]{6}) ([0-9a-f]{40}) ([0-3])\t(.*)$/;

export function listGitIndex(root) {
  const records = decodeNulRecords(runGit(root, ['ls-files', '-z', '--cached', '--stage']), 'git ls-files');
  const files = [];
  const blobs = new Map();
  const seen = new Set();
  for (const record of records) {
    const match = STAGE_LINE.exec(record);
    if (!match) fail(`git ls-files stage line is malformed (${record.slice(0, 120)})`);
    const [, mode, blob, stage, file] = match;
    assertPortableGitPath(file);
    if (stage !== '0') fail(`git index has an unmerged path (${file})`);
    if (!ALLOWED_GIT_MODES.has(mode)) fail(`git index has a non-file mode ${mode} (${file})`);
    if (seen.has(file)) fail(`git index has a duplicate path (${file})`);
    seen.add(file);
    files.push(file);
    blobs.set(file, blob);
  }
  files.sort();
  return { files, blobs };
}

export function buildInventory(files) {
  const skill = [];
  const repoOnly = [];
  const repoMetadata = [];
  const seen = new Set();
  for (const file of files) {
    assertPortableGitPath(file);
    if (seen.has(file)) fail(`duplicate git path (${file})`);
    seen.add(file);
    const kind = classifyGitPath(file);
    if (kind === 'forbidden') {
      if (file === RUNTIME_STORE_PREFIX.slice(0, -1) || file.startsWith(RUNTIME_STORE_PREFIX)
        || file === LEGACY_RUNTIME_STORE_PREFIX.slice(0, -1) || file.startsWith(LEGACY_RUNTIME_STORE_PREFIX)) {
        fail(`runtime store must not be present (${file})`);
      }
      fail(`forbidden repository path (${file})`);
    }
    if (kind === 'unclassified') fail(`unclassified tracked path (${file})`);
    if (kind === 'skill') skill.push(file);
    else if (kind === 'repo-only') repoOnly.push(file);
    else repoMetadata.push(file);
  }
  skill.sort();
  repoOnly.sort();
  repoMetadata.sort();
  return {
    all: [...seen].sort(),
    skill,
    repoOnly,
    repoMetadata,
  };
}

export function assertInventoryContract(inventory) {
  if (!inventory.skill.length) fail('skill artifact inventory is empty');
  const missingMetadata = REQUIRED_REPO_METADATA.filter((file) => !inventory.repoMetadata.includes(file));
  if (missingMetadata.length) fail(`required repository metadata is missing (${missingMetadata.join(', ')})`);
  const missingSkill = REQUIRED_SKILL_FILES.filter((file) => !inventory.skill.includes(file));
  if (missingSkill.length) fail(`required skill files are missing (${missingSkill.join(', ')})`);
  const runtime = inventory.all.filter((file) => file === RUNTIME_STORE_PREFIX.slice(0, -1) || file.startsWith(RUNTIME_STORE_PREFIX));
  if (runtime.length) fail(`runtime store must not be tracked (${runtime.join(', ')})`);
  const leakedRepoOnly = inventory.skill.filter((file) => REPO_ONLY_PREFIXES.some((prefix) => file.startsWith(prefix)));
  if (leakedRepoOnly.length) fail(`repo-only paths appeared in the skill artifact (${leakedRepoOnly.join(', ')})`);
  return inventory;
}

export function assertExactSkillManifest(inventory) {
  const expected = [...EXPECTED_SKILL_FILES].sort();
  const actual = [...inventory.skill].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const extra = actual.filter((file) => !expected.includes(file));
    const missing = expected.filter((file) => !actual.includes(file));
    fail(`installed Skill manifest is not exact (extra: ${extra.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'})`);
  }
  return actual;
}

export function inventoryFromGit(root) {
  const index = listGitIndex(root);
  const inventory = assertInventoryContract(buildInventory(index.files));
  return { ...inventory, blobs: index.blobs };
}

export function listRepositoryFiles(root) {
  const resolvedRoot = path.resolve(root);
  const rootStat = lstatIfPresent(resolvedRoot);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail('repository root must be a real directory');
  }
  const files = [];
  const walk = (directory, relative) => {
    for (const name of readdirSync(directory).sort()) {
      if (!relative && (name === '.git' || name === 'node_modules')) continue;
      const portable = relative ? `${relative}/${name}` : name;
      const absolute = path.join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) fail(`repository contains a symlink or reparse point (${portable})`);
      if (stat.isDirectory()) walk(absolute, portable);
      else if (stat.isFile()) files.push(assertPortableGitPath(portable));
      else fail(`repository contains an unsupported entry (${portable})`);
    }
  };
  walk(resolvedRoot, '');
  if (!files.length) fail('repository worktree contains no files');
  if (files.length > MAX_GIT_PATHS) fail(`repository worktree exceeds ${MAX_GIT_PATHS} files`);
  return files.sort();
}

function containedInPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function importSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

export function assertRepositoryBoundaries(root, files = listRepositoryFiles(root)) {
  const resolvedRoot = path.resolve(root);
  for (const forbidden of ['.autopilot', '.codex', '.continuity']) {
    const absolute = path.join(resolvedRoot, ...forbidden.split('/'));
    if (lstatIfPresent(absolute)) fail(`forbidden repository directory is present (${forbidden})`);
  }

  const skillRoot = path.join(resolvedRoot, 'continuity');
  const skillStat = lstatIfPresent(skillRoot);
  if (!skillStat || skillStat.isSymbolicLink() || !skillStat.isDirectory()) {
    fail('continuity Skill subtree must be a real directory');
  }
  const skillManifests = files.filter((file) => file === 'SKILL.md' || file.endsWith('/SKILL.md'));
  if (!skillManifests.includes(CANONICAL_SKILL_MANIFEST)) {
    fail('repository must contain exactly one Skill subtree: continuity/');
  }
  for (const manifest of skillManifests) {
    if (manifest === CANONICAL_SKILL_MANIFEST) continue;
    if (!isAllowedVendorSkillManifest(manifest)) {
      fail('repository must contain exactly one Skill subtree: continuity/');
    }
    const absolute = path.join(resolvedRoot, ...manifest.split('/'));
    const name = parseSkillFrontmatterName(readFileSync(absolute, 'utf8'));
    if (name !== 'continuity') {
      fail(`vendor Skill copy must keep frontmatter name: continuity (${manifest})`);
    }
  }

  for (const file of files) {
    const extension = path.extname(file).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) fail(`repository images are forbidden (${file})`);
    const absolute = path.join(resolvedRoot, ...file.split('/'));
    if (PUBLIC_TEXT_EXTENSIONS.has(extension) || PUBLIC_TEXT_EXACT.has(file)) {
      const text = readFileSync(absolute, 'utf8');
      if (!LOCALIZED_README_FILES.includes(file) && /[\u0400-\u052f]/u.test(text)) {
        fail(`public repository text contains Cyrillic (${file})`);
      }
    }
    if (file.startsWith(`${SKILL_PREFIX}scripts/`) && extension === '.mjs') {
      const source = readFileSync(absolute, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        if (!specifier.startsWith('.')) continue;
        const resolvedImport = path.resolve(path.dirname(absolute), specifier);
        if (!containedInPath(skillRoot, resolvedImport)) {
          fail(`Skill runtime import escapes its self-contained subtree (${file}: ${specifier})`);
        }
      }
    }
  }
  return files;
}

export function inventoryFromWorktree(root) {
  const files = listRepositoryFiles(root);
  assertRepositoryBoundaries(root, files);
  const inventory = assertInventoryContract(buildInventory(files));
  return { ...inventory, blobs: new Map() };
}

export function listGitOthers(root) {
  const records = decodeNulRecords(
    runGit(root, ['ls-files', '-z', '--others', '--exclude-standard']),
    'git ls-files --others',
    { allowEmpty: true },
  );
  const files = [];
  const seen = new Set();
  for (const record of records) {
    assertPortableGitPath(record);
    if (seen.has(record)) fail(`git others has a duplicate path (${record})`);
    seen.add(record);
    files.push(record);
  }
  files.sort();
  return files;
}

export function matchesDistributableAllowlist(file, allowlist = DISTRIBUTABLE_FILES) {
  const portable = posixPath(file);
  return allowlist.some((entry) => portable === entry || portable.startsWith(`${entry}/`));
}

export function assertNoUnexpectedPackageableExtras(root, allowlist = FORWARD_SKILL_ALLOWLIST) {
  const others = listGitOthers(root);
  const unexpected = others.filter((file) => matchesDistributableAllowlist(file) && !allowlist.includes(file));
  if (unexpected.length) fail(`unexpected packageable extra (${unexpected.slice(0, 8).join(', ')})`);
  return others.filter((file) => allowlist.includes(file)).sort();
}

export function expectedNpmPackFiles(inventory, extraFiles = []) {
  const matched = [];
  const seen = new Set();
  for (const file of [...inventory.all, ...extraFiles]) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (!matchesDistributableAllowlist(file)) continue;
    const kind = classifyGitPath(file);
    if (kind === 'forbidden' || kind === 'repo-only') {
      fail(`distributable allowlist matched a forbidden or repo-only path (${file})`);
    }
    matched.push(file);
  }
  matched.sort();
  if (!matched.length) fail('expected npm pack inventory is empty');
  return matched;
}

function sameResolved(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function containedIn(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function lstatIfPresent(absolute) {
  try {
    return lstatSync(absolute);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
}

function assertNotReparse(absolute, label) {
  const stat = lstatIfPresent(absolute);
  if (!stat) return null;
  if (stat.isSymbolicLink()) fail(`${label} is a symlink/junction/reparse point`);
  try {
    readlinkSync(absolute);
    fail(`${label} is a symlink/junction/reparse point`);
  } catch (error) {
    if (error instanceof InventoryError) throw error;
  }
  return stat;
}

function assertSafePathChain(absolute, stopAt) {
  let current = path.resolve(absolute);
  const stop = path.resolve(stopAt);
  while (true) {
    assertNotReparse(current, current);
    if (sameResolved(current, stop) || path.dirname(current) === current) break;
    current = path.dirname(current);
  }
}

function realpathExistingPrefix(absolute) {
  let current = path.resolve(absolute);
  const missing = [];
  while (!lstatIfPresent(current) && path.dirname(current) !== current) {
    missing.unshift(path.basename(current));
    current = path.dirname(current);
  }
  const stat = assertNotReparse(current, current);
  if (!stat) fail('install dest has no existing ancestor');
  return path.resolve(realpathSync(current), ...missing);
}

export function assertTempInstallHome(installHome, { tmpdir = os.tmpdir() } = {}) {
  if (typeof installHome !== 'string' || installHome.length === 0) fail('temporary install home is required');
  const tempRoot = path.resolve(tmpdir);
  const resolved = path.resolve(installHome);
  if (!tmpdir) fail('install home must be inside the temp directory');
  const lexicalHit = containedIn(tempRoot, resolved);
  if (!lexicalHit) fail('install home must be inside the temp directory');
  assertSafePathChain(resolved, tempRoot);
  let realTemp;
  let realHome;
  try {
    realTemp = realpathSync(tempRoot);
    realHome = realpathExistingPrefix(resolved);
  } catch (error) {
    if (error instanceof InventoryError) throw error;
    fail('temporary install home is unavailable');
  }
  const canonicalHit = containedIn(realTemp, realHome);
  if (!canonicalHit) fail('install home resolves outside the temp directory');
  assertSafePathChain(realHome, realTemp);
  return resolved;
}

export function assertSkillsDest(installHome, dest) {
  const home = assertTempInstallHome(installHome);
  const skillsRoot = path.resolve(home, 'skills');
  if (typeof dest !== 'string' || dest.length === 0) fail('install dest is required');
  if (dest.includes('\0') || dest.split(/[\\/]/).includes('..')) fail('install dest has unsafe path components');
  const resolved = path.resolve(dest);
  if (!containedIn(skillsRoot, resolved)) fail('install dest is outside the temporary skills directory');

  assertNotReparse(home, 'install home');
  assertSafePathChain(skillsRoot, home);
  assertSafePathChain(resolved, home);

  const destStat = lstatIfPresent(resolved);
  if (destStat) {
    if (destStat.isSymbolicLink()) fail('install dest is a symlink/junction/reparse point');
    if (!destStat.isDirectory()) fail('install dest is not a directory');
  }
  const skillsStat = lstatIfPresent(skillsRoot);
  if (skillsStat) {
    if (skillsStat.isSymbolicLink()) fail('skills root is a symlink/junction/reparse point');
    if (!skillsStat.isDirectory()) fail('skills root is not a directory');
  }

  const realSkills = skillsStat ? realpathSync(skillsRoot) : realpathExistingPrefix(skillsRoot);
  const realDest = destStat ? realpathSync(resolved) : realpathExistingPrefix(resolved);
  if (!containedIn(realSkills, realDest)) fail('install dest is outside the temporary skills directory');
  return destStat ? realDest : resolved;
}

export function skillInstallDest(installHome) {
  const home = assertTempInstallHome(installHome);
  return path.join(home, 'skills', 'continuity');
}

export function assertUninstallDest(installHome) {
  const home = assertTempInstallHome(installHome);
  const dest = path.resolve(home, 'skills', 'continuity');
  const skillsRoot = path.resolve(home, 'skills');
  const destStat = lstatIfPresent(dest);
  if (!destStat) fail('installed skill dest is missing');
  if (destStat.isSymbolicLink()) fail('refusing to delete a symlink/junction dest');
  if (!destStat.isDirectory()) fail('installed skill dest is not a directory');
  const skillsStat = lstatIfPresent(skillsRoot);
  if (!skillsStat) fail('skills root is missing');
  if (skillsStat.isSymbolicLink()) fail('refusing to delete through a reparse skills root');
  if (!skillsStat.isDirectory()) fail('skills root is not a directory');
  assertSafePathChain(dest, home);
  const realDest = realpathSync(dest);
  const realSkills = realpathSync(skillsRoot);
  const realHome = realpathSync(home);
  const realExpected = path.join(realSkills, 'continuity');
  if (!sameResolved(realDest, realExpected)) fail('refusing to delete unverified path');
  if (!containedIn(home, realDest) && !containedIn(realHome, realDest)) {
    fail('refusing to delete dest outside the temporary install home');
  }
  if (path.basename(realDest) !== 'continuity') fail('refusing to delete unverified path');
  return realDest;
}

export function expectedSkillCandidateFiles(inventory) {
  assertInventoryContract(inventory);
  return [...EXPECTED_SKILL_FILES].sort();
}

function listRegularFiles(root) {
  const files = [];
  const walk = (directory, relative) => {
    for (const name of readdirSync(directory).sort()) {
      const portable = relative ? `${relative}/${name}` : name;
      const absolute = path.join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) fail(`skill candidate contains a symlink (${portable})`);
      if (stat.isDirectory()) walk(absolute, portable);
      else if (stat.isFile()) files.push(portable);
      else fail(`skill candidate has an unsupported entry (${portable})`);
    }
  };
  if (existsSync(root)) walk(root, '');
  return files.sort();
}

export function materializeSkillCandidate(repoRoot, dest, inventory = inventoryFromWorktree(repoRoot)) {
  const expected = expectedSkillCandidateFiles(inventory);
  if (existsSync(dest)) fail('skill candidate dest already exists');
  mkdirSync(dest, { recursive: true });
  for (const repoPath of expected) {
    if (!repoPath.startsWith(SKILL_PREFIX)) fail(`candidate path is not a skill file (${repoPath})`);
    const relative = repoPath.slice(SKILL_PREFIX.length);
    const src = path.join(repoRoot, ...repoPath.split('/'));
    const srcStat = lstatIfPresent(src);
    if (!srcStat) fail(`skill candidate source is missing (${repoPath})`);
    if (srcStat.isSymbolicLink() || !srcStat.isFile()) fail(`skill candidate source is not a regular file (${repoPath})`);
    const target = path.join(dest, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(src));
  }
  const actual = listRegularFiles(dest);
  const expectedRelatives = expected.map((repoPath) => repoPath.slice(SKILL_PREFIX.length));
  if (JSON.stringify(actual) !== JSON.stringify(expectedRelatives)) {
    fail('skill candidate file list does not equal the repository Skill subtree');
  }
  return { files: actual, expected, inventory };
}

export function parseNpmPackJson(stdout) {
  const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout);
  if (Buffer.byteLength(text, 'utf8') > MAX_NPM_PACK_BYTES) fail('npm pack JSON exceeds the output bound');
  const start = text.search(/[\[{]/);
  if (start === -1) fail('npm pack --json did not return JSON');
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    fail('npm pack --json did not return JSON');
  }
  const record = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!record || typeof record !== 'object' || !Array.isArray(record.files)) {
    fail('npm pack JSON is missing a files list');
  }
  const files = record.files.map((entry) => {
    const filePath = typeof entry === 'string' ? entry : entry?.path;
    if (typeof filePath !== 'string' || filePath.length === 0) fail('npm pack entry is missing a path');
    return posixPath(filePath).replace(/^package\//, '');
  }).sort();
  return { filename: record.filename ?? null, files };
}

export function assertNpmPackPurity(pack) {
  const packed = pack.files;
  if (packed.some((file) => file === RUNTIME_STORE_PREFIX.slice(0, -1) || file.startsWith(RUNTIME_STORE_PREFIX)
    || file === LEGACY_RUNTIME_STORE_PREFIX.slice(0, -1) || file.startsWith(LEGACY_RUNTIME_STORE_PREFIX))) {
    fail('npm pack payload includes the runtime store');
  }
  if (packed.some((file) => file.split('/').includes('node_modules'))) fail('npm pack payload includes node_modules');
  if (packed.some((file) => file === '.autopilot' || file.startsWith('.autopilot/'))) {
    fail('npm pack payload includes .autopilot');
  }
  if (packed.some((file) => REPO_ONLY_PREFIXES.some((prefix) => file === prefix.slice(0, -1) || file.startsWith(prefix)))) {
    fail('npm pack payload includes repo-only paths');
  }
  return packed;
}

export function assertNpmPackIsNotSkillArtifact(pack, inventory) {
  const packed = assertNpmPackPurity(pack);
  const skillOnly = new Set(inventory.skill);
  const packSet = new Set(packed);
  if (packed.length === skillOnly.size && packed.every((file) => skillOnly.has(file))) {
    fail('npm pack payload equals the skill artifact; installation copies the skill directory, not npm pack');
  }
  const missingSkill = inventory.skill.filter((file) => !packSet.has(file));
  if (missingSkill.length) fail(`npm pack omitted tracked skill files (${missingSkill.slice(0, 8).join(', ')})`);
  return packed;
}

export function assertNpmPackEqualsDistributable(pack, inventory, extraFiles = []) {
  assertNpmPackIsNotSkillArtifact(pack, inventory);
  const expected = expectedNpmPackFiles(inventory, extraFiles);
  const actual = [...pack.files].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const actualSet = new Set(actual);
    const extra = actual.filter((file) => !expected.includes(file));
    const missing = expected.filter((file) => !actualSet.has(file));
    fail(`npm pack payload does not equal DISTRIBUTABLE_FILES expansion (extra: ${extra.slice(0, 8).join(', ') || 'none'}; missing: ${missing.slice(0, 8).join(', ') || 'none'})`);
  }
  return actual;
}

function resolveNpmCli() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  fail('npm CLI is not available next to Node');
}

export function runNpmPackDryRun(root) {
  const result = spawnSync(process.execPath, [resolveNpmCli(), 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'buffer',
    timeout: NPM_PACK_TIMEOUT_MS,
    maxBuffer: MAX_NPM_PACK_BYTES,
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      npm_config_ignore_scripts: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
    },
  });
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') fail('npm pack timed out');
    fail(`npm pack failed to start (${result.error.message})`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString('utf8').trim() : '';
    fail(`npm pack --dry-run --json --ignore-scripts exited ${result.status}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`);
  }
  return parseNpmPackJson(result.stdout ?? Buffer.alloc(0));
}
