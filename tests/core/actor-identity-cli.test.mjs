import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendV3, initializeV3, readV3Journal } from '../../continuity/scripts/lib/core/journal-v3.mjs';
import { recipeTask } from '../../continuity/scripts/lib/core/recipes-v3.mjs';
import { assertPathSafe, gitAdminTopology } from '../../continuity/scripts/lib/core/store.mjs';

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
  const root = mkdtempSync(path.join(os.tmpdir(), 'pm-actor-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Actor Test']);
  git(root, ['config', 'user.email', 'actor@example.invalid']);
  writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

function sameResolved(left, right) {
  return path.relative(left, right) === '' && path.relative(right, left) === '';
}

function removeTree(target) {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    /* best-effort fixture cleanup */
  }
}

function tryMakeRootAlias() {
  const real = mkdtempSync(path.join(os.tmpdir(), 'pm-actor-real-'));
  const parent = mkdtempSync(path.join(os.tmpdir(), 'pm-actor-alias-'));
  const alias = path.join(parent, 'root');
  try {
    symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    removeTree(real);
    removeTree(parent);
    throw new CaseSkip(`cannot create a test root alias (${error.code || error.message})`);
  }
  const lexical = path.resolve(alias);
  let canonical;
  try {
    canonical = realpathSync.native(alias);
  } catch (error) {
    removeTree(alias);
    removeTree(real);
    removeTree(parent);
    throw new CaseSkip(`cannot resolve a test root alias (${error.code || error.message})`);
  }
  if (sameResolved(lexical, canonical)) {
    removeTree(alias);
    removeTree(real);
    removeTree(parent);
    throw new CaseSkip('platform root alias has identical lexical and canonical paths');
  }
  return { real, parent, alias: lexical, canonical };
}

