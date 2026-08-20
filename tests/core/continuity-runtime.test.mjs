import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_STORE_DIR, LEGACY_STORE_DIR, STORE_DIR_ENV, discoverLegacyStore, storePaths,
} from '../../continuity/scripts/lib/core/store.mjs';

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../continuity/scripts');
const continuityCli = path.join(scripts, 'continuity.mjs');
const compatibilityCli = path.join(scripts, 'project-memory.mjs');
const v3InitTemplate = path.resolve(scripts, '../assets/init-v3.template.json');

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function makeRepository(label) {
  const root = mkdtempSync(path.join(os.tmpdir(), `continuity-${label}-`));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Continuity Test']);
  git(root, ['config', 'user.email', 'continuity-test@example.invalid']);
  writeFileSync(path.join(root, 'README.md'), '# Fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

function envWith(values = {}) {
  const env = { ...process.env };
  delete env[STORE_DIR_ENV];
  return Object.assign(env, values);
}

function runCli(cli, root, args, values = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: envWith(values),
  });
}

function dataTreeDigest(root) {
  const hash = createHash('sha256');
  const visit = (directory, relative = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (!relative && entry.name === '.git') continue;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      const details = lstatSync(target);
      hash.update(`${childRelative}\0${details.mode}\0${details.size}\0`);
      if (entry.isSymbolicLink()) hash.update('link');
      else if (entry.isDirectory()) visit(target, childRelative);
      else hash.update(readFileSync(target));
    }
  };
  visit(root);
  return hash.digest('hex');
}

export async function run() {
  const roots = [];
  let skipped = 0;
  try {
    const outsideGit = mkdtempSync(path.join(os.tmpdir(), 'continuity-help-'));
    roots.push(outsideGit);
    let result = runCli(continuityCli, outsideGit, ['--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^usage: continuity\.mjs/m);
    assert.match(result.stdout, /CONTINUITY_STORE_DIR=<repository-relative-directory>/);
    result = runCli(continuityCli, outsideGit, ['--version']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'continuity 2.0.0\n');
    result = runCli(compatibilityCli, outsideGit, ['--version']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'continuity 2.0.0\n');
    assert.equal(existsSync(path.join(outsideGit, DEFAULT_STORE_DIR)), false);
    assert.equal(existsSync(path.join(outsideGit, '.codex')), false);

    const defaultRoot = makeRepository('default');
    const ignoredCodexHome = mkdtempSync(path.join(os.tmpdir(), 'continuity-codex-home-'));
    roots.push(defaultRoot, ignoredCodexHome);
    result = runCli(continuityCli, defaultRoot, ['init'], { CODEX_HOME: ignoredCodexHome });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(storePaths(defaultRoot).store, path.join(defaultRoot, DEFAULT_STORE_DIR));
    assert.equal(existsSync(path.join(defaultRoot, DEFAULT_STORE_DIR, 'HISTORY.ndjson')), true);
    assert.equal(existsSync(path.join(defaultRoot, '.codex')), false);
    assert.deepEqual(readdirSync(ignoredCodexHome), []);

    const overrideRoot = makeRepository('override');
    roots.push(overrideRoot);
    const override = 'state/continuity-data';
    result = runCli(continuityCli, overrideRoot, ['init', '--schema', '3', '--file', v3InitTemplate], { [STORE_DIR_ENV]: override });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(overrideRoot, 'state', 'continuity-data', 'HISTORY.ndjson')), true);
    assert.equal(existsSync(path.join(overrideRoot, DEFAULT_STORE_DIR)), false);
    assert.equal(existsSync(path.join(overrideRoot, '.codex')), false);

    const rejectedRoot = makeRepository('rejected-overrides');
    const outsideStore = mkdtempSync(path.join(os.tmpdir(), 'continuity-outside-store-'));
    roots.push(rejectedRoot, outsideStore);
    for (const rejected of ['../escape', 'nested/../escape', '.', '.git/continuity', path.join(outsideStore, 'absolute-store')]) {
      const before = dataTreeDigest(rejectedRoot);
      result = runCli(continuityCli, rejectedRoot, ['init'], { [STORE_DIR_ENV]: rejected });
      assert.notEqual(result.status, 0, `accepted ${rejected}`);
      assert.match(result.stderr, /CONTINUITY_STORE_DIR|continuity path/);
      assert.equal(dataTreeDigest(rejectedRoot), before, `rejected ${rejected} changed repository data`);
      assert.deepEqual(readdirSync(outsideStore), [], `rejected ${rejected} wrote outside`);
    }

    const linkedRoot = makeRepository('linked-override');
    const linkedOutside = mkdtempSync(path.join(os.tmpdir(), 'continuity-linked-outside-'));
    roots.push(linkedRoot, linkedOutside);
    try {
      symlinkSync(linkedOutside, path.join(linkedRoot, 'linked-store'), process.platform === 'win32' ? 'junction' : 'dir');
      const before = dataTreeDigest(linkedRoot);
      result = runCli(continuityCli, linkedRoot, ['init'], { [STORE_DIR_ENV]: 'linked-store' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must not use links or reparse points/);
      assert.equal(dataTreeDigest(linkedRoot), before);
      assert.deepEqual(readdirSync(linkedOutside), []);
    } catch (error) {
      if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
      skipped += 1;
    }

    const legacyRoot = makeRepository('legacy-discovery');
    roots.push(legacyRoot);
    const legacyStore = path.resolve(legacyRoot, ...LEGACY_STORE_DIR.split('/'));
    mkdirSync(legacyStore, { recursive: true });
    const legacyHistory = path.join(legacyStore, 'HISTORY.ndjson');
    writeFileSync(legacyHistory, 'not-json-and-must-not-be-read\n');
    const legacyBefore = readFileSync(legacyHistory);
    const discovery = discoverLegacyStore(legacyRoot);
    assert.deepEqual({ status: discovery.status, history: discovery.history, current: discovery.current }, {
      status: 'present', history: true, current: false,
    });
    result = runCli(continuityCli, legacyRoot, ['init']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(legacyHistory).equals(legacyBefore), true);
    assert.equal(existsSync(path.join(legacyRoot, DEFAULT_STORE_DIR, 'HISTORY.ndjson')), true);
    console.log(`continuity runtime: found=6 executed=${6 - skipped} passed=${6 - skipped} failed=0 skipped=${skipped}`);
  } finally {
    for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
  }
}
