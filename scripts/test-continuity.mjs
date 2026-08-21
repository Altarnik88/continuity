#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUITE_NAMES, SuiteSelectionError, discoverTests, runTestFiles, suiteFiles } from '../tests/helpers/suite-aggregator.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDirectory = path.join(repoRoot, 'tests');

const requestedSuiteIndex = process.argv.indexOf('--suite');
if (requestedSuiteIndex !== -1) {
  const requestedSuite = process.argv[requestedSuiteIndex + 1];
  if (process.argv.length !== 4) {
    console.error('continuity tests: unknown or missing suite');
    process.exit(2);
  }
  let files;
  try {
    files = suiteFiles(testsDirectory, requestedSuite);
  } catch (error) {
    if (!(error instanceof SuiteSelectionError)) throw error;
    console.error(error.reason === 'unknown' ? 'continuity tests: unknown or missing suite' : `continuity tests: suite ${requestedSuite} is ${error.reason}`);
    process.exit(2);
  }
  await runTestFiles(files);
  console.log(`continuity ${requestedSuite} suite: PASS (${files.length} file(s))`);
  process.exit(0);
}

const helper = path.join(repoRoot, 'continuity', 'scripts', 'continuity.mjs');
const v3Template = path.join(repoRoot, 'continuity', 'assets', 'init-v3.template.json');
const fixture = mkdtempSync(path.join(os.tmpdir(), 'continuity-test-'));
const outside = mkdtempSync(path.join(os.tmpdir(), 'continuity-outside-'));
const disposableRoots = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function git(root, args) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function run(args, { root = fixture, env = {} } = {}) {
  return spawnSync(process.execPath, [helper, ...args, '--root', root], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runFrom(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [helper, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function makeRepository(label) {
  const root = mkdtempSync(path.join(os.tmpdir(), `continuity-${label}-`));
  disposableRoots.push(root);
  spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  spawnSync('git', ['-C', root, 'config', 'user.name', 'Continuity Test'], { encoding: 'utf8' });
  spawnSync('git', ['-C', root, 'config', 'user.email', 'continuity-test@example.invalid'], { encoding: 'utf8' });
  writeFileSync(path.join(root, 'README.md'), '# Fixture\n');
  spawnSync('git', ['-C', root, 'add', 'README.md'], { encoding: 'utf8' });
  spawnSync('git', ['-C', root, 'commit', '-qm', 'fixture'], { encoding: 'utf8' });
  return root;
}

try {
  let result = runFrom(['--version'], { cwd: outside });
  assert(result.status === 0 && result.stdout.trim() === 'continuity 2.0.0', '--version failed');

  result = runFrom(['snapshot', 'template'], { cwd: outside });
  assert(result.status !== 0 && result.stderr.includes('legacy-v1v2-final'), 'v1 snapshot invocation was not refused');

  const unbornRoot = makeRepository('unborn');
  result = run(['doctor'], { root: unbornRoot });
  assert(result.status === 0 && result.stdout.includes('journal=uninitialized'), `uninitialized doctor failed: ${result.stderr}`);
  result = run(['init', '--schema', '3', '--file', v3Template], { root: unbornRoot });
  assert(result.status === 0, `v3 init failed: ${result.stderr}`);
  result = run(['validate'], { root: unbornRoot });
  assert(result.status === 0 && result.stdout.includes('event(s)'), 'unborn init did not create a valid journal');
  result = run(['init', '--schema', '3', '--file', v3Template], { root: unbornRoot });
  assert(result.status !== 0 && result.stderr.includes('already initialized'), 'init did not refuse an initialized store');
  result = run(['doctor'], { root: unbornRoot });
  assert(result.status === 0 && result.stdout.includes('journal=valid'), 'doctor failed on an initialized repository');
  mkdirSync(path.join(unbornRoot, 'docs'), { recursive: true });
  result = runFrom(['doctor'], { cwd: path.join(unbornRoot, 'docs') });
  assert(result.status === 0 && result.stdout.includes('repository=ok'), `default root discovery did not use cwd Git top-level: ${result.stderr}`);
  result = run(['doctor'], { root: path.join(unbornRoot, 'docs') });
  assert(result.status !== 0 && result.stderr.includes('must name the Git worktree top-level'), 'explicit nested --root was accepted');
  result = run(['doctor'], { root: outside });
  assert(result.status !== 0 && result.stderr.includes('not inside a Git worktree'), 'non-Git --root was accepted');
  const opaqueArgument = '--credential=must-not-echo';
  result = runFrom(['doctor', opaqueArgument], { cwd: unbornRoot });
  assert(result.status !== 0 && !`${result.stdout}${result.stderr}`.includes(opaqueArgument), 'unknown argument was echoed');

  const linkedStoreRoot = makeRepository('linked-store');
  const outsideStore = mkdtempSync(path.join(os.tmpdir(), 'continuity-linked-store-outside-'));
  disposableRoots.push(outsideStore);
  symlinkSync(outsideStore, path.join(linkedStoreRoot, '.continuity'), process.platform === 'win32' ? 'junction' : 'dir');
  result = run(['init', '--schema', '3', '--file', v3Template], { root: linkedStoreRoot });
  assert(result.status !== 0 && result.stderr.includes('must not use links or reparse points'), 'linked store junction was followed');
  assert(!existsSync(path.join(outsideStore, 'HISTORY.ndjson')), 'linked store wrote outside the repository');

  const worktreeRoot = path.join(unbornRoot, 'linked-worktree');
  git(unbornRoot, ['worktree', 'add', '-q', '--detach', worktreeRoot, 'HEAD']);
  result = run(['init', '--schema', '3', '--file', v3Template], { root: worktreeRoot });
  assert(result.status !== 0 && result.stderr.includes('refused in linked worktrees'), `linked worktree init was not refused: ${result.stderr}`);
  result = run(['doctor'], { root: worktreeRoot });
  assert(result.status === 0 && result.stdout.includes('worktree=linked mutation=refused'), 'doctor did not diagnose linked worktree mutation refusal');
  git(unbornRoot, ['worktree', 'remove', '--force', worktreeRoot]);

  console.log('continuity isolated hardening tests: PASS');
} finally {
  for (const root of disposableRoots) rmSync(root, { recursive: true, force: true });
  rmSync(fixture, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

for (const suiteName of SUITE_NAMES) {
  const directory = path.join(testsDirectory, suiteName);
  let files;
  try { files = discoverTests(directory); } catch { continue; }
  if (!files.length) continue;
  await runTestFiles(files);
  console.log(`continuity ${suiteName} suite: PASS (${files.length} file(s))`);
}
