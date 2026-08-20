import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { captureAuthoritativeInput } from '../../continuity/scripts/lib/core/input-v3.mjs';
import {
  MemoryError, classifyRisk, foldV3, validateDraftV3,
} from '../../continuity/scripts/lib/core/domain-v3.mjs';
import { appendV3, initializeV3, readV3Journal, rebuildV3 } from '../../continuity/scripts/lib/core/journal-v3.mjs';
import { recipeEvidence, recipeFail, recipeResult, recipeStart, recipeTask } from '../../continuity/scripts/lib/core/recipes-v3.mjs';
import { buildInspectV3, liveContextFromWorkspace, renderInspectText } from '../../continuity/scripts/lib/core/inspect-v3.mjs';
import { gitAdminTopology } from '../../continuity/scripts/lib/core/store.mjs';

const CLI = fileURLToPath(new URL('../../continuity/scripts/continuity.mjs', import.meta.url));

class CaseSkip extends Error {}

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function git(root, args) {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

function makeRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pm-v3-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'V3 Test']);
  git(root, ['config', 'user.email', 'v3@example.invalid']);
  writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

const clock = () => new Date('2026-08-18T00:00:00.000Z');

const INIT = {
  schemaVersion: 3,
  project: {
    projectId: 'project-demo',
    name: 'Demo',
    identity: 'v3 fixture',
    implementationBoundaries: ['Synthetic only'],
    operatingRules: ['No network'],
  },
  finalGoal: {
    goalId: 'goal-final',
    title: 'Remember honestly',
    outcome: 'Inspect tells the truth',
    isFinal: true,
    authority: 'user',
    basis: 'user_stated',
    criterionIds: ['criterion-honest'],
  },
  criterion: {
    criterionId: 'criterion-honest',
    ownerType: 'goal',
    ownerId: 'goal-final',
    condition: 'Success has evidence',
    scope: 'fixture',
    requiredEvidenceKinds: ['command'],
    freshnessPolicy: { kind: 'source_digest' },
    waivableByUser: false,
  },
  actor: { kind: 'user', id: 'actor-user', role: 'user' },
  occurredAt: '2026-08-18T00:00:00.000Z',
};

function actor(kind = 'coordinator') {
  return { kind, id: `actor-${kind}`, role: kind, runId: `run-${kind}` };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function persistenceFingerprint(root) {
  const store = readV3Journal(root);
  const history = readFileSync(store.files.history);
  const current = readFileSync(store.files.current);
  return {
    historySha256: sha256(history),
    currentSha256: sha256(current),
    records: store.events.length,
    lastEventHash: store.events.at(-1).eventHash,
    lockExists: existsSync(gitAdminTopology(root).lock),
  };
}

function cliEnv() {
  return {
    ...process.env,
    PATH: ['C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\Git\\bin', process.env.PATH]
      .filter(Boolean)
      .join(path.delimiter),
    NO_COLOR: '1',
  };
}

function runProjectMemory(root, args) {
  return spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    env: cliEnv(),
    maxBuffer: 1024 * 1024,
  });
}

