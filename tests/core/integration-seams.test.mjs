import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import {
  appendFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { main } from '../../continuity/scripts/lib/core/cli.mjs';
import { MemoryError, ZERO_HASH, buildEnvelope, foldV2 } from '../../continuity/scripts/lib/core/domain-v2.mjs';
import { appendV2, initializeV2, rebuildProjection, validateV2Append } from '../../continuity/scripts/lib/core/journal-v2.mjs';
import { readLegacyInspectInput, renderLegacyInspectV1 } from '../../continuity/scripts/lib/core/legacy-v1.mjs';
import {
  assertOwnedFile, detectStoreVersion, gitAdminTopology, openStore, readOwnedFileBounded, readV2Journal, storePaths,
} from '../../continuity/scripts/lib/core/store.mjs';
import { makeRepository, runCli } from '../helpers/repository.mjs';

const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../continuity/scripts/continuity.mjs');
const journalModuleUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../continuity/scripts/lib/core/journal-v2.mjs')).href;

function initInput(suffix) {
  return {
    schemaVersion: 2,
    project: {
      projectId: `project-integration-${suffix}`,
      name: 'Integration seam fixture',
      identity: 'Synthetic repository only',
      implementationBoundaries: ['No runtime store access'],
      operatingRules: ['Race rejection has no helper side effect'],
    },
    finalGoal: {
      goalId: `goal-integration-${suffix}`,
      title: 'Close deterministic I/O seams',
      outcome: 'All synchronized races fail closed',
      isFinal: true,
      authority: 'user',
      basis: 'user_stated',
      criterionIds: [],
    },
    actor: { kind: 'user', id: 'actor-user', role: 'user' },
    occurredAt: '2026-08-16T00:00:00.000Z',
    evidenceRef: `evidence-user-${suffix}`,
  };
}

function taskDraft(suffix, project) {
  return {
    eventType: 'task.planned',
    occurredAt: '2026-08-16T00:00:00.000Z',
    actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
    subject: { type: 'task', id: `task-integration-${suffix}` },
    goalId: project.finalGoal.goalId,
    taskId: `task-integration-${suffix}`,
    supersedes: [],
    contradicts: [],
    evidenceRefs: [],
    sensitivity: 'internal',
    payload: {
      task: {
        taskId: `task-integration-${suffix}`,
        goalId: project.finalGoal.goalId,
        title: 'Exercise a deterministic I/O seam',
        scope: 'Synthetic integration fixture',
        pathOwnership: ['src/integration-seam'],
        owner: 'actor-subagent',
        dependencyIds: [],
        criterionIds: [],
        userFacing: false,
        requiredForGoal: false,
      },
    },
  };
}

const TERMINAL_ACTOR_KINDS = Object.freeze(['user', 'coordinator', 'subagent', 'tool', 'migration']);
const TERMINAL_OCCURRED_AT = '2026-08-16T00:00:00.000Z';

function terminalActor(kind) {
  return { kind, id: `actor-${kind}`, role: kind };
}

function accessorBackedSnapshot(base, changes) {
  const value = structuredClone(base);
  const observations = {};
  for (const [property, { first, later, onFirstRead }] of Object.entries(changes)) {
    let reads = 0;
    const getter = () => {
      reads += 1;
      if (reads === 1) onFirstRead?.();
      return structuredClone(reads === 1 ? first : later);
    };
    Object.defineProperty(value, property, { configurable: true, enumerable: true, get: getter });
    observations[property] = { getter, reads: () => reads };
  }
  return { observations, value };
}

function preparedMigrationMarker() {
  return {
    markerVersion: 1,
    migrationId: 'migration-integration-d19-marker',
    phase: 'prepared',
    startedAt: TERMINAL_OCCURRED_AT,
    updatedAt: TERMINAL_OCCURRED_AT,
    source: {
      historyPath: 'HISTORY.ndjson', historyBytes: 0, historySha256: 'a'.repeat(64),
      eventCount: 0, finalEventHash: 'b'.repeat(64),
    },
    targets: {
      archiveHistory: 'HISTORY.v1.ndjson', archiveCurrent: 'CURRENT.v1.json',
      v2History: 'HISTORY.ndjson', v2Current: 'CURRENT.json',
    },
    temps: {
      v2History: 'MIGRATION.v1-to-v2.history.tmp',
      v2Current: 'MIGRATION.v1-to-v2.current.tmp',
    },
    v2EpochId: 'epoch-integration-d19-marker',
  };
}

function prepareTerminalActorAppend(root, targetEvent) {
  const criterionId = 'criterion-terminal-actor';
  const taskId = 'task-terminal-actor';
  const attemptId = 'attempt-terminal-actor';
  const completionEvidenceId = 'evidence-terminal-completion';
  const acceptanceEvidenceId = 'evidence-terminal-acceptance';
  const acceptanceFeedbackId = 'feedback-terminal-acceptance';
  const input = initInput(`terminal-actor-${targetEvent.split('.')[0]}`);
  input.finalGoal.criterionIds = [criterionId];
  initializeV2(root, input, { clock: () => new Date(TERMINAL_OCCURRED_AT) });
  const goalId = input.finalGoal.goalId;
  const draft = (eventType, subject, actorKind, payload, { task = false, evidenceRefs = [] } = {}) => ({
    eventType, occurredAt: TERMINAL_OCCURRED_AT, actor: terminalActor(actorKind), subject, goalId,
    ...(task ? { taskId } : {}),
    supersedes: [], contradicts: [], evidenceRefs, sensitivity: 'internal', payload,
  });
  const append = (value) => appendV2(root, value);

  append(draft('criterion.declared', { type: 'criterion', id: criterionId }, 'coordinator', {
    criterion: {
      criterionId, ownerType: 'goal', ownerId: goalId,
      condition: 'Terminal state requires independent passing evidence', scope: 'Synthetic terminal actor matrix',
      requiredEvidenceKinds: ['test'], freshnessPolicy: { kind: 'immutable_until_superseded' },
      waivableByUser: false,
    },
  }));
  append(draft('task.planned', { type: 'task', id: taskId }, 'coordinator', {
    task: {
      taskId, goalId, title: 'Exercise terminal actor authorization', scope: 'Synthetic actor matrix',
      pathOwnership: ['src/terminal-actor'], owner: 'actor-subagent', dependencyIds: [],
      criterionIds: [criterionId], userFacing: false, requiredForGoal: true,
    },
  }, { task: true }));
  append(draft('attempt.started', { type: 'attempt', id: attemptId }, 'subagent', {
    attempt: {
      attemptId, taskId, ordinal: 1, owner: 'actor-subagent', approachId: 'approach-terminal-actor',
      hypothesisId: 'hypothesis-terminal-actor', approachSummary: 'Exercise the exact actor partition',
    },
  }, { task: true }));
  append(draft('task.started', { type: 'task', id: taskId }, 'subagent', { attemptId }, { task: true }));
  append(draft('evidence.recorded', { type: 'criterion', id: criterionId }, 'tool', {
    evidence: {
      evidenceId: completionEvidenceId, kind: 'test', subjectId: criterionId,
      scope: 'Independent terminal completion evidence', locator: 'checks/terminal-actor',
      observedAt: TERMINAL_OCCURRED_AT, verifier: { kind: 'tool', id: 'actor-tool' },
      method: 'Synthetic independent verification', outcome: 'passed',
      policy: { kind: 'immutable_until_superseded' }, sourceRefs: [], sensitivity: 'internal',
    },
  }));
  append(draft('task.implemented', { type: 'task', id: taskId }, 'subagent', {
    attemptId, deliverableEvidenceRefs: [completionEvidenceId],
  }, { task: true }));
  append(draft('attempt.reported', { type: 'attempt', id: attemptId }, 'subagent', {
    attemptId, outcome: 'succeeded', endedAt: TERMINAL_OCCURRED_AT, summary: 'Synthetic terminal work succeeded',
    evidenceRefs: [completionEvidenceId],
  }, { task: true }));

  const completion = (actorKind) => draft('task.completed', { type: 'task', id: taskId }, actorKind, {
    attemptId, criterionEvidenceRefs: [completionEvidenceId],
  }, { task: true });
  if (targetEvent === 'task.completed') return completion;

  append(completion('coordinator'));
  append(draft('evidence.recorded', { type: 'goal', id: goalId }, 'user', {
    evidence: {
      evidenceId: acceptanceEvidenceId, kind: 'user_message', subjectId: goalId,
      scope: 'Exact user goal acceptance', locator: 'user-message-terminal-acceptance',
      observedAt: TERMINAL_OCCURRED_AT, verifier: { kind: 'user', id: 'actor-user' },
      method: 'Synthetic user-authored acceptance', outcome: 'observed',
      policy: { kind: 'immutable_until_superseded' }, sourceRefs: [], sensitivity: 'internal',
    },
  }));
  append(draft('feedback.satisfied', { type: 'goal', id: goalId }, 'user', {
    feedback: {
      feedbackId: acceptanceFeedbackId, subjectId: goalId, disposition: 'satisfied',
      acceptanceEffect: 'accept', statement: 'The user accepts the exact synthetic goal result',
      evidenceRef: acceptanceEvidenceId,
    },
  }, { evidenceRefs: [acceptanceEvidenceId] }));
  return (actorKind) => draft('goal.achieved', { type: 'goal', id: goalId }, actorKind, {
    criterionEvidenceRefs: [completionEvidenceId], acceptanceFeedbackId,
  });
}

async function invokeMain(root, args, injected = {}) {
  let stdout = ''; let stderr = '';
  const status = await main(['--root', root, ...args], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    ...injected,
  });
  return { status, stdout, stderr };
}

function fakeHandler(calls, status) {
  return (context, args) => {
    calls.push({ operation: context.operation, options: context.options, args: [...args] });
    return status;
  };
}

function snapshotTree(root, { omitRootEntries = [] } = {}) {
  if (!existsSync(root)) return [];
  if (!omitRootEntries.includes('.git') && existsSync(path.join(root, '.git'))) {
    throw new Error('raw snapshot of a Git repository root is forbidden; use semantic repository truth');
  }
  const records = [];
  const omitted = new Set(omitRootEntries);
  const visit = (directory, prefix = '') => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      if (!prefix && omitted.has(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        records.push([relative, 'directory']);
        visit(absolute, relative);
      } else if (entry.isFile()) {
        records.push([relative, 'file', readFileSync(absolute).toString('base64')]);
      } else {
        const details = lstatSync(absolute);
        records.push([relative, 'other', details.mode, details.size]);
      }
    }
  };
  visit(root);
  return records;
}

function snapshotTreeIdentities(root, { omitRootEntries = [] } = {}) {
  if (!existsSync(root)) return [];
  if (!omitRootEntries.includes('.git') && existsSync(path.join(root, '.git'))) {
    throw new Error('raw identity snapshot of a Git repository root is forbidden; use semantic repository truth');
  }
  const records = [];
  const omitted = new Set(omitRootEntries);
  const visit = (directory, prefix = '') => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      if (!prefix && omitted.has(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const details = lstatSync(absolute, { bigint: true });
      // Directory link counts and allocated sizes are filesystem bookkeeping, not
      // stable object identity: APFS can retain changed values after transient
      // entries. Preserve the stable directory inode/type/mode while retaining the
      // full identity tuple for files, symlinks, and other non-directory entries.
      if (details.isDirectory()) {
        records.push([relative, 'directory', details.dev, details.ino, details.mode]);
      } else {
        const kind = details.isFile() ? 'file' : details.isSymbolicLink() ? 'symlink' : 'other';
        records.push([
          relative, kind, details.dev, details.ino, details.nlink, details.mode, details.size,
          ...(kind === 'symlink' ? [readlinkSync(absolute)] : []),
        ]);
      }
      if (details.isDirectory()) visit(absolute, relative);
    }
  };
  visit(root);
  return records;
}

function readGitSemanticState(root, args, { allowMissing = false } = {}) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: null,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || (result.status !== 0 && !(allowMissing && result.status === 1))) {
    throw new Error(`unable to read semantic Git state: git ${args.join(' ')}`);
  }
  return result.status === 0 ? result.stdout.toString('base64') : null;
}

function snapshotRepositoryTruth(root) {
  // Git maintenance locks, index stat-cache refreshes, and pack representation are
  // administrative implementation details. The no-effect contract concerns the
  // exact worktree/store plus semantic Git truth: HEAD, symbolic HEAD, refs, staged
  // entries, and index flags. Read-only Git observations disable optional locks.
  return {
    worktreeBytes: snapshotTree(root, { omitRootEntries: ['.git'] }),
    worktreeIdentities: snapshotTreeIdentities(root, { omitRootEntries: ['.git'] }),
    head: readGitSemanticState(root, ['rev-parse', '--verify', 'HEAD']),
    symbolicHead: readGitSemanticState(root, ['symbolic-ref', '-q', 'HEAD'], { allowMissing: true }),
    refs: readGitSemanticState(root, [
      'for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)',
    ]),
    indexEntries: readGitSemanticState(root, ['ls-files', '--stage', '-z']),
    indexFlags: readGitSemanticState(root, ['ls-files', '-v', '-z']),
  };
}