const INIT = {
  schemaVersion: 3,
  project: {
    projectId: 'project-demo',
    name: 'Demo',
    identity: 'actor identity fixture',
    implementationBoundaries: ['Synthetic only'],
    operatingRules: ['No network'],
  },
  finalGoal: {
    goalId: 'goal-final',
    title: 'Remember honestly',
    outcome: 'Actors are explicit and independently verified',
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

function seedProject(root) {
  initializeV3(root, JSON.stringify(INIT), { clock });
  return readV3Journal(root);
}

export const CASES = Object.freeze([
  {
    id: 'T01-R08-001-actor-id-run-id-and-invalid-no-effect',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        seedProject(root);
        const recorded = runProjectMemory(root, [
          'record', 'task', '--title', 'Ship identity',
          '--as', 'subagent', '--actor-id', 'actor-alpha', '--run-id', 'run-alpha',
        ]);
        assert.equal(recorded.status, 0, recorded.stderr);
        const store = readV3Journal(root);
        const event = store.events.at(-1);
        assert.equal(event.eventType, 'task.planned');
        assert.equal(event.actor.kind, 'subagent');
        assert.equal(event.actor.id, 'actor-alpha');
        assert.equal(event.actor.runId, 'run-alpha');
        assert.equal(event.payload.task.owner, 'actor-alpha');
        const before = persistenceFingerprint(root);
        assert.equal(before.lockExists, false);
        for (const args of [
          ['record', 'task', '--title', 'Rejected', '--actor-id', 'INVALID'],
          ['record', 'task', '--title', 'Rejected', '--run-id', 'BAD'],
          ['record', 'task', '--title', 'Rejected', '--actor-id', 'actor'],
        ]) {
          const rejected = runProjectMemory(root, args);
          assert.notEqual(rejected.status, 0, args.join(' '));
          assert.equal(rejected.stdout, '');
          assert.deepEqual(persistenceFingerprint(root), before, args.join(' '));
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T01-R08-002-as-kind-default-cannot-self-verify',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        seedProject(root);
        const task = runProjectMemory(root, ['record', 'task', '--title', 'Ship core', '--as', 'subagent']);
        assert.equal(task.status, 0, task.stderr);
        const start = runProjectMemory(root, ['record', 'start', '--as', 'subagent', '--approach', 'implement']);
        assert.equal(start.status, 0, start.stderr);
        const evidence = runProjectMemory(root, ['record', 'evidence', '--as', 'subagent', '--exit-code', '0']);
        assert.equal(evidence.status, 0, evidence.stderr);
        const result = runProjectMemory(root, [
          'record', 'result', '--as', 'subagent', '--expected', 'pass', '--actual', 'pass',
        ]);
        assert.equal(result.status, 0, result.stderr);
        const store = readV3Journal(root);
        const resultEvent = store.events.findLast
          ? store.events.findLast((item) => item.eventType === 'result.recorded')
          : [...store.events].reverse().find((item) => item.eventType === 'result.recorded');
        assert.equal(resultEvent.actor.kind, 'subagent');
        assert.equal(resultEvent.actor.id, 'actor-subagent');
        assert.equal(resultEvent.actor.runId, 'run-cli');
        assert.equal(store.state.evidence.at(-1).kind, 'command');
        assert.equal(store.state.evidence.at(-1).authorizing, true);
        const before = persistenceFingerprint(root);
        const verify = runProjectMemory(root, [
          'record', 'verify', '--as', 'subagent',
          '--found', '1', '--executed', '1', '--passed', '1', '--failed', '0',
          '--exit-code', '0',
        ]);
        assert.notEqual(verify.status, 0, verify.stderr);
        assert.equal(verify.stdout, '');
        assert.deepEqual(persistenceFingerprint(root), before);
        assert.equal(readV3Journal(root).state.verificationReports.length, 0);
        assert.equal(readV3Journal(root).state.results[0].verification, 'unverified');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T01-R08-003-distinct-identity-independent-verify',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        seedProject(root);
        const task = runProjectMemory(root, [
          'record', 'task', '--title', 'Ship core', '--as', 'subagent',
          '--actor-id', 'actor-cheap', '--run-id', 'run-exec',
        ]);
        assert.equal(task.status, 0, task.stderr);
        const start = runProjectMemory(root, [
          'record', 'start', '--as', 'subagent',
          '--actor-id', 'actor-cheap', '--run-id', 'run-exec', '--approach', 'implement',
        ]);
        assert.equal(start.status, 0, start.stderr);
        const evidence = runProjectMemory(root, [
          'record', 'evidence', '--as', 'subagent',
          '--actor-id', 'actor-cheap', '--run-id', 'run-exec',
          '--exit-code', '0', '--kind', 'test',
        ]);
        assert.equal(evidence.status, 0, evidence.stderr);
        const result = runProjectMemory(root, [
          'record', 'result', '--as', 'subagent',
          '--actor-id', 'actor-cheap', '--run-id', 'run-exec',
          '--expected', 'pass', '--actual', 'pass',
        ]);
        assert.equal(result.status, 0, result.stderr);
        appendV3(root, `${JSON.stringify(agentRegistration(VERIFIER_AGENT))}\n`, { clock });
        const store = readV3Journal(root);
        assert.equal(store.state.results[0].actor.id, 'actor-cheap');
        assert.equal(store.state.results[0].actor.runId, 'run-exec');
        const sameRun = persistenceFingerprint(root);
        const selfVerify = runProjectMemory(root, [
          'record', 'verify', '--as', 'subagent',
          '--actor-id', 'actor-cheap', '--run-id', 'run-exec',
          '--found', '1', '--executed', '1', '--passed', '1', '--failed', '0',
          '--exit-code', '0',
        ]);
        assert.notEqual(selfVerify.status, 0, selfVerify.stderr);
        assert.deepEqual(persistenceFingerprint(root), sameRun);
        const verify = runProjectMemory(root, [
          'record', 'verify', '--as', 'subagent',
          '--actor-id', 'actor-deep', '--run-id', 'run-verify',
          '--found', '1', '--executed', '1', '--passed', '1', '--failed', '0',
          '--exit-code', '0',
        ]);
        assert.equal(verify.status, 0, verify.stderr);
        const after = readV3Journal(root);
        const report = after.events.at(-1);
        assert.equal(report.eventType, 'verification.recorded');
        assert.equal(report.actor.kind, 'subagent');
        assert.equal(report.actor.id, 'actor-deep');
        assert.equal(report.actor.runId, 'run-verify');
        assert.equal(after.state.results[0].verification, 'passed');
        assert.equal(after.state.results[0].acceptance, 'pending');
        assert.equal(after.state.verificationReports.length, 1);
        assert.notEqual(report.actor.id, after.state.results[0].actor.id);
        assert.notEqual(report.actor.runId, after.state.results[0].actor.runId);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T01-R08-004-exit-code-authorizing-command-evidence',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        seedProject(root);
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, {
          actor: actor(), title: 'Capture command evidence',
        }, { clock }), { clock });
        const recorded = runProjectMemory(root, ['record', 'evidence', '--exit-code', '0']);
        assert.equal(recorded.status, 0, recorded.stderr);
        store = readV3Journal(root);
        const evidence = store.state.evidence.at(-1);
        assert.equal(store.events.at(-1).eventType, 'evidence.recorded');
        assert.equal(evidence.kind, 'command');
        assert.equal(evidence.authorizing, true);
        assert.equal(evidence.outcome, 'passed');
        const beforeKind = persistenceFingerprint(root);
        const withKind = runProjectMemory(root, [
          'record', 'evidence', '--exit-code', '0', '--kind', 'command',
        ]);
        assert.equal(withKind.status, 0, withKind.stderr);
        assert.notDeepEqual(persistenceFingerprint(root), beforeKind);
        store = readV3Journal(root);
        const second = store.state.evidence.at(-1);
        assert.equal(second.kind, 'command');
        assert.equal(second.authorizing, true);
        assert.equal(second.outcome, 'passed');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T01-R08-005-dry-run-unregistered-verifier-matches-write',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        seedProject(root);
        const task = runProjectMemory(root, [
          'record', 'task', '--title', 'Ship core', '--as', 'subagent',
          '--actor-id', 'actor-cheap', '--run-id', 'run-exec',
        ]);
        assert.equal(task.status, 0, task.stderr);
        assert.equal(runProjectMemory(root, [
          'record', 'start', '--as', 'subagent',
          '--actor-id', 'actor-cheap', '--run-id', 'run-exec', '--approach', 'implement',
        ]).status, 0);
        assert.equal(runProjectMemory(root, [
          'record', 'evidence', '--as', 'subagent',
          '--actor-id', 'actor-cheap', '--run-id', 'run-exec',
          '--exit-code', '0', '--kind', 'test',
        ]).status, 0);
        assert.equal(runProjectMemory(root, [
          'record', 'result', '--as', 'subagent',
          '--actor-id', 'actor-cheap', '--run-id', 'run-exec',
          '--expected', 'pass', '--actual', 'pass',
        ]).status, 0);
        const verifyArgs = [
          'record', 'verify', '--as', 'subagent',
          '--actor-id', 'actor-deep', '--run-id', 'run-verify',
          '--found', '1', '--executed', '1', '--passed', '1', '--failed', '0',
          '--exit-code', '0',
        ];
        const before = persistenceFingerprint(root);
        const dryRun = runProjectMemory(root, [...verifyArgs, '--dry-run']);
        const write = runProjectMemory(root, verifyArgs);
        assert.notEqual(dryRun.status, 0, dryRun.stdout);
        assert.notEqual(write.status, 0, write.stdout);
        assert.equal(dryRun.status, write.status);
        assert.equal(dryRun.stdout, '');
        assert.equal(write.stdout, '');
        assert.match(dryRun.stderr, /registered verifier/i);
        assert.match(write.stderr, /registered verifier/i);
        assert.deepEqual(persistenceFingerprint(root), before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T01-R08-006-assign-actor-is-not-assignee',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        seedProject(root);
        const planned = runProjectMemory(root, [
          'record', 'task', '--title', 'Ship core', '--as', 'coordinator',
          '--actor-id', 'actor-coord', '--run-id', 'run-plan',
        ]);
        assert.equal(planned.status, 0, planned.stderr);
        const store = readV3Journal(root);
        const taskId = store.state.tasks[0].taskId;
        appendV3(root, `${JSON.stringify(agentRegistration({
          ...VERIFIER_AGENT,
          actorId: 'actor-cheap',
          capabilityProfiles: ['implementation'],
          costTier: 'lowest',
          speedTier: 'fast',
        }))}\n`, { clock });
        const packet = runProjectMemory(root, [
          'record', 'packet', '--task', taskId, '--as', 'coordinator',
          '--actor-id', 'actor-coord', '--run-id', 'run-plan',
        ]);
        assert.equal(packet.status, 0, packet.stderr);
        const before = persistenceFingerprint(root);
        for (const [label, args] of [
          ['omit --assignee with --actor-id', [
            'record', 'assign', '--task', taskId, '--as', 'coordinator',
            '--actor-id', 'actor-cheap', '--run-id', 'run-exec',
          ]],
          ['omit --assignee without --actor-id', [
            'record', 'assign', '--task', taskId, '--as', 'coordinator',
          ]],
        ]) {
          const implicit = runProjectMemory(root, args);
          assert.notEqual(implicit.status, 0, `${label}: ${implicit.stdout}`);
          assert.equal(implicit.stdout, '', label);
          assert.match(implicit.stderr, /assignee/i, label);
          assert.deepEqual(persistenceFingerprint(root), before, label);
        }
        const assigned = runProjectMemory(root, [
          'record', 'assign', '--task', taskId, '--as', 'coordinator',
          '--actor-id', 'actor-coord', '--run-id', 'run-plan',
          '--assignee', 'actor-cheap',
        ]);
        assert.equal(assigned.status, 0, assigned.stderr);
        const after = readV3Journal(root);
        const event = after.events.at(-1);
        assert.equal(event.eventType, 'assignment.recorded');
        assert.equal(event.actor.id, 'actor-coord');
        assert.equal(event.actor.runId, 'run-plan');
        assert.equal(event.payload.assignment.actorId, 'actor-cheap');
        assert.notEqual(event.actor.id, event.payload.assignment.actorId);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T01-R08-007-path-escape-and-linked-store-rejected',
    async run() {
      const root = mkdtempSync(path.join(os.tmpdir(), 'pm-actor-safe-'));
      const outside = mkdtempSync(path.join(os.tmpdir(), 'pm-actor-outside-'));
      try {
        assert.throws(
          () => assertPathSafe(root, path.join(root, '..', 'outside')),
          /path escapes the repository/,
        );
        try {
          symlinkSync(outside, path.join(root, '.continuity'), process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error) {
          throw new CaseSkip(`cannot create a linked store component (${error.code || error.message})`);
        }
        assert.throws(
          () => assertPathSafe(root, path.join(root, '.continuity', 'HISTORY.ndjson')),
          /links or reparse points/,
        );
      } finally {
        removeTree(root);
        removeTree(outside);
      }
    },
  },
  {
    id: 'T01-R08-008-root-alias-accepted',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const alias = tryMakeRootAlias();
      try {
        git(alias.alias, ['init', '-q']);
        git(alias.alias, ['config', 'user.name', 'Actor Test']);
        git(alias.alias, ['config', 'user.email', 'actor@example.invalid']);
        writeFileSync(path.join(alias.alias, 'README.md'), 'fixture\n');
        git(alias.alias, ['add', 'README.md']);
        git(alias.alias, ['commit', '-qm', 'fixture']);
        const nested = path.join(alias.alias, '.continuity', 'HISTORY.ndjson');
        const relativeToCanonical = path.relative(alias.canonical, path.resolve(nested));
        assert.equal(sameResolved(path.resolve(alias.alias), alias.canonical), false);
        assert.equal(relativeToCanonical.startsWith('..') || path.isAbsolute(relativeToCanonical), true);
        assert.doesNotThrow(() => assertPathSafe(alias.alias, nested));
        seedProject(alias.alias);
        const recorded = runProjectMemory(alias.alias, [
          'record', 'task', '--title', 'Ship alias root',
          '--as', 'subagent', '--actor-id', 'actor-alias', '--run-id', 'run-alias',
        ]);
        assert.equal(recorded.status, 0, recorded.stderr);
        const store = readV3Journal(alias.alias);
        assert.equal(store.events.at(-1).actor.id, 'actor-alias');
        assert.equal(existsSync(path.join(alias.real, '.continuity', 'HISTORY.ndjson')), true);
      } finally {
        removeTree(alias.alias);
        removeTree(alias.real);
        removeTree(alias.parent);
      }
    },
  },
]);

export async function run() {
  const totals = { found: CASES.length, executed: 0, passed: 0, failed: 0, skipped: 0 };
  for (const testCase of CASES) {
    try {
      await testCase.run();
      totals.executed += 1;
      totals.passed += 1;
      console.log(`PASS ${testCase.id}`);
    } catch (error) {
      if (error instanceof CaseSkip) {
        totals.skipped += 1;
        console.log(`SKIP ${testCase.id}: ${error.message}`);
      } else {
        totals.executed += 1;
        totals.failed += 1;
        console.error(`FAIL ${testCase.id}: ${error instanceof Error ? error.stack : error}`);
      }
    }
  }
  if (totals.found === 0 || totals.executed + totals.skipped !== totals.found) totals.failed += 1;
  console.log(`actor identity: found=${totals.found} executed=${totals.executed} passed=${totals.passed} failed=${totals.failed} skipped=${totals.skipped}`);
  if (totals.failed > 0 || totals.executed === 0) {
    throw new Error(`actor identity failed found=${totals.found} passed=${totals.passed} failed=${totals.failed} skipped=${totals.skipped}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}
