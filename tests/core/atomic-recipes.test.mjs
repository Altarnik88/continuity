import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MemoryError } from '../../continuity/scripts/lib/core/domain-v3.mjs';
import { appendV3, initializeV3, readV3Journal } from '../../continuity/scripts/lib/core/journal-v3.mjs';
import {
  applyRecipes, recipeAccept, recipeEvidence, recipeFail, recipeResult, recipeStart, recipeTask,
  recipeVerify,
} from '../../continuity/scripts/lib/core/recipes-v3.mjs';
import { gitAdminTopology } from '../../continuity/scripts/lib/core/store.mjs';

const CLI = fileURLToPath(new URL('../../continuity/scripts/continuity.mjs', import.meta.url));
const clock = () => new Date('2026-08-18T00:00:00.000Z');

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
  const root = mkdtempSync(path.join(os.tmpdir(), 'pm-atomic-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Atomic Test']);
  git(root, ['config', 'user.email', 'atomic@example.invalid']);
  writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

const INIT = {
  schemaVersion: 3,
  project: {
    projectId: 'project-demo',
    name: 'Demo',
    identity: 'atomic recipe fixture',
    implementationBoundaries: ['Synthetic only'],
    operatingRules: ['No network'],
  },
  finalGoal: {
    goalId: 'goal-final',
    title: 'Remember honestly',
    outcome: 'Atomic recipes leave no partial writes',
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

function actor(kind = 'coordinator', extra = {}) {
  return { kind, id: extra.id || `actor-${kind}`, role: kind, runId: extra.runId || `run-${kind}` };
}

function agentRegistration(record) {
  return {
    eventType: 'agent.registered',
    occurredAt: clock().toISOString(),
    actor: actor(),
    subject: { type: 'agent', id: record.actorId },
    supersedes: [],
    contradicts: [],
    evidenceRefs: [],
    sensitivity: 'internal',
    payload: { agent: record },
  };
}

const VERIFIER_AGENT = {
  actorId: 'actor-deep',
  providerFamily: 'other',
  modelFamily: 'large',
  capabilityProfiles: ['implementation', 'integration', 'deep_reasoning'],
  costTier: 'high',
  speedTier: 'slow',
  trustTier: 'standard',
  calibrationStatus: 'calibrated',
};

function fileInventory(root, relative = '') {
  const absolute = relative ? path.join(root, relative) : root;
  const entries = readdirSync(absolute, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const inventory = [];
  for (const entry of entries) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    const portable = child.split(path.sep).join('/');
    if (entry.isDirectory()) {
      inventory.push(`directory:${portable}`);
      inventory.push(...fileInventory(root, child));
    } else {
      const stat = lstatSync(path.join(root, child));
      inventory.push(`${entry.isSymbolicLink() ? 'link' : 'file'}:${portable}:${stat.size}`);
    }
  }
  return inventory;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function persistenceFingerprint(root) {
  const store = readV3Journal(root);
  const history = readFileSync(store.files.history);
  const current = readFileSync(store.files.current);
  const lock = gitAdminTopology(root).lock;
  const last = store.events.at(-1);
  const inventory = fileInventory(root);
  return {
    historyBytes: history.toString('base64'),
    historySha256: sha256(history),
    records: store.events.length,
    lastSequence: last.sequence,
    lastEventHash: last.eventHash,
    currentBytes: current.toString('base64'),
    currentSha256: sha256(current),
    inventory,
    lockExists: existsSync(lock),
    tempArtifacts: inventory.filter((item) => item.includes('.tmp')),
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

function seedAttempt(root) {
  initializeV3(root, JSON.stringify(INIT), { clock });
  let store = readV3Journal(root);
  appendV3(root, recipeTask(store, { actor: actor(), title: 'Ship memory' }, { clock }), { clock });
  store = readV3Journal(root);
  appendV3(root, recipeStart(store, { actor: actor(), approach: 'atomic fail' }, { clock }), { clock });
  return readV3Journal(root);
}

function seedResult(root) {
  seedAttempt(root);
  let store = readV3Journal(root);
  appendV3(root, recipeEvidence(store, {
    actor: actor(),
    kind: 'command',
    source: 'node --test',
    expected: 'pass',
    actual: 'found=1 executed=1 passed=1 failed=0',
    exitCode: 0,
  }, { clock }), { clock });
  store = readV3Journal(root);
  appendV3(root, recipeResult(store, {
    actor: actor(), expected: 'pass', actual: 'pass',
  }, { clock }), { clock });
  return readV3Journal(root);
}

export const CASES = Object.freeze([
  {
    id: 'T01-R07-001-fail-later-draft-invalid-no-effect',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        seedAttempt(root);
        const before = persistenceFingerprint(root);
        assert.equal(before.lockExists, false);
        assert.deepEqual(before.tempArtifacts, []);
        assert.throws(() => applyRecipes(root, (store) => {
          const drafts = recipeFail(store, {
            actor: actor(), why: 'git.exe missing', next: 'Install Git',
          }, { clock });
          const failure = JSON.parse(drafts.failure);
          failure.payload.failure.symptom = '';
          return [drafts.lesson, drafts.nextAction, `${JSON.stringify(failure)}\n`];
        }, { clock }), MemoryError);
        assert.deepEqual(persistenceFingerprint(root), before);

        const started = before.records;
        const failCli = runProjectMemory(root, ['record', 'fail', '--why', 'git.exe missing', '--next', 'Install Git']);
        assert.equal(failCli.status, 0, failCli.stderr);
        assert.match(failCli.stdout, /^event recorded: sequence=\d+ event=[a-f0-9]{12} projection=current\r?\n/);
        const after = readV3Journal(root);
        assert.equal(after.events.length, started + 3);
        assert.equal(after.events.at(-3).eventType, 'lesson.recorded');
        assert.equal(after.events.at(-2).eventType, 'next_action.recorded');
        assert.equal(after.events.at(-1).eventType, 'failure.recorded');
        assert.equal(after.state.lessons.length, 1);
        assert.equal(after.state.nextActions.length, 1);
        assert.equal(after.state.failures.length, 1);
        assert.deepEqual(persistenceFingerprint(root).tempArtifacts, []);
        assert.equal(persistenceFingerprint(root).lockExists, false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T01-R07-002-batch-holds-lock-consecutive-events',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        seedAttempt(root);
        const before = persistenceFingerprint(root);
        const lock = gitAdminTopology(root).lock;
        let lockHeldInBuilder = false;
        const receipts = applyRecipes(root, (store) => {
          lockHeldInBuilder = existsSync(lock);
          const drafts = recipeFail(store, {
            actor: actor(), why: 'git.exe missing', next: 'Install Git',
          }, { clock });
          return [drafts.lesson, drafts.nextAction, drafts.failure];
        }, { clock });
        assert.equal(lockHeldInBuilder, true);
        assert.equal(receipts.length, 3);
        assert.equal(receipts[1].sequence, receipts[0].sequence + 1);
        assert.equal(receipts[2].sequence, receipts[0].sequence + 2);
        const after = readV3Journal(root);
        const written = after.events.slice(-3);
        assert.equal(after.events.length, before.records + 3);
        assert.equal(written[0].sequence, before.lastSequence + 1);
        assert.equal(written[1].sequence, before.lastSequence + 2);
        assert.equal(written[2].sequence, before.lastSequence + 3);
        assert.equal(written[0].eventType, 'lesson.recorded');
        assert.equal(written[1].eventType, 'next_action.recorded');
        assert.equal(written[2].eventType, 'failure.recorded');
        assert.equal(existsSync(lock), false);
        assert.deepEqual(persistenceFingerprint(root).tempArtifacts, []);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T01-R07-003-accept-evidence-feedback-atomic',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        const seeded = seedResult(root);
        const resultId = seeded.state.results[0].resultId;
        const beforeReject = persistenceFingerprint(root);
        assert.throws(() => applyRecipes(root, (store) => {
          const drafts = recipeAccept(store, {
            actor: actor('user'), result: resultId, why: 'accepted',
          }, { clock });
          const feedback = JSON.parse(drafts.feedback);
          feedback.payload.feedback.statement = '';
          return [drafts.evidence, `${JSON.stringify(feedback)}\n`];
        }, { clock }), MemoryError);
        assert.deepEqual(persistenceFingerprint(root), beforeReject);
        assert.equal(readV3Journal(root).state.evidence.length, seeded.state.evidence.length);
        assert.equal(readV3Journal(root).state.feedback.length, 0);

        const acceptCli = runProjectMemory(root, [
          'record', 'accept', '--as', 'user', '--result', resultId, '--why', 'accepted',
        ]);
        assert.equal(acceptCli.status, 0, acceptCli.stderr);
        assert.match(acceptCli.stdout, /^event recorded: sequence=\d+ event=[a-f0-9]{12} projection=current\r?\n/);
        const after = readV3Journal(root);
        assert.equal(after.events.length, beforeReject.records + 2);
        assert.equal(after.events.at(-2).eventType, 'evidence.recorded');
        assert.equal(after.events.at(-1).eventType, 'feedback.recorded');
        assert.equal(after.state.feedback.length, 1);
        assert.equal(after.state.feedback[0].acceptance, 'accepted');
        assert.equal(after.state.results[0].acceptance, 'accepted');
        assert.equal(persistenceFingerprint(root).lockExists, false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T01-R07-004-reject-next-action-atomic',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        const seeded = seedResult(root);
        const resultId = seeded.state.results[0].resultId;
        const before = persistenceFingerprint(root);
        assert.equal(seeded.state.results[0].acceptance, 'pending');
        assert.equal(seeded.state.results[0].verification, 'unverified');
        assert.throws(() => applyRecipes(root, (store) => {
          const drafts = recipeAccept(store, {
            actor: actor('user'), reject: true, result: resultId, next: 'Change the approach', why: 'not done',
          }, { clock });
          const feedback = JSON.parse(drafts.feedback);
          feedback.payload.feedback.statement = '';
          return [drafts.nextAction, drafts.evidence, `${JSON.stringify(feedback)}\n`];
        }, { clock }), MemoryError);
        assert.deepEqual(persistenceFingerprint(root), before);
        assert.equal(readV3Journal(root).state.feedback.length, 0);
        assert.equal(readV3Journal(root).state.nextActions.length, 0);

        const coordinator = runProjectMemory(root, [
          'record', 'reject', '--as', 'coordinator', '--result', resultId, '--next', 'Change the approach',
        ]);
        assert.notEqual(coordinator.status, 0, coordinator.stdout);
        assert.equal(coordinator.stdout, '');
        assert.match(coordinator.stderr, /only the user/i);
        assert.deepEqual(persistenceFingerprint(root), before);

        const missingNext = runProjectMemory(root, [
          'record', 'reject', '--as', 'user', '--result', resultId,
        ]);
        assert.notEqual(missingNext.status, 0, missingNext.stdout);
        assert.equal(missingNext.stdout, '');
        assert.match(missingNext.stderr, /--next/i);
        assert.deepEqual(persistenceFingerprint(root), before);

        const dryMissing = runProjectMemory(root, [
          'record', 'reject', '--as', 'user', '--result', resultId, '--dry-run',
        ]);
        assert.equal(dryMissing.status, missingNext.status);
        assert.equal(dryMissing.stdout, '');
        assert.match(dryMissing.stderr, /--next/i);
        assert.deepEqual(persistenceFingerprint(root), before);

        const dryCoordinator = runProjectMemory(root, [
          'record', 'reject', '--as', 'coordinator', '--result', resultId, '--next', 'Change the approach', '--dry-run',
        ]);
        assert.equal(dryCoordinator.status, coordinator.status);
        assert.equal(dryCoordinator.stdout, '');
        assert.match(dryCoordinator.stderr, /only the user/i);
        assert.deepEqual(persistenceFingerprint(root), before);

        const dryReject = runProjectMemory(root, [
          'record', 'reject', '--as', 'user', '--result', resultId, '--next', 'Change the approach', '--why', 'not done', '--dry-run',
        ]);
        assert.equal(dryReject.status, 0, dryReject.stderr);
        assert.match(dryReject.stdout, /^record dry-run: ok recipe=reject\r?\n$/);
        assert.deepEqual(persistenceFingerprint(root), before);

        const rejected = runProjectMemory(root, [
          'record', 'reject', '--as', 'user', '--result', resultId, '--next', 'Change the approach', '--why', 'not done',
        ]);
        assert.equal(rejected.status, 0, rejected.stderr);
        assert.match(rejected.stdout, /^event recorded: sequence=\d+ event=[a-f0-9]{12} projection=current\r?\n/);
        const after = readV3Journal(root);
        assert.equal(after.events.length, before.records + 3);
        assert.equal(after.events.at(-3).eventType, 'next_action.recorded');
        assert.equal(after.events.at(-2).eventType, 'evidence.recorded');
        assert.equal(after.events.at(-1).eventType, 'feedback.recorded');
        assert.equal(after.state.feedback.length, 1);
        assert.equal(after.state.feedback[0].disposition, 'rejected');
        assert.equal(after.state.feedback[0].acceptance, 'rejected');
        assert.equal(after.state.nextActions.length, 1);
        assert.equal(after.state.nextActions[0].action, 'Change the approach');
        assert.equal(after.state.feedback[0].nextActionId, after.state.nextActions[0].nextActionId);
        assert.equal(after.state.results[0].acceptance, 'rejected');
        assert.equal(after.state.results[0].verification, seeded.state.results[0].verification);
        assert.equal(after.state.evidence.at(-1).kind, 'user_message');
        assert.equal(after.state.evidence.at(-1).authorizing, false);
        assert.equal(persistenceFingerprint(root).lockExists, false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T01-R07-006-dry-run-batch-fingerprint-no-effect',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        seedAttempt(root);
        const before = persistenceFingerprint(root);
        const dryFail = runProjectMemory(root, [
          'record', 'fail', '--why', 'git.exe missing', '--next', 'Install Git', '--dry-run',
        ]);
        assert.equal(dryFail.status, 0, dryFail.stderr);
        assert.match(dryFail.stdout, /^record dry-run: ok recipe=fail\r?\n$/);
        assert.deepEqual(persistenceFingerprint(root), before);
        const dryVerify = runProjectMemory(root, [
          'record', 'verify', '--found', '1', '--executed', '1', '--passed', '1', '--failed', '0', '--dry-run',
        ]);
        assert.notEqual(dryVerify.status, 0, dryVerify.stdout);
        assert.equal(dryVerify.stdout, '');
        assert.deepEqual(persistenceFingerprint(root), before);
        const dryAccept = runProjectMemory(root, [
          'record', 'accept', '--as', 'user', '--why', 'accepted', '--dry-run',
        ]);
        assert.notEqual(dryAccept.status, 0, dryAccept.stdout);
        assert.equal(dryAccept.stdout, '');
        assert.deepEqual(persistenceFingerprint(root), before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T03-R3A-001-verify-missing-exit-code-no-effect',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        seedResult(root);
        appendV3(root, `${JSON.stringify(agentRegistration(VERIFIER_AGENT))}\n`, { clock });
        const store = readV3Journal(root);
        const resultId = store.state.results[0].resultId;
        const before = persistenceFingerprint(root);
        const expected = 'record verify requires --exit-code observed from the verification run';
        assert.throws(
          () => recipeVerify(store, {
            actor: actor('subagent', { id: 'actor-deep', runId: 'run-verify' }),
            result: resultId,
            found: 1, executed: 1, passed: 1, failed: 0,
          }, { clock }),
          (error) => error instanceof MemoryError && error.message === expected,
        );
        assert.deepEqual(persistenceFingerprint(root), before);
        const rejected = runProjectMemory(root, [
          'record', 'verify', '--as', 'subagent', '--actor-id', 'actor-deep', '--run-id', 'run-verify',
          '--result', resultId, '--found', '1', '--executed', '1', '--passed', '1', '--failed', '0',
        ]);
        assert.notEqual(rejected.status, 0, rejected.stdout);
        assert.equal(rejected.stdout, '');
        assert.match(rejected.stderr, /record verify requires --exit-code observed from the verification run/);
        assert.deepEqual(persistenceFingerprint(root), before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T03-R3B-001-succeeded-result-ambiguous-evidence-no-effect',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        seedAttempt(root);
        let store = readV3Journal(root);
        appendV3(root, recipeEvidence(store, {
          actor: actor(), kind: 'command', source: 'node --test', expected: 'pass',
          actual: 'first authorizing observation', exitCode: 0, id: 'evidence-first000',
        }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeEvidence(store, {
          actor: actor(), kind: 'test', source: 'node --test', expected: 'pass',
          actual: 'second authorizing observation', exitCode: 0, id: 'evidence-second00',
        }, { clock }), { clock });
        store = readV3Journal(root);
        const before = persistenceFingerprint(root);
        assert.throws(
          () => recipeResult(store, {
            actor: actor(), expected: 'pass', actual: 'pass', execution: 'succeeded',
          }, { clock }),
          (error) => error instanceof MemoryError
            && /record result requires --evidence/.test(error.message)
            && error.message.includes('evidence-first000')
            && error.message.includes('evidence-second00'),
        );
        assert.deepEqual(persistenceFingerprint(root), before);
        const rejected = runProjectMemory(root, [
          'record', 'result', '--expected', 'pass', '--actual', 'pass', '--execution', 'succeeded',
        ]);
        assert.notEqual(rejected.status, 0, rejected.stdout);
        assert.equal(rejected.stdout, '');
        assert.match(rejected.stderr, /record result requires --evidence/);
        assert.match(rejected.stderr, /evidence-first000/);
        assert.match(rejected.stderr, /evidence-second00/);
        assert.deepEqual(persistenceFingerprint(root), before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T03-R3B-002-succeeded-result-prior-attempt-evidence-no-effect',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        seedAttempt(root);
        let store = readV3Journal(root);
        appendV3(root, recipeEvidence(store, {
          actor: actor(), kind: 'command', source: 'node --test', expected: 'pass',
          actual: 'authorizing on first attempt', exitCode: 0, id: 'evidence-attempt1',
        }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeStart(store, {
          actor: actor(), approach: 'second attempt does not inherit prior evidence',
        }, { clock }), { clock });
        store = readV3Journal(root);
        const before = persistenceFingerprint(root);
        assert.throws(
          () => recipeResult(store, {
            actor: actor(), expected: 'pass', actual: 'pass', execution: 'succeeded',
          }, { clock }),
          (error) => error instanceof MemoryError
            && /record result requires --evidence/.test(error.message)
            && /current attempt/.test(error.message),
        );
        assert.deepEqual(persistenceFingerprint(root), before);
        const rejected = runProjectMemory(root, [
          'record', 'result', '--expected', 'pass', '--actual', 'pass', '--execution', 'succeeded',
        ]);
        assert.notEqual(rejected.status, 0, rejected.stdout);
        assert.equal(rejected.stdout, '');
        assert.match(rejected.stderr, /record result requires --evidence/);
        assert.deepEqual(persistenceFingerprint(root), before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T03-R3C-001-evidence-default-limitation-is-self-reported',
    async run() {
      const draft = JSON.parse(recipeEvidence({
        state: { tasks: [{ taskId: 'task-limit', goalId: 'goal-final', criterionIds: ['criterion-honest'] }] },
      }, {
        actor: actor(), kind: 'command', expected: 'pass', actual: 'exit 0', exitCode: 0,
      }, { clock }));
      assert.deepEqual(draft.payload.evidence.limitations, [
        'Exit code and outputs are self-reported by the writer; the CLI did not execute or observe the command.',
      ]);
      assert.equal(
        JSON.stringify(draft).includes('truncated and hashed')
          || JSON.stringify(draft).includes('raw logs are not stored'),
        false,
      );
    },
  },
]);

export async function run() {
  const totals = { found: CASES.length, executed: 0, passed: 0, failed: 0, skipped: 0 };
  const reasons = [];
  for (const testCase of CASES) {
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
  console.log(`atomic recipes: found=${totals.found} executed=${totals.executed} passed=${totals.passed} failed=${totals.failed} skipped=${totals.skipped}`);
  if (totals.failed > 0 || totals.executed === 0) {
    throw new Error(`atomic recipes failed found=${totals.found} passed=${totals.passed} failed=${totals.failed} skipped=${totals.skipped}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}