function runGitFixture(root, args) {
  execFileSync('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function assertRepositoryTruthFingerprint(makeRoot) {
  const root = makeRoot('integration-repository-truth-fingerprint');
  const readme = path.join(root, 'README.md');
  const readmeBytes = readFileSync(readme);
  assert.throws(
    () => snapshotTree(root),
    /raw snapshot of a Git repository root is forbidden/,
    'repository-root byte snapshots bypassed semantic Git truth',
  );
  assert.throws(
    () => snapshotTreeIdentities(root),
    /raw identity snapshot of a Git repository root is forbidden/,
    'repository-root identity snapshots bypassed semantic Git truth',
  );
  const baseline = snapshotRepositoryTruth(root);

  // Use a unique administrative probe instead of contending with a real Git
  // maintenance process for its well-known lock pathname.
  const adminProbe = path.join(root, '.git', 'objects', 'continuity-semantic-probe.lock');
  writeFileSync(adminProbe, 'synthetic transient Git-admin representation\n', { flag: 'wx' });
  assert.deepEqual(
    snapshotRepositoryTruth(root), baseline,
    'transient Git-admin representation changed semantic repository truth',
  );
  unlinkSync(adminProbe);

  writeFileSync(readme, '# Worktree mutation control\n');
  assert.notDeepEqual(snapshotRepositoryTruth(root), baseline, 'worktree mutation escaped semantic repository truth');
  writeFileSync(readme, readmeBytes);
  assert.deepEqual(snapshotRepositoryTruth(root), baseline, 'worktree mutation control did not restore the baseline');

  writeFileSync(readme, '# Staged index mutation control\n');
  runGitFixture(root, ['add', '--', 'README.md']);
  writeFileSync(readme, readmeBytes);
  assert.notDeepEqual(snapshotRepositoryTruth(root), baseline, 'staged index mutation escaped semantic repository truth');
  runGitFixture(root, ['reset', '-q', 'HEAD', '--', 'README.md']);
  assert.deepEqual(snapshotRepositoryTruth(root), baseline, 'staged mutation control did not restore the baseline');

  runGitFixture(root, ['update-index', '--assume-unchanged', 'README.md']);
  assert.notDeepEqual(snapshotRepositoryTruth(root), baseline, 'index flag mutation escaped semantic repository truth');
  runGitFixture(root, ['update-index', '--no-assume-unchanged', 'README.md']);
  assert.deepEqual(snapshotRepositoryTruth(root), baseline, 'index flag control did not restore the baseline');

  runGitFixture(root, ['branch', 'semantic-fingerprint-probe']);
  assert.notDeepEqual(snapshotRepositoryTruth(root), baseline, 'ref mutation escaped semantic repository truth');
  runGitFixture(root, ['branch', '-D', 'semantic-fingerprint-probe']);
  assert.deepEqual(snapshotRepositoryTruth(root), baseline, 'ref mutation control did not restore the baseline');

  const store = path.join(root, '.continuity');
  const storeFile = path.join(store, 'sentinel.txt');
  mkdirSync(store);
  writeFileSync(storeFile, 'strict store bytes\n');
  const storeBaseline = snapshotRepositoryTruth(root);
  writeFileSync(storeFile, 'changed store bytes\n');
  assert.notDeepEqual(snapshotRepositoryTruth(root), storeBaseline, 'store byte mutation escaped semantic repository truth');
  writeFileSync(storeFile, 'strict store bytes\n');
  const replacement = `${storeFile}.replacement`;
  const displaced = `${storeFile}.displaced`;
  writeFileSync(replacement, 'strict store bytes\n', { flag: 'wx' });
  renameSync(storeFile, displaced);
  renameSync(replacement, storeFile);
  unlinkSync(displaced);
  assert.notDeepEqual(
    snapshotRepositoryTruth(root), storeBaseline,
    'byte-equivalent store identity replacement escaped semantic repository truth',
  );
}

export function runRepositoryTruthFingerprint() {
  const roots = [];
  const makeRoot = (label) => { const root = makeRepository(label); roots.push(root); return root; };
  try {
    assertRepositoryTruthFingerprint(makeRoot);
    assertPreOpenOwnedReadBoundary(makeRoot);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

function assertSemanticTreeIdentityFingerprint(makeRoot) {
  const root = makeRoot('integration-semantic-tree-identity-fingerprint');
  const fixture = path.join(root, 'identity-fixture');
  const firstTarget = path.join(fixture, 'target-a');
  const secondTarget = path.join(fixture, 'target-b');
  const stableFile = path.join(fixture, 'stable.txt');
  const linkedDirectory = path.join(fixture, 'linked-directory');
  mkdirSync(firstTarget, { recursive: true });
  mkdirSync(secondTarget);
  writeFileSync(stableFile, 'stable identity bytes\n');
  symlinkSync(firstTarget, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');

  const relative = (file) => path.relative(fixture, file).split(path.sep).join('/');
  const findIdentity = (snapshot, file) => snapshot.find(([entry]) => entry === relative(file));
  const beforeBytes = snapshotTree(fixture);
  const beforeIdentities = snapshotTreeIdentities(fixture);
  const directoryIdentity = findIdentity(beforeIdentities, firstTarget);
  const fileIdentity = findIdentity(beforeIdentities, stableFile);
  const linkIdentity = findIdentity(beforeIdentities, linkedDirectory);
  assert.equal(directoryIdentity?.[1], 'directory', 'semantic fingerprint lost the directory type');
  assert.equal(directoryIdentity?.length, 5, 'semantic fingerprint retained mutable directory bookkeeping');
  assert.equal(fileIdentity?.[1], 'file', 'semantic fingerprint lost the regular-file type');
  assert.equal(fileIdentity?.length, 7, 'semantic fingerprint lost regular-file identity fields');
  assert.equal(linkIdentity?.[1], 'symlink', 'semantic fingerprint lost the symlink type');
  assert.equal(linkIdentity?.length, 8, 'semantic fingerprint lost symlink identity fields or target');
  assert.equal(linkIdentity?.at(-1), readlinkSync(linkedDirectory), 'semantic fingerprint recorded the wrong symlink target');

  const replacement = `${stableFile}.replacement`;
  const displaced = `${stableFile}.displaced`;
  writeFileSync(replacement, readFileSync(stableFile), { flag: 'wx' });
  renameSync(stableFile, displaced);
  renameSync(replacement, stableFile);
  unlinkSync(displaced);
  assert.deepEqual(snapshotTree(fixture), beforeBytes, 'byte-equivalent file replacement changed the byte snapshot');
  const replacedIdentities = snapshotTreeIdentities(fixture);
  const replacedFileIdentity = findIdentity(replacedIdentities, stableFile);
  assert.equal(
    replacedFileIdentity[2] === fileIdentity[2] && replacedFileIdentity[3] === fileIdentity[3],
    false,
    'byte-equivalent file replacement escaped the semantic identity fingerprint',
  );

  unlinkSync(linkedDirectory);
  symlinkSync(secondTarget, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  const retargetedLinkIdentity = findIdentity(snapshotTreeIdentities(fixture), linkedDirectory);
  assert.notEqual(
    retargetedLinkIdentity.at(-1),
    linkIdentity.at(-1),
    'same-length symlink retarget escaped the semantic identity fingerprint',
  );
}

export function runSemanticTreeIdentityFingerprint() {
  const roots = [];
  const makeRoot = (label) => { const root = makeRepository(label); roots.push(root); return root; };
  try {
    assertSemanticTreeIdentityFingerprint(makeRoot);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

function sameIdentity(actual, expected, label) {
  assert.equal(actual.dev, expected.dev, `${label} device changed`);
  assert.equal(actual.ino, expected.ino, `${label} identity changed`);
}

function observeLockOpen(topology, action) {
  const originalOpenSync = fs.openSync;
  let lockMaterializations = 0;
  let result;
  let error;
  fs.openSync = function observedOpenSync(file, ...args) {
    if (typeof file === 'string' && path.normalize(file) === path.normalize(topology.lock)) {
      lockMaterializations += 1;
    }
    return Reflect.apply(originalOpenSync, fs, [file, ...args]);
  };
  syncBuiltinESMExports();
  try {
    result = action();
  } catch (caught) {
    error = caught;
  } finally {
    fs.openSync = originalOpenSync;
    syncBuiltinESMExports();
  }
  return { error, lockMaterializations, result };
}

function assertTerminalActorAppendPreflight(makeRoot) {
  const rows = [
    {
      eventType: 'goal.achieved', allowedActor: 'user', forbiddenActors: ['subagent', 'tool', 'migration'],
      message: 'goal.achieved requires user or coordinator actor',
    },
    {
      eventType: 'task.completed', allowedActor: 'coordinator', forbiddenActors: ['user', 'subagent', 'tool', 'migration'],
      message: 'task.completed requires coordinator actor',
    },
  ];

  for (const row of rows) {
    for (const actorKind of row.forbiddenActors) {
      const root = makeRoot(`integration-terminal-actor-${row.eventType.split('.')[0]}-${actorKind}`);
      const makeDraft = prepareTerminalActorAppend(root, row.eventType);
      const validCompanion = makeDraft(row.allowedActor);
      assert.doesNotThrow(
        () => validateV2Append(root, validCompanion),
        `${row.eventType} ${actorKind} fixture is not otherwise state-valid`,
      );
      const topology = gitAdminTopology(root);
      const rootBefore = snapshotRepositoryTruth(root);
      assert.equal(existsSync(topology.lock), false, `${row.eventType} ${actorKind} fixture began with lock residue`);

      const originalOpenSync = fs.openSync;
      let lockMaterializations = 0;
      fs.openSync = function observedOpenSync(file, ...args) {
        if (typeof file === 'string' && path.normalize(file) === path.normalize(topology.lock)) {
          lockMaterializations += 1;
        }
        return Reflect.apply(originalOpenSync, fs, [file, ...args]);
      };
      syncBuiltinESMExports();
      try {
        assert.throws(
          () => appendV2(root, makeDraft(actorKind)),
          (error) => error instanceof MemoryError && error.exitCode === 2 && error.message === row.message,
          `${row.eventType} accepted forbidden ${actorKind} actor`,
        );
      } finally {
        fs.openSync = originalOpenSync;
        syncBuiltinESMExports();
      }

      assert.equal(lockMaterializations, 0, `${row.eventType} ${actorKind} materialized the Git-admin lock`);
      assert.equal(existsSync(topology.lock), false, `${row.eventType} ${actorKind} left Git-admin lock residue`);
      assert.deepEqual(
        snapshotRepositoryTruth(root), rootBefore,
        `${row.eventType} ${actorKind} changed semantic repository truth`,
      );
    }
  }
  assert.deepEqual(
    TERMINAL_ACTOR_KINDS,
    ['user', 'coordinator', 'subagent', 'tool', 'migration'],
    'terminal actor fixture lost a contract actor kind',
  );
}

export function runTerminalActorAppendMatrix() {
  const roots = [];
  const makeRoot = (label) => { const root = makeRepository(label); roots.push(root); return root; };
  try {
    assertTerminalActorAppendPreflight(makeRoot);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

function assertD19PublicAppendSnapshot(makeRoot) {
  const forbiddenRoot = makeRoot('integration-d19-append-forbidden-snapshot');
  const forbiddenDraft = prepareTerminalActorAppend(forbiddenRoot, 'goal.achieved');
  const forbidden = accessorBackedSnapshot(forbiddenDraft('tool'), {
    actor: { first: terminalActor('tool'), later: terminalActor('user') },
  });
  const forbiddenDescriptor = Object.getOwnPropertyDescriptor(forbidden.value, 'actor');
  const forbiddenTopology = gitAdminTopology(forbiddenRoot);
  const forbiddenBefore = snapshotRepositoryTruth(forbiddenRoot);
  const forbiddenAttempt = observeLockOpen(forbiddenTopology, () => appendV2(forbiddenRoot, forbidden.value));
  assert.equal(
    forbiddenAttempt.lockMaterializations,
    0,
    'captured forbidden actor crossed the Git-admin lock before rejection',
  );
  assert.ok(
    forbiddenAttempt.error instanceof MemoryError
      && forbiddenAttempt.error.exitCode === 2
      && forbiddenAttempt.error.message === 'goal.achieved requires user or coordinator actor',
    `captured forbidden actor did not return the exact authority error: ${forbiddenAttempt.error?.message ?? 'append succeeded'}`,
  );
  assert.equal(forbidden.observations.actor.reads(), 1, 'appendV2 reread a forbidden caller-owned actor after snapshot');
  assert.strictEqual(
    Object.getOwnPropertyDescriptor(forbidden.value, 'actor').get,
    forbiddenDescriptor.get,
    'appendV2 replaced the forbidden caller-owned actor accessor',
  );
  assert.equal(existsSync(forbiddenTopology.lock), false, 'forbidden snapshot left Git-admin lock residue');
  assert.deepEqual(
    snapshotRepositoryTruth(forbiddenRoot), forbiddenBefore,
    'forbidden snapshot changed semantic repository truth',
  );

  const allowedRoot = makeRoot('integration-d19-append-allowed-snapshot');
  const allowedDraft = prepareTerminalActorAppend(allowedRoot, 'goal.achieved');
  const allowed = accessorBackedSnapshot(allowedDraft('user'), {
    actor: { first: terminalActor('user'), later: terminalActor('tool') },
  });
  const allowedDescriptor = Object.getOwnPropertyDescriptor(allowed.value, 'actor');
  const receipt = appendV2(allowedRoot, allowed.value);
  const stored = readV2Journal(allowedRoot);
  const persisted = stored.events.at(-1);
  assert.equal(receipt.eventId, persisted.eventId, 'allowed snapshot receipt does not identify the persisted event');
  assert.equal(persisted.eventType, 'goal.achieved', 'allowed snapshot persisted the wrong event type');
  assert.equal(persisted.actor.kind, 'user', 'appendV2 persisted an actor outside the validated snapshot');
  assert.equal(allowed.observations.actor.reads(), 1, 'appendV2 reread an allowed caller-owned actor after snapshot');
  assert.strictEqual(
    Object.getOwnPropertyDescriptor(allowed.value, 'actor').get,
    allowedDescriptor.get,
    'appendV2 replaced the allowed caller-owned actor accessor',
  );
  assert.equal(existsSync(gitAdminTopology(allowedRoot).lock), false, 'allowed snapshot left Git-admin lock residue');
}

function assertD19MarkerAfterSnapshotBarrier(makeRoot) {
  const root = makeRoot('integration-d19-marker-after-snapshot');
  const makeDraft = prepareTerminalActorAppend(root, 'goal.achieved');
  const files = storePaths(root);
  const topology = gitAdminTopology(root);
  const historyBefore = readFileSync(files.history);
  const historyIdentity = lstatSync(files.history, { bigint: true });
  const currentBefore = readFileSync(files.current);
  const currentIdentity = lstatSync(files.current, { bigint: true });
  const markerBytes = Buffer.from(`${JSON.stringify(preparedMigrationMarker())}\n`);
  let afterMarker;
  const changing = accessorBackedSnapshot(makeDraft('user'), {
    actor: {
      first: terminalActor('user'),
      later: terminalActor('user'),
      onFirstRead: () => {
        writeFileSync(files.migrationMarker, markerBytes);
        afterMarker = {
          markerIdentity: lstatSync(files.migrationMarker, { bigint: true }),
          repositoryTruth: snapshotRepositoryTruth(root),
        };
      },
    },
  });
  assert.equal(existsSync(files.migrationMarker), false, 'marker-after-snapshot fixture began blocked');
  const attempt = observeLockOpen(topology, () => appendV2(root, changing.value));
  assert.ok(afterMarker, 'caller snapshot did not create the prepared migration marker');
  assert.equal(attempt.lockMaterializations, 0, 'snapshot-created marker was not rejected before Git lock acquisition');
  assert.ok(
    attempt.error instanceof MemoryError
      && attempt.error.exitCode === 3
      && attempt.error.message === 'continuity mutation is blocked by interrupted migration',
    `snapshot-created marker did not return the exact barrier error: ${attempt.error?.message ?? 'append succeeded'}`,
  );
  assert.equal(changing.observations.actor.reads(), 1, 'marker race reread the caller-owned actor after snapshot');
  assert.deepEqual(readFileSync(files.migrationMarker), markerBytes, 'snapshot-created prepared marker was not retained');
  sameIdentity(lstatSync(files.migrationMarker, { bigint: true }), afterMarker.markerIdentity, 'prepared migration marker');
  assert.deepEqual(readFileSync(files.history), historyBefore, 'marker race changed HISTORY bytes');
  sameIdentity(lstatSync(files.history, { bigint: true }), historyIdentity, 'marker race HISTORY');
  assert.deepEqual(readFileSync(files.current), currentBefore, 'marker race changed CURRENT bytes');
  sameIdentity(lstatSync(files.current, { bigint: true }), currentIdentity, 'marker race CURRENT');
  assert.deepEqual(
    snapshotRepositoryTruth(root), afterMarker.repositoryTruth,
    'marker race changed semantic repository truth after marker creation',
  );
  assert.equal(existsSync(topology.lock), false, 'marker race left Git-admin lock residue');
}

function hostileDraftObserver() {
  const traps = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0 };
  const target = Object.create(null);
  const value = new Proxy(target, {
    get(object, property, receiver) {
      traps.get += 1;
      return Reflect.get(object, property, receiver);
    },
    ownKeys(object) {
      traps.ownKeys += 1;
      return Reflect.ownKeys(object);
    },
    getOwnPropertyDescriptor(object, property) {
      traps.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(object, property);
    },
    getPrototypeOf(object) {
      traps.getPrototypeOf += 1;
      return Reflect.getPrototypeOf(object);
    },
  });
  return { traps, value };
}

function assertD19MalformedRootPreflight(makeRoot) {
  const rows = [];

  const codexFileRoot = makeRoot('integration-d19-malformed-continuity-file');
  writeFileSync(path.join(codexFileRoot, '.continuity'), 'not a directory\n');
  rows.push({
    label: '.continuity file',
    root: codexFileRoot,
    message: 'continuity directory component is invalid',
    outside: [],
  });

  const storeFileRoot = makeRoot('integration-d19-malformed-store-file');
  writeFileSync(path.join(storeFileRoot, '.continuity'), 'not a directory\n');
  rows.push({
    label: 'continuity component file',
    root: storeFileRoot,
    message: 'continuity directory component is invalid',
    outside: [],
  });

  const junctionRoot = makeRoot('integration-d19-malformed-junction');
  const junctionOutside = makeRoot('integration-d19-malformed-junction-outside');
  writeFileSync(path.join(junctionOutside, 'outside-sentinel.txt'), 'outside bytes must remain unchanged\n');
  try {
    symlinkSync(junctionOutside, path.join(junctionRoot, '.continuity'), process.platform === 'win32' ? 'junction' : 'dir');
    rows.push({
      label: '.continuity junction',
      root: junctionRoot,
      message: 'continuity path must not use links or reparse points',
      outside: [junctionOutside],
    });
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) throw error;
  }

  for (const row of rows) {
    const observer = hostileDraftObserver();
    const topology = gitAdminTopology(row.root);
    const rootBefore = snapshotRepositoryTruth(row.root);
    const outsideBefore = row.outside.map((directory) => ({
      directory,
      truth: snapshotRepositoryTruth(directory),
    }));
    assert.throws(
      () => appendV2(row.root, observer.value),
      (error) => error instanceof MemoryError && error.exitCode === 3 && error.message === row.message,
      `${row.label} did not fail at the exact generic root boundary`,
    );
    assert.deepEqual(
      observer.traps,
      { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0 },
      `${row.label} inspected caller draft before malformed-root rejection`,
    );
    assert.deepEqual(
      snapshotRepositoryTruth(row.root), rootBefore,
      `${row.label} changed semantic project truth`,
    );
    for (const before of outsideBefore) {
      assert.deepEqual(
        snapshotRepositoryTruth(before.directory), before.truth,
        `${row.label} changed outside repository truth`,
      );
    }
  }
}

export function runD19AppendSnapshotMatrix() {
  const roots = [];
  const makeRoot = (label) => { const root = makeRepository(label); roots.push(root); return root; };
  try {
    assertD19PublicAppendSnapshot(makeRoot);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

export function runD19MarkerOrderingMatrix() {
  const roots = [];
  const makeRoot = (label) => { const root = makeRepository(label); roots.push(root); return root; };
  try {
    assertD19MarkerAfterSnapshotBarrier(makeRoot);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

export function runD19MalformedRootMatrix() {
  const roots = [];
  const makeRoot = (label) => { const root = makeRepository(label); roots.push(root); return root; };
  try {
    assertD19MalformedRootPreflight(makeRoot);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

function assertPreOpenOwnedReadBoundary(makeRoot) {
  const root = makeRoot('integration-pre-open-owned-read-boundary');
  const label = 'synthetic bounded target';
  const regular = path.join(root, 'regular.txt');
  writeFileSync(regular, 'bounded regular bytes\n');
  let before = snapshotRepositoryTruth(root);
  assert.deepEqual(readOwnedFileBounded(regular, 64, label), Buffer.from('bounded regular bytes\n'));
  assert.deepEqual(snapshotRepositoryTruth(root), before, 'bounded regular read changed semantic repository truth');

  const assertPreOpenReject = (target, kind) => {
    before = snapshotRepositoryTruth(root);
    assert.throws(
      () => readOwnedFileBounded(target, 64, label),
      (error) => error instanceof MemoryError
        && error.exitCode === 3
        && error.message === `${label} must be a regular file with exactly one hard link`,
      `${kind} did not fail at the pre-open type/link boundary`,
    );
    assert.deepEqual(snapshotRepositoryTruth(root), before, `${kind} rejection changed semantic repository truth`);
  };

  const directory = path.join(root, 'directory-target');
  mkdirSync(directory);
  writeFileSync(path.join(directory, 'sentinel.txt'), 'directory sentinel\n');
  assertPreOpenReject(directory, 'directory target');

  const hardLink = path.join(root, 'regular-hardlink.txt');
  linkSync(regular, hardLink);
  assertPreOpenReject(regular, 'multiply-linked regular target');
  assertPreOpenReject(hardLink, 'hard-link alias');

  const symbolic = path.join(root, 'symbolic-target.txt');
  try {
    symlinkSync(regular, symbolic, 'file');
    assertPreOpenReject(symbolic, 'symbolic-link target');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) throw error;
  }

  const junction = path.join(root, 'junction-target');
  try {
    symlinkSync(directory, junction, 'junction');
    assertPreOpenReject(junction, 'junction target');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) throw error;
  }
}

function waitForChildExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForBarrierReady(child, ready, stderr) {
  const deadline = Date.now() + 15_000;
  while (!existsSync(ready)) {
    if (child.exitCode !== null) throw new Error(`race helper exited before READY: ${stderr()}`);
    if (Date.now() >= deadline) throw new Error(`race helper did not reach synchronized barrier: ${stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Source-only instrumentation for spawned test children: production modules never
// see this preload. It records completed target renames and can make any descent
// below a synchronized disposable directory mutation-sensitive.
const raceTracePreload = `data:text/javascript,${encodeURIComponent(String.raw`
  import fs from 'node:fs';
  import path from 'node:path';
  import { syncBuiltinESMExports } from 'node:module';
  const originalAppendFileSync = fs.appendFileSync;
  const originalOpendirSync = fs.opendirSync;
  const originalReadFileSync = fs.readFileSync;
  const originalReaddirSync = fs.readdirSync;
  const originalRenameSync = fs.renameSync;
  const canonicalPath = (value) => {
    const resolved = path.resolve(String(value));
    const canonical = path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved));
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  };
  fs.renameSync = (...args) => {
    const target = process.env.PROJECT_MEMORY_TEST_RENAME_TARGET;
    const trace = process.env.PROJECT_MEMORY_TEST_RENAME_TRACE;
    let tracesTarget = false;
    if (process.env.NODE_ENV === 'test' && target && trace) {
      try { tracesTarget = canonicalPath(args[1]) === canonicalPath(target); } catch {}
    }
    const result = originalRenameSync(...args);
    if (tracesTarget) originalAppendFileSync(trace, 'renamed\n', 'utf8');
    return result;
  };
  const normalizedPath = (value) => {
    const resolved = path.resolve(String(value));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const guardDescent = (value) => {
    const rootFile = process.env.PROJECT_MEMORY_TEST_DESCENT_ROOT_FILE;
    const trace = process.env.PROJECT_MEMORY_TEST_DESCENT_TRACE;
    const control = process.env.PROJECT_MEMORY_TEST_DESCENT_CONTROL;
    if (process.env.NODE_ENV !== 'test' || !rootFile || !trace || !control || !fs.existsSync(rootFile)) return;
    const root = normalizedPath(originalReadFileSync(rootFile, 'utf8').trim());
    const candidate = normalizedPath(value);
    originalAppendFileSync(control, 'directory-inspection-observed\n', 'utf8');
    const relative = path.relative(root, candidate);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      originalAppendFileSync(trace, 'descended\n', 'utf8');
      throw new Error('test observed forbidden temporary-directory descent');
    }
  };
  fs.opendirSync = (value, ...args) => {
    guardDescent(value);
    return originalOpendirSync(value, ...args);
  };
  fs.readdirSync = (value, ...args) => {
    guardDescent(value);
    return originalReaddirSync(value, ...args);
  };
  syncBuiltinESMExports();
`)}`;

async function runBarrierRace({
  point, command, args, env = {}, observeRenameTarget, forbidDirectoryDescent = false, mutate,
}) {
  const barrier = mkdtempSync(path.join(os.tmpdir(), 'project-memory-integration-race-'));
  const ready = path.join(barrier, 'ready.json');
  const release = path.join(barrier, 'release');
  const renameTrace = path.join(barrier, 'rename-trace.txt');
  const descentRootFile = path.join(barrier, 'descent-root.txt');
  const descentTrace = path.join(barrier, 'descent-trace.txt');
  const descentControl = path.join(barrier, 'descent-control.txt');
  const usePreload = Boolean(observeRenameTarget || forbidDirectoryDescent);
  let child;
  let stdout = '';
  let stderr = '';
  try {
    child = spawn(command, usePreload ? ['--import', raceTracePreload, ...args] : args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PROJECT_MEMORY_TEST_BARRIER_POINT: point,
        PROJECT_MEMORY_TEST_BARRIER_DIR: barrier,
        ...(observeRenameTarget ? {
          PROJECT_MEMORY_TEST_RENAME_TARGET: observeRenameTarget,
          PROJECT_MEMORY_TEST_RENAME_TRACE: renameTrace,
        } : {}),
        ...(forbidDirectoryDescent ? {
          PROJECT_MEMORY_TEST_DESCENT_ROOT_FILE: descentRootFile,
          PROJECT_MEMORY_TEST_DESCENT_TRACE: descentTrace,
          PROJECT_MEMORY_TEST_DESCENT_CONTROL: descentControl,
        } : {}),
        ...env,
      },
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = waitForChildExit(child);
    await waitForBarrierReady(child, ready, () => stderr);
    const details = JSON.parse(readFileSync(ready, 'utf8'));
    if (forbidDirectoryDescent) writeFileSync(descentRootFile, `${details.target}\n`, { flag: 'wx' });
    await mutate(details);
    writeFileSync(release, 'release\n', { flag: 'wx' });
    let exitTimer;
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => { exitTimer = setTimeout(() => reject(new Error('race helper did not exit after RELEASE')), 15_000); }),
    ]).finally(() => clearTimeout(exitTimer));
    const renameTraceCount = existsSync(renameTrace)
      ? readFileSync(renameTrace, 'utf8').split('\n').filter(Boolean).length
      : 0;
    const descentTraceCount = existsSync(descentTrace)
      ? readFileSync(descentTrace, 'utf8').split('\n').filter(Boolean).length
      : 0;
    const descentControlCount = existsSync(descentControl)
      ? readFileSync(descentControl, 'utf8').split('\n').filter(Boolean).length
      : 0;
    return {
      ...result, stdout, stderr, details, renameTraceCount, descentTraceCount, descentControlCount,
    };
  } finally {
    if (child && child.exitCode === null) child.kill();
    rmSync(barrier, { recursive: true, force: true });
  }
}

const journalChildScript = String.raw`
  const [moduleUrl, operation, root, inputFile] = process.argv.slice(1);
  const module = await import(moduleUrl);
  const { readFileSync } = await import('node:fs');
  try {
    const input = inputFile ? JSON.parse(readFileSync(inputFile, 'utf8')) : undefined;
    if (operation === 'initialize') module.initializeV2(root, input);
    else if (operation === 'append') module.appendV2(root, input);
    else if (operation === 'rebuild') module.rebuildProjection(root);
    else throw new Error('unknown child operation');
  } catch (error) {
    process.stderr.write(String(error && error.message || 'child failure') + '\n');
    process.exitCode = Number.isInteger(error && error.exitCode) ? error.exitCode : 1;
  }
`;

function journalChildArgs(operation, root, inputFile) {
  return ['--input-type=module', '-e', journalChildScript, journalModuleUrl, operation, root, inputFile ?? ''];
}

async function assertD20RetainedInLockMarkerRace(makeRoot) {
  const root = makeRoot('integration-d20-retained-in-lock-marker');
  const input = initInput('d20-retained-in-lock-marker');
  initializeV2(root, input, { clock: () => new Date(TERMINAL_OCCURRED_AT) });
  const files = storePaths(root);
  const topology = gitAdminTopology(root);
  const missingGoalId = 'goal-integration-d20-missing';
  const invalidDraft = taskDraft('d20-retained-in-lock-marker', input);
  invalidDraft.goalId = missingGoalId;
  invalidDraft.payload.task.goalId = missingGoalId;
  const draftFile = path.join(root, 'd20-retained-in-lock-marker-draft.json');
  writeFileSync(draftFile, `${JSON.stringify(invalidDraft)}\n`);

  const historyBefore = readFileSync(files.history);
  const historyIdentity = lstatSync(files.history, { bigint: true });
  const currentBefore = readFileSync(files.current);
  const currentIdentity = lstatSync(files.current, { bigint: true });
  const markerBytes = Buffer.from(`${JSON.stringify(preparedMigrationMarker())}\n`);
  let markerIdentity;
  let afterMarkerTruth;

  const race = await runBarrierRace({
    point: 'journal-append-after-lock',
    command: process.execPath,
    args: journalChildArgs('append', root, draftFile),
    mutate: (details) => {
      assert.deepEqual(
        Object.keys(details).sort(),
        ['lock', 'point'],
        'post-lock barrier exposed an unexpected payload contract',
      );
      assert.equal(details.point, 'journal-append-after-lock', 'append reached the wrong race phase');
      assert.equal(
        path.normalize(details.lock),
        path.normalize(topology.lock),
        'post-lock barrier did not identify the exact Git-admin lock',
      );
      assert.equal(existsSync(files.migrationMarker), false, 'post-lock fixture began with a migration marker');
      const lockDetails = lstatSync(details.lock, { bigint: true });
      assert.equal(lockDetails.isFile(), true, 'post-lock barrier lock is not a regular file');
      assert.equal(lockDetails.isSymbolicLink(), false, 'post-lock barrier lock is a symbolic link');
      assert.equal(lockDetails.nlink, 1n, 'post-lock barrier lock does not have exactly one hard link');
      const lockMetadata = JSON.parse(readFileSync(details.lock, 'utf8'));
      assert.deepEqual(Object.keys(lockMetadata).sort(), ['acquiredAt', 'pid'], 'lock metadata shape changed');
      assert.equal(Number.isInteger(lockMetadata.pid) && lockMetadata.pid > 0, true, 'lock metadata pid is invalid');
      assert.equal(
        new Date(lockMetadata.acquiredAt).toISOString(),
        lockMetadata.acquiredAt,
        'lock metadata acquiredAt is not an exact ISO timestamp',
      );
      assert.deepEqual(readFileSync(files.history), historyBefore, 'append changed HISTORY before the in-lock marker phase');
      sameIdentity(lstatSync(files.history, { bigint: true }), historyIdentity, 'pre-marker HISTORY');
      assert.deepEqual(readFileSync(files.current), currentBefore, 'append changed CURRENT before the in-lock marker phase');
      sameIdentity(lstatSync(files.current, { bigint: true }), currentIdentity, 'pre-marker CURRENT');
      writeFileSync(files.migrationMarker, markerBytes, { flag: 'wx', mode: 0o600 });
      markerIdentity = lstatSync(files.migrationMarker, { bigint: true });
      afterMarkerTruth = snapshotRepositoryTruth(root);
    },
  });

  assert.equal(race.details.point, 'journal-append-after-lock', 'race result lost the exact post-lock phase');
  assert.equal(race.signal, null, `post-lock marker child was terminated by ${race.signal}`);
  assert.equal(race.code, 3, `post-lock marker append returned the wrong exit code\n${race.stderr}`);
  assert.equal(race.stdout, '', 'post-lock marker append wrote success output');
  assert.equal(
    race.stderr,
    'continuity mutation is blocked by interrupted migration\n',
    'post-lock marker append did not report the exact retained-barrier error',
  );
  assert.deepEqual(readFileSync(files.history), historyBefore, 'retained in-lock marker rejection changed HISTORY bytes');
  sameIdentity(lstatSync(files.history, { bigint: true }), historyIdentity, 'retained in-lock marker HISTORY');
  assert.deepEqual(readFileSync(files.current), currentBefore, 'retained in-lock marker rejection changed CURRENT bytes');
  sameIdentity(lstatSync(files.current, { bigint: true }), currentIdentity, 'retained in-lock marker CURRENT');
  assert.ok(markerIdentity, 'post-lock fixture did not create the prepared migration marker');
  assert.deepEqual(readFileSync(files.migrationMarker), markerBytes, 'retained prepared marker bytes changed');
  const retainedMarker = lstatSync(files.migrationMarker, { bigint: true });
  sameIdentity(retainedMarker, markerIdentity, 'retained prepared migration marker');
  assert.equal(retainedMarker.isFile(), true, 'retained prepared marker is not a regular file');
  assert.equal(retainedMarker.isSymbolicLink(), false, 'retained prepared marker is a symbolic link');
  assert.equal(retainedMarker.nlink, 1n, 'retained prepared marker does not have exactly one hard link');
  assert.equal(existsSync(topology.lock), false, 'retained in-lock rejection left Git-admin lock residue');
  const retiredPrefix = `${path.basename(topology.lock)}.retired-`;
  assert.deepEqual(
    readdirSync(path.dirname(topology.lock)).filter((name) => name.startsWith(retiredPrefix)),
    [],
    'retained in-lock rejection left a retired lock occupant',
  );
  assert.deepEqual(
    snapshotRepositoryTruth(root),
    afterMarkerTruth,
    'retained in-lock rejection changed semantic repository truth',
  );
}

export async function runD20RetainedInLockMarkerRace() {
  const roots = [];
  const makeRoot = (label) => { const root = makeRepository(label); roots.push(root); return root; };
  try {
    await assertD20RetainedInLockMarkerRace(makeRoot);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

function legacyCandidate(root, suffix) {
  const files = storePaths(root);
  const snapshot = JSON.parse(readFileSync(files.current, 'utf8'));
  snapshot.nextSteps = [...snapshot.nextSteps, `Deterministic ${suffix}`];
  const input = path.join(root, `${suffix}.snapshot.json`);
  writeFileSync(input, `${JSON.stringify(snapshot)}\n`);
  return input;
}

function poisonBag(key) {
  let reads = 0;
  const bag = {};
  Object.defineProperty(bag, key, {
    configurable: true,
    enumerable: false,
    get() { reads += 1; throw new Error('forbidden option getter was read'); },
  });
  return { bag, reads: () => reads };
}

function migratedEvents() {
  const events = [];
  const recordedAt = '2026-08-16T00:00:00.000Z';
  const workspaceAtRecord = {
    head: 'a'.repeat(40), branch: 'main', dirty: false,
    statusFingerprint: 'b'.repeat(64), fingerprintPartial: false, capturedAt: recordedAt,
  };
  const actor = { kind: 'migration', id: 'actor-migration', role: 'migration' };
  const add = (draft) => {
    const event = buildEnvelope(draft, {
      epochId: 'epoch-migration-seam', sequence: events.length + 1, recordedAt,
      workspaceAtRecord, previousEventHash: events.at(-1)?.eventHash ?? ZERO_HASH,
    });
    foldV2([...events, event]);
    events.push(event);
    return event;
  };
  add({
    eventType: 'project.initialized', occurredAt: recordedAt, actor,
    subject: { type: 'project', id: 'project-migration-seam' },
    supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal',
    payload: {
      project: {
        projectId: 'project-migration-seam', name: 'Migration seam', identity: 'Synthetic fixture',
        implementationBoundaries: ['Synthetic files only'], operatingRules: ['No network'],
      },
      initialization: 'migration',
    },
  });
  const receiptEvent = add({
    eventType: 'migration.v1_imported', occurredAt: recordedAt, actor,
    subject: { type: 'migration', id: 'migration-seam' },
    supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal',
    payload: {
      archiveHistory: 'HISTORY.v1.ndjson', historyBytes: 0,
      historySha256: 'c'.repeat(64), eventCount: 0, finalEventHash: 'd'.repeat(64),
      recordChunkCount: 0,
    },
  });
  return { events, receiptEvent };
}

function writeV2Journal(root, events) {
  const files = storePaths(root);
  mkdirSync(files.store, { recursive: true });
  writeFileSync(files.history, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  return files;
}

function inspectFixtures() {
  const timestamp = '2026-08-16T00:00:00.000Z';
  const workspace = (head, dirty) => ({
    head, branch: 'main', dirty, statusFingerprint: 'e'.repeat(64),
    fingerprintPartial: false, capturedAt: timestamp,
  });
  const minimum = {
    inspectVersion: 1,
    view: 'coordinator',
    generatedAt: timestamp,
    store: {
      schemaVersion: 2, epochId: 'epoch-inspect-seam', sequence: 1,
      eventHash: 'f'.repeat(64), journalState: 'valid', projectionState: 'current', partialTail: false,
    },
    project: {
      projectId: 'project-inspect-seam', name: 'Inspect seam', identity: 'Synthetic fixture',
      finalGoal: {
        goalId: 'goal-inspect-minimum', title: 'Minimum inspect goal', outcome: 'Exercise the coordinator branch',
        lifecycle: 'active', acceptance: 'pending', verification: 'not_run', freshness: 'unknown',
        criterionIds: [], failureIds: [], warningIds: [],
      },
    },
    criteria: [],
    boundaries: [],
    attention: { goalFailures: [], blocked: [], failed: [], verificationFailed: [], rejected: [], contested: [], stale: [] },
    tasks: [],
    nextActions: [],
    handoffs: [],
    feedback: [],
    evidenceSummary: [],
    workspaceDrift: {
      recorded: workspace('1'.repeat(40), false), current: workspace('1'.repeat(40), false),
      headDrift: false, statusDrift: false, fingerprintState: 'full',
    },
    sourceDrift: [],
    graphifyReceipts: [],
    legacy: [],
    warnings: [],
  };
  const evidence = {
    evidenceId: 'evidence-inspect-seam', kind: 'test', subjectId: 'task-inspect-seam',
    outcome: 'failed', observedAt: timestamp, freshness: 'stale', scope: 'Synthetic seam',
    limitation: 'Historical evidence only',
  };
  const criterion = {
    criterionId: 'criterion-inspect-seam', condition: 'The seam remains closed', scope: 'Synthetic fixture',
    lifecycle: 'active', verification: 'failed', freshness: 'stale', evidenceRefs: [evidence.evidenceId],
  };
  const task = {
    taskId: 'task-inspect-seam', title: 'Exercise structured inspect', scope: 'Synthetic fixture',
    owner: 'actor-coordinator', requiredForGoal: true, execution: 'blocked', verification: 'failed',
    acceptance: 'rejected', freshness: 'stale', currentAttemptId: 'attempt-inspect-seam',
    dependencyIds: [], criterionIds: [criterion.criterionId], nextAction: 'Revise the synthetic approach',
    warningIds: ['warning-inspect-seam'],
  };
  const taskSummary = {
    taskId: task.taskId, title: task.title, owner: task.owner, execution: task.execution,
    verification: task.verification, acceptance: task.acceptance, freshness: task.freshness,
    failureIds: ['failure-inspect-seam'], nextAction: task.nextAction,
  };
  const failure = {
    failureId: 'failure-inspect-seam', subject: { type: 'goal', id: 'goal-inspect-seam' },
    terminal: 'blocked', responsibleBoundary: 'External dependency', observedSymptom: 'Synthetic block observed',
    impact: 'The fixture cannot complete', unchanged: ['No production state changed'],
    rootCause: { state: 'hypothesis', summary: 'Synthetic root cause' }, lessonId: 'lesson-inspect-seam',
    nextAction: 'Verify the synthetic dependency', evidenceRefs: [evidence.evidenceId],
  };
  const handoff = {
    handoffId: 'handoff-inspect-seam', taskId: task.taskId, owner: 'actor-subagent', state: 'reported',
    criterionIds: [criterion.criterionId], reportOutcome: 'blocked', warningIds: ['warning-inspect-seam'],
  };
  const minimumReceipt = {
    receiptId: 'receipt-inspect-minimum', adapterVersion: 1, state: 'not_present',
    graphifyVersion: null, graphPath: 'graphify-out/graph.json', repositoryHead: 'unavailable',
    workspaceDirty: false, observedAt: timestamp, scope: 'Synthetic Graphify observation',
    limitations: ['Graph file is not present'],
  };
  const maximum = structuredClone(minimum);
  maximum.store.legacyArchiveState = 'valid';
  maximum.project.finalGoal = {
    goalId: 'goal-inspect-seam', title: 'Finish inspect seam', outcome: 'Expose truthful structured context',
    lifecycle: 'blocked', acceptance: 'pending', verification: 'failed', freshness: 'stale',
    criterionIds: [criterion.criterionId], failureIds: [failure.failureId],
    nextAction: 'Resolve the synthetic block', warningIds: ['warning-inspect-seam'],
  };
  maximum.criteria = [criterion];
  maximum.boundaries = ['Synthetic files only'];
  maximum.attention = {
    goalFailures: [failure], blocked: [taskSummary],
    failed: [{ ...taskSummary, execution: 'failed' }],
    verificationFailed: [taskSummary], rejected: [taskSummary],
    contested: [{
      contradictionId: 'contradiction-inspect-seam', claimKey: 'a'.repeat(64),
      claimIds: ['claim-inspect-left', 'claim-inspect-right'], state: 'contested', reason: 'Synthetic disagreement',
    }],
    stale: [evidence],
  };
  maximum.tasks = [task];
  maximum.nextActions = [{
    subjectId: task.taskId, action: task.nextAction, owner: task.owner, blockedByIds: ['dependency-inspect-seam'],
  }];
  maximum.handoffs = [handoff];
  maximum.feedback = [{
    feedbackId: 'feedback-inspect-seam', subjectId: task.taskId, disposition: 'dissatisfied',
    acceptanceEffect: 'reject', lifecycle: 'active', evidenceRef: evidence.evidenceId,
    lessonId: 'lesson-inspect-seam', nextAction: task.nextAction, correctionPlan: 'Change the synthetic approach',
  }];
  maximum.evidenceSummary = [evidence];
  maximum.workspaceDrift = {
    recorded: workspace('1'.repeat(40), false), current: workspace('2'.repeat(40), true),
    headDrift: true, statusDrift: true, fingerprintState: 'partial',
  };
  maximum.sourceDrift = [{ path: 'README.md', purpose: 'Synthetic source', state: 'stale' }];
  maximum.graphifyReceipts = [{
    receiptId: 'receipt-inspect-maximum', adapterVersion: 1, state: 'stale_known',
    graphifyVersion: '1.2.3', graphPath: 'graphify-out/graph.json', byteSize: 4096,
    rawSha256: '3'.repeat(64), builtAtCommit: '1'.repeat(40), repositoryHead: '2'.repeat(40), workspaceDirty: true,
    observedAt: timestamp, scope: 'Synthetic Graphify observation',
    limitations: ['Dirty workspace prevents a current claim', 'Semantic scope remains unknown'],
  }];
  maximum.legacy = [{
    legacyId: 'legacy-inspect-seam', kind: 'activeWork', summary: 'Legacy status retained',
    legacyStatus: 'done', checkedAt: timestamp, freshness: 'unknown',
  }];
  maximum.warnings = [{
    warningId: 'warning-inspect-seam', severity: 'blocking', code: 'synthetic_block',
    subjectId: task.taskId, message: 'Synthetic warning',
  }];
  const handoffView = structuredClone(maximum);
  handoffView.view = 'handoff';
  handoffView.attention = { goalFailures: [], blocked: [], failed: [], verificationFailed: [], rejected: [], contested: [], stale: [] };
  handoffView.feedback = [];
  handoffView.graphifyReceipts = [];
  handoffView.legacy = [];
  Object.assign(handoffView.handoffs[0], {
    assignmentId: 'assignment-inspect-seam', parentRunId: 'run-inspect-parent', scope: 'Synthetic fixture',
    pathOwnership: ['src/inspect'], deliverables: ['Return a bounded report'],
    prohibitedActions: ['Do not mutate unrelated files'],
  });
  handoffView.selectedEvidence = [{ ...evidence, locator: 'checks/integration-inspect' }];
  const minimumHandoff = structuredClone(minimum);
  minimumHandoff.view = 'handoff';
  minimumHandoff.project.finalGoal = {
    goalId: 'goal-handoff-minimum', title: 'Minimum handoff goal', outcome: 'Exercise the bounded branch',
    lifecycle: 'active', acceptance: 'pending', verification: 'not_run', freshness: 'unknown',
    criterionIds: [], failureIds: [], warningIds: [],
  };
  minimumHandoff.tasks = [{
    taskId: 'task-handoff-minimum', title: 'Minimum handoff task', scope: 'Synthetic fixture',
    owner: 'actor-subagent', requiredForGoal: false, execution: 'planned', verification: 'not_run',
    acceptance: 'not_requested', freshness: 'unknown', dependencyIds: [], criterionIds: [], warningIds: [],
  }];
  minimumHandoff.handoffs = [{
    handoffId: 'handoff-minimum', taskId: 'task-handoff-minimum', assignmentId: 'assignment-minimum',
    parentRunId: 'run-minimum-parent', owner: 'actor-subagent', scope: 'Synthetic fixture',
    pathOwnership: ['src/minimum'], criterionIds: [], deliverables: ['Return a bounded report'],
    prohibitedActions: ['Do not mutate unrelated files'], state: 'assigned', warningIds: [],
  }];
  minimumHandoff.evidenceSummary = [{
    evidenceId: 'evidence-handoff-minimum', kind: 'test', subjectId: 'task-handoff-minimum',
    outcome: 'observed', observedAt: timestamp, freshness: 'unknown', scope: 'Synthetic minimum evidence',
  }];
  minimumHandoff.selectedEvidence = [{
    ...minimumHandoff.evidenceSummary[0], locator: 'checks/minimum-handoff',
  }];
  return { minimum, maximum, handoffView, minimumHandoff, minimumReceipt };
}

function assertInspectSchema() {
  const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../continuity');
  const contract = JSON.parse(readFileSync(path.join(skillRoot, 'references', 'v2-contract.schema.json'), 'utf8'));
  const inspect = JSON.parse(readFileSync(path.join(skillRoot, 'references', 'inspect-v1.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(contract);
  const validate = ajv.compile(inspect);
  const { minimum, maximum, handoffView, minimumHandoff, minimumReceipt } = inspectFixtures();
  for (const fixture of [minimum, maximum, handoffView, minimumHandoff]) {
    assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
  }
  const minimumReceiptFixture = structuredClone(minimum);
  minimumReceiptFixture.graphifyReceipts = [minimumReceipt];
  assert.equal(validate(minimumReceiptFixture), true, JSON.stringify(validate.errors));
  const maximumReceiptFixture = structuredClone(minimum);
  maximumReceiptFixture.graphifyReceipts = [{
    ...minimumReceipt,
    receiptId: 'receipt-inspect-present',
    state: 'observed_unverified',
    graphifyVersion: '1.2.3',
    byteSize: 64 * 1024 * 1024,
    rawSha256: '4'.repeat(64),
    builtAtCommit: '5'.repeat(40),
    repositoryHead: '6'.repeat(40),
    workspaceDirty: true,
    limitations: ['Graph content was observed but not semantically verified'],
  }];
  assert.equal(validate(maximumReceiptFixture), true, JSON.stringify(validate.errors));
  const maximumClaimsFixture = structuredClone(maximum);
  maximumClaimsFixture.attention.contested[0].claimIds = Array.from(
    { length: 50 },
    (_, index) => `claim-inspect-${String(index + 1).padStart(2, '0')}`,
  );
  assert.equal(validate(maximumClaimsFixture), true, JSON.stringify(validate.errors));
  const minimumSequenceFixture = structuredClone(minimum);
  minimumSequenceFixture.store.sequence = 1;
  assert.equal(validate(minimumSequenceFixture), true, JSON.stringify(validate.errors));
  const maximumSequenceFixture = structuredClone(minimum);
  maximumSequenceFixture.store.sequence = Number.MAX_SAFE_INTEGER;
  assert.equal(validate(maximumSequenceFixture), true, JSON.stringify(validate.errors));
  const unsafeSequenceFixture = structuredClone(minimum);
  unsafeSequenceFixture.store.sequence = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(validate(unsafeSequenceFixture), false, 'inspect accepted a sequence above Number.MAX_SAFE_INTEGER');
  const oversizedReceiptFixture = structuredClone(maximumReceiptFixture);
  oversizedReceiptFixture.graphifyReceipts[0].byteSize = (64 * 1024 * 1024) + 1;
  assert.equal(validate(oversizedReceiptFixture), false, 'inspect accepted a Graphify receipt above 64 MiB');
  const reportedWithoutOutcome = structuredClone(maximum);
  delete reportedWithoutOutcome.handoffs[0].reportOutcome;
  assert.equal(validate(reportedWithoutOutcome), false, 'reported handoff accepted no report outcome');
  const acceptedWithoutOutcome = structuredClone(maximum);
  acceptedWithoutOutcome.handoffs[0].state = 'accepted';
  delete acceptedWithoutOutcome.handoffs[0].reportOutcome;
  assert.equal(validate(acceptedWithoutOutcome), false, 'accepted handoff accepted no report outcome or decision');
  const singleClaimContradiction = structuredClone(maximum);
  singleClaimContradiction.attention.contested[0].claimIds = ['claim-inspect-left'];
  assert.equal(validate(singleClaimContradiction), false, 'contradiction accepted fewer than two claims');
  for (const [field, incoherent] of [
    ['byteSize', 1],
    ['rawSha256', '4'.repeat(64)],
    ['builtAtCommit', '5'.repeat(40)],
  ]) {
    const invalidNotPresent = structuredClone(minimumReceiptFixture);
    invalidNotPresent.graphifyReceipts[0][field] = incoherent;
    assert.equal(validate(invalidNotPresent), false, `not_present Graphify receipt accepted incoherent ${field}`);
  }
  const legacyReceiptFixture = structuredClone(minimum);
  legacyReceiptFixture.graphifyReceipts = [{
    receiptId: 'receipt-old-shape', state: 'stale_known', graphPath: 'graphify-out/graph.json',
    observedAt: minimum.generatedAt, repositoryHead: '1'.repeat(40), graphHead: '2'.repeat(40),
    scope: 'Unauthorized old receipt', bounded: true, sourceRefs: [],
  }];
  assert.equal(validate(legacyReceiptFixture), false, 'inspect accepted the unauthorized old Graphify receipt');
  for (const field of Object.keys(minimum)) {
    const missing = structuredClone(minimum);
    delete missing[field];
    assert.equal(validate(missing), false, `inspect accepted missing top-level ${field}`);
  }
  const unknownTop = { ...minimum, unknown: true };
  assert.equal(validate(unknownTop), false, 'inspect accepted an unknown top-level field');
  for (const mutate of [
    (value) => { value.store.unknown = true; },
    (value) => { value.project.unknown = true; },
    (value) => { value.project.finalGoal.unknown = true; },
    (value) => { value.criteria[0].unknown = true; },
    (value) => { value.attention.unknown = []; },
    (value) => { value.attention.goalFailures[0].unknown = true; },
    (value) => { value.attention.goalFailures[0].subject.unknown = true; },
    (value) => { value.attention.goalFailures[0].rootCause.unknown = true; },
    (value) => { value.attention.blocked[0].unknown = true; },
    (value) => { value.attention.contested[0].unknown = true; },
    (value) => { value.tasks[0].unknown = true; },
    (value) => { value.nextActions[0].unknown = true; },
    (value) => { value.handoffs[0].unknown = true; },
    (value) => { value.feedback[0].unknown = true; },
    (value) => { value.evidenceSummary[0].unknown = true; },
    (value) => { value.workspaceDrift.unknown = true; },
    (value) => { value.sourceDrift[0].unknown = true; },
    (value) => { value.graphifyReceipts[0].unknown = true; },
    (value) => { value.legacy[0].unknown = true; },
    (value) => { value.warnings[0].unknown = true; },
  ]) {
    const invalid = structuredClone(maximum);
    mutate(invalid);
    assert.equal(validate(invalid), false, 'inspect accepted an unknown nested field');
  }
  const requiredFamilies = [
    ['Store', (value) => value.store, ['schemaVersion', 'epochId', 'sequence', 'eventHash', 'journalState', 'projectionState', 'partialTail']],
    ['Project', (value) => value.project, ['projectId', 'name', 'identity', 'finalGoal']],
    ['FinalGoal', (value) => value.project.finalGoal, ['goalId', 'title', 'outcome', 'lifecycle', 'acceptance', 'verification', 'freshness', 'criterionIds', 'failureIds', 'warningIds']],
    ['Criterion', (value) => value.criteria[0], ['criterionId', 'condition', 'scope', 'lifecycle', 'verification', 'freshness', 'evidenceRefs']],
    ['Task', (value) => value.tasks[0], ['taskId', 'title', 'scope', 'owner', 'requiredForGoal', 'execution', 'verification', 'acceptance', 'freshness', 'dependencyIds', 'criterionIds', 'warningIds']],
    ['Attention', (value) => value.attention, ['goalFailures', 'blocked', 'failed', 'verificationFailed', 'rejected', 'contested', 'stale']],
    ['TaskSummary', (value) => value.attention.blocked[0], ['taskId', 'title', 'owner', 'execution', 'verification', 'acceptance', 'freshness', 'failureIds']],
    ['FailureSummary', (value) => value.attention.goalFailures[0], ['failureId', 'subject', 'terminal', 'responsibleBoundary', 'observedSymptom', 'impact', 'unchanged', 'rootCause', 'evidenceRefs']],
    ['FailureSubject', (value) => value.attention.goalFailures[0].subject, ['type', 'id']],
    ['RootCause', (value) => value.attention.goalFailures[0].rootCause, ['state', 'summary']],
    ['ContradictionSummary', (value) => value.attention.contested[0], ['contradictionId', 'claimKey', 'claimIds', 'state']],
    ['NextAction', (value) => value.nextActions[0], ['subjectId', 'action', 'owner', 'blockedByIds']],
    ['Handoff', (value) => value.handoffs[0], ['handoffId', 'taskId', 'owner', 'state', 'criterionIds', 'warningIds']],
    ['Feedback', (value) => value.feedback[0], ['feedbackId', 'subjectId', 'disposition', 'acceptanceEffect', 'lifecycle', 'evidenceRef']],
    ['EvidenceSummary', (value) => value.evidenceSummary[0], ['evidenceId', 'kind', 'subjectId', 'outcome', 'observedAt', 'freshness', 'scope']],
    ['WorkspaceDrift', (value) => value.workspaceDrift, ['recorded', 'current', 'headDrift', 'statusDrift', 'fingerprintState']],
    ['WorkspaceObservation', (value) => value.workspaceDrift.recorded, ['head', 'branch', 'dirty', 'statusFingerprint', 'fingerprintPartial', 'capturedAt']],
    ['SourceDrift', (value) => value.sourceDrift[0], ['path', 'purpose', 'state']],
    ['GraphifyReceiptV1', (value) => value.graphifyReceipts[0], ['receiptId', 'adapterVersion', 'state', 'graphifyVersion', 'graphPath', 'repositoryHead', 'workspaceDirty', 'observedAt', 'scope', 'limitations']],
    ['Legacy', (value) => value.legacy[0], ['legacyId', 'kind', 'summary', 'freshness']],
    ['Warning', (value) => value.warnings[0], ['warningId', 'severity', 'code', 'message']],
  ];
  for (const [family, select, fields] of requiredFamilies) {
    for (const field of fields) {
      const invalid = structuredClone(maximum);
      delete select(invalid)[field];
      assert.equal(validate(invalid), false, `${family} accepted missing required field ${field}`);
    }
  }
  for (const [field, narrative] of [
    ['attention', ['Narrative attention']],
    ['feedback', ['Narrative feedback']],
    ['evidenceSummary', ['Narrative evidence']],
    ['workspaceDrift', 'Narrative drift'],
    ['sourceDrift', ['Narrative source drift']],
  ]) {
    const invalid = structuredClone(maximum);
    invalid[field] = narrative;
    assert.equal(validate(invalid), false, `inspect accepted narrative-only ${field}`);
  }
  const mismatchedBlocked = structuredClone(maximum);
  mismatchedBlocked.attention.blocked[0].execution = 'failed';
  assert.equal(validate(mismatchedBlocked), false, 'blocked attention accepted non-blocked execution');
  const mismatchedFailed = structuredClone(maximum);
  mismatchedFailed.attention.failed[0].execution = 'blocked';
  assert.equal(validate(mismatchedFailed), false, 'failed attention accepted non-failed execution');
  const mismatchedRejected = structuredClone(maximum);
  mismatchedRejected.attention.rejected[0].acceptance = 'accepted';
  assert.equal(validate(mismatchedRejected), false, 'rejected attention accepted non-rejected acceptance');
  const mismatchedContested = structuredClone(maximum);
  mismatchedContested.attention.contested[0].state = 'resolved';
  assert.equal(validate(mismatchedContested), false, 'contested attention accepted resolved contradiction');
  const mismatchedStale = structuredClone(maximum);
  mismatchedStale.attention.stale[0].freshness = 'fresh';
  assert.equal(validate(mismatchedStale), false, 'stale attention accepted fresh evidence');
  const missingHandoff = structuredClone(handoffView);
  missingHandoff.handoffs = [];
  assert.equal(validate(missingHandoff), false, 'handoff view accepted no handoff');
  const handoffFeedback = structuredClone(handoffView);
  handoffFeedback.feedback = maximum.feedback;
  assert.equal(validate(handoffFeedback), false, 'handoff view accepted feedback');
  const handoffLegacy = structuredClone(handoffView);
  handoffLegacy.legacy = maximum.legacy;
  assert.equal(validate(handoffLegacy), false, 'handoff view accepted legacy notes');
  const handoffWithoutGoal = structuredClone(minimumHandoff);
  delete handoffWithoutGoal.project.finalGoal;
  assert.equal(validate(handoffWithoutGoal), false, 'handoff view accepted a missing final goal');
  const handoffWithoutTask = structuredClone(minimumHandoff);
  handoffWithoutTask.tasks = [];
  assert.equal(validate(handoffWithoutTask), false, 'handoff view accepted zero tasks');
  const taskFailureWithoutOwner = structuredClone(maximum);
  taskFailureWithoutOwner.attention.goalFailures[0].subject = { type: 'task', id: maximum.tasks[0].taskId };
  delete taskFailureWithoutOwner.attention.goalFailures[0].owner;
  assert.equal(validate(taskFailureWithoutOwner), false, 'task-subject failure accepted no owner');
  for (const family of ['goalFailures', 'blocked', 'failed', 'verificationFailed', 'rejected', 'contested', 'stale']) {
    const copiedAttention = structuredClone(minimumHandoff);
    copiedAttention.attention[family] = structuredClone(maximum.attention[family]);
    assert.equal(validate(copiedAttention), false, `handoff view accepted prohibited ${family} attention`);
  }
  const unrelatedTask = structuredClone(handoffView);
  unrelatedTask.tasks.push({ ...unrelatedTask.tasks[0], taskId: 'task-unrelated-seam' });
  assert.equal(validate(unrelatedTask), false, 'handoff view accepted multiple tasks');
  const unsupportedFailure = structuredClone(maximum);
  delete unsupportedFailure.attention.goalFailures[0].lessonId;
  delete unsupportedFailure.attention.goalFailures[0].nextAction;
  assert.equal(validate(unsupportedFailure), false, 'failure summary accepted no lesson or next action');
  const unevidencedFailure = structuredClone(maximum);
  unevidencedFailure.attention.goalFailures[0].evidenceRefs = [];
  assert.equal(validate(unevidencedFailure), false, 'failure summary accepted no evidence');
}

async function assertPublicOptionBoundaries(makeRoot) {
  const root = makeRoot('integration-public-option-bags');
  const input = initInput('public-option-bags');
  const before = snapshotRepositoryTruth(root);
  const aliases = ['fileSystem', 'filesystem', 'fs', 'freshness', 'freshnessEvaluator', 'evaluateFreshness'];

  assert.throws(
    () => initializeV2(root, input, { clock: 0 }),
    (error) => error instanceof MemoryError && error.exitCode === 3 && error.message === 'initializeV2 options are invalid',
    'initializeV2 accepted a non-function clock',
  );
  let unusedGitReads = 0;
  const badLegacyClock = { clock: 0 };
  Object.defineProperty(badLegacyClock, 'git', {
    enumerable: true,
    get() { unusedGitReads += 1; return () => ({ status: 0, stdout: '' }); },
  });
  assert.throws(
    () => renderLegacyInspectV1(root, badLegacyClock),
    (error) => error?.exitCode === 3 && error.message === 'renderLegacyInspectV1 options are invalid',
    'renderLegacyInspectV1 accepted a non-function clock',
  );
  assert.equal(unusedGitReads, 0, 'legacy option validation read git after rejecting clock');
  let invalidGitClockCalls = 0;
  assert.throws(
    () => renderLegacyInspectV1(root, {
      clock: () => { invalidGitClockCalls += 1; return new Date('2026-08-16T00:00:00.000Z'); },
      git: 0,
    }),
    (error) => error?.exitCode === 3 && error.message === 'renderLegacyInspectV1 options are invalid',
    'renderLegacyInspectV1 accepted a non-function git dependency',
  );
  assert.equal(invalidGitClockCalls, 0, 'legacy option validation invoked clock before rejecting git');

  for (const alias of aliases) {
    const journal = poisonBag(alias);
    assert.throws(
      () => initializeV2(root, input, journal.bag),
      (error) => error instanceof MemoryError && error.exitCode === 3 && error.message === 'initializeV2 options are invalid',
      `initializeV2 accepted ${alias}`,
    );
    assert.equal(journal.reads(), 0, `initializeV2 read forbidden ${alias}`);

    const legacy = poisonBag(alias);
    assert.throws(
      () => renderLegacyInspectV1(root, legacy.bag),
      (error) => error?.exitCode === 3 && error.message === 'renderLegacyInspectV1 options are invalid',
      `renderLegacyInspectV1 accepted ${alias}`,
    );
    assert.equal(legacy.reads(), 0, `renderLegacyInspectV1 read forbidden ${alias}`);

    for (const [label, invoke] of [
      ['openStore', (bag) => openStore(root, bag)],
      ['readV2Journal', (bag) => readV2Journal(root, bag)],
      ['assertOwnedFile', (bag) => assertOwnedFile(path.join(root, 'missing'), 'synthetic option target', bag)],
    ]) {
      const store = poisonBag(alias);
      assert.throws(
        () => invoke(store.bag),
        (error) => error instanceof MemoryError && error.exitCode === 3,
        `${label} accepted ${alias}`,
      );
      assert.equal(store.reads(), 0, `${label} read forbidden ${alias}`);
    }

    let stderr = '';
    const cli = poisonBag(alias);
    Object.defineProperty(cli.bag, 'stderr', {
      configurable: true,
      enumerable: true,
      value: { write: (value) => { stderr += value; } },
    });
    const status = await main(['--root', root, 'inspect'], cli.bag);
    assert.equal(status, 3, `main accepted ${alias}`);
    assert.equal(cli.reads(), 0, `main read forbidden ${alias}`);
    assert.match(stderr, /continuity: ERROR:/, `main did not report a generic ${alias} rejection`);
    assert.equal(stderr.includes(alias), false, `main echoed forbidden option ${alias}`);
  }

  const inherited = Object.create({ fileSystem: new Proxy({}, { get() { throw new Error('inherited authority read'); } }) });
  assert.throws(
    () => initializeV2(root, input, inherited),
    (error) => error instanceof MemoryError && error.exitCode === 3,
    'initializeV2 accepted inherited authority',
  );
  assert.throws(
    () => renderLegacyInspectV1(root, inherited),
    (error) => error?.exitCode === 3,
    'renderLegacyInspectV1 accepted inherited authority',
  );

  const symbolBag = { clock: () => new Date('2026-08-16T00:00:00.000Z') };
  Object.defineProperty(symbolBag, Symbol('fileSystem'), { value: {}, enumerable: false });
  assert.throws(
    () => initializeV2(root, input, symbolBag),
    (error) => error instanceof MemoryError && error.exitCode === 3,
    'initializeV2 accepted a symbol option',
  );

  let journalMetaReads = 0;
  const uninspectableJournal = new Proxy({}, {
    ownKeys() { journalMetaReads += 1; throw new Error('uninspectable journal options'); },
    get() { throw new Error('journal option getter read'); },
  });
  assert.throws(
    () => initializeV2(root, input, uninspectableJournal),
    (error) => error instanceof MemoryError && error.exitCode === 3,
    'initializeV2 accepted uninspectable options',
  );
  assert.equal(journalMetaReads, 1);

  let arityReads = 0;
  const arityPoison = new Proxy({}, {
    ownKeys() { arityReads += 1; throw new Error('arity inspected options'); },
    get() { arityReads += 1; throw new Error('arity read options'); },
  });
  assert.throws(() => Reflect.apply(initializeV2, null, [root, input, arityPoison, {}]), (error) => error?.exitCode === 3);
  assert.throws(() => Reflect.apply(appendV2, null, [root, {}, arityPoison]), (error) => error?.exitCode === 3);
  assert.throws(() => Reflect.apply(validateV2Append, null, [root, {}, arityPoison]), (error) => error?.exitCode === 3);
  assert.throws(() => Reflect.apply(rebuildProjection, null, [root, arityPoison]), (error) => error?.exitCode === 3);
  assert.throws(() => Reflect.apply(readLegacyInspectInput, null, [root, arityPoison]), (error) => error?.exitCode === 3);
  assert.throws(() => Reflect.apply(renderLegacyInspectV1, null, [root, arityPoison, {}]), (error) => error?.exitCode === 3);
  assert.throws(() => Reflect.apply(openStore, null, [root, arityPoison, {}]), (error) => error?.exitCode === 3);
  assert.throws(() => Reflect.apply(readV2Journal, null, [root, arityPoison, {}]), (error) => error?.exitCode === 3);
  assert.throws(() => Reflect.apply(assertOwnedFile, null, [root, 'synthetic', arityPoison, {}]), (error) => error?.exitCode === 3);
  assert.equal(arityReads, 0, 'exact arity rejection inspected an earlier option bag');

  let cliMetaReads = 0;
  const uninspectableCli = new Proxy({}, {
    ownKeys() { cliMetaReads += 1; throw new Error('uninspectable CLI options'); },
    get() { throw new Error('CLI option getter read'); },
  });
  assert.equal(await main(['--root', root, 'inspect'], uninspectableCli), 3);
  assert.equal(cliMetaReads, 1);
  cliMetaReads = 0;
  assert.equal(await Reflect.apply(main, null, [['--root', root, 'inspect'], uninspectableCli, {}]), 3);
  assert.equal(cliMetaReads, 0, 'main exact arity rejection inspected io');
  assert.deepEqual(
    snapshotRepositoryTruth(root), before,
    'public option rejection changed semantic repository truth',
  );
}

async function assertMainOptionValueBoundaries(makeRoot) {
  const invoke = async (root, args, defineOptions) => {
    let stdout = ''; let stderr = '';
    const io = {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    };
    defineOptions(io);
    const status = await main(['--root', root, ...args], io);
    return { status, stdout, stderr };
  };
  const assertGenericOptionError = (result, label) => {
    assert.equal(result.status, 3, `${label} did not fail at the integrity boundary`);
    assert.equal(result.stdout, '', `${label} emitted success output`);
    assert.equal(result.stderr, 'continuity: ERROR: main options are invalid\n', `${label} leaked a lower-layer error`);
  };
  const assertTreeUnchanged = (root, before, label) => {
    assert.deepEqual(snapshotRepositoryTruth(root), before, `${label} changed semantic repository truth`);
  };

  const dataRoot = makeRoot('integration-main-data-option-values');
  const dataInput = path.join(dataRoot, 'd15-init.json');
  writeFileSync(dataInput, `${JSON.stringify(initInput('d15-data-values'))}\n`);
  const dataPaths = storePaths(dataRoot);
  const dataLock = gitAdminTopology(dataRoot).lock;
  const dataBefore = snapshotRepositoryTruth(dataRoot);
  for (const invalidKey of ['clock', 'git']) {
    let clockCalls = 0; let gitReads = 0;
    const result = await invoke(
      dataRoot,
      ['init', '--schema', '2', '--file', dataInput],
      (io) => {
        if (invalidKey === 'clock') {
          io.clock = 0;
          Object.defineProperty(io, 'git', {
            enumerable: true,
            get() { gitReads += 1; throw new Error('sibling git accessor was read'); },
          });
        } else {
          io.clock = () => { clockCalls += 1; return new Date('2026-08-16T00:00:00.000Z'); };
          io.git = 0;
        }
      },
    );
    assertGenericOptionError(result, `own data ${invalidKey}`);
    assert.equal(clockCalls, 0, `own data ${invalidKey} invoked clock`);
    assert.equal(gitReads, 0, `own data ${invalidKey} read the sibling git accessor`);
    assert.equal(existsSync(dataPaths.store), false, `own data ${invalidKey} created the store`);
    assert.equal(existsSync(dataLock), false, `own data ${invalidKey} created the mutation lock`);
    assertTreeUnchanged(dataRoot, dataBefore, `own data ${invalidKey}`);
  }

  let invalidClockReads = 0;
  const invalidClock = await invoke(
    dataRoot,
    ['init', '--schema', '2', '--file', dataInput],
    (io) => {
      Object.defineProperty(io, 'clock', {
        enumerable: true,
        get() { invalidClockReads += 1; return 0; },
      });
      io.git = () => ({ status: 0, stdout: '' });
    },
  );
  assertGenericOptionError(invalidClock, 'selected clock accessor');
  assert.equal(invalidClockReads, 1, 'selected clock accessor was not resolved exactly once');
  assert.equal(existsSync(dataPaths.store), false, 'selected clock accessor created the store');
  assert.equal(existsSync(dataLock), false, 'selected clock accessor created the mutation lock');
  assertTreeUnchanged(dataRoot, dataBefore, 'selected clock accessor');

  const lazyRoot = makeRoot('integration-main-lazy-git-option');
  const lazyInput = path.join(lazyRoot, 'd15-lazy-init.json');
  writeFileSync(lazyInput, `${JSON.stringify(initInput('d15-lazy-git'))}\n`);
  let defaultClockReads = 0; let unselectedGitReads = 0;
  const lazyResult = await invoke(
    lazyRoot,
    ['init', '--schema', '2', '--file', lazyInput],
    (io) => {
      Object.defineProperty(io, 'clock', {
        enumerable: true,
        get() { defaultClockReads += 1; return undefined; },
      });
      Object.defineProperty(io, 'git', {
        enumerable: true,
        get() { unselectedGitReads += 1; throw new Error('unselected git accessor was read'); },
      });
    },
  );
  assert.equal(lazyResult.status, 0, lazyResult.stderr);
  assert.match(lazyResult.stdout, /^continuity v2 initialized:/);
  assert.equal(lazyResult.stderr, '');
  assert.equal(defaultClockReads, 1, 'selected undefined clock accessor was not resolved once');
  assert.equal(unselectedGitReads, 0, 'init read the unselected git accessor');
  assert.equal(detectStoreVersion(lazyRoot), 2, 'undefined clock default did not initialize v2');

  const legacyRoot = makeRoot('integration-main-selected-git-option');
  const legacyInit = runCli(helper, legacyRoot, ['init']);
  assert.equal(legacyInit.status, 0, legacyInit.stderr);
  const legacyBefore = snapshotRepositoryTruth(legacyRoot);
  let selectedGitReads = 0; let legacyClockCalls = 0;
  const invalidGit = await invoke(legacyRoot, ['inspect', '--json'], (io) => {
    io.clock = () => { legacyClockCalls += 1; return new Date('2026-08-16T00:00:00.000Z'); };
    Object.defineProperty(io, 'git', {
      enumerable: true,
      get() { selectedGitReads += 1; return 0; },
    });
  });
  assertGenericOptionError(invalidGit, 'selected git accessor');
  assert.equal(selectedGitReads, 1, 'selected git accessor was not resolved exactly once');
  assert.equal(legacyClockCalls, 0, 'git accessor rejection invoked the legacy clock');
  assertTreeUnchanged(legacyRoot, legacyBefore, 'selected git accessor');
}

async function assertProjectionIdentityRaces(makeRoot) {
  const v2Root = makeRoot('integration-v2-projection-identity-race');
  initializeV2(v2Root, initInput('v2-projection-race'), { clock: () => new Date('2026-08-16T00:00:00.000Z') });
  const v2Files = storePaths(v2Root);
  const v2Before = readFileSync(v2Files.current);
  const v2Identity = lstatSync(v2Files.current);
  let v2Replacement;
  let v2Displaced;
  const v2Result = await runBarrierRace({
    point: 'journal-projection-before-rename',
    command: process.execPath,
    args: journalChildArgs('rebuild', v2Root),
    mutate: ({ temporary }) => {
      v2Replacement = temporary;
      v2Displaced = `${temporary}.externally-displaced`;
      renameSync(temporary, v2Displaced);
      writeFileSync(temporary, 'external v2 projection replacement\n', { flag: 'wx' });
    },
  });
  assert.equal(v2Result.code, 3, v2Result.stderr);
  assert.deepEqual(readFileSync(v2Files.current), v2Before, 'v2 projection race changed prior CURRENT bytes');
  sameIdentity(lstatSync(v2Files.current), v2Identity, 'v2 prior CURRENT');
  assert.equal(readFileSync(v2Replacement, 'utf8'), 'external v2 projection replacement\n');
  assert.deepEqual(readFileSync(v2Displaced), v2Before, 'v2 retained temp bytes were not preserved');

  const v1Root = makeRoot('integration-v1-projection-identity-race');
  let result = runCli(helper, v1Root, ['init']);
  assert.equal(result.status, 0, result.stderr);
  const v1Files = storePaths(v1Root);
  const v1Before = readFileSync(v1Files.current);
  const v1Identity = lstatSync(v1Files.current);
  const candidate = legacyCandidate(v1Root, 'projection-race');
  let v1Replacement;
  let v1Displaced;
  const v1Result = await runBarrierRace({
    point: 'legacy-projection-before-rename',
    command: process.execPath,
    args: [helper, '--root', v1Root, 'checkpoint', '--file', candidate],
    mutate: ({ temporary }) => {
      v1Replacement = temporary;
      v1Displaced = `${temporary}.externally-displaced`;
      renameSync(temporary, v1Displaced);
      writeFileSync(temporary, 'external v1 projection replacement\n', { flag: 'wx' });
    },
  });
  assert.equal(v1Result.code, 3, v1Result.stderr);
  assert.deepEqual(readFileSync(v1Files.current), v1Before, 'v1 projection race changed prior CURRENT bytes');
  sameIdentity(lstatSync(v1Files.current), v1Identity, 'v1 prior CURRENT');
  assert.equal(readFileSync(v1Replacement, 'utf8'), 'external v1 projection replacement\n');
  assert.ok(existsSync(v1Displaced), 'v1 retained temp was not preserved');
}

function assertGenericProjectionRaceFailure(race, alias, label) {
  assert.equal(race.code, 3, `${label}\n${race.stderr}`);
  assert.equal(race.signal, null, `${label} was terminated by ${race.signal}`);
  assert.equal(race.stdout, '', `${label} wrote success output`);
  assert.ok(race.stderr.trim(), `${label} did not report a generic failure`);
  assert.equal(race.stderr.includes(alias), false, `${label} exposed the external alias`);
}

function assertPriorProjectionLinks(files, prior, alias, rollback, label) {
  assert.deepEqual(readFileSync(files.current), prior.currentBytes, `${label} changed prior CURRENT bytes`);
  sameIdentity(lstatSync(files.current, { bigint: true }), prior.currentIdentity, `${label} prior CURRENT`);
  assert.deepEqual(readFileSync(files.history), prior.historyBytes, `${label} changed HISTORY bytes`);
  sameIdentity(lstatSync(files.history, { bigint: true }), prior.historyIdentity, `${label} HISTORY`);
  assert.equal(existsSync(alias), true, `${label} removed the external alias`);
  assert.equal(existsSync(rollback), true, `${label} removed the retained rollback link`);
  const currentIdentity = lstatSync(files.current, { bigint: true });
  const aliasIdentity = lstatSync(alias, { bigint: true });
  const rollbackIdentity = lstatSync(rollback, { bigint: true });
  sameIdentity(aliasIdentity, prior.currentIdentity, `${label} alias`);
  sameIdentity(rollbackIdentity, prior.currentIdentity, `${label} rollback`);
  assert.equal(currentIdentity.nlink, 3n, `${label} prior CURRENT link count changed`);
  assert.equal(aliasIdentity.nlink, 3n, `${label} alias link count changed`);
  assert.equal(rollbackIdentity.nlink, 3n, `${label} rollback link count changed`);
}

function assertInstalledProjectionBarrier(details, point, files, prior, label) {
  assert.deepEqual(
    Object.keys(details).sort(),
    ['point', 'target'],
    `${label} exposed an unexpected barrier payload contract`,
  );
  assert.equal(details.point, point, `${label} reached the wrong synchronized barrier`);
  const targetParent = lstatSync(path.dirname(details.target), { bigint: true });
  const currentParent = lstatSync(path.dirname(files.current), { bigint: true });
  assert.equal(targetParent.isDirectory(), true, `${label} rollback parent is not a directory`);
  assert.equal(currentParent.isDirectory(), true, `${label} CURRENT parent is not a directory`);
  sameIdentity(targetParent, currentParent, `${label} rollback parent`);
  assert.equal(
    path.basename(details.target).startsWith(`${path.basename(files.current)}.rollback-`),
    true,
    `${label} did not identify the retained rollback link`,
  );
  assert.notDeepEqual(
    readFileSync(files.current),
    prior.currentBytes,
    `${label} did not install the new projection before cleanup`,
  );
  const installedIdentity = lstatSync(files.current, { bigint: true });
  assert.equal(
    installedIdentity.dev === prior.currentIdentity.dev && installedIdentity.ino === prior.currentIdentity.ino,
    false,
    `${label} did not replace prior CURRENT identity`,
  );
  return details.target;
}

async function assertPriorCurrentHardLinkRaces(makeRoot) {
  const v2Root = makeRoot('integration-v2-prior-current-hardlink-race');
  initializeV2(v2Root, initInput('v2-prior-current-hardlink-race'), {
    clock: () => new Date('2026-08-16T00:00:00.000Z'),
  });
  const v2Files = storePaths(v2Root);
  const v2Prior = {
    currentBytes: readFileSync(v2Files.current),
    currentIdentity: lstatSync(v2Files.current, { bigint: true }),
    historyBytes: readFileSync(v2Files.history),
    historyIdentity: lstatSync(v2Files.history, { bigint: true }),
  };
  let v2Alias;
  let v2Rollback;
  let v2Temporary;
  const v2Race = await runBarrierRace({
    point: 'journal-projection-before-rename',
    command: process.execPath,
    args: journalChildArgs('rebuild', v2Root),
    observeRenameTarget: v2Files.current,
    mutate: (details) => {
      v2Rollback = details.rollback;
      v2Temporary = details.temporary;
      assert.ok(v2Rollback && existsSync(v2Rollback), 'v2 prior-CURRENT race did not retain a rollback link');
      assert.deepEqual(readFileSync(v2Files.current), v2Prior.currentBytes, 'v2 prior-CURRENT changed before race mutation');
      sameIdentity(lstatSync(v2Files.current, { bigint: true }), v2Prior.currentIdentity, 'v2 prior-CURRENT before race mutation');
      sameIdentity(lstatSync(v2Rollback, { bigint: true }), v2Prior.currentIdentity, 'v2 rollback before race mutation');
      assert.equal(lstatSync(v2Files.current, { bigint: true }).nlink, 2n, 'v2 prior-CURRENT was not in the explicit rollback 2-link state');
      v2Alias = `${v2Files.current}.external-prior-hardlink`;
      linkSync(v2Files.current, v2Alias);
      sameIdentity(lstatSync(v2Files.current, { bigint: true }), v2Prior.currentIdentity, 'v2 prior-CURRENT after race mutation');
      assert.equal(lstatSync(v2Files.current, { bigint: true }).nlink, 3n, 'v2 hard-link race did not change the retained prior inode');
    },
  });
  assertGenericProjectionRaceFailure(v2Race, v2Alias, 'v2 prior-CURRENT hard-link race');
  assert.equal(v2Race.renameTraceCount, 0, 'v2 prior-CURRENT hard-link race reached the post-rename/install phase');
  assertPriorProjectionLinks(v2Files, v2Prior, v2Alias, v2Rollback, 'v2 prior-CURRENT hard-link race');
  assert.equal(existsSync(v2Temporary), false, 'v2 prior-CURRENT hard-link race retained an owned projection temp');

  const v1Root = makeRoot('integration-v1-prior-current-hardlink-race');
  const initialized = runCli(helper, v1Root, ['init']);
  assert.equal(initialized.status, 0, initialized.stderr);
  const v1Files = storePaths(v1Root);
  const v1Candidate = legacyCandidate(v1Root, 'prior-current-hardlink-race');
  writeFileSync(v1Files.current, '{}\n');
  const v1Prior = {
    currentBytes: readFileSync(v1Files.current),
    currentIdentity: lstatSync(v1Files.current, { bigint: true }),
    historyBytes: readFileSync(v1Files.history),
    historyIdentity: lstatSync(v1Files.history, { bigint: true }),
  };
  let v1Alias;
  let v1Rollback;
  let v1Temporary;
  const v1Race = await runBarrierRace({
    point: 'legacy-projection-before-rename',
    command: process.execPath,
    args: [helper, '--root', v1Root, 'checkpoint', '--file', v1Candidate],
    observeRenameTarget: v1Files.current,
    mutate: (details) => {
      v1Rollback = details.rollback;
      v1Temporary = details.temporary;
      assert.ok(v1Rollback && existsSync(v1Rollback), 'v1 prior-CURRENT race did not retain a rollback link');
      assert.deepEqual(readFileSync(v1Files.current), v1Prior.currentBytes, 'v1 prior-CURRENT changed before race mutation');
      sameIdentity(lstatSync(v1Files.current, { bigint: true }), v1Prior.currentIdentity, 'v1 prior-CURRENT before race mutation');
      sameIdentity(lstatSync(v1Rollback, { bigint: true }), v1Prior.currentIdentity, 'v1 rollback before race mutation');
      assert.equal(lstatSync(v1Files.current, { bigint: true }).nlink, 2n, 'v1 prior-CURRENT was not in the explicit rollback 2-link state');
      v1Alias = `${v1Files.current}.external-prior-hardlink`;
      linkSync(v1Files.current, v1Alias);
      sameIdentity(lstatSync(v1Files.current, { bigint: true }), v1Prior.currentIdentity, 'v1 prior-CURRENT after race mutation');
      assert.equal(lstatSync(v1Files.current, { bigint: true }).nlink, 3n, 'v1 hard-link race did not change the retained prior inode');
    },
  });
  assertGenericProjectionRaceFailure(v1Race, v1Alias, 'v1 prior-CURRENT hard-link race');
  assert.equal(v1Race.renameTraceCount, 0, 'v1 prior-CURRENT hard-link race reached the post-rename/install phase');
  assertPriorProjectionLinks(v1Files, v1Prior, v1Alias, v1Rollback, 'v1 prior-CURRENT hard-link race');
  assert.equal(existsSync(v1Temporary), false, 'v1 prior-CURRENT hard-link race retained an owned projection temp');
}

async function assertProjectionRollbackRecoveryRaces(makeRoot) {
  const v2Root = makeRoot('integration-v2-projection-rollback-recovery-race');
  initializeV2(v2Root, initInput('v2-projection-rollback-recovery-race'), {
    clock: () => new Date('2026-08-16T00:00:00.000Z'),
  });
  const v2Files = storePaths(v2Root);
  writeFileSync(v2Files.current, '{}\n');
  const v2Prior = {
    currentBytes: readFileSync(v2Files.current),
    currentIdentity: lstatSync(v2Files.current, { bigint: true }),
    historyBytes: readFileSync(v2Files.history),
    historyIdentity: lstatSync(v2Files.history, { bigint: true }),
  };
  let v2Alias;
  let v2Rollback;
  const v2Race = await runBarrierRace({
    point: 'journal-projection-rollback-cleanup',
    command: process.execPath,
    args: journalChildArgs('rebuild', v2Root),
    observeRenameTarget: v2Files.current,
    mutate: (details) => {
      v2Rollback = assertInstalledProjectionBarrier(
        details,
        'journal-projection-rollback-cleanup',
        v2Files,
        v2Prior,
        'v2 rollback recovery',
      );
      sameIdentity(lstatSync(v2Rollback, { bigint: true }), v2Prior.currentIdentity, 'v2 rollback recovery prior inode');
      v2Alias = `${v2Rollback}.external-hardlink`;
      linkSync(v2Rollback, v2Alias);
      assert.equal(lstatSync(v2Rollback, { bigint: true }).nlink, 2n, 'v2 rollback cleanup hard link was not inserted');
    },
  });
  assertGenericProjectionRaceFailure(v2Race, v2Alias, 'v2 projection rollback recovery race');
  assert.equal(v2Race.details.target, v2Rollback, 'v2 rollback recovery race lost the synchronized installed phase');
  assert.ok(v2Race.renameTraceCount >= 1, 'v2 rollback recovery rename tracer missed the installed projection');
  assertPriorProjectionLinks(v2Files, v2Prior, v2Alias, v2Rollback, 'v2 projection rollback recovery race');

  const v1Root = makeRoot('integration-v1-projection-rollback-recovery-race');
  const initialized = runCli(helper, v1Root, ['init']);
  assert.equal(initialized.status, 0, initialized.stderr);
  const v1Files = storePaths(v1Root);
  const v1Candidate = legacyCandidate(v1Root, 'projection-rollback-recovery-race');
  writeFileSync(v1Files.current, '{}\n');
  const v1Prior = {
    currentBytes: readFileSync(v1Files.current),
    currentIdentity: lstatSync(v1Files.current, { bigint: true }),
    historyBytes: readFileSync(v1Files.history),
    historyIdentity: lstatSync(v1Files.history, { bigint: true }),
  };
  let v1Alias;
  let v1Rollback;
  const v1Race = await runBarrierRace({
    point: 'legacy-projection-rollback-cleanup',
    command: process.execPath,
    args: [helper, '--root', v1Root, 'checkpoint', '--file', v1Candidate],
    observeRenameTarget: v1Files.current,
    mutate: (details) => {
      v1Rollback = assertInstalledProjectionBarrier(
        details,
        'legacy-projection-rollback-cleanup',
        v1Files,
        v1Prior,
        'v1 rollback recovery',
      );
      sameIdentity(lstatSync(v1Rollback, { bigint: true }), v1Prior.currentIdentity, 'v1 rollback recovery prior inode');
      v1Alias = `${v1Rollback}.external-hardlink`;
      linkSync(v1Rollback, v1Alias);
      assert.equal(lstatSync(v1Rollback, { bigint: true }).nlink, 2n, 'v1 rollback cleanup hard link was not inserted');
    },
  });
  assertGenericProjectionRaceFailure(v1Race, v1Alias, 'v1 projection rollback recovery race');
  assert.equal(v1Race.details.target, v1Rollback, 'v1 rollback recovery race lost the synchronized installed phase');
  assert.ok(v1Race.renameTraceCount >= 1, 'v1 rollback recovery rename tracer missed the installed projection');
  assertPriorProjectionLinks(v1Files, v1Prior, v1Alias, v1Rollback, 'v1 projection rollback recovery race');
}

export async function runProjectionRollbackRecoveryRaces() {
  const roots = [];
  const makeRoot = (label) => { const root = makeRepository(label); roots.push(root); return root; };
  try {
    await assertProjectionRollbackRecoveryRaces(makeRoot);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

async function assertCleanupIdentityRaces(makeRoot) {
  let result;
  const runInitCleanupRace = async (suffix, mutate, raceOptions = {}) => {
    const root = makeRoot(`integration-v2-init-temp-cleanup-${suffix}`);
    const inputFile = path.join(root, `v2-init-${suffix}.json`);
    writeFileSync(inputFile, `${JSON.stringify(initInput(`init-temp-cleanup-${suffix}`))}\n`);
    const race = await runBarrierRace({
      point: 'journal-init-temp-cleanup',
      command: process.execPath,
      args: journalChildArgs('initialize', root, inputFile),
      env: { PROJECT_MEMORY_TEST_FAIL_V2_INIT_TEMP: '1' },
      mutate,
      ...raceOptions,
    });
    assert.equal(race.code, 3, `${suffix}\n${race.stderr}`);
    assert.equal(existsSync(storePaths(root).store), false, `${suffix} installed a canonical store`);
    return { race, root };
  };

  const provenanceRoot = makeRoot('integration-v2-init-temp-manifest-provenance');
  const provenanceInput = path.join(provenanceRoot, 'v2-init-manifest-provenance.json');
  writeFileSync(provenanceInput, `${JSON.stringify(initInput('init-temp-manifest-provenance'))}\n`);
  let provenanceReplacement;
  let provenanceDisplaced;
  let provenanceReplacementIdentity;
  const provenanceRace = await runBarrierRace({
    point: 'journal-init-temp-manifest',
    command: process.execPath,
    args: journalChildArgs('initialize', provenanceRoot, provenanceInput),
    mutate: ({ target }) => {
      provenanceReplacement = path.join(target, 'CURRENT.json');
      provenanceDisplaced = `${target}.CURRENT.externally-displaced-before-manifest`;
      const bytes = readFileSync(provenanceReplacement);
      renameSync(provenanceReplacement, provenanceDisplaced);
      writeFileSync(provenanceReplacement, bytes, { flag: 'wx' });
      provenanceReplacementIdentity = lstatSync(provenanceReplacement, { bigint: true });
    },
  });
  assert.equal(provenanceRace.code, 3, provenanceRace.stderr);
  assert.match(provenanceRace.stderr, /continuity initialization temporary ownership changed/);
  sameIdentity(
    lstatSync(provenanceReplacement, { bigint: true }), provenanceReplacementIdentity,
    'same-byte pre-manifest replacement',
  );
  assert.equal(existsSync(provenanceDisplaced), true, 'pre-manifest rejection removed the descriptor-owned file');
  const provenanceOwnedIdentity = lstatSync(provenanceDisplaced, { bigint: true });
  assert.equal(
    provenanceOwnedIdentity.dev === provenanceReplacementIdentity.dev
      && provenanceOwnedIdentity.ino === provenanceReplacementIdentity.ino,
    false,
    'pre-manifest mutation did not substitute the descriptor-owned inode',
  );
  assert.deepEqual(
    readFileSync(provenanceReplacement), readFileSync(provenanceDisplaced),
    'same-byte pre-manifest mutation control did not preserve equal bytes',
  );
  assert.equal(existsSync(storePaths(provenanceRoot).store), false, 'pre-manifest replacement installed a canonical store');

  const stableInit = await runInitCleanupRace('stable-owned-tree', () => undefined);
  assert.match(stableInit.race.stderr, /simulated v2 initialization temporary failure/);
  assert.equal(
    existsSync(stableInit.race.details.target), false,
    'stable owned initialization temporary was not retired',
  );

  let extraEntry;
  const injectedEntry = await runInitCleanupRace('injected-entry', ({ target }) => {
    extraEntry = path.join(target, 'externally-injected.txt');
    writeFileSync(extraEntry, 'external injected bytes\n', { flag: 'wx' });
  });
  assert.match(injectedEntry.race.stderr, /continuity initialization temporary ownership changed/);
  assert.equal(readFileSync(extraEntry, 'utf8'), 'external injected bytes\n');

  let deepInjectedSentinel;
  const injectedDirectory = await runInitCleanupRace('injected-deep-directory', ({ target }) => {
    const deepInjected = path.join(
      target, 'externally-injected-directory',
      ...Array.from({ length: 24 }, (_, index) => `depth-${index}`),
    );
    mkdirSync(deepInjected, { recursive: true });
    deepInjectedSentinel = path.join(deepInjected, 'sentinel.txt');
    writeFileSync(deepInjectedSentinel, 'deep external sentinel\n');
  }, { forbidDirectoryDescent: true });
  assert.match(injectedDirectory.race.stderr, /continuity initialization temporary ownership changed/);
  assert.equal(
    injectedDirectory.race.descentTraceCount, 0,
    'cleanup traversed an unexpected initialization temporary directory',
  );
  assert.ok(
    injectedDirectory.race.descentControlCount >= 1,
    'temporary-directory descent tracer missed the expected root inspection control',
  );
  assert.equal(readFileSync(deepInjectedSentinel, 'utf8'), 'deep external sentinel\n');

  let replacedOwned;
  let displacedOwned;
  let replacementIdentity;
  const replacedFile = await runInitCleanupRace('replaced-owned-file', ({ target }) => {
    replacedOwned = path.join(target, 'CURRENT.json');
    displacedOwned = `${target}.CURRENT.externally-displaced`;
    const original = readFileSync(replacedOwned);
    renameSync(replacedOwned, displacedOwned);
    writeFileSync(replacedOwned, original, { flag: 'wx' });
    replacementIdentity = lstatSync(replacedOwned, { bigint: true });
  });
  assert.match(replacedFile.race.stderr, /continuity initialization temporary ownership changed/);
  sameIdentity(lstatSync(replacedOwned, { bigint: true }), replacementIdentity, 'replacement initialization file');
  assert.equal(existsSync(displacedOwned), true, 'cleanup removed the displaced owned initialization file');

  let changedOwned;
  let changedOwnedBytes;
  const changedFile = await runInitCleanupRace('changed-owned-file-bytes', ({ target }) => {
    changedOwned = path.join(target, 'CURRENT.json');
    changedOwnedBytes = readFileSync(changedOwned);
    changedOwnedBytes[0] ^= 1;
    writeFileSync(changedOwned, changedOwnedBytes);
  });
  assert.match(changedFile.race.stderr, /continuity initialization temporary ownership changed/);
  assert.deepEqual(readFileSync(changedOwned), changedOwnedBytes, 'cleanup changed the externally modified owned-file bytes');

  let retargetedOwned;
  let displacedForLink;
  let retargetedLink;
  let firstLink;
  let firstTargetSentinel;
  let secondTargetSentinel;
  const symlinkRetarget = await runInitCleanupRace('symlink-retarget', ({ target }) => {
    retargetedOwned = path.join(target, 'HISTORY.ndjson');
    displacedForLink = `${target}.HISTORY.externally-displaced`;
    const firstTarget = path.join(path.dirname(target), 'external-link-target-a');
    const secondTarget = path.join(path.dirname(target), 'external-link-target-b');
    mkdirSync(firstTarget);
    mkdirSync(secondTarget);
    firstTargetSentinel = path.join(firstTarget, 'sentinel.txt');
    secondTargetSentinel = path.join(secondTarget, 'sentinel.txt');
    writeFileSync(firstTargetSentinel, 'first external target\n');
    writeFileSync(secondTargetSentinel, 'second external target\n');
    renameSync(retargetedOwned, displacedForLink);
    symlinkSync(firstTarget, retargetedOwned, process.platform === 'win32' ? 'junction' : 'dir');
    firstLink = readlinkSync(retargetedOwned);
    unlinkSync(retargetedOwned);
    symlinkSync(secondTarget, retargetedOwned, process.platform === 'win32' ? 'junction' : 'dir');
    retargetedLink = readlinkSync(retargetedOwned);
  });
  assert.notEqual(retargetedLink, firstLink, 'symlink retarget control retained the original target');
  assert.match(symlinkRetarget.race.stderr, /continuity initialization temporary ownership changed/);
  assert.equal(readlinkSync(retargetedOwned), retargetedLink, 'cleanup changed the retargeted external link');
  assert.equal(readFileSync(firstTargetSentinel, 'utf8'), 'first external target\n');
  assert.equal(readFileSync(secondTargetSentinel, 'utf8'), 'second external target\n');
  assert.equal(existsSync(displacedForLink), true, 'cleanup removed the file displaced by a symlink');

  const initRoot = makeRoot('integration-v2-init-temp-cleanup-race');
  const initFile = path.join(initRoot, 'v2-init-input.json');
  writeFileSync(initFile, `${JSON.stringify(initInput('init-temp-cleanup'))}\n`);
  let replacementDirectory;
  let displacedDirectory;
  const initResult = await runBarrierRace({
    point: 'journal-init-temp-cleanup',
    command: process.execPath,
    args: journalChildArgs('initialize', initRoot, initFile),
    env: { PROJECT_MEMORY_TEST_FAIL_V2_INIT_TEMP: '1' },
    mutate: ({ target }) => {
      displacedDirectory = `${target}.externally-displaced`;
      renameSync(target, displacedDirectory);
      mkdirSync(target);
      writeFileSync(path.join(target, 'replacement.txt'), 'external init replacement\n');
      replacementDirectory = target;
    },
  });
  assert.equal(initResult.code, 3, initResult.stderr);
  assert.match(initResult.stderr, /continuity initialization temporary ownership changed/);
  assert.equal(readFileSync(path.join(replacementDirectory, 'replacement.txt'), 'utf8'), 'external init replacement\n');
  assert.equal(existsSync(path.join(displacedDirectory, 'CURRENT.json')), true, 'cleanup removed the displaced owned directory');
  assert.equal(existsSync(storePaths(initRoot).store), false, 'failed v2 init installed a canonical store');

  for (const [label, point, command, args, env] of [
    [
      'v2 lock failure', 'journal-lock-failure-cleanup', process.execPath,
      journalChildArgs('initialize', makeRoot('integration-v2-lock-failure-race'), initFile),
      { PROJECT_MEMORY_TEST_FAIL_V2_LOCK_METADATA: '1' },
    ],
    [
      'v1 lock failure', 'legacy-lock-failure-cleanup', process.execPath,
      [helper, '--root', makeRoot('integration-v1-lock-failure-race'), 'init'],
      { PROJECT_MEMORY_TEST_FAIL_LOCK_METADATA: '1' },
    ],
  ]) {
    let replacement;
    const race = await runBarrierRace({
      point, command, args, env,
      mutate: ({ target }) => {
        const displaced = `${target}.externally-displaced`;
        renameSync(target, displaced);
        writeFileSync(target, `${label} replacement\n`, { flag: 'wx' });
        replacement = target;
      },
    });
    assert.equal(race.code, 3, `${label}\n${race.stderr}`);
    assert.equal(readFileSync(replacement, 'utf8'), `${label} replacement\n`, `${label} cleanup removed a replacement`);
  }

  const v2ReleaseRoot = makeRoot('integration-v2-lock-release-race');
  const v2ReleaseInput = initInput('lock-release-race');
  initializeV2(v2ReleaseRoot, v2ReleaseInput, { clock: () => new Date('2026-08-16T00:00:00.000Z') });
  const duplicateDraft = taskDraft('lock-release-race', v2ReleaseInput);
  appendV2(v2ReleaseRoot, duplicateDraft);
  const duplicateFile = path.join(v2ReleaseRoot, 'duplicate-draft.json');
  writeFileSync(duplicateFile, `${JSON.stringify(duplicateDraft)}\n`);
  const v2ReleaseBefore = snapshotTree(storePaths(v2ReleaseRoot).store);
  let v2ReleaseReplacement;
  const v2Release = await runBarrierRace({
    point: 'journal-lock-release-cleanup',
    command: process.execPath,
    args: journalChildArgs('append', v2ReleaseRoot, duplicateFile),
    mutate: ({ target }) => {
      renameSync(target, `${target}.externally-displaced`);
      writeFileSync(target, 'v2 release replacement\n', { flag: 'wx' });
      v2ReleaseReplacement = target;
    },
  });
  assert.equal(v2Release.code, 3, v2Release.stderr);
  assert.deepEqual(snapshotTree(storePaths(v2ReleaseRoot).store), v2ReleaseBefore, 'v2 release race changed canonical store');
  assert.equal(readFileSync(v2ReleaseReplacement, 'utf8'), 'v2 release replacement\n');

  const v1ReleaseRoot = makeRoot('integration-v1-lock-release-race');
  let v1ReleaseReplacement;
  const v1Release = await runBarrierRace({
    point: 'legacy-lock-release-cleanup',
    command: process.execPath,
    args: [helper, '--root', v1ReleaseRoot, 'init'],
    env: { PROJECT_MEMORY_TEST_FAIL_LEGACY_AFTER_LOCK: '1' },
    mutate: ({ target }) => {
      renameSync(target, `${target}.externally-displaced`);
      writeFileSync(target, 'v1 release replacement\n', { flag: 'wx' });
      v1ReleaseReplacement = target;
    },
  });
  assert.equal(v1Release.code, 3, v1Release.stderr);
  assert.equal(existsSync(storePaths(v1ReleaseRoot).store), false, 'v1 release race created a canonical store');
  assert.equal(readFileSync(v1ReleaseReplacement, 'utf8'), 'v1 release replacement\n');

  const v2TempRoot = makeRoot('integration-v2-temp-cleanup-race');
  initializeV2(v2TempRoot, initInput('v2-temp-cleanup-race'), { clock: () => new Date('2026-08-16T00:00:00.000Z') });
  const v2TempFiles = storePaths(v2TempRoot);
  const v2TempCurrent = readFileSync(v2TempFiles.current);
  const v2TempIdentity = lstatSync(v2TempFiles.current);
  let v2TempReplacement;
  const v2Temp = await runBarrierRace({
    point: 'journal-projection-temp-cleanup',
    command: process.execPath,
    args: journalChildArgs('rebuild', v2TempRoot),
    env: { PROJECT_MEMORY_TEST_FAIL_V2_CURRENT_REPLACE: '1' },
    mutate: ({ target }) => {
      renameSync(target, `${target}.externally-displaced`);
      writeFileSync(target, 'v2 cleanup replacement\n', { flag: 'wx' });
      v2TempReplacement = target;
    },
  });
  assert.equal(v2Temp.code, 3, v2Temp.stderr);
  assert.deepEqual(readFileSync(v2TempFiles.current), v2TempCurrent, 'v2 temp cleanup race changed CURRENT bytes');
  sameIdentity(lstatSync(v2TempFiles.current), v2TempIdentity, 'v2 cleanup prior CURRENT');
  assert.equal(readFileSync(v2TempReplacement, 'utf8'), 'v2 cleanup replacement\n');

  const v1TempRoot = makeRoot('integration-v1-temp-cleanup-race');
  result = runCli(helper, v1TempRoot, ['init']);
  assert.equal(result.status, 0, result.stderr);
  const v1TempFiles = storePaths(v1TempRoot);
  const v1TempCurrent = readFileSync(v1TempFiles.current);
  const v1TempIdentity = lstatSync(v1TempFiles.current);
  const v1TempCandidate = legacyCandidate(v1TempRoot, 'temp-cleanup-race');
  let v1TempReplacement;
  const v1Temp = await runBarrierRace({
    point: 'legacy-projection-temp-cleanup',
    command: process.execPath,
    args: [helper, '--root', v1TempRoot, 'checkpoint', '--file', v1TempCandidate],
    env: { PROJECT_MEMORY_TEST_FAIL_CURRENT_REPLACE: '1' },
    mutate: ({ target }) => {
      renameSync(target, `${target}.externally-displaced`);
      writeFileSync(target, 'v1 cleanup replacement\n', { flag: 'wx' });
      v1TempReplacement = target;
    },
  });
  assert.equal(v1Temp.code, 3, v1Temp.stderr);
  assert.deepEqual(readFileSync(v1TempFiles.current), v1TempCurrent, 'v1 temp cleanup race changed CURRENT bytes');
  sameIdentity(lstatSync(v1TempFiles.current), v1TempIdentity, 'v1 cleanup prior CURRENT');
  assert.equal(readFileSync(v1TempReplacement, 'utf8'), 'v1 cleanup replacement\n');
}

export async function runCleanupIdentityRaces() {
  const roots = [];
  const makeRoot = (label) => { const root = makeRepository(label); roots.push(root); return root; };
  try {
    await assertCleanupIdentityRaces(makeRoot);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

function assertHardLinkCleanupFailure(race, target, alias, label) {
  assert.equal(race.code, 3, `${label}\n${race.stderr}`);
  assert.equal(race.signal, null, `${label} was terminated by ${race.signal}`);
  assert.equal(race.stdout, '', `${label} wrote success output`);
  assert.ok(race.stderr.trim(), `${label} did not report a generic failure`);
  assert.equal(race.stderr.includes(alias), false, `${label} exposed the hard-link alias`);
  assert.equal(existsSync(target), true, `${label} removed the acquired cleanup path`);
  assert.equal(existsSync(alias), true, `${label} treated an external hard link as successful cleanup`);
  const targetIdentity = lstatSync(target, { bigint: true });
  const aliasIdentity = lstatSync(alias, { bigint: true });
  sameIdentity(aliasIdentity, targetIdentity, `${label} hard-link alias`);
  assert.equal(targetIdentity.isFile(), true, `${label} cleanup target is no longer a regular file`);
  assert.equal(targetIdentity.nlink, 2n, `${label} cleanup target link count changed`);
  assert.equal(aliasIdentity.nlink, 2n, `${label} alias link count changed`);
}

async function assertCleanupHardLinkRaces(makeRoot) {
  const raceWithHardLink = async ({ label, point, command, args, env = {} }) => {
    let target;
    let alias;
    const race = await runBarrierRace({
      point,
      command,
      args,
      env,
      mutate: (details) => {
        target = details.target;
        alias = `${target}.external-hardlink`;
        linkSync(target, alias);
      },
    });
    assertHardLinkCleanupFailure(race, target, alias, label);
    return { race, target, alias };
  };

  const v2FailureRoot = makeRoot('integration-v2-lock-failure-hardlink-race');
  const v2FailureInput = path.join(v2FailureRoot, 'v2-init-input.json');
  writeFileSync(v2FailureInput, `${JSON.stringify(initInput('v2-lock-failure-hardlink-race'))}\n`);
  await raceWithHardLink({
    label: 'v2 lock failure hard-link race',
    point: 'journal-lock-failure-cleanup',
    command: process.execPath,
    args: journalChildArgs('initialize', v2FailureRoot, v2FailureInput),
    env: { PROJECT_MEMORY_TEST_FAIL_V2_LOCK_METADATA: '1' },
  });
  assert.equal(existsSync(storePaths(v2FailureRoot).store), false, 'v2 lock failure hard-link race installed a canonical store');

  const v1FailureRoot = makeRoot('integration-v1-lock-failure-hardlink-race');
  await raceWithHardLink({
    label: 'v1 lock failure hard-link race',
    point: 'legacy-lock-failure-cleanup',
    command: process.execPath,
    args: [helper, '--root', v1FailureRoot, 'init'],
    env: { PROJECT_MEMORY_TEST_FAIL_LOCK_METADATA: '1' },
  });
  assert.equal(existsSync(storePaths(v1FailureRoot).store), false, 'v1 lock failure hard-link race installed a canonical store');

  const v2ReleaseRoot = makeRoot('integration-v2-lock-release-hardlink-race');
  const v2ReleaseInput = initInput('v2-lock-release-hardlink-race');
  initializeV2(v2ReleaseRoot, v2ReleaseInput, { clock: () => new Date('2026-08-16T00:00:00.000Z') });
  const duplicateDraft = taskDraft('v2-lock-release-hardlink-race', v2ReleaseInput);
  appendV2(v2ReleaseRoot, duplicateDraft);
  const duplicateFile = path.join(v2ReleaseRoot, 'duplicate-hardlink-draft.json');
  writeFileSync(duplicateFile, `${JSON.stringify(duplicateDraft)}\n`);
  const v2ReleaseFiles = storePaths(v2ReleaseRoot);
  const v2ReleaseBefore = snapshotTree(v2ReleaseFiles.store);
  const v2ReleaseIdentities = snapshotTreeIdentities(v2ReleaseFiles.store);
  await raceWithHardLink({
    label: 'v2 lock release hard-link race',
    point: 'journal-lock-release-cleanup',
    command: process.execPath,
    args: journalChildArgs('append', v2ReleaseRoot, duplicateFile),
  });
  assert.deepEqual(snapshotTree(v2ReleaseFiles.store), v2ReleaseBefore, 'v2 lock release hard-link race changed canonical store bytes');
  assert.deepEqual(snapshotTreeIdentities(v2ReleaseFiles.store), v2ReleaseIdentities, 'v2 lock release hard-link race changed canonical store identities');

  const v1ReleaseRoot = makeRoot('integration-v1-lock-release-hardlink-race');
  await raceWithHardLink({
    label: 'v1 lock release hard-link race',
    point: 'legacy-lock-release-cleanup',
    command: process.execPath,
    args: [helper, '--root', v1ReleaseRoot, 'init'],
    env: { PROJECT_MEMORY_TEST_FAIL_LEGACY_AFTER_LOCK: '1' },
  });
  assert.equal(existsSync(storePaths(v1ReleaseRoot).store), false, 'v1 lock release hard-link race created a canonical store');

  const v2TempRoot = makeRoot('integration-v2-temp-cleanup-hardlink-race');
  initializeV2(v2TempRoot, initInput('v2-temp-cleanup-hardlink-race'), {
    clock: () => new Date('2026-08-16T00:00:00.000Z'),
  });
  const v2TempFiles = storePaths(v2TempRoot);
  const v2TempHistory = readFileSync(v2TempFiles.history);
  const v2TempHistoryIdentity = lstatSync(v2TempFiles.history);
  const v2TempCurrent = readFileSync(v2TempFiles.current);
  const v2TempCurrentIdentity = lstatSync(v2TempFiles.current);
  await raceWithHardLink({
    label: 'v2 projection-temp hard-link race',
    point: 'journal-projection-temp-cleanup',
    command: process.execPath,
    args: journalChildArgs('rebuild', v2TempRoot),
    env: { PROJECT_MEMORY_TEST_FAIL_V2_CURRENT_REPLACE: '1' },
  });
  assert.deepEqual(readFileSync(v2TempFiles.history), v2TempHistory, 'v2 projection-temp hard-link race changed HISTORY bytes');
  sameIdentity(lstatSync(v2TempFiles.history), v2TempHistoryIdentity, 'v2 projection-temp hard-link race HISTORY');
  assert.deepEqual(readFileSync(v2TempFiles.current), v2TempCurrent, 'v2 projection-temp hard-link race changed CURRENT bytes');
  sameIdentity(lstatSync(v2TempFiles.current), v2TempCurrentIdentity, 'v2 projection-temp hard-link race CURRENT');

  const v1TempRoot = makeRoot('integration-v1-temp-cleanup-hardlink-race');
  const initialized = runCli(helper, v1TempRoot, ['init']);
  assert.equal(initialized.status, 0, initialized.stderr);
  const v1TempFiles = storePaths(v1TempRoot);
  const v1TempCandidate = legacyCandidate(v1TempRoot, 'temp-cleanup-hardlink-race');
  writeFileSync(v1TempFiles.current, '{}\n');
  const v1TempHistory = readFileSync(v1TempFiles.history);
  const v1TempHistoryIdentity = lstatSync(v1TempFiles.history);
  const v1TempCurrent = readFileSync(v1TempFiles.current);
  const v1TempCurrentIdentity = lstatSync(v1TempFiles.current);
  await raceWithHardLink({
    label: 'v1 projection-temp hard-link race',
    point: 'legacy-projection-temp-cleanup',
    command: process.execPath,
    args: [helper, '--root', v1TempRoot, 'checkpoint', '--file', v1TempCandidate],
    env: { PROJECT_MEMORY_TEST_FAIL_CURRENT_REPLACE: '1' },
  });
  assert.deepEqual(readFileSync(v1TempFiles.history), v1TempHistory, 'v1 projection-temp hard-link race changed HISTORY bytes');
  sameIdentity(lstatSync(v1TempFiles.history), v1TempHistoryIdentity, 'v1 projection-temp hard-link race HISTORY');
  assert.deepEqual(readFileSync(v1TempFiles.current), v1TempCurrent, 'v1 projection-temp hard-link race changed CURRENT bytes');
  sameIdentity(lstatSync(v1TempFiles.current), v1TempCurrentIdentity, 'v1 projection-temp hard-link race CURRENT');
}

async function assertDescriptorBoundAppendRaces(makeRoot) {
  for (const mode of ['growth', 'shrink', 'swap']) {
    const root = makeRoot(`integration-v2-append-${mode}`);
    const input = initInput(`v2-append-${mode}`);
    initializeV2(root, input, { clock: () => new Date('2026-08-16T00:00:00.000Z') });
    const files = storePaths(root);
    const draftFile = path.join(root, `v2-${mode}-draft.json`);
    writeFileSync(draftFile, `${JSON.stringify(taskDraft(`v2-append-${mode}`, input))}\n`);
    const historyBefore = readFileSync(files.history);
    const currentBefore = readFileSync(files.current);
    const currentIdentity = lstatSync(files.current);
    let expectedHistory;
    let displaced;
    const race = await runBarrierRace({
      point: 'journal-append-before-write',
      command: process.execPath,
      args: journalChildArgs('append', root, draftFile),
      mutate: ({ history }) => {
        if (mode === 'growth') {
          const external = Buffer.from('external-growth');
          appendFileSync(history, external);
          expectedHistory = Buffer.concat([historyBefore, external]);
        } else if (mode === 'shrink') {
          expectedHistory = historyBefore.subarray(0, historyBefore.length - 1);
          writeFileSync(history, expectedHistory);
        } else {
          displaced = `${history}.externally-displaced`;
          renameSync(history, displaced);
          writeFileSync(history, historyBefore);
          expectedHistory = historyBefore;
        }
      },
    });
    assert.equal(race.code, 3, `v2 append ${mode}\n${race.stderr}`);
    assert.deepEqual(readFileSync(files.history), expectedHistory, `v2 append ${mode} wrote after descriptor mismatch`);
    if (displaced) assert.deepEqual(readFileSync(displaced), historyBefore, 'v2 append swap changed displaced journal');
    assert.deepEqual(readFileSync(files.current), currentBefore, `v2 append ${mode} changed CURRENT bytes`);
    sameIdentity(lstatSync(files.current), currentIdentity, `v2 append ${mode} CURRENT`);
  }

  for (const mode of ['growth', 'shrink', 'swap']) {
    const root = makeRoot(`integration-v1-append-${mode}`);
    const initialized = runCli(helper, root, ['init']);
    assert.equal(initialized.status, 0, initialized.stderr);
    const files = storePaths(root);
    const candidate = legacyCandidate(root, `v1-append-${mode}`);
    const historyBefore = readFileSync(files.history);
    const currentBefore = readFileSync(files.current);
    const currentIdentity = lstatSync(files.current);
    let expectedHistory;
    let displaced;
    const race = await runBarrierRace({
      point: 'legacy-append-before-write',
      command: process.execPath,
      args: [helper, '--root', root, 'checkpoint', '--file', candidate],
      mutate: ({ history }) => {
        if (mode === 'growth') {
          const external = Buffer.from('external-growth');
          appendFileSync(history, external);
          expectedHistory = Buffer.concat([historyBefore, external]);
        } else if (mode === 'shrink') {
          expectedHistory = historyBefore.subarray(0, historyBefore.length - 1);
          writeFileSync(history, expectedHistory);
        } else {
          displaced = `${history}.externally-displaced`;
          renameSync(history, displaced);
          writeFileSync(history, historyBefore);
          expectedHistory = historyBefore;
        }
      },
    });
    assert.equal(race.code, 3, `v1 append ${mode}\n${race.stderr}`);
    assert.deepEqual(readFileSync(files.history), expectedHistory, `v1 append ${mode} wrote after descriptor mismatch`);
    if (displaced) assert.deepEqual(readFileSync(displaced), historyBefore, 'v1 append swap changed displaced journal');
    assert.deepEqual(readFileSync(files.current), currentBefore, `v1 append ${mode} changed CURRENT bytes`);
    sameIdentity(lstatSync(files.current), currentIdentity, `v1 append ${mode} CURRENT`);
  }
}

export async function run() {
  const roots = [];
  const makeRoot = (label) => { const root = makeRepository(label); roots.push(root); return root; };
  try {
    assertSemanticTreeIdentityFingerprint(makeRoot);
    assertRepositoryTruthFingerprint(makeRoot);
    assertPreOpenOwnedReadBoundary(makeRoot);
    await assertMainOptionValueBoundaries(makeRoot);
    await assertPublicOptionBoundaries(makeRoot);
    assertTerminalActorAppendPreflight(makeRoot);
    assertD19PublicAppendSnapshot(makeRoot);
    assertD19MarkerAfterSnapshotBarrier(makeRoot);
    assertD19MalformedRootPreflight(makeRoot);
    await assertD20RetainedInLockMarkerRace(makeRoot);
    await assertProjectionIdentityRaces(makeRoot);
    await assertPriorCurrentHardLinkRaces(makeRoot);
    await assertProjectionRollbackRecoveryRaces(makeRoot);
    await assertCleanupIdentityRaces(makeRoot);
    await assertCleanupHardLinkRaces(makeRoot);
    await assertDescriptorBoundAppendRaces(makeRoot);

    const parserRoot = makeRoot('integration-migration-parser');
    const migrationCalls = [];
    const migrationCommandHandler = fakeHandler(migrationCalls, 71);
    for (const args of [
      ['migrate', '--to', '2'],
      ['migrate', '--to', '2', '--dry-run'],
      ['migrate', '--to', '2', '--resume'],
      ['migrate', '--to', '2', '--rollback'],
    ]) {
      const result = await invokeMain(parserRoot, args, { migrationCommandHandler });
      assert.equal(result.status, 71, `${args.join(' ')}\n${result.stderr}`);
    }
    assert.equal(migrationCalls.length, 4);

    const rejected = [
      ['migrate', '--to', '2', '--resume', '--resume'],
      ['migrate', '--to', '2', '--rollback', '--rollback'],
      ['migrate', '--to', '2', '--resume', '--rollback'],
      ['migrate', '--to', '2', '--resume', '--dry-run'],
      ['migrate', '--to', '2', '--rollback', '--dry-run'],
      ['migrate', '--to', '1'],
      ['validate', '--resume'],
      ['doctor', '--rollback'],
    ];
    for (const args of rejected) {
      const result = await invokeMain(parserRoot, args, { migrationCommandHandler });
      assert.equal(result.status, 2, `${args.join(' ')}\n${result.stderr}`);
      assert.equal(migrationCalls.length, 4, 'rejected migration argv reached the injected handler');
    }
    const opaque = '--resume=credential-like-value';
    const nonEcho = await invokeMain(parserRoot, ['migrate', '--to', '2', opaque], { migrationCommandHandler });
    assert.equal(nonEcho.status, 2);
    assert.equal(`${nonEcho.stdout}${nonEcho.stderr}`.includes(opaque), false);
    assert.equal(migrationCalls.length, 4, 'opaque invalid migration argv reached the injected handler');

    const pathsRoot = makeRoot('integration-migration-paths');
    const exact = storePaths(pathsRoot);
    assert.equal(path.basename(exact.migrationMarker), 'MIGRATION.v1-to-v2.json');
    assert.equal(path.basename(exact.historyV1), 'HISTORY.v1.ndjson');
    assert.equal(path.basename(exact.currentV1), 'CURRENT.v1.json');
    mkdirSync(exact.store, { recursive: true });
    writeFileSync(path.join(exact.store, 'MIGRATION.json'), '{}\n');
    assert.equal(detectStoreVersion(pathsRoot), 'uninitialized');
    writeFileSync(exact.historyV1, 'synthetic archive bytes\n');
    assert.equal(detectStoreVersion(pathsRoot), 'uninitialized');
    writeFileSync(exact.migrationMarker, '{}\n');
    assert.equal(detectStoreVersion(pathsRoot), 'interrupted-migration');
    const markerLink = path.join(pathsRoot, 'marker-hardlink.json');
    linkSync(exact.migrationMarker, markerLink);
    assert.throws(() => detectStoreVersion(pathsRoot), MemoryError);
    unlinkSync(markerLink);
    const archiveLink = path.join(pathsRoot, 'archive-hardlink.ndjson');
    linkSync(exact.historyV1, archiveLink);
    assert.throws(() => detectStoreVersion(pathsRoot), MemoryError);
    unlinkSync(archiveLink);

    for (const [label, selectTarget] of [
      ['marker', (files) => files.migrationMarker],
      ['archive', (files) => files.historyV1],
    ]) {
      const danglingRoot = makeRoot(`integration-dangling-${label}`);
      const dangling = storePaths(danglingRoot);
      mkdirSync(dangling.store, { recursive: true });
      let linked = false;
      try {
        symlinkSync('missing-synthetic-target', selectTarget(dangling), 'file');
        linked = true;
      } catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error?.code)) throw error;
      }
      if (linked) {
        assert.throws(
          () => detectStoreVersion(danglingRoot),
          (error) => error instanceof MemoryError && error.exitCode === 3,
          `dangling ${label} link did not fail closed`,
        );
      }
    }
    const interruptedRoot = makeRoot('integration-interrupted');
    let result = runCli(helper, interruptedRoot, ['init']);
    assert.equal(result.status, 0, result.stderr);
    const interrupted = storePaths(interruptedRoot);
    writeFileSync(interrupted.migrationMarker, '{}\n');
    assert.equal(detectStoreVersion(interruptedRoot), 'interrupted-migration');
    const interruptedHistory = readFileSync(interrupted.history);
    const interruptedMarker = readFileSync(interrupted.migrationMarker);
    const interruptedCurrent = readFileSync(interrupted.current);
    const interruptedFileSet = readdirSync(interrupted.store).sort();
    for (const action of ['--resume', '--rollback']) {
      result = runCli(helper, interruptedRoot, ['init', action]);
      assert.equal(result.status, 2, `${action}\n${result.stderr}`);
      assert.deepEqual(readdirSync(interrupted.store).sort(), interruptedFileSet);
      assert.deepEqual(readFileSync(interrupted.history), interruptedHistory);
      assert.deepEqual(readFileSync(interrupted.current), interruptedCurrent);
      assert.deepEqual(readFileSync(interrupted.migrationMarker), interruptedMarker);
    }
    result = runCli(helper, interruptedRoot, ['init']);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /mutation is blocked by interrupted migration/);
    assert.deepEqual(readdirSync(interrupted.store).sort(), interruptedFileSet);
    assert.deepEqual(readFileSync(interrupted.history), interruptedHistory);
    assert.deepEqual(readFileSync(interrupted.current), interruptedCurrent);
    assert.deepEqual(readFileSync(interrupted.migrationMarker), interruptedMarker);
    const interruptedMigrationCalls = [];
    const interruptedMigrationHandler = fakeHandler(interruptedMigrationCalls, 72);
    for (const command of ['validate', 'doctor']) {
      result = await invokeMain(interruptedRoot, [command], { migrationCommandHandler: interruptedMigrationHandler });
      assert.equal(result.status, 72, result.stderr);
    }
    assert.deepEqual(interruptedMigrationCalls.map((call) => call.operation), ['validate-marker', 'doctor-marker']);
    const interruptedContinuityCalls = [];
    result = await invokeMain(interruptedRoot, ['inspect'], {
      continuityCommandHandler: fakeHandler(interruptedContinuityCalls, 73),
    });
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /migration is interrupted/);
    assert.equal(interruptedContinuityCalls.length, 0, 'interrupted inspect reached the continuity handler');
    assert.deepEqual(readFileSync(interrupted.history), interruptedHistory);
    assert.deepEqual(readFileSync(interrupted.migrationMarker), interruptedMarker);

    const corruptOrderingRoot = makeRoot('integration-corrupt-ordering');
    result = runCli(helper, corruptOrderingRoot, ['init']);
    assert.equal(result.status, 0, result.stderr);
    const corruptOrdering = storePaths(corruptOrderingRoot);
    writeFileSync(corruptOrdering.history, '{broken\n');
    const corruptOrderingFiles = readdirSync(corruptOrdering.store).sort();
    const corruptOrderingHistory = readFileSync(corruptOrdering.history);
    const corruptOrderingCurrent = readFileSync(corruptOrdering.current);
    result = runCli(helper, corruptOrderingRoot, ['init', '--resume']);
    assert.equal(result.status, 3, result.stderr);
    assert.deepEqual(readdirSync(corruptOrdering.store).sort(), corruptOrderingFiles);
    assert.deepEqual(readFileSync(corruptOrdering.history), corruptOrderingHistory);
    assert.deepEqual(readFileSync(corruptOrdering.current), corruptOrderingCurrent);

    const migratedRoot = makeRoot('integration-migrated-archive');
    const { events, receiptEvent } = migratedEvents();
    const files = writeV2Journal(migratedRoot, events);
    const migratedValidationCalls = [];
    result = await invokeMain(migratedRoot, ['validate'], {
      migrationCommandHandler: fakeHandler(migratedValidationCalls, 74),
    });
    assert.equal(result.status, 74, result.stderr);
    assert.deepEqual(migratedValidationCalls.map((call) => call.operation), ['validate-v1-archive']);
    assert.equal(readFileSync(files.history, 'utf8').split('\n').filter(Boolean).length, 2);

    let callbackCount = 0;
    const journal = readV2Journal(migratedRoot, {
      validateLegacyArchive: (details) => {
        callbackCount += 1;
        assert.equal(details.root, migratedRoot);
        assert.equal(details.files.historyV1, files.historyV1);
        assert.deepEqual(details.receiptEvent, receiptEvent);
        assert.equal(details.state.schemaVersion, 2);
        return true;
      },
    });
    assert.equal(journal.events.length, 2);
    assert.equal(callbackCount, 1);
    writeFileSync(files.historyV1, 'synthetic immutable archive bytes\n');
    writeFileSync(files.current, `${JSON.stringify(journal.state)}\n`);
    const callbackProtectedFiles = readdirSync(files.store).sort();
    const callbackProtectedHistory = readFileSync(files.history);
    const callbackProtectedArchive = readFileSync(files.historyV1);
    const forgedHistory = path.join(migratedRoot, 'forged-history.ndjson');
    let callbackDetails;
    let mutationResults;
    const defendedJournal = readV2Journal(migratedRoot, {
      validateLegacyArchive: (details) => {
        callbackDetails = details;
        mutationResults = [
          Reflect.set(details.files, 'history', forgedHistory),
          Reflect.set(details.receiptEvent, 'eventType', 'project.initialized'),
          Reflect.set(details.receiptEvent.payload, 'archiveHistory', 'forged-history.ndjson'),
          Reflect.set(details.state, 'schemaVersion', 1),
          Reflect.set(details.state.project, 'projectId', 'project-forged'),
        ];
        return true;
      },
    });
    assert.deepEqual(mutationResults, [false, false, false, false, false], 'archive callback received mutable authority');
    assert.equal(Object.isFrozen(callbackDetails.files), true);
    assert.equal(Object.isFrozen(callbackDetails.receiptEvent), true);
    assert.equal(Object.isFrozen(callbackDetails.receiptEvent.payload), true);
    assert.equal(Object.isFrozen(callbackDetails.state), true);
    assert.equal(Object.isFrozen(callbackDetails.state.project), true);
    assert.notEqual(callbackDetails.files, defendedJournal.files);
    assert.notEqual(callbackDetails.receiptEvent, defendedJournal.events[1]);
    assert.notEqual(callbackDetails.receiptEvent.payload, defendedJournal.events[1].payload);
    assert.notEqual(callbackDetails.state, defendedJournal.state);
    assert.notEqual(callbackDetails.state.project, defendedJournal.state.project);
    assert.equal(defendedJournal.files.history, files.history);
    assert.equal(defendedJournal.events[1].eventType, 'migration.v1_imported');
    assert.equal(defendedJournal.events[1].payload.archiveHistory, 'HISTORY.v1.ndjson');
    assert.equal(defendedJournal.state.schemaVersion, 2);
    assert.equal(defendedJournal.state.project.projectId, 'project-migration-seam');
    assert.deepEqual(readdirSync(files.store).sort(), callbackProtectedFiles);
    assert.deepEqual(readFileSync(files.history), callbackProtectedHistory);
    assert.deepEqual(readFileSync(files.historyV1), callbackProtectedArchive);
    for (const nonSuccess of [false, undefined, 0, {}, 'true']) {
      assert.throws(
        () => readV2Journal(migratedRoot, {
          validateLegacyArchive: () => nonSuccess,
        }),
        (error) => error instanceof MemoryError
          && error.exitCode === 3
          && error.message === 'legacy archive validation failed',
        `archive validation accepted ${String(nonSuccess)} instead of literal true`,
      );
      assert.deepEqual(readdirSync(files.store).sort(), callbackProtectedFiles);
      assert.deepEqual(readFileSync(files.history), callbackProtectedHistory);
      assert.deepEqual(readFileSync(files.historyV1), callbackProtectedArchive);
    }
    const sensitiveCallbackText = 'Bearer callback-secret-must-not-echo';
    assert.throws(
      () => readV2Journal(migratedRoot, {
        validateLegacyArchive: () => { throw new MemoryError(sensitiveCallbackText, 2); },
      }),
      (error) => error instanceof MemoryError
        && error.exitCode === 3
        && error.message === 'legacy archive validation failed'
        && !error.message.includes(sensitiveCallbackText),
    );
    assert.throws(
      () => readV2Journal(migratedRoot, {
        validateLegacyArchive: () => { throw new Error('opaque callback failure must not escape'); },
      }),
      (error) => error instanceof MemoryError && error.exitCode === 3 && error.message === 'legacy archive validation failed',
    );
    assert.throws(
      () => readV2Journal(migratedRoot, {
        validateLegacyArchive: () => Promise.resolve('asynchronous success is not authoritative'),
      }),
      (error) => error instanceof MemoryError && error.exitCode === 3 && error.message === 'legacy archive validation failed',
      'archive validation accepted an asynchronous success',
    );
    assert.deepEqual(readdirSync(files.store).sort(), callbackProtectedFiles);
    assert.deepEqual(readFileSync(files.history), callbackProtectedHistory);
    assert.deepEqual(readFileSync(files.historyV1), callbackProtectedArchive);
    assert.throws(
      () => readV2Journal(migratedRoot, {
        validateLegacyArchive: () => Promise.reject(new Error('Bearer rejected-validator-secret')),
      }),
      (error) => error instanceof MemoryError
        && error.exitCode === 3
        && error.message === 'legacy archive validation failed'
        && !error.message.includes('rejected-validator-secret'),
      'archive validation accepted an asynchronously rejected result',
    );
    assert.deepEqual(readdirSync(files.store).sort(), callbackProtectedFiles);
    assert.deepEqual(readFileSync(files.history), callbackProtectedHistory);
    assert.deepEqual(readFileSync(files.historyV1), callbackProtectedArchive);
    assert.throws(
      () => readV2Journal(migratedRoot, {
        validateLegacyArchive: () => ({ then: () => 'custom thenable must not be awaited' }),
      }),
      (error) => error instanceof MemoryError && error.exitCode === 3 && error.message === 'legacy archive validation failed',
      'archive validation accepted a custom thenable',
    );
    assert.deepEqual(readdirSync(files.store).sort(), callbackProtectedFiles);
    assert.deepEqual(readFileSync(files.history), callbackProtectedHistory);
    assert.deepEqual(readFileSync(files.historyV1), callbackProtectedArchive);

    let callerFileSystemCalls = 0;
    const callerFileSystem = new Proxy({}, {
      get() { callerFileSystemCalls += 1; throw new Error('caller filesystem authority was invoked'); },
      ownKeys() { callerFileSystemCalls += 1; throw new Error('caller filesystem authority was inspected'); },
      getOwnPropertyDescriptor() { callerFileSystemCalls += 1; throw new Error('caller filesystem authority was inspected'); },
    });
    assert.throws(
      () => readV2Journal(migratedRoot, { fileSystem: callerFileSystem }),
      (error) => error instanceof MemoryError
        && error.exitCode === 3
        && error.message === 'readV2Journal options are invalid',
      'public replay accepted caller filesystem authority',
    );
    assert.equal(callerFileSystemCalls, 0, 'public replay called or inspected caller filesystem authority');
    assert.deepEqual(readdirSync(files.store).sort(), callbackProtectedFiles);
    assert.deepEqual(readFileSync(files.history), callbackProtectedHistory);
    assert.deepEqual(readFileSync(files.historyV1), callbackProtectedArchive);
    assert.throws(
      () => readV2Journal(migratedRoot, {}, { fileSystem: callerFileSystem }),
      (error) => error instanceof MemoryError
        && error.exitCode === 3
        && error.message === 'readV2Journal options are invalid',
      'public replay accepted a third authority argument',
    );
    assert.equal(callerFileSystemCalls, 0, 'third-argument rejection called caller filesystem authority');
    assert.deepEqual(readdirSync(files.store).sort(), callbackProtectedFiles);
    assert.deepEqual(readFileSync(files.history), callbackProtectedHistory);
    assert.deepEqual(readFileSync(files.historyV1), callbackProtectedArchive);

    const linkedPrimaryRoot = makeRoot('integration-linked-worktree');
    const linkedRoot = path.join(linkedPrimaryRoot, 'linked-worktree');
    execFileSync('git', ['-C', linkedPrimaryRoot, 'worktree', 'add', '-q', '--detach', linkedRoot, 'HEAD']);
    try {
      const linkedRootBefore = snapshotRepositoryTruth(linkedRoot);
      assert.throws(
        () => initializeV2(linkedRoot, {
          schemaVersion: 2,
          project: {
            projectId: 'project-linked-worktree', name: 'Linked worktree fixture',
            identity: 'Synthetic repository only', implementationBoundaries: ['No linked-worktree mutation'],
            operatingRules: ['Preserve the primary journal'],
          },
          finalGoal: {
            goalId: 'goal-linked-worktree', title: 'Reject linked-worktree mutation',
            outcome: 'No filesystem side effects', isFinal: true, authority: 'user', basis: 'user_stated', criterionIds: [],
          },
          actor: { kind: 'user', id: 'actor-user', role: 'user' },
          occurredAt: '2026-08-16T00:00:00.000Z', evidenceRef: 'evidence-linked-worktree',
        }, { clock: () => new Date('2026-08-16T00:00:00.000Z') }),
        (error) => error instanceof MemoryError
          && error.exitCode === 3
          && error.message === 'mutating continuity is refused in linked worktrees',
        'v2 initialization did not preserve the linked-worktree mutation refusal',
      );
      assert.deepEqual(
        snapshotRepositoryTruth(linkedRoot), linkedRootBefore,
        'linked-worktree rejection changed semantic repository truth',
      );
    } finally {
      execFileSync('git', ['-C', linkedPrimaryRoot, 'worktree', 'remove', '--force', linkedRoot]);
    }

    const externalGitRoot = makeRoot('integration-external-git-admin');
    const externalGitAdmin = path.join(path.dirname(externalGitRoot), `${path.basename(externalGitRoot)}.git-admin`);
    roots.push(externalGitAdmin);
    renameSync(path.join(externalGitRoot, '.git'), externalGitAdmin);
    writeFileSync(path.join(externalGitRoot, '.git'), `gitdir: ${externalGitAdmin.replaceAll('\\', '/')}\n`);
    execFileSync('git', ['-C', externalGitRoot, 'status', '--short']);
    const externalRootBefore = snapshotRepositoryTruth(externalGitRoot);
    assert.throws(
      () => initializeV2(externalGitRoot, {
        schemaVersion: 2,
        project: {
          projectId: 'project-external-git-admin', name: 'External Git admin fixture',
          identity: 'Synthetic repository only', implementationBoundaries: ['No external lock writes'],
          operatingRules: ['Reject unsafe Git topology'],
        },
        finalGoal: {
          goalId: 'goal-external-git-admin', title: 'Reject external lock topology',
          outcome: 'No filesystem side effects', isFinal: true, authority: 'user', basis: 'user_stated', criterionIds: [],
        },
        actor: { kind: 'user', id: 'actor-user', role: 'user' },
        occurredAt: '2026-08-16T00:00:00.000Z', evidenceRef: 'evidence-external-git-admin',
      }, { clock: () => new Date('2026-08-16T00:00:00.000Z') }),
      (error) => error instanceof MemoryError && error.exitCode === 3,
      'v2 initialization accepted an external Git administration directory',
    );
    assert.deepEqual(
      snapshotRepositoryTruth(externalGitRoot), externalRootBefore,
      'external Git topology changed semantic repository truth',
    );

    const externalLegacyRoot = makeRoot('integration-external-v1-git-admin');
    const externalLegacyAdmin = path.join(path.dirname(externalLegacyRoot), `${path.basename(externalLegacyRoot)}.git-admin`);
    roots.push(externalLegacyAdmin);
    renameSync(path.join(externalLegacyRoot, '.git'), externalLegacyAdmin);
    writeFileSync(path.join(externalLegacyRoot, '.git'), `gitdir: ${externalLegacyAdmin.replaceAll('\\', '/')}\n`);
    execFileSync('git', ['-C', externalLegacyRoot, 'status', '--short']);
    const externalLegacyRootBefore = snapshotRepositoryTruth(externalLegacyRoot);
    result = runCli(helper, externalLegacyRoot, ['init']);
    assert.equal(result.status, 3, result.stderr);
    assert.deepEqual(
      snapshotRepositoryTruth(externalLegacyRoot), externalLegacyRootBefore,
      'legacy init changed external-admin semantic repository truth',
    );

    assertInspectSchema();

    const v1Root = makeRoot('integration-v1-dispatch');
    result = runCli(helper, v1Root, ['init']);
    assert.equal(result.status, 0, result.stderr);
    result = runCli(helper, v1Root, ['inspect']);
    assert.equal(result.status, 0, result.stderr);
    result = runCli(helper, v1Root, ['history', '--tail', '1']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^#1 /);

    const unsafeV1 = storePaths(v1Root);
    writeFileSync(unsafeV1.historyV1, 'synthetic unsafe archive\n');
    const unsafeArchiveLink = path.join(v1Root, 'unsafe-archive-hardlink.ndjson');
    linkSync(unsafeV1.historyV1, unsafeArchiveLink);
    const unsafeRootSet = readdirSync(v1Root).sort();
    const unsafeStoreSet = readdirSync(unsafeV1.store).sort();
    const unsafeHistory = readFileSync(unsafeV1.history);
    const unsafeCurrent = readFileSync(unsafeV1.current);
    const unsafeArchive = readFileSync(unsafeV1.historyV1);
    result = runCli(helper, v1Root, ['init', '--rollback']);
    assert.equal(result.status, 3, result.stderr);
    assert.deepEqual(readdirSync(v1Root).sort(), unsafeRootSet);
    assert.deepEqual(readdirSync(unsafeV1.store).sort(), unsafeStoreSet);
    assert.deepEqual(readFileSync(unsafeV1.history), unsafeHistory);
    assert.deepEqual(readFileSync(unsafeV1.current), unsafeCurrent);
    assert.deepEqual(readFileSync(unsafeV1.historyV1), unsafeArchive);
    result = runCli(helper, v1Root, ['inspect']);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /continuity: ERROR:/);
    assert.doesNotMatch(result.stdout, /Project memory snapshot/);
    assert.deepEqual(readdirSync(v1Root).sort(), unsafeRootSet);
    assert.deepEqual(readdirSync(unsafeV1.store).sort(), unsafeStoreSet);
    assert.deepEqual(readFileSync(unsafeV1.history), unsafeHistory);
    assert.deepEqual(readFileSync(unsafeV1.current), unsafeCurrent);
    assert.deepEqual(readFileSync(unsafeV1.historyV1), unsafeArchive);

    const dashedParent = makeRoot('integration-dashed-root-parent');
    const dashedRoot = path.join(dashedParent, '--graph');
    mkdirSync(dashedRoot);
    execFileSync('git', ['init', '-q', dashedRoot]);
    execFileSync('git', ['-C', dashedRoot, 'config', 'user.email', 'fixture@example.invalid']);
    execFileSync('git', ['-C', dashedRoot, 'config', 'user.name', 'Continuity Fixture']);
    writeFileSync(path.join(dashedRoot, 'README.md'), '# Dashed synthetic fixture\n');
    execFileSync('git', ['-C', dashedRoot, 'add', 'README.md']);
    execFileSync('git', ['-C', dashedRoot, 'commit', '-qm', 'fixture']);
    result = runCli(helper, dashedRoot, ['init']);
    assert.equal(result.status, 0, result.stderr);
    result = spawnSync(process.execPath, [helper, '--root', '--graph', 'inspect'], {
      cwd: dashedParent, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
    });
    assert.equal(result.status, 0, result.stderr);

    result = runCli(helper, migratedRoot, ['history', '--tail', '1']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /migration\.v1_imported/);
    const continuityCalls = [];
    result = await invokeMain(migratedRoot, ['history', '--subject', 'project-migration-seam'], {
      continuityCommandHandler: fakeHandler(continuityCalls, 75),
    });
    assert.equal(result.status, 75, result.stderr);
    assert.deepEqual(continuityCalls.map((call) => call.operation), ['history']);
    assert.equal(result.stdout, '');

    const graphRoot = makeRoot('integration-graphify-parser');
    const graphifyCalls = [];
    const graphifyCommandHandler = fakeHandler(graphifyCalls, 76);
    for (const args of [
      ['graphify', 'observe'],
      ['graphify', 'observe', '--graph', 'graphify-out/graph.json', '--json'],
      ['graphify', 'query', '--graph', 'graphify-out/graph.json', '--', 'query', 'symbol-name'],
      ['graphify', 'query', '--graph', 'graphify-out/custom.json', '--timeout-ms', '2500', '--', 'path', 'symbol-name'],
      ['graphify', 'query', '--', 'explain', 'symbol-name'],
      ['graphify', 'query', '--graph', 'graphify-out/graph.json', '--', 'query', '--timeout-ms', '999999', '--graph', '../opaque-data'],
    ]) {
      result = await invokeMain(graphRoot, args, { graphifyCommandHandler });
      assert.equal(result.status, 76, `${args.join(' ')}\n${result.stderr}`);
    }
    assert.equal(graphifyCalls.length, 6, 'valid Graphify argv did not reach the injected handler exactly once');
    assert.deepEqual(graphifyCalls.map((call) => call.args), [
      ['observe'], ['observe'], ['query'], ['query'], ['query'], ['query'],
    ]);
    assert.equal(existsSync(path.join(graphRoot, '.continuity')), false, 'Graphify routing created a Continuity store');

    for (const args of [
      ['graphify', 'query', '--graph', 'graphify-out/graph.json'],
      ['graphify', 'query', '--graph', 'graphify-out/graph.json', '--'],
      ['graphify', 'query', '--graph', 'graphify-out/graph.json', '--', '--'],
      ['graphify', 'query', '--graph', 'graphify-out/graph.json', 'query', 'symbol-name'],
      ['graphify', 'query', '--graph', 'graphify-out/graph.json', '--unknown', '--', 'query', 'symbol-name'],
      ['graphify', 'query', '--graph', 'graphify-out/graph.json', '--graph', 'graphify-out/other.json', '--', 'query', 'symbol-name'],
      ['graphify', 'query', '--timeout-ms', '999', '--', 'query', 'symbol-name'],
      ['graphify', 'query', '--timeout-ms', '30001', '--', 'query', 'symbol-name'],
      ['graphify', 'query', '--timeout-ms', '1.5', '--', 'query', 'symbol-name'],
      ['graphify', 'query', '--timeout-ms', '1000', '--timeout-ms', '2000', '--', 'query', 'symbol-name'],
      ['graphify', 'query', '--json', '--', 'query', 'symbol-name'],
      ['graphify', 'observe', '--timeout-ms', '1000'],
      ['graphify', 'observe', '--', 'query', 'symbol-name'],
      ['graphify', 'unknown'],
    ]) {
      result = await invokeMain(graphRoot, args, { graphifyCommandHandler });
      assert.equal(result.status, 2, `${args.join(' ')}\n${result.stderr}`);
      assert.equal(graphifyCalls.length, 6, 'rejected Graphify argv reached the injected handler');
    }

    for (const args of [
      ['validate', '--graph', 'graphify-out/graph.json'],
      ['doctor', '--timeout-ms', '1000'],
      ['history', '--', 'query'],
    ]) {
      result = runCli(helper, parserRoot, args);
      assert.equal(result.status, 2, `${args.join(' ')}\n${result.stderr}`);
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}
