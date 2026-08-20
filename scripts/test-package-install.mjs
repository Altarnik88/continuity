import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertSkillsDest,
  assertTempInstallHome,
  assertUninstallDest,
  materializeSkillCandidate,
  skillInstallDest,
} from './package-inventory.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceSkill = path.join(repoRoot, 'continuity');

function fingerprint(root) {
  if (!existsSync(root)) return { exists: false, entries: [] };
  const entries = [];
  const walk = (directory, relative) => {
    for (const name of readdirSync(directory).sort()) {
      const portable = relative ? `${relative}/${name}` : name;
      const absolute = path.join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        entries.push(`d:${portable}`);
        walk(absolute, portable);
      } else {
        const sha256 = createHash('sha256').update(readFileSync(absolute)).digest('hex');
        entries.push(`f:${portable}:${stat.size}:${sha256}`);
      }
    }
  };
  walk(root, '');
  return { exists: true, entries };
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
}

function makeTempGitProject(label) {
  const root = mkdtempSync(path.join(os.tmpdir(), `continuity-pkg-proj-${label}-`));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Package Install Test']);
  git(root, ['config', 'user.email', 'package-install@example.invalid']);
  writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

function makeTempInstallHome(label) {
  const root = mkdtempSync(path.join(os.tmpdir(), `continuity-install-${label}-`));
  assertTempInstallHome(root);
  mkdirSync(path.join(root, 'skills'), { recursive: true });
  return root;
}

function copySkillLikeInstaller(src, dest, installHome) {
  assertSkillsDest(installHome, dest);
  if (path.basename(path.resolve(dest)) !== 'continuity') throw new Error('skill dest name must be continuity');
  if (!existsSync(path.join(src, 'SKILL.md'))) throw new Error('SKILL.md not found in selected skill directory.');
  if (existsSync(dest)) throw new Error(`Destination already exists: ${dest}`);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, errorOnExist: true, force: false });
}

function installSkillFromWorktree(installHome) {
  const dest = skillInstallDest(installHome);
  assertSkillsDest(installHome, dest);
  if (existsSync(dest)) throw new Error(`Destination already exists: ${dest}`);
  materializeSkillCandidate(repoRoot, dest);
  return dest;
}

function uninstallInstalledSkill(installHome) {
  const realDest = assertUninstallDest(installHome);
  rmSync(realDest, { recursive: true, force: false });
}

function helperEnv() {
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  env.NODE_PATH = path.join(os.tmpdir(), 'continuity-no-node-path');
  return env;
}

function runInstalled(helper, args, { cwd, root }) {
  return spawnSync(process.execPath, [helper, ...args, '--root', root], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    env: helperEnv(),
  });
}

export const CASES = [
  {
    id: 'PKG-010-copy-refuses-existing-dest',
    run() {
      const installHome = makeTempInstallHome('exists');
      const outside = mkdtempSync(path.join(os.tmpdir(), 'continuity-outside-'));
      try {
        const dest = installSkillFromWorktree(installHome);
        const beforeHome = fingerprint(installHome);
        const beforeOutside = fingerprint(outside);
        const marker = readFileSync(path.join(dest, 'SKILL.md'), 'utf8');
        assert.throws(() => copySkillLikeInstaller(sourceSkill, dest, installHome), /already exists/);
        assert.equal(readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), marker);
        assert.deepEqual(fingerprint(installHome), beforeHome);
        assert.deepEqual(fingerprint(outside), beforeOutside);
      } finally {
        rmSync(installHome, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'PKG-011-reject-dest-outside-temp-skills',
    run() {
      const installHome = makeTempInstallHome('escape');
      const outside = mkdtempSync(path.join(os.tmpdir(), 'continuity-escape-'));
      try {
        const beforeHome = fingerprint(installHome);
        const beforeOutside = fingerprint(outside);
        const escaped = path.join(outside, 'continuity');
        assert.throws(() => copySkillLikeInstaller(sourceSkill, escaped, installHome), /outside the temporary skills directory/);
        const traversal = path.join(installHome, 'skills', '..', '..', path.basename(outside), 'continuity');
        assert.throws(() => copySkillLikeInstaller(sourceSkill, traversal, installHome), /unsafe path components|outside the temporary skills directory/);
        assert.deepEqual(fingerprint(installHome), beforeHome);
        assert.deepEqual(fingerprint(outside), beforeOutside);
      } finally {
        rmSync(installHome, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'PKG-012-uninstall-preserves-consumer-store',
    run() {
      const installHome = makeTempInstallHome('uninstall');
      const project = makeTempGitProject('store');
      try {
        const dest = installSkillFromWorktree(installHome);
        if (process.platform === 'darwin') {
          assert.notEqual(path.resolve(installHome), realpathSync(installHome), 'PKG-012 did not exercise the macOS temp-root alias');
          assert.notEqual(path.resolve(dest), realpathSync(dest), 'PKG-012 destination did not preserve the macOS temp-root alias');
        }
        const store = path.join(project, '.continuity');
        mkdirSync(store, { recursive: true });
        writeFileSync(path.join(store, 'HISTORY.ndjson'), 'compatibility-store-marker\n');
        const storeBefore = fingerprint(store);
        uninstallInstalledSkill(installHome);
        assert.equal(existsSync(dest), false);
        assert.deepEqual(fingerprint(store), storeBefore);
        assert.throws(() => uninstallInstalledSkill(installHome), /missing|unverified/);
        assert.deepEqual(fingerprint(store), storeBefore);
      } finally {
        rmSync(installHome, { recursive: true, force: true });
        rmSync(project, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'PKG-013-installed-public-cli-smoke',
    run() {
      const installHome = makeTempInstallHome('smoke');
      const project = makeTempGitProject('smoke');
      try {
        const dest = installSkillFromWorktree(installHome);
        const helper = path.join(dest, 'scripts', 'continuity.mjs');
        const template = path.join(dest, 'assets', 'init-v3.template.json');
        if (!existsSync(helper)) throw new Error('public continuity CLI entry point is missing');
        const version = spawnSync(process.execPath, [helper, '--version'], {
          cwd: project,
          encoding: 'utf8',
          windowsHide: true,
          shell: false,
          env: helperEnv(),
        });
        assert.equal(version.status, 0, version.stderr);
        assert.match(version.stdout, /^continuity 2\.0\.0\n?$/);

        const doctorEmpty = runInstalled(helper, ['doctor'], { cwd: project, root: project });
        assert.equal(
          doctorEmpty.status === 0 || doctorEmpty.stderr.includes('not initialized') || doctorEmpty.stdout.includes('uninitialized'),
          true,
          doctorEmpty.stderr,
        );
        const init = runInstalled(helper, ['init', '--schema', '3', '--file', template], { cwd: project, root: project });
        assert.equal(init.status, 0, init.stderr);
        const store = path.join(project, '.continuity');
        assert.equal(existsSync(path.join(store, 'HISTORY.ndjson')), true);
        assert.equal(existsSync(path.join(dest, '.continuity')), false);
      } finally {
        rmSync(installHome, { recursive: true, force: true });
        rmSync(project, { recursive: true, force: true });
      }
    },
  },
];