export const CASES = Object.freeze([
  {
    id: 'V3-001-object-input-rejected',
    async run() {
      const reads = [];
      const proxy = new Proxy({ eventType: 'task.planned' }, {
        get(target, property) {
          reads.push(String(property));
          return target[property];
        },
      });
      assert.throws(() => captureAuthoritativeInput(proxy), MemoryError);
      assert.equal(reads.includes('eventType'), false);
    },
  },
  {
    id: 'V3-002-success-without-evidence-rejected',
    async run() {
      assert.equal(classifyRisk('result.recorded', { result: { execution: 'succeeded' } }), 'significant');
      const draft = {
        eventType: 'result.recorded',
        occurredAt: '2026-08-18T00:00:00.000Z',
        actor: actor(),
        subject: { type: 'result', id: 'result-one' },
        supersedes: [],
        contradicts: [],
        evidenceRefs: [],
        sensitivity: 'internal',
        payload: {
          result: {
            resultId: 'result-one',
            goalId: 'goal-final',
            criterionIds: ['criterion-honest'],
            taskId: 'task-alpha',
            attemptId: 'attempt-one',
            actor: actor(),
            expected: 'ok',
            actual: 'ok',
            execution: 'succeeded',
            verification: 'passed',
            acceptance: 'pending',
            evidenceIds: [],
            verificationMethod: 'none',
          },
        },
      };
      assert.throws(() => validateDraftV3(draft), /succeeded requires authorizing evidence|final goal|task/);
    },
  },
  {
    id: 'V3-003-user-only-acceptance',
    async run() {
      const draft = {
        eventType: 'feedback.recorded',
        occurredAt: '2026-08-18T00:00:00.000Z',
        actor: actor('coordinator'),
        subject: { type: 'result', id: 'result-one' },
        supersedes: [],
        contradicts: [],
        evidenceRefs: ['evidence-user'],
        sensitivity: 'internal',
        payload: {
          feedback: {
            feedbackId: 'feedback-user',
            subjectId: 'result-one',
            disposition: 'satisfied',
            acceptance: 'accepted',
            statement: 'looks good',
            evidenceId: 'evidence-user',
          },
        },
      };
      assert.throws(() => validateDraftV3(draft), /only the user may set acceptance/);
    },
  },
  {
    id: 'V3-004-oversized-input-rejected',
    async run() {
      assert.throws(() => captureAuthoritativeInput(`{"x":"${'a'.repeat(70 * 1024)}"}`), MemoryError);
    },
  },
  {
    id: 'V3-005-init-record-rebuild',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, { actor: actor(), title: 'Ship memory' }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeStart(store, { actor: actor(), approach: 'recipes' }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeEvidence(store, {
          actor: actor(),
          expected: 'tests pass',
          actual: 'found=3 executed=3 passed=3',
          exitCode: 0,
        }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeResult(store, { actor: actor(), expected: 'tests pass', actual: '3 passed' }, { clock }), { clock });
        store = readV3Journal(root);
        const before = JSON.stringify(store.state);
        rmSync(store.files.current, { force: true });
        rebuildV3(root);
        store = readV3Journal(root);
        assert.equal(store.projection, 'current');
        assert.equal(JSON.stringify(store.state), before);
        const inspect = buildInspectV3(store, liveContextFromWorkspace(store.state.workspaceAtLastEvent));
        const text = renderInspectText(inspect);
        assert.match(text, /GOAL goal-final/);
        assert.match(text, /UNVERIFIED result-/);
        assert.doesNotMatch(text, /\bPASS\b/);
        assert.equal(foldV3(store.events).results.length, 1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'V3-006-hash-chain-corruption',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        const store = readV3Journal(root);
        const corrupted = store.events.map((event, index) => (
          index === 1 ? { ...event, eventHash: 'ab'.repeat(32) } : event
        ));
        assert.throws(() => foldV3(corrupted), /hash/);
        const reordered = [store.events[1], store.events[0]];
        assert.throws(() => foldV3(reordered), /hash-chain|sequence|version/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'V3-007-fail-recipe-keeps-next-action',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, { actor: actor(), title: 'Restore git' }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeStart(store, { actor: actor(), approach: 'search PATH' }, { clock }), { clock });
        store = readV3Journal(root);
        const drafts = recipeFail(store, { actor: actor(), why: 'git.exe missing', impact: 'cannot commit', next: 'Install Git' }, { clock });
        appendV3(root, drafts.lesson, { clock });
        appendV3(root, drafts.nextAction, { clock });
        appendV3(root, drafts.failure, { clock });
        store = readV3Journal(root);
        assert.equal(store.state.failures.length, 1);
        assert.equal(store.state.nextActions.length, 1);
        assert.equal(store.state.tasks[0].execution, 'failed');
        const inspect = renderInspectText(buildInspectV3(store, liveContextFromWorkspace(store.state.workspaceAtLastEvent)));
        assert.match(inspect, /FAILURES/);
        assert.match(inspect, /NEXT /);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'V3-008-inspect-live-dirty-and-head-not-fresh',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, { actor: actor(), title: 'Ship memory' }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeStart(store, { actor: actor(), approach: 'recipes' }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeEvidence(store, {
          actor: actor(),
          expected: 'tests pass',
          actual: 'found=1 executed=1 passed=1',
          exitCode: 0,
        }, { clock }), { clock });
        store = readV3Journal(root);
        const taskId = store.state.tasks[0].taskId;
        const beforeDirty = persistenceFingerprint(root);
        const readyClean = runProjectMemory(root, ['inspect', 'ready', '--json']);
        assert.equal(readyClean.status, 0, readyClean.stderr);
        assert.deepEqual(persistenceFingerprint(root), beforeDirty);
        const cleanView = JSON.parse(readyClean.stdout);
        writeFileSync(path.join(root, 'README.md'), 'dirty live inspect\n');
        const afterDirtyWrite = persistenceFingerprint(root);
        assert.deepEqual(afterDirtyWrite, beforeDirty);
        const readyDirty = runProjectMemory(root, ['inspect', 'ready', '--json']);
        assert.equal(readyDirty.status, 0, readyDirty.stderr);
        assert.deepEqual(persistenceFingerprint(root), beforeDirty);
        const dirtyView = JSON.parse(readyDirty.stdout);
        assert.equal(dirtyView.freshness[taskId], 'stale');
        git(root, ['add', 'README.md']);
        git(root, ['commit', '-qm', 'live head change']);
        const afterHead = persistenceFingerprint(root);
        assert.deepEqual(afterHead, beforeDirty);
        const readyHead = runProjectMemory(root, ['inspect', 'ready', '--json']);
        assert.equal(readyHead.status, 0, readyHead.stderr);
        assert.deepEqual(persistenceFingerprint(root), beforeDirty);
        const headView = JSON.parse(readyHead.stdout);
        assert.notEqual(headView.freshness[taskId], 'fresh');
        assert.notEqual(cleanView.freshness[taskId], 'stale');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'V3-009-user-reject-requires-next-and-links-feedback',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, { actor: actor(), title: 'Ship memory' }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeStart(store, { actor: actor(), approach: 'recipes' }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeEvidence(store, {
          actor: actor(),
          expected: 'tests pass',
          actual: 'found=1 executed=1 passed=1 failed=0',
          exitCode: 0,
        }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeResult(store, {
          actor: actor(), expected: 'pass', actual: 'pass',
        }, { clock }), { clock });
        store = readV3Journal(root);
        const resultId = store.state.results[0].resultId;
        const verification = store.state.results[0].verification;
        const before = persistenceFingerprint(root);
        const missing = runProjectMemory(root, ['record', 'reject', '--as', 'user', '--result', resultId]);
        assert.notEqual(missing.status, 0, missing.stdout);
        assert.equal(missing.stdout, '');
        assert.match(missing.stderr, /--next/i);
        assert.deepEqual(persistenceFingerprint(root), before);
        const coordinator = runProjectMemory(root, [
          'record', 'reject', '--as', 'coordinator', '--result', resultId, '--next', 'Retry with a new Attempt',
        ]);
        assert.notEqual(coordinator.status, 0, coordinator.stdout);
        assert.equal(coordinator.stdout, '');
        assert.match(coordinator.stderr, /only the user/i);
        assert.deepEqual(persistenceFingerprint(root), before);
        const rejected = runProjectMemory(root, [
          'record', 'reject', '--as', 'user', '--result', resultId, '--next', 'Retry with a new Attempt',
        ]);
        assert.equal(rejected.status, 0, rejected.stderr);
        store = readV3Journal(root);
        assert.equal(store.events.at(-3).eventType, 'next_action.recorded');
        assert.equal(store.events.at(-2).eventType, 'evidence.recorded');
        assert.equal(store.events.at(-1).eventType, 'feedback.recorded');
        assert.equal(store.state.feedback[0].disposition, 'rejected');
        assert.equal(store.state.feedback[0].nextActionId, store.state.nextActions[0].nextActionId);
        assert.equal(store.state.nextActions[0].action, 'Retry with a new Attempt');
        assert.equal(store.state.results[0].acceptance, 'rejected');
        assert.equal(store.state.results[0].verification, verification);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'V3-010-public-class-function-ready',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        const created = runProjectMemory(root, [
          'record', 'task',
          '--title', 'Ship function',
          '--priority', 'core',
          '--size', 'S',
          '--class', 'function',
        ]);
        assert.equal(created.status, 0, created.stderr);
        const taskId = JSON.parse(runProjectMemory(root, ['inspect', '--json']).stdout)
          .activeTasks.find((item) => item.title === 'Ship function')?.taskId;
        const ready = runProjectMemory(root, ['inspect', 'ready', '--json']);
        assert.equal(ready.status, 0, ready.stderr);
        const readyView = JSON.parse(ready.stdout);
        assert.equal(readyView.buildFirst.passed, false);
        assert.equal(readyView.availableTasks.find((item) => item.id === taskId)?.class, 'function');

        const omitted = runProjectMemory(root, ['record', 'task', '--title', 'Unclassified public task']);
        assert.equal(omitted.status, 0, omitted.stderr);
        const omittedId = JSON.parse(runProjectMemory(root, ['inspect', '--json']).stdout)
          .activeTasks.find((item) => item.title === 'Unclassified public task')?.taskId;
        const omittedReady = JSON.parse(runProjectMemory(root, ['inspect', 'ready', '--json']).stdout);
        assert.equal(omittedReady.availableTasks.some((item) => item.id === omittedId), false);
        assert.equal(
          omittedReady.excludedTasks.some((item) => item.taskId === omittedId && item.reason === 'unclassified-task-class'),
          true,
        );

        const beforeUnknown = persistenceFingerprint(root);
        const unknown = runProjectMemory(root, ['record', 'task', '--title', 'Mystery', '--class', 'mystery']);
        assert.notEqual(unknown.status, 0, unknown.stdout);
        assert.equal(unknown.stdout, '');
        assert.match(unknown.stderr, /task\.class is not an allowed enum/i);
        assert.deepEqual(persistenceFingerprint(root), beforeUnknown);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
]);

export async function run() {
  const report = await runCases();
  if (!report.ok) throw new Error(`v3 cases failed found=${report.found} passed=${report.passed} failed=${report.failed} skipped=${report.skipped}`);
}

export async function runCases(selected = CASES) {
  const totals = { found: selected.length, executed: 0, passed: 0, failed: 0, skipped: 0 };
  const reasons = [];
  for (const testCase of selected) {
    try {
      await testCase.run();
      totals.executed += 1;
      totals.passed += 1;
      console.log(`PASS ${testCase.id}`);
    } catch (error) {
      if (error instanceof CaseSkip) {
        totals.skipped += 1;
        reasons.push(`${testCase.id}: skipped: ${error.message}`);
        console.log(`SKIP ${testCase.id}: ${error.message}`);
      } else {
        totals.executed += 1;
        totals.failed += 1;
        reasons.push(`${testCase.id}: ${error instanceof Error ? error.message : String(error)}`);
        console.error(`FAIL ${testCase.id}: ${error instanceof Error ? error.stack : error}`);
      }
    }
  }
  if (totals.found === 0 || totals.executed + totals.skipped !== totals.found) totals.failed += 1;
  console.log(`v3 cases: found=${totals.found} executed=${totals.executed} passed=${totals.passed} failed=${totals.failed} skipped=${totals.skipped}`);
  return { ...totals, reasons, ok: totals.found > 0 && totals.failed === 0 && totals.executed > 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runCases();
  if (!report.ok) process.exitCode = 1;
}
