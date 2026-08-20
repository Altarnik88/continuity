#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
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
const fixture = mkdtempSync(path.join(os.tmpdir(), 'continuity-test-'));
const outside = mkdtempSync(path.join(os.tmpdir(), 'continuity-outside-'));
const disposableRoots = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function run(args, input, { root = fixture, env = {} } = {}) {
  return spawnSync(process.execPath, [helper, ...args, '--root', root], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runFrom(args, input, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [helper, ...args], {
    input,
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function makeRepository(label, { commit = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), `continuity-${label}-`));
  disposableRoots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Continuity Test']);
  git(root, ['config', 'user.email', 'continuity-test@example.invalid']);
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'source.md'), '# Source\n');
  if (commit) {
    git(root, ['add', 'docs/source.md']);
    git(root, ['commit', '-qm', 'fixture']);
  }
  return root;
}

function normalizedTextHash(file) {
  const normalized = readFileSync(file, 'utf8').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function snapshotFor(root = fixture, sourcePath = 'docs/source.md') {
  const absoluteSource = path.join(root, ...sourcePath.split('/'));
  return {
    project: { name: 'Fixture', identity: 'Bounded test project' },
    stableGoals: ['Keep continuity safe'],
    implementationBoundaries: ['Source remains authoritative'],
    operatingRules: ['Verify before mutation'],
    activeWork: [{ summary: 'Exercise helper', status: 'active', sourceRefs: [sourcePath] }],
    decisions: [{ summary: 'Use bounded snapshots', status: 'accepted', sourceRefs: [sourcePath] }],
    recentWork: [{ summary: 'Created fixture', status: 'verified', checkedAt: '2026-08-14T00:00:00.000Z', sourceRefs: [sourcePath] }],
    validationEvidence: [{ name: 'fixture', status: 'pass', scope: 'isolated helper behavior', checkedAt: '2026-08-14T00:00:00.000Z', sourceRefs: [sourcePath] }],
    unresolvedItems: [],
    nextSteps: ['Run validation'],
    sourceRefs: [{ path: sourcePath, purpose: 'fixture truth', contentSha256: normalizedTextHash(absoluteSource) }],
  };
}

function cloneFixture(label, autocrlf = false) {
  const cloneRoot = mkdtempSync(path.join(os.tmpdir(), `continuity-${label}-`));
  rmSync(cloneRoot, { recursive: true, force: true });
  const args = ['clone', '-q'];
  if (autocrlf) args.unshift('-c', 'core.autocrlf=true');
  execFileSync('git', [...args, fixture, cloneRoot]);
  disposableRoots.push(cloneRoot);
  return cloneRoot;
}

try {
  let result = runFrom(['--version'], undefined, { cwd: outside });
  assert(result.status === 0 && result.stdout.trim() === 'continuity 2.0.0', '--version failed');

  result = runFrom(['snapshot', 'template'], undefined, { cwd: outside });
  assert(result.status === 0, `snapshot template failed outside Git: ${result.stderr}`);
  const bundledTemplate = JSON.parse(result.stdout);
  assert(bundledTemplate.schemaVersion === 1 && bundledTemplate.sourceRefs.length === 0, 'snapshot template is not source-less schema v1');
  const schemaPath = path.join(path.dirname(helper), '..', 'references', 'snapshot-v1.schema.json');
  assert(JSON.parse(readFileSync(schemaPath, 'utf8')).title === 'Continuity snapshot v1', 'machine-readable schema is invalid');

  const unbornRoot = makeRepository('unborn', { commit: false });
  const lintFile = path.join(unbornRoot, 'snapshot.json');
  writeFileSync(lintFile, JSON.stringify(bundledTemplate));
  result = run(['lint', '--file', lintFile], undefined, { root: unbornRoot });
  assert(result.status === 0 && result.stdout.includes('snapshot lint: ok'), `source-less lint failed before first commit: ${result.stderr}`);
  result = run(['checkpoint', '--dry-run', '--stdin'], JSON.stringify(bundledTemplate), { root: unbornRoot });
  assert(result.status === 0 && result.stdout.includes('prospective-sequence=1'), `dry-run failed before first commit: ${result.stderr}`);
  assert(!existsSync(path.join(unbornRoot, '.continuity')), 'checkpoint dry-run wrote the store');
  result = run(['init'], undefined, { root: unbornRoot });
  assert(result.status === 0, `init failed before first commit: ${result.stderr}`);
  result = run(['validate'], undefined, { root: unbornRoot });
  assert(result.status === 0 && result.stdout.includes('1 event(s)'), 'unborn init did not create a valid journal');
  result = run(['source', 'hash', 'docs/source.md'], undefined, { root: unbornRoot });
  assert(result.status !== 0 && result.stderr.includes('committed HEAD'), 'source hash worked without committed HEAD');
  result = run(['init'], undefined, { root: unbornRoot });
  assert(result.status !== 0 && result.stderr.includes('already initialized'), 'init did not refuse an initialized store');
  result = run(['doctor'], undefined, { root: unbornRoot });
  assert(result.status === 0 && result.stdout.includes('journal=valid'), 'doctor failed on an unborn initialized repository');
  result = runFrom(['doctor'], undefined, { cwd: path.join(unbornRoot, 'docs') });
  assert(result.status === 0 && result.stdout.includes('repository=ok'), 'default root discovery did not use cwd Git top-level');
  result = run(['doctor'], undefined, { root: path.join(unbornRoot, 'docs') });
  assert(result.status !== 0 && result.stderr.includes('must name the Git worktree top-level'), 'explicit nested --root was accepted');
  result = run(['doctor'], undefined, { root: outside });
  assert(result.status !== 0 && result.stderr.includes('not inside a Git worktree'), 'non-Git --root was accepted');
  const opaqueArgument = '--credential=must-not-echo';
  result = runFrom(['doctor', opaqueArgument], undefined, { cwd: unbornRoot });
  assert(result.status !== 0 && !`${result.stdout}${result.stderr}`.includes(opaqueArgument), 'unknown argument was echoed');

  mkdirSync(path.join(fixture, 'docs'), { recursive: true });
  writeFileSync(path.join(fixture, 'docs', 'source.md'), '# Verified source\r\n');
  writeFileSync(path.join(fixture, 'docs', 'dirty.md'), 'baseline\n');
  writeFileSync(path.join(fixture, '.gitignore'), 'ignored.txt\n');
  git(fixture, ['init', '-q']);
  git(fixture, ['config', 'user.name', 'Continuity Test']);
  git(fixture, ['config', 'user.email', 'continuity-test@example.invalid']);
  git(fixture, ['config', 'core.autocrlf', 'true']);
  git(fixture, ['add', 'docs', '.gitignore']);
  git(fixture, ['commit', '-qm', 'fixture']);

  writeFileSync(path.join(fixture, 'docs', 'dirty.md'), 'dirty-A\n');
  let base = snapshotFor();
  result = run(['checkpoint', '--stdin'], JSON.stringify(base));
  assert(result.status === 0, `first checkpoint failed: ${result.stderr}`);
  result = run(['validate']);
  assert(result.status === 0 && result.stdout.includes('1 event(s)') && result.stdout.includes('projection=current'), 'initial validation failed');
  result = run(['inspect']);
  assert(result.status === 0 && result.stdout.includes('\nDecisions\n') && result.stdout.includes('\nRecent work\n'), 'inspect omitted decisions or recentWork');
  result = run(['source', 'hash', 'docs\\source.md']);
  assert(result.status === 0, `Windows-separator source hash failed: ${result.stderr}`);
  const sourceHash = JSON.parse(result.stdout);
  assert(sourceHash.path === 'docs/source.md' && sourceHash.contentSha256 === base.sourceRefs[0].contentSha256, 'source hash was not canonical or correct');
  result = run(['checkpoint', '--dry-run', '--stdin'], JSON.stringify(base));
  assert(result.status === 0 && result.stdout.includes('prospective-sequence=2'), 'checkpoint dry-run did not validate initialized state');
  result = run(['validate']);
  assert(result.stdout.includes('1 event(s)'), 'checkpoint dry-run mutated the journal');

  writeFileSync(path.join(fixture, 'docs', 'dirty.md'), 'dirty-B\n');
  result = run(['inspect']);
  assert(result.status === 0 && result.stdout.includes('status: recorded=dirty current=dirty drift=YES'), 'same-status content drift was not detected');

  writeFileSync(path.join(fixture, 'docs', 'source.md'), '# Verified source\n');
  result = run(['inspect']);
  assert(result.status === 0 && result.stdout.includes('CURRENT: docs/source.md'), 'CRLF/LF normalization changed the source hash');

  writeFileSync(path.join(fixture, 'docs', 'source.md'), '# Dirty source\n');
  let rejectedSource = snapshotFor();
  result = run(['checkpoint', '--stdin'], JSON.stringify(rejectedSource));
  assert(result.status !== 0 && result.stderr.includes('tracked, committed, non-ignored, and clean'), 'dirty tracked source was accepted');
  assert(!result.stderr.includes('# Dirty source'), 'dirty source content was echoed');
  writeFileSync(path.join(fixture, 'docs', 'source.md'), '# Verified source\n');

  writeFileSync(path.join(fixture, 'docs', 'source.md'), '# Staged source\n');
  git(fixture, ['add', 'docs/source.md']);
  rejectedSource = snapshotFor();
  result = run(['checkpoint', '--stdin'], JSON.stringify(rejectedSource));
  assert(result.status !== 0 && result.stderr.includes('tracked, committed, non-ignored, and clean'), 'staged source was accepted');
  assert(!result.stderr.includes('# Staged source'), 'staged source content was echoed');
  git(fixture, ['reset', '-q', 'HEAD', '--', 'docs/source.md']);
  writeFileSync(path.join(fixture, 'docs', 'source.md'), '# Verified source\n');

  writeFileSync(path.join(fixture, 'ignored.txt'), 'ignored source\n');
  rejectedSource = snapshotFor(fixture, 'ignored.txt');
  result = run(['checkpoint', '--stdin'], JSON.stringify(rejectedSource));
  assert(result.status !== 0 && result.stderr.includes('tracked, committed, non-ignored, and clean'), 'ignored untracked source was accepted');
  assert(!result.stderr.includes('ignored source'), 'ignored source content was echoed');
  rmSync(path.join(fixture, 'ignored.txt'));

  writeFileSync(path.join(fixture, 'untracked.txt'), 'untracked source\n');
  rejectedSource = snapshotFor(fixture, 'untracked.txt');
  result = run(['checkpoint', '--stdin'], JSON.stringify(rejectedSource));
  assert(result.status !== 0 && result.stderr.includes('tracked, committed, non-ignored, and clean'), 'untracked source was accepted');
  assert(!result.stderr.includes('untracked source'), 'untracked source content was echoed');
  rmSync(path.join(fixture, 'untracked.txt'));

  base = snapshotFor();
  result = run(['checkpoint', '--stdin'], JSON.stringify({ ...base, nextSteps: ['Second checkpoint'] }));
  assert(result.status === 0, `clean tracked checkpoint failed: ${result.stderr}`);
  result = run(['history', '--tail', '2']);
  assert(result.status === 0 && result.stdout.includes('#1 ') && result.stdout.includes('#2 '), 'bounded history failed');

  const partial = { ...base, nextSteps: ['Projection recovery checkpoint'] };
  result = run(['checkpoint', '--stdin'], JSON.stringify(partial), {
    env: { NODE_ENV: 'test', PROJECT_MEMORY_TEST_FAIL_CURRENT_REPLACE: '1' },
  });
  assert(result.status !== 0 && result.stderr.includes('checkpoint committed as sequence 3'), 'simulated locked CURRENT did not report a committed journal event');
  result = run(['validate']);
  assert(result.status === 0 && result.stdout.includes('3 event(s)') && result.stdout.includes('projection=stale'), 'journal did not remain authoritative after projection failure');
  result = run(['inspect']);
  assert(result.status === 0 && result.stdout.includes('CURRENT projection=stale'), 'read-only inspect did not derive the committed journal snapshot');
  result = run(['checkpoint', '--stdin'], JSON.stringify({ ...base, nextSteps: ['Repair projection'] }));
  assert(result.status === 0 && result.stdout.includes('projection=current'), 'checkpoint did not reconcile the stale projection');

  writeFileSync(path.join(fixture, '.continuity', 'HISTORY.ndjson'), '{"partial":', { flag: 'a' });
  result = run(['validate']);
  assert(result.status === 0 && result.stdout.includes('journal-tail=partial'), 'partial journal tail was not safely ignored');
  result = run(['checkpoint', '--stdin'], JSON.stringify({ ...base, nextSteps: ['Recover partial tail'] }));
  assert(result.status === 0, 'checkpoint did not truncate and recover the partial journal tail');

  const rejectedValues = [
    'Bearer ' + 'A'.repeat(24),
    'Authorization: Basic ' + 'Q'.repeat(20),
    '+7 (999) 123-45-67',
    '555-123-4567',
    'sk_live_' + 'L'.repeat(24),
    'sk_test_' + 'T'.repeat(24),
    'xoxb-' + '123456789012-ABCDEFGHIJKL',
    'person' + '@example.invalid',
    'postgresql://' + 'user:credential' + '@database.invalid/project',
    'PROD_VALUE=' + 'must-not-be-stored',
    'diff --' + 'git a/file b/file',
    '*** Begin ' + 'Patch',
    '-----BEGIN PRIVATE ' + 'KEY-----',
    'Cookie: session=' + 'A'.repeat(20),
    'Set-Cookie: identity=' + 'B'.repeat(20),
    'Session-ID: ' + 'C'.repeat(20),
    'raw command line one\nraw command line two',
    'rendered-line\u0085injection',
    'rendered-line\u2028injection',
    'rendered-line\u2029injection',
    'bidi\u202Eoverride',
    'format\u2060control',
  ];
  for (const rejected of rejectedValues) {
    result = run(['checkpoint', '--stdin'], JSON.stringify({ ...base, nextSteps: [rejected] }));
    assert(result.status !== 0, `sensitive material was accepted: ${rejected.slice(0, 12)}`);
    assert(!`${result.stdout}${result.stderr}`.includes(rejected), 'rejected sensitive material was echoed');
  }

  const invalidDate = {
    ...base,
    recentWork: [{ ...base.recentWork[0], checkedAt: '2026-08-14' }],
  };
  result = run(['checkpoint', '--stdin'], JSON.stringify(invalidDate));
  assert(result.status !== 0 && result.stderr.includes('strict ISO-8601'), 'non-strict date was accepted');

  const windowsPathSnapshot = snapshotFor();
  windowsPathSnapshot.sourceRefs[0].path = 'docs\\source.md';
  for (const item of [
    ...windowsPathSnapshot.activeWork,
    ...windowsPathSnapshot.decisions,
    ...windowsPathSnapshot.recentWork,
    ...windowsPathSnapshot.validationEvidence,
  ]) item.sourceRefs = ['docs\\source.md'];
  result = run(['checkpoint', '--stdin'], JSON.stringify(windowsPathSnapshot));
  assert(result.status === 0, `checkpoint rejected canonicalizable Windows source paths: ${result.stderr}`);
  const canonicalProjection = JSON.parse(readFileSync(path.join(fixture, '.continuity', 'CURRENT.json'), 'utf8'));
  assert(canonicalProjection.sourceRefs[0].path === 'docs/source.md', 'stored top-level source path was not canonicalized');
  assert(canonicalProjection.decisions[0].sourceRefs[0] === 'docs/source.md', 'stored nested source path was not canonicalized');

  writeFileSync(path.join(outside, 'source.md'), '# Outside\n');
  const escapePath = path.join(fixture, 'escape');
  symlinkSync(outside, escapePath, process.platform === 'win32' ? 'junction' : 'dir');
  const escaped = snapshotFor(outside, 'source.md');
  escaped.sourceRefs[0].path = 'escape/source.md';
  escaped.activeWork[0].sourceRefs = ['escape/source.md'];
  escaped.decisions[0].sourceRefs = ['escape/source.md'];
  escaped.recentWork[0].sourceRefs = ['escape/source.md'];
  escaped.validationEvidence[0].sourceRefs = ['escape/source.md'];
  result = run(['checkpoint', '--stdin'], JSON.stringify(escaped));
  assert(result.status !== 0 && result.stderr.includes('escape the repository'), 'linked source escape was accepted');

  const linkedStoreRoot = makeRepository('linked-store');
  const outsideStore = mkdtempSync(path.join(os.tmpdir(), 'continuity-linked-store-outside-'));
  disposableRoots.push(outsideStore);
  symlinkSync(outsideStore, path.join(linkedStoreRoot, '.continuity'), process.platform === 'win32' ? 'junction' : 'dir');
  result = run(['init'], undefined, { root: linkedStoreRoot });
  assert(result.status !== 0 && result.stderr.includes('must not use links or reparse points'), 'linked store junction was followed');
  assert(!existsSync(path.join(outsideStore, 'HISTORY.ndjson')), 'linked store wrote outside the repository');

  const linkedFileRoot = makeRepository('linked-history-file');
  const outsideHistory = path.join(outsideStore, 'outside-history.ndjson');
  writeFileSync(outsideHistory, '');
  mkdirSync(path.join(linkedFileRoot, '.continuity'), { recursive: true });
  const linkedHistoryPath = path.join(linkedFileRoot, '.continuity', 'HISTORY.ndjson');
  try {
    symlinkSync(outsideHistory, linkedHistoryPath, 'file');
  } catch (error) {
    if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
    symlinkSync(outsideStore, linkedHistoryPath, 'junction');
  }
  result = run(['init'], undefined, { root: linkedFileRoot });
  assert(result.status !== 0 && result.stderr.includes('must not use links or reparse points'), 'linked journal file was followed');
  assert(readFileSync(outsideHistory, 'utf8') === '', 'linked journal write escaped the repository');

  const hardlinkRoot = makeRepository('hardlink-store');
  const hardlinkSnapshot = snapshotFor(hardlinkRoot);
  result = run(['checkpoint', '--stdin'], JSON.stringify(hardlinkSnapshot), { root: hardlinkRoot });
  assert(result.status === 0, `hardlink fixture initialization failed: ${result.stderr}`);
  const hardlinkStore = path.join(hardlinkRoot, '.continuity');
  const historyPath = path.join(hardlinkStore, 'HISTORY.ndjson');
  const externalHistoryLink = path.join(hardlinkRoot, 'external-history-link.ndjson');
  linkSync(historyPath, externalHistoryLink);
  const externalHistoryBefore = readFileSync(externalHistoryLink);
  result = run(['checkpoint', '--stdin'], JSON.stringify({ ...hardlinkSnapshot, nextSteps: ['Must not append through a hard link'] }), { root: hardlinkRoot });
  assert(result.status !== 0 && result.stderr.includes('exactly one hard link'), 'hard-linked history was accepted');
  assert(readFileSync(externalHistoryLink).equals(externalHistoryBefore), 'rejected hard-linked history mutated the external inode');
  rmSync(externalHistoryLink);
  result = run(['validate'], undefined, { root: hardlinkRoot });
  assert(result.status === 0 && result.stdout.includes('1 event(s)'), 'history changed despite hardlink rejection');

  const currentPath = path.join(hardlinkStore, 'CURRENT.json');
  const externalCurrentLink = path.join(hardlinkRoot, 'external-current-link.json');
  linkSync(currentPath, externalCurrentLink);
  const externalCurrentBefore = readFileSync(externalCurrentLink);
  result = run(['checkpoint', '--stdin'], JSON.stringify({ ...hardlinkSnapshot, nextSteps: ['Must not replace through a hard link'] }), { root: hardlinkRoot });
  assert(result.status !== 0 && result.stderr.includes('exactly one hard link'), 'hard-linked CURRENT projection was accepted');
  assert(readFileSync(externalCurrentLink).equals(externalCurrentBefore), 'rejected hard-linked projection mutated the external inode');
  rmSync(externalCurrentLink);
  result = run(['validate'], undefined, { root: hardlinkRoot });
  assert(result.status === 0 && result.stdout.includes('1 event(s)') && result.stdout.includes('projection=current'), 'projection or journal changed despite hardlink rejection');

  writeFileSync(path.join(fixture, '.continuity', 'CURRENT.json'), 'X'.repeat(70 * 1024));
  result = run(['validate']);
  assert(result.status === 0 && result.stdout.includes('projection=invalid'), 'oversized projection was read or treated as authoritative');
  result = run(['history', '--tail', '1']);
  assert(result.status === 0, 'history depended on the oversized projection');
  result = run(['checkpoint', '--stdin'], JSON.stringify({ ...base, nextSteps: ['Repair oversized projection'] }));
  assert(result.status === 0, 'checkpoint did not repair the oversized projection');

  let boundaryAccepted = false;
  for (let total = 64_000; total >= 54_000; total -= 500) {
    const goals = [];
    let remaining = total;
    while (remaining > 0) {
      const count = Math.min(2_000, remaining);
      goals.push('G'.repeat(count));
      remaining -= count;
    }
    const boundary = { ...base, stableGoals: goals };
    result = run(['checkpoint', '--stdin'], JSON.stringify(boundary));
    if (result.status === 0) {
      boundaryAccepted = true;
      break;
    }
    assert(result.stderr.includes('size limit'), 'near-limit rejection failed for an unrelated reason');
  }
  assert(boundaryAccepted, 'no near-limit snapshot was accepted');
  const projectionSize = statSync(path.join(fixture, '.continuity', 'CURRENT.json')).size;
  assert(projectionSize > 54_000 && projectionSize <= 64 * 1024, 'accepted projection did not remain within the exact byte limit');
  result = run(['validate']);
  assert(result.status === 0 && result.stdout.includes('projection=current'), 'accepted near-limit snapshot produced an invalid projection');
  result = run(['checkpoint', '--stdin'], JSON.stringify({ ...base, nextSteps: ['Shrink boundary projection'] }));
  assert(result.status === 0, 'checkpoint did not replace the boundary projection');

  const hugePath = path.join(fixture, 'docs', 'huge.txt');
  writeFileSync(hugePath, 'H'.repeat(1024 * 1024 + 1));
  git(fixture, ['add', 'docs/huge.txt']);
  git(fixture, ['commit', '-qm', 'large source fixture']);
  const huge = snapshotFor();
  huge.sourceRefs = [{ path: 'docs/huge.txt', purpose: 'oversized fixture', contentSha256: '0'.repeat(64) }];
  for (const item of [...huge.activeWork, ...huge.decisions, ...huge.recentWork, ...huge.validationEvidence]) item.sourceRefs = ['docs/huge.txt'];
  result = run(['checkpoint', '--stdin'], JSON.stringify(huge));
  assert(result.status !== 0 && result.stderr.includes('hashing size limit'), 'oversized source was hashed without a bound');
  git(fixture, ['rm', '-q', 'docs/huge.txt']);
  git(fixture, ['commit', '-qm', 'remove large source fixture']);

  const lockPath = git(fixture, ['rev-parse', '--git-path', 'project-memory.checkpoint.lock']);
  const resolvedLock = path.isAbsolute(lockPath) ? lockPath : path.resolve(fixture, lockPath);
  result = run(['checkpoint', '--stdin'], JSON.stringify(base), {
    env: { NODE_ENV: 'test', PROJECT_MEMORY_TEST_FAIL_LOCK_METADATA: '1' },
  });
  assert(result.status !== 0 && result.stderr.includes('initialize the checkpoint lock'), 'lock metadata failure was not reported');
  assert(!existsSync(resolvedLock), 'failed lock metadata initialization left a stale lock');
  const externalLockLink = path.join(fixture, 'external-checkpoint-lock');
  writeFileSync(resolvedLock, '{"pid":777777}');
  linkSync(resolvedLock, externalLockLink);
  const externalLockBefore = readFileSync(externalLockLink);
  result = run(['checkpoint', '--stdin'], JSON.stringify(base));
  assert(result.status !== 0 && result.stderr.includes('exactly one hard link'), 'hard-linked checkpoint lock was accepted');
  assert(readFileSync(externalLockLink).equals(externalLockBefore), 'rejected hard-linked lock mutated the external inode');
  rmSync(externalLockLink);
  rmSync(resolvedLock);
  writeFileSync(resolvedLock, '{"pid":999999}');
  result = run(['checkpoint', '--stdin'], JSON.stringify(base));
  assert(result.status !== 0 && result.stderr.includes('checkpoint locked'), 'lock conflict was not clear');
  assert(readFileSync(resolvedLock, 'utf8').includes('999999'), 'conflicting lock was deleted');
  result = run(['doctor']);
  assert(result.status === 0 && result.stdout.includes('lock=present-manual-review-required'), 'doctor did not report the stale-lock workflow boundary');
  rmSync(resolvedLock);

  const worktreeRoot = path.join(fixture, 'linked-worktree');
  git(fixture, ['worktree', 'add', '-q', '--detach', worktreeRoot, 'HEAD']);
  result = run(['checkpoint', '--stdin'], JSON.stringify(snapshotFor(worktreeRoot)), { root: worktreeRoot });
  assert(result.status !== 0 && result.stderr.includes('refused in linked worktrees'), `linked worktree checkpoint was not refused: ${result.stderr}`);
  result = run(['init'], undefined, { root: worktreeRoot });
  assert(result.status !== 0 && result.stderr.includes('refused in linked worktrees'), 'linked worktree init was not refused');
  result = run(['doctor'], undefined, { root: worktreeRoot });
  assert(result.status === 0 && result.stdout.includes('worktree=linked mutation=refused'), 'doctor did not diagnose linked worktree mutation refusal');
  git(fixture, ['worktree', 'remove', '--force', worktreeRoot]);

  git(fixture, ['add', 'docs/source.md', 'docs/dirty.md', '.continuity']);
  git(fixture, ['commit', '-qm', 'store fixture']);
  const readableWorktree = path.join(fixture, 'readable-linked-worktree');
  git(fixture, ['worktree', 'add', '-q', '--detach', readableWorktree, 'HEAD']);
  result = run(['validate'], undefined, { root: readableWorktree });
  assert(result.status === 0, `read-only validate failed in linked worktree: ${result.stderr}`);
  result = run(['inspect'], undefined, { root: readableWorktree });
  assert(result.status === 0 && result.stdout.includes('Fixture:'), `read-only inspect failed in linked worktree: ${result.stderr}`);
  git(fixture, ['worktree', 'remove', '--force', readableWorktree]);
  const cloneRoot = cloneFixture('clone', true);
  result = run(['inspect'], undefined, { root: cloneRoot });
  assert(result.status === 0 && result.stdout.includes('CURRENT: docs/source.md'), 'fresh autocrlf clone reported a committed source stale or missing');

  const partialRoot = makeRepository('partial-fingerprint');
  const largeDirtyPath = path.join(partialRoot, 'large-dirty.bin');
  const largeDirty = Buffer.alloc(1024 * 1024 + 128, 0x41);
  writeFileSync(largeDirtyPath, largeDirty);
  result = run(['checkpoint', '--stdin'], JSON.stringify(snapshotFor(partialRoot)), { root: partialRoot });
  assert(result.status === 0, `partial-fingerprint checkpoint failed: ${result.stderr}`);
  largeDirty[1024 * 1024 + 64] = 0x42;
  writeFileSync(largeDirtyPath, largeDirty);
  result = run(['inspect'], undefined, { root: partialRoot });
  const driftLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith('- status:')) ?? '';
  assert(result.status === 0 && driftLine.includes('drift=UNKNOWN') && !driftLine.includes('drift=no'), 'partial fingerprint claimed no drift after a byte change beyond the cap');

  const corruptRoot = cloneFixture('corrupt');
  writeFileSync(path.join(corruptRoot, '.continuity', 'HISTORY.ndjson'), '{broken\n', { flag: 'a' });
  result = run(['validate'], undefined, { root: corruptRoot });
  assert(result.status !== 0 && result.stderr.includes('not valid JSON'), 'committed history corruption was not detected');

  const oversizedHistoryRoot = cloneFixture('oversized-history');
  writeFileSync(path.join(oversizedHistoryRoot, '.continuity', 'HISTORY.ndjson'), Buffer.alloc(8 * 1024 * 1024 + 1), { flag: 'a' });
  result = run(['validate'], undefined, { root: oversizedHistoryRoot });
  assert(result.status !== 0 && result.stderr.includes('HISTORY.ndjson total'), 'oversized history was loaded without a bound');

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
