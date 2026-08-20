import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MemoryError, emptyProjectStateV3, foldV3, validateDraftV3,
} from '../../continuity/scripts/lib/core/domain-v3.mjs';
import { appendV3, initializeV3, readV3Journal, rebuildV3 } from '../../continuity/scripts/lib/core/journal-v3.mjs';
import {
  recipeAssign, recipeAttemptReport, recipeBacklog, recipeContextHandoff, recipeEvidence, recipeFail,
  recipePacket, recipeRelease, recipeResult, recipeStart, recipeTask, recipeVerify,
} from '../../continuity/scripts/lib/core/recipes-v3.mjs';
import {
  COORDINATION_CONTRACT_ID,
  COORDINATION_CONTRACT_VERSION,
  buildCoordinatorView,
  buildFirstState,
  buildTaskAccumulator,
  buildWorkPackets,
  canParkInBacklog,
  cheapestEligible,
  contextAllowsNewPacket,
  loadAgentRegistry,
  readyTasks,
  repairPolicy,
  selectVerifier,
  selectWave,
  validateAssignment,
} from '../../continuity/scripts/lib/core/coordination/index.mjs';
import { buildInspectV3, liveContextFromWorkspace } from '../../continuity/scripts/lib/core/inspect-v3.mjs';

const CLI = fileURLToPath(new URL('../../continuity/scripts/continuity.mjs', import.meta.url));

class CaseSkip extends Error {}

const require = createRequire(import.meta.url);

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
  const root = mkdtempSync(path.join(os.tmpdir(), 'pm-coord-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Coord Test']);
  git(root, ['config', 'user.email', 'coord@example.invalid']);
  writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
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
  const reportedLock = execFileSync('git', [
    '-C', root, 'rev-parse', '--git-path', 'project-memory.checkpoint.lock',
  ], { encoding: 'utf8' }).trim();
  const lock = path.isAbsolute(reportedLock) ? reportedLock : path.resolve(root, reportedLock);
  const last = store.events.at(-1);
  return {
    historyBytes: history.toString('base64'),
    historySha256: sha256(history),
    records: store.events.length,
    lastSequence: last.sequence,
    lastEventHash: last.eventHash,
    currentBytes: current.toString('base64'),
    currentSha256: sha256(current),
    lockExists: existsSync(lock),
    inventory: fileInventory(root),
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

const clock = () => new Date('2026-08-18T00:00:00.000Z');
const INIT = {
  schemaVersion: 3,
  project: {
    projectId: 'project-demo',
    name: 'Demo',
    identity: 'coordination fixture',
    implementationBoundaries: ['Synthetic only'],
    operatingRules: ['No network'],
  },
  finalGoal: {
    goalId: 'goal-final',
    title: 'Remember honestly',
    outcome: 'Coordinator reads truthful memory',
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

function memTask(overrides) {
  return {
    taskId: 'task-core',
    goalId: 'goal-final',
    title: 'Core path',
    scope: 'core',
    owner: 'actor-coordinator',
    criterionIds: ['criterion-honest'],
    userFacing: true,
    execution: 'planned',
    verification: 'unverified',
    acceptance: 'pending',
    attemptIds: [],
    resultIds: [],
    failureIds: [],
    dependencyIds: [],
    capabilities: ['implementation'],
    requiredCapabilities: ['implementation'],
    pathOwnership: ['src/core'],
    ownershipScope: ['src/core'],
    priority: 'core',
    size: 'S',
    complexity: 'low',
    risk: 'routine',
    class: 'function',
    moduleId: 'core',
    enablesTaskIds: [],
    createdAt: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

function memState(tasks, extras = {}) {
  const state = emptyProjectStateV3();
  state.project = INIT.project;
  state.finalGoalId = 'goal-final';
  state.goals = [{ goalId: 'goal-final', title: 'Remember honestly', outcome: 'truth', isFinal: true, authority: 'user', basis: 'user_stated', criterionIds: ['criterion-honest'] }];
  state.criteria = [{ ...INIT.criterion, verification: 'unverified' }];
  state.tasks = tasks;
  Object.assign(state, extras);
  return state;
}

const AGENTS = [
  {
    actorId: 'actor-cheap',
    providerFamily: 'local',
    modelFamily: 'small',
    capabilityProfiles: ['mechanical', 'implementation'],
    costTier: 'lowest',
    speedTier: 'fast',
    trustTier: 'standard',
    calibrationStatus: 'calibrated',
  },
  {
    actorId: 'actor-deep',
    providerFamily: 'other',
    modelFamily: 'large',
    capabilityProfiles: ['implementation', 'integration', 'deep_reasoning', 'security_critical'],
    costTier: 'high',
    speedTier: 'slow',
    trustTier: 'standard',
    calibrationStatus: 'calibrated',
  },
  {
    actorId: 'actor-unknown',
    providerFamily: 'new',
    modelFamily: 'unspecified',
    capabilityProfiles: [],
    costTier: 'low',
    trustTier: 'unknown',
    calibrationStatus: 'untested',
  },
];

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

export const CASES = Object.freeze([
  {
    id: 'COORD-001-accumulator-replay',
    requirement: 'TaskAccumulator restores from journal replay',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, {
          actor: actor(), title: 'Ship core', size: 'S', priority: 'core', complexity: 'low',
          risk: 'routine', capabilities: ['implementation'], pathOwnership: ['src/core'],
        }, { clock }), { clock });
        store = readV3Journal(root);
        const before = buildTaskAccumulator(store.state);
        rmSync(store.files.current, { force: true });
        rebuildV3(root);
        store = readV3Journal(root);
        const after = buildTaskAccumulator(store.state);
        assert.equal(store.projection, 'current');
        assert.deepEqual(after.tasks.map((item) => item.id), before.tasks.map((item) => item.id));
        assert.equal(after.tasks[0].priority, 'core');
        assert.equal(after.tasks[0].size, 'S');
        assert.equal(after.tasks[0].weight, 2);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-002-deterministic-ready-set',
    requirement: 'ready set is deterministic',
    async run() {
      const state = memState([
        memTask({ taskId: 'task-b', title: 'B', pathOwnership: ['src/b'], ownershipScope: ['src/b'] }),
        memTask({ taskId: 'task-a', title: 'A', pathOwnership: ['src/a'], ownershipScope: ['src/a'] }),
      ]);
      const first = readyTasks(state).deterministicOrder;
      const second = readyTasks(state).deterministicOrder;
      assert.deepEqual(first, ['task-a', 'task-b']);
      assert.deepEqual(second, first);
    },
  },
  {
    id: 'COORD-003-dependency-ordering',
    requirement: 'unfinished dependencies exclude a task from ready set',
    async run() {
      const state = memState([
        memTask({ taskId: 'task-dep', title: 'Dep' }),
        memTask({
          taskId: 'task-later', title: 'Later', dependencyIds: ['task-dep'],
          pathOwnership: ['src/later'], ownershipScope: ['src/later'],
        }),
      ]);
      const ready = readyTasks(state);
      assert.deepEqual(ready.deterministicOrder, ['task-dep']);
      assert.equal(ready.excluded.find((item) => item.taskId === 'task-later').reason, 'unfinished-dependencies');
    },
  },
  {
    id: 'COORD-004-dependency-cycle',
    requirement: 'dependency cycles are excluded and reported',
    async run() {
      const state = memState([
        memTask({ taskId: 'task-one', dependencyIds: ['task-two'], pathOwnership: ['src/one'], ownershipScope: ['src/one'] }),
        memTask({ taskId: 'task-two', dependencyIds: ['task-one'], pathOwnership: ['src/two'], ownershipScope: ['src/two'] }),
      ]);
      const ready = readyTasks(state);
      assert.deepEqual(ready.deterministicOrder, []);
      assert.equal(ready.excluded.every((item) => item.reason === 'dependency-cycle'), true);
    },
  },
  {
    id: 'COORD-005-blocker-priority',
    requirement: 'blocker outranks core in ready order',
    async run() {
      const state = memState([
        memTask({ taskId: 'task-core', priority: 'core', pathOwnership: ['src/core'], ownershipScope: ['src/core'] }),
        memTask({
          taskId: 'task-block', priority: 'blocker', class: 'blocker',
          pathOwnership: ['src/block'], ownershipScope: ['src/block'],
        }),
      ]);
      assert.deepEqual(readyTasks(state).deterministicOrder, ['task-block', 'task-core']);
    },
  },
  {
    id: 'COORD-006-backlog-exclusion',
    requirement: 'backlog is not auto-assigned',
    async run() {
      const state = memState([
        memTask({
          taskId: 'task-optional', priority: 'backlog', class: 'cosmetic',
          criterionIds: ['criterion-optional'],
        }),
      ]);
      state.criteria.push({
        criterionId: 'criterion-optional', ownerType: 'goal', ownerId: 'goal-final',
        condition: 'nice to have', scope: 'fixture', requiredEvidenceKinds: ['command'],
        freshnessPolicy: { kind: 'source_digest' }, waivableByUser: true,
      });
      const ready = readyTasks(state);
      assert.deepEqual(ready.deterministicOrder, []);
      assert.equal(ready.excluded[0].reason, 'backlog-excluded');
    },
  },
  {
    id: 'COORD-007-required-criterion-not-hidden',
    requirement: 'required criterion cannot be parked in backlog',
    async run() {
      const state = memState([memTask({ taskId: 'task-required' })]);
      const parked = canParkInBacklog(state, 'task-required');
      assert.equal(parked.allowed, false);
      assert.match(parked.reason, /required-criterion/);
      const draft = recipeTask({ state, events: [] }, {
        actor: actor(), title: 'Hide required', priority: 'backlog',
      }, { clock });
      assert.throws(() => validateDraftV3(JSON.parse(draft), memState([])), /required-criterion-cannot-hide-in-backlog/);
    },
  },
  {
    id: 'COORD-008-dimensions-independent',
    requirement: 'priority size complexity and risk stay independent',
    async run() {
      const task = memTask({ priority: 'backlog', size: 'XS', complexity: 'high', risk: 'critical' });
      const record = buildTaskAccumulator(memState([task])).tasks[0];
      assert.equal(record.priority, 'backlog');
      assert.equal(record.size, 'XS');
      assert.equal(record.weight, 1);
      assert.equal(record.complexity, 'high');
      assert.equal(record.risk, 'critical');
      assert.equal(record.weight === PRIORITY_RANK_GUARD(record), false);
    },
  },
  {
    id: 'COORD-009-xl-must-split',
    requirement: 'XL cannot be assigned before split',
    async run() {
      const state = memState([memTask({ taskId: 'task-xl', size: 'XL', complexity: 'high' })]);
      const ready = readyTasks(state);
      assert.equal(ready.excluded[0].reason, 'xl-must-split');
      const packet = buildWorkPackets([{ ...readyTasks(memState([memTask({ taskId: 'task-xl', size: 'XL' })]), {}, { includeBacklog: true }).ready[0] || buildTaskAccumulator(state).tasks[0] }])[0];
      assert.equal(packet.isolationReason, 'xl-must-split');
      assert.throws(() => validateAssignment({
        packet, actor: actor('subagent'), agents: loadAgentRegistry(AGENTS).agents,
      }), MemoryError);
    },
  },
  {
    id: 'COORD-010-weighted-load',
    requirement: 'waves balance packet weight not task count',
    async run() {
      const tasks = [
        memTask({ taskId: 'task-l', size: 'L', pathOwnership: ['src/l'], ownershipScope: ['src/l'] }),
        memTask({ taskId: 'task-s1', size: 'XS', moduleId: 'small', pathOwnership: ['src/s1'], ownershipScope: ['src/s1'] }),
        memTask({ taskId: 'task-s2', size: 'XS', moduleId: 'other', pathOwnership: ['src/s2'], ownershipScope: ['src/s2'] }),
      ];
      const packets = buildWorkPackets(buildTaskAccumulator(memState(tasks)).tasks);
      const wave = selectWave(packets, { slots: 2, agents: loadAgentRegistry(AGENTS).agents });
      assert.equal(wave.wave.length, 2);
      assert.equal(wave.totalWeight >= 8, true);
      assert.equal(wave.wave[0].weight >= wave.wave[1].weight, true);
    },
  },
  {
    id: 'COORD-011-tie-break',
    requirement: 'equal ready tasks break ties by stable id',
    async run() {
      const state = memState([
        memTask({ taskId: 'task-zeta', pathOwnership: ['src/z'], ownershipScope: ['src/z'] }),
        memTask({ taskId: 'task-alpha', pathOwnership: ['src/a'], ownershipScope: ['src/a'] }),
      ]);
      assert.deepEqual(readyTasks(state).deterministicOrder, ['task-alpha', 'task-zeta']);
    },
  },
  {
    id: 'COORD-012-ownership-conflict',
    requirement: 'conflicting path ownership is not parallel',
    async run() {
      const state = memState([
        memTask({ taskId: 'task-one', pathOwnership: ['src/shared'], ownershipScope: ['src/shared'] }),
        memTask({ taskId: 'task-two', pathOwnership: ['src/shared'], ownershipScope: ['src/shared'] }),
      ]);
      state.assignments = [{
        assignmentId: 'assignment-one', packetId: 'packet-one', taskIds: ['task-one'],
        actorId: 'actor-cheap', state: 'held', pathOwnership: ['src/shared'], generation: 1,
      }];
      const ready = readyTasks(state);
      assert.equal(ready.excluded.some((item) => item.reason === 'ownership-conflict' || item.reason === 'already-assigned'), true);
    },
  },
  {
    id: 'COORD-013-duplicate-assignment',
    requirement: 'duplicate assignment is rejected with no-effect',
    async run() {
      const packet = { packetId: 'packet-one', taskIds: ['task-core'], allowedPaths: ['src/core'], requiredCapabilities: ['implementation'], riskCeiling: 'routine', isolationReason: null };
      const held = [{ state: 'held', taskIds: ['task-core'], pathOwnership: ['src/core'] }];
      assert.throws(() => validateAssignment({ packet, actor: actor('subagent', { id: 'actor-cheap' }), held }), /duplicate/);
    },
  },
  {
    id: 'COORD-014-invalid-and-capability',
    requirement: 'invalid actor and insufficient capability are rejected',
    async run() {
      const packet = { packetId: 'packet-sec', taskIds: ['task-sec'], allowedPaths: ['src/sec'], requiredCapabilities: ['security_critical'], riskCeiling: 'critical', isolationReason: 'critical-risk' };
      const agents = loadAgentRegistry(AGENTS).agents;
      assert.throws(() => validateAssignment({ packet, actor: actor('subagent', { id: 'actor-missing' }), agents }), /invalid actor/);
      assert.throws(() => validateAssignment({ packet, actor: actor('subagent', { id: 'actor-cheap' }), agents }), /unknown or insufficient|insufficient/);
    },
  },
  {
    id: 'COORD-015-cheapest-eligible',
    requirement: 'cheapest eligible agent is selected',
    async run() {
      const agents = loadAgentRegistry(AGENTS).agents;
      const chosen = cheapestEligible(agents, ['implementation'], { risk: 'routine' });
      assert.equal(chosen.actorId, 'actor-cheap');
      const unknown = cheapestEligible(agents, ['security_critical'], { risk: 'critical' });
      assert.equal(unknown.actorId, 'actor-deep');
      assert.equal(cheapestEligible(agents.filter((item) => item.actorId === 'actor-unknown'), ['implementation'], { risk: 'critical' }), null);
    },
  },
  {
    id: 'COORD-016-packet-batching',
    requirement: '2-4 small same-module tasks may batch; isolated work stays isolated',
    async run() {
      const small = ['task-a', 'task-b', 'task-c'].map((taskId, index) => memTask({
        taskId, size: 'XS', moduleId: 'mod', pathOwnership: [`src/mod/${index}`], ownershipScope: [`src/mod/${index}`],
      }));
      const isolated = memTask({
        taskId: 'task-sec', size: 'S', risk: 'critical', class: 'security',
        requiredCapabilities: ['security_critical'], capabilities: ['security_critical'],
        pathOwnership: ['src/sec'], ownershipScope: ['src/sec'],
      });
      const packets = buildWorkPackets(buildTaskAccumulator(memState([...small, isolated])).tasks);
      const batched = packets.find((item) => item.taskIds.length > 1);
      const solo = packets.find((item) => item.taskIds.includes('task-sec'));
      assert.equal(batched.taskIds.length, 3);
      assert.equal(solo.taskIds.length, 1);
      assert.equal(solo.isolated, true);
    },
  },
  {
    id: 'COORD-017-context-threshold',
    requirement: 'no new packet after 65% context or conservative heuristic',
    async run() {
      assert.equal(contextAllowsNewPacket({ exact: true, usedRatio: 0.64 }), true);
      assert.equal(contextAllowsNewPacket({ exact: true, usedRatio: 0.65 }), false);
      assert.equal(contextAllowsNewPacket({ packetsAssigned: 1, lastPacket: { isolationReason: 'complex', riskCeiling: 'significant', weight: 4 } }), false);
    },
  },
  {
    id: 'COORD-018-build-first-wrapper',
    requirement: 'wrappers before Build-First require a core link; core remains allowed',
    async run() {
      const state = memState([
        memTask({ taskId: 'task-docs', class: 'documentation', priority: 'verification' }),
        memTask({ taskId: 'task-core', class: 'function' }),
        memTask({
          taskId: 'task-wrap', class: 'wrapper', enablesTaskIds: ['task-core'],
          pathOwnership: ['src/wrap'], ownershipScope: ['src/wrap'],
        }),
      ]);
      const ready = readyTasks(state);
      assert.equal(ready.excluded.find((item) => item.taskId === 'task-docs').reason, 'wrapper-without-required-core-link');
      assert.equal(ready.deterministicOrder.includes('task-core'), true);
      assert.equal(ready.deterministicOrder.includes('task-wrap'), true);
      assert.equal(buildFirstState(state).passed, false);
    },
  },
  {
    id: 'COORD-019-self-verify-and-empty-set',
    requirement: 'self-verification and empty test sets fail closed',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const agents = loadAgentRegistry(AGENTS).agents;
      assert.throws(() => selectVerifier({
        agents: agents.filter((item) => item.actorId === 'actor-cheap'),
        executor: { id: 'actor-cheap', actorId: 'actor-cheap' },
        requiredCapabilities: ['implementation'],
      }), /independently verify|unavailable/);
      const verifier = selectVerifier({
        agents, executor: { id: 'actor-cheap', actorId: 'actor-cheap', modelFamily: 'small' },
        requiredCapabilities: ['implementation'],
      });
      assert.notEqual(verifier.actorId, 'actor-cheap');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, {
          actor: actor(), title: 'Persisted verification guard', class: 'function',
          capabilities: ['implementation'],
        }, { clock }), { clock });
        store = readV3Journal(root);
        const executor = actor('subagent', { id: 'actor-cheap', runId: 'run-executor' });
        appendV3(root, recipeStart(store, { actor: executor, approach: 'produce result' }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeEvidence(store, {
          actor: executor, kind: 'test', source: 'node --test', exitCode: 0,
          expected: 'pass', actual: 'found=1 executed=1 passed=1 failed=0',
        }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeResult(store, {
          actor: executor, execution: 'succeeded', expected: 'pass', actual: 'pass',
        }, { clock }), { clock });
        appendV3(root, `${JSON.stringify(agentRegistration(AGENTS[1]))}\n`, { clock });
        store = readV3Journal(root);
        const verifierActor = actor('subagent', { id: 'actor-deep', runId: 'run-verifier' });
        const valid = JSON.parse(recipeVerify(store, {
          actor: verifierActor, result: store.state.results[0].resultId,
          found: 1, executed: 1, passed: 1, failed: 0,
        }, { clock }));
        const before = persistenceFingerprint(root);

        const selfVerify = JSON.parse(JSON.stringify(valid));
        selfVerify.subject.id = 'verification-self';
        selfVerify.payload.report.verificationId = 'verification-self';
        selfVerify.actor = executor;
        selfVerify.payload.report.verifier = executor;
        assert.throws(
          () => appendV3(root, `${JSON.stringify(selfVerify)}\n`, { clock }),
          /independently verify|own work/,
        );
        assert.deepEqual(persistenceFingerprint(root), before);

        const empty = JSON.parse(JSON.stringify(valid));
        empty.subject.id = 'verification-empty';
        empty.payload.report.verificationId = 'verification-empty';
        empty.payload.report.counts = { found: 0, executed: 0, passed: 0, failed: 0, skipped: 0 };
        assert.throws(() => appendV3(root, `${JSON.stringify(empty)}\n`, { clock }), /empty test set/);
        assert.deepEqual(persistenceFingerprint(root), before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-020-repair-limits',
    requirement: 'two failed hypotheses force a new approach; three no-progress attempts force replan',
    async run() {
      const state = memState([memTask({ taskId: 'task-repair', attemptIds: ['attempt-1', 'attempt-2', 'attempt-3'] })]);
      state.attempts = [
        { attemptId: 'attempt-1', taskId: 'task-repair', owner: 'actor-a', approachId: 'approach-x', hypothesisId: 'hyp-x', execution: 'failed' },
        { attemptId: 'attempt-2', taskId: 'task-repair', owner: 'actor-a', approachId: 'approach-x', hypothesisId: 'hyp-x', execution: 'failed' },
        { attemptId: 'attempt-3', taskId: 'task-repair', owner: 'actor-a', approachId: 'approach-x', hypothesisId: 'hyp-x', execution: 'failed' },
      ];
      state.failures = [
        { failureId: 'failure-1', subject: { type: 'task', id: 'task-repair' }, hypothesisId: 'hyp-x', approachId: 'approach-x' },
        { failureId: 'failure-2', subject: { type: 'task', id: 'task-repair' }, hypothesisId: 'hyp-x', approachId: 'approach-x' },
      ];
      const policy = repairPolicy(state, 'task-repair');
      assert.equal(policy.changeApproach, true);
      assert.equal(policy.replan, true);
    },
  },
  {
    id: 'COORD-021-no-interview-and-no-graphify',
    requirement: 'Continuity does not interview and core works without Graphify',
    async run() {
      const view = buildCoordinatorView({ state: memState([memTask({})]), events: [] }, {});
      assert.equal(view.interview.offered, false);
      assert.equal(view.graphifyRequired, false);
      assert.equal(view.daemon, false);
      assert.equal(view.contractId, COORDINATION_CONTRACT_ID);
      assert.equal(view.contractVersion, COORDINATION_CONTRACT_VERSION);
      assert.doesNotMatch(JSON.stringify(view), /interview the user|ask the user for stack/i);
    },
  },
  {
    id: 'COORD-022-no-hidden-network',
    requirement: 'coordination library has no hidden network or daemon writes',
    async run() {
      const sources = [
        '../../continuity/scripts/lib/core/coordination/contract.mjs',
        '../../continuity/scripts/lib/core/coordination/accumulator.mjs',
        '../../continuity/scripts/lib/core/coordination/registry.mjs',
        '../../continuity/scripts/lib/core/coordination/schedule.mjs',
        '../../continuity/scripts/lib/core/coordination/index.mjs',
      ];
      for (const file of sources) {
        const text = require('node:fs').readFileSync(new URL(file, import.meta.url), 'utf8');
        assert.doesNotMatch(text, /net\.|http\.|https\.|child_process|setInterval|createServer/);
      }
    },
  },
  {
    id: 'COORD-023-round-trip-and-handoff',
    requirement: 'Coordinator round-trip through public PM interface; new actor cannot claim old attempt',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, {
          actor: actor(), title: 'Ship core', class: 'function', size: 'S', priority: 'core',
          capabilities: ['implementation'], pathOwnership: ['src/core'],
        }, { clock }), { clock });
        store = readV3Journal(root);
        const ready = buildCoordinatorView(store, {}, { agents: AGENTS, slots: 1, view: 'ready' });
        assert.equal(ready.availableTasks.length, 1);
        const registered = loadAgentRegistry([AGENTS[0]]).agents[0];
        appendV3(root, `${JSON.stringify(agentRegistration(registered))}\n`, { clock });
        store = readV3Journal(root);
        appendV3(root, recipePacket(store, { actor: actor(), task: store.state.tasks[0].taskId }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeAssign(store, {
          actor: actor(), task: store.state.tasks[0].taskId, assignee: 'actor-cheap',
          pathOwnership: ['src/core'],
        }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeStart(store, { actor: actor('subagent', { id: 'actor-cheap' }), approach: 'implement core' }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeEvidence(store, {
          actor: actor('subagent', { id: 'actor-cheap' }), expected: 'core runs', actual: 'core runs',
        }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeAttemptReport(store, {
          actor: actor('subagent', { id: 'actor-cheap' }), execution: 'partial', actual: 'context high',
        }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeContextHandoff(store, {
          actor: actor('subagent', { id: 'actor-cheap' }),
          task: store.state.tasks[0].taskId,
          next: 'resume with a new attempt',
          pathOwnership: ['src/core'],
        }, { clock }), { clock });
        store = readV3Journal(root);
        const firstAttempt = store.state.attempts[0].attemptId;
        appendV3(root, recipeStart(store, {
          actor: actor('subagent', { id: 'actor-deep', runId: 'run-deep' }),
          task: store.state.tasks[0].taskId,
          approach: 'continue after handoff',
        }, { clock }), { clock });
        store = readV3Journal(root);
        assert.equal(store.state.attempts.length, 2);
        assert.notEqual(store.state.attempts[1].attemptId, firstAttempt);
        assert.notEqual(store.state.attempts[1].owner, store.state.attempts[0].owner);
        assert.equal(store.state.contextHandoffs.length, 1);
        appendV3(root, recipeEvidence(store, {
          actor: actor('subagent', { id: 'actor-deep', runId: 'run-deep' }),
          kind: 'command', source: 'node --test', exitCode: 0,
          expected: 'core runs', actual: 'found=1 executed=1 passed=1 failed=0',
        }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeResult(store, {
          actor: actor('subagent', { id: 'actor-deep', runId: 'run-deep' }),
          expected: 'core runs', actual: 'core runs',
        }, { clock }), { clock });
        store = readV3Journal(root);
        assert.throws(() => recipeVerify(store, {
          actor: actor('subagent', { id: 'actor-deep', runId: 'run-deep' }),
          result: store.state.results[0].resultId,
        }, { clock }), /independently verify/);
        appendV3(root, recipeVerify(store, {
          actor: actor('subagent', { id: 'actor-cheap', runId: 'run-verify' }),
          result: store.state.results[0].resultId,
          found: 1, executed: 1, passed: 1, failed: 0, skipped: 0,
        }, { clock }), { clock });
        store = readV3Journal(root);
        assert.equal(store.state.results[0].verification, 'passed');
        assert.equal(store.state.results[0].acceptance, 'pending');
        const before = store.events.length;
        assert.throws(() => appendV3(root, recipeAssign(store, {
          actor: actor('user'), task: store.state.tasks[0].taskId, assignee: 'actor-user',
          pathOwnership: ['src/core'],
        }, { clock }), { clock }), /user actors are not assigned/);
        store = readV3Journal(root);
        assert.equal(store.events.length, before);
        rmSync(store.files.current, { force: true });
        rebuildV3(root);
        store = readV3Journal(root);
        assert.equal(store.projection, 'current');
        assert.equal(foldV3(store.events).verificationReports.length, 1);
        const view = buildCoordinatorView(store, {}, { agents: AGENTS, view: 'ready' });
        assert.equal(view.userAcceptance, 'pending');
        assert.equal(view.buildFirst.passed, true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-024-pm-without-coordinator-runtime',
    requirement: 'Continuity mutates without a Coordinator process',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, { actor: actor(), title: 'Standalone' }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeStart(store, { actor: actor(), approach: 'direct' }, { clock }), { clock });
        store = readV3Journal(root);
        assert.equal(store.state.tasks.length, 1);
        assert.equal(store.state.attempts.length, 1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-025-secret-agent-rejected',
    requirement: 'capability registry rejects secrets',
    async run() {
      assert.throws(() => loadAgentRegistry([{ actorId: 'actor-bad', apiKey: 'sk-live-secret', capabilityProfiles: ['mechanical'] }]), /must not store/);
    },
  },
  {
    id: 'COORD-026-calibration-not-high-trust',
    requirement: 'calibration cannot grant high trust automatically',
    async run() {
      assert.throws(() => loadAgentRegistry([{
        actorId: 'actor-new', capabilityProfiles: ['implementation'],
        calibrationStatus: 'limited', trustTier: 'high',
      }]), /high trust/);
    },
  },
  {
    id: 'COORD-027-release-and-stale',
    requirement: 'explicit release, not wall-clock, frees an assignment',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, { actor: actor(), title: 'Owned', pathOwnership: ['src/a'] }, { clock }), { clock });
        store = readV3Journal(root);
        const registered = loadAgentRegistry([AGENTS[0]]).agents[0];
        appendV3(root, `${JSON.stringify(agentRegistration(registered))}\n`, { clock });
        store = readV3Journal(root);
        appendV3(root, recipePacket(store, { actor: actor(), task: store.state.tasks[0].taskId }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeAssign(store, {
          actor: actor(), task: store.state.tasks[0].taskId, assignee: 'actor-cheap', pathOwnership: ['src/a'],
        }, { clock }), { clock });
        store = readV3Journal(root);
        assert.equal(store.state.assignments[0].state, 'held');
        appendV3(root, recipeRelease(store, { actor: actor(), why: 'actor finished' }, { clock }), { clock });
        store = readV3Journal(root);
        assert.equal(store.state.assignments[0].state, 'released');
        assert.equal(store.state.tasks[0].assignmentId, null);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-028-cli-ready-wave',
    requirement: 'CLI inspect ready/wave is read-only; record assign mutates a real v3 store',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, {
          actor: actor(), title: 'Ship core', class: 'function', size: 'S', priority: 'core',
          capabilities: ['implementation'], pathOwnership: ['src/core'],
        }, { clock }), { clock });
        store = readV3Journal(root);
        const coordinatorAgent = loadAgentRegistry([{
          actorId: 'actor-coordinator',
          capabilityProfiles: ['implementation'],
          trustTier: 'standard',
          calibrationStatus: 'calibrated',
          kind: 'coordinator',
        }]).agents[0];
        appendV3(root, `${JSON.stringify(agentRegistration(coordinatorAgent))}\n`, { clock });
        store = readV3Journal(root);
        appendV3(root, recipePacket(store, { actor: actor(), task: store.state.tasks[0].taskId }, { clock }), { clock });
        store = readV3Journal(root);
        const beforeInspect = persistenceFingerprint(root);
        const before = store.events.at(-1).sequence;
        const taskId = store.state.tasks[0].taskId;
        const readyCli = runProjectMemory(root, ['inspect', 'ready', '--json']);
        assert.equal(readyCli.status, 0, readyCli.stderr);
        const readyView = JSON.parse(readyCli.stdout);
        assert.equal(readyView.view, 'ready');
        assert.equal(readyView.availableTasks.some((item) => item.id === taskId), true, readyCli.stdout);
        assert.deepEqual(persistenceFingerprint(root), beforeInspect);
        const waveCli = runProjectMemory(root, ['inspect', 'wave', '--json']);
        assert.equal(waveCli.status, 0, waveCli.stderr);
        const waveView = JSON.parse(waveCli.stdout);
        assert.equal(waveView.view, 'wave');
        assert.equal(waveView.wave.wave.some((item) => item.taskIds.includes(taskId)), true);
        assert.deepEqual(persistenceFingerprint(root), beforeInspect);
        const omittedAssign = runProjectMemory(root, ['record', 'assign', '--task', taskId]);
        assert.notEqual(omittedAssign.status, 0, omittedAssign.stdout);
        assert.equal(omittedAssign.stdout, '');
        assert.match(omittedAssign.stderr, /assignee/i);
        assert.deepEqual(persistenceFingerprint(root), beforeInspect);
        const assignCli = runProjectMemory(root, [
          'record', 'assign', '--task', taskId, '--assignee', 'actor-coordinator',
        ]);
        assert.equal(assignCli.status, 0, assignCli.stderr);
        assert.match(assignCli.stdout, /event recorded: sequence=/);
        store = readV3Journal(root);
        assert.equal(store.events.at(-1).sequence, before + 1);
        assert.equal(store.state.assignments[0].state, 'held');
        assert.deepEqual(store.state.assignments[0].taskIds, [taskId]);
        const afterAssign = runProjectMemory(root, ['inspect', 'ready', '--json']);
        assert.equal(afterAssign.status, 0, afterAssign.stderr);
        const afterView = JSON.parse(afterAssign.stdout);
        assert.equal(afterView.availableTasks.some((item) => item.id === taskId), false);
        assert.equal(afterView.excludedTasks.some((item) => item.taskId === taskId && item.reason === 'already-assigned'), true);
        assert.equal(readV3Journal(root).events.at(-1).sequence, before + 1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-029-backlog-append-rejected',
    requirement: 'parking the only required-criterion task in backlog is a no-effect reject',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, {
          actor: actor(), title: 'Required core', size: 'S', priority: 'core',
          capabilities: ['implementation'], pathOwnership: ['src/core'],
        }, { clock }), { clock });
        store = readV3Journal(root);
        const before = store.events.at(-1).sequence;
        const taskId = store.state.tasks[0].taskId;
        assert.equal(store.state.tasks[0].priority, 'core');
        const draft = recipeBacklog(store, {
          actor: actor(), task: taskId, why: 'hide the required criterion',
        }, { clock });
        assert.throws(() => appendV3(root, draft, { clock }), MemoryError);
        assert.throws(() => appendV3(root, draft, { clock }), /required-criterion-cannot-hide-in-backlog/);
        store = readV3Journal(root);
        assert.equal(store.events.at(-1).sequence, before);
        assert.equal(store.events.length, before);
        assert.equal(store.state.tasks[0].priority, 'core');
        assert.equal(store.state.backlogItems.length, 0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-030-stale-assignment',
    requirement: 'a second release of a released assignment is rejected; superseded generations are not live',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, {
          actor: actor(), title: 'Owned', class: 'function', pathOwnership: ['src/a'],
        }, { clock }), { clock });
        store = readV3Journal(root);
        const taskId = store.state.tasks[0].taskId;
        const registered = loadAgentRegistry([AGENTS[0]]).agents[0];
        appendV3(root, `${JSON.stringify(agentRegistration(registered))}\n`, { clock });
        store = readV3Journal(root);
        appendV3(root, recipePacket(store, { actor: actor(), task: taskId }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeAssign(store, {
          actor: actor(), task: taskId, assignee: 'actor-cheap', pathOwnership: ['src/a'],
        }, { clock }), { clock });
        store = readV3Journal(root);
        const generation = store.state.assignments[0].generation;
        appendV3(root, recipeRelease(store, { actor: actor(), why: 'actor finished' }, { clock }), { clock });
        store = readV3Journal(root);
        assert.equal(store.state.assignments[0].state, 'released');
        assert.equal(store.state.assignments[0].generation, generation);
        assert.equal(store.state.tasks[0].assignmentId, null);
        const ready = readyTasks(store.state);
        assert.equal(ready.deterministicOrder.includes(taskId), true);
        assert.equal(ready.excluded.some((item) => item.reason === 'already-assigned'), false);
        const before = store.events.at(-1).sequence;
        assert.throws(() => recipeRelease(store, { actor: actor(), why: 'release again' }, { clock }), /record release requires an assignment/);
        store = readV3Journal(root);
        assert.equal(store.events.at(-1).sequence, before);
        assert.equal(store.state.assignments[0].state, 'released');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      const stale = memState([memTask({ assignmentGeneration: 2 })], {
        assignments: [{
          assignmentId: 'assignment-stale',
          packetId: 'packet-stale',
          taskIds: ['task-core'],
          actorId: 'actor-cheap',
          state: 'superseded',
          pathOwnership: ['src/core'],
          generation: 1,
        }],
      });
      const staleReady = readyTasks(stale);
      assert.deepEqual(staleReady.deterministicOrder, ['task-core']);
      assert.equal(staleReady.excluded.some((item) => item.reason === 'already-assigned'), false);
    },
  },
  {
    id: 'COORD-031-journal-corruption-rebuild',
    requirement: 'rebuildV3 restores CURRENT.json from the journal after projection corruption',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, {
          actor: actor(), title: 'Persisted core', size: 'S', priority: 'core',
          capabilities: ['implementation'], pathOwnership: ['src/core'],
        }, { clock }), { clock });
        store = readV3Journal(root);
        assert.equal(store.projection, 'current');
        const sequence = store.events.at(-1).sequence;
        const taskId = store.state.tasks[0].taskId;
        writeFileSync(store.files.current, '{not-valid-current-json');
        store = readV3Journal(root);
        assert.equal(store.projection, 'invalid');
        assert.equal(store.events.at(-1).sequence, sequence);
        assert.equal(store.state.tasks[0].taskId, taskId);
        const rebuilt = rebuildV3(root);
        assert.equal(rebuilt.sequence, sequence);
        store = readV3Journal(root);
        assert.equal(store.projection, 'current');
        assert.equal(store.events.at(-1).sequence, sequence);
        assert.equal(store.state.tasks[0].taskId, taskId);
        assert.equal(store.state.tasks[0].title, 'Persisted core');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-032-historical-pass-not-current',
    requirement: 'a verification pass does not become current user acceptance',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, {
          actor: actor(), title: 'Ship core', class: 'function', size: 'S', priority: 'core',
          capabilities: ['implementation'], pathOwnership: ['src/core'],
        }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeStart(store, {
          actor: actor('subagent', { id: 'actor-cheap' }), approach: 'implement core',
        }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeEvidence(store, {
          actor: actor('subagent', { id: 'actor-cheap' }), kind: 'command', source: 'node --test',
          expected: 'core runs', actual: 'found=1 executed=1 passed=1 failed=0', exitCode: 0,
        }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeResult(store, {
          actor: actor('subagent', { id: 'actor-cheap' }), expected: 'core runs', actual: 'core runs',
        }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, `${JSON.stringify(agentRegistration(AGENTS[1]))}\n`, { clock });
        store = readV3Journal(root);
        appendV3(root, recipeVerify(store, {
          actor: actor('subagent', { id: 'actor-deep', runId: 'run-verify' }),
          result: store.state.results[0].resultId,
          found: 1, executed: 1, passed: 1, failed: 0, skipped: 0,
        }, { clock }), { clock });
        store = readV3Journal(root);
        assert.equal(store.state.results[0].verification, 'passed');
        assert.equal(store.state.results[0].acceptance, 'pending');
        assert.equal(store.state.goals[0].acceptance, 'pending');
        const live = liveContextFromWorkspace(store.state.workspaceAtLastEvent);
        const coordinator = buildCoordinatorView(store, live, { agents: AGENTS, view: 'ready' });
        assert.equal(coordinator.userAcceptance, 'pending');
        assert.equal(coordinator.goal.acceptance, 'pending');
        const inspect = buildInspectV3(store, live);
        assert.equal(inspect.goal.acceptance, 'pending');
        assert.equal(inspect.rejections.length, 0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-033-attempt-report-not-evidence',
    requirement: 'attempt.reported cannot carry authorizing evidence; executor summary is not evidence',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, {
          actor: actor(), title: 'Ship core', size: 'S', priority: 'core',
        }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeStart(store, {
          actor: actor('subagent', { id: 'actor-cheap' }), approach: 'implement core',
        }, { clock }), { clock });
        store = readV3Journal(root);
        const before = store.events.at(-1).sequence;
        const parsed = JSON.parse(recipeAttemptReport(store, {
          actor: actor('subagent', { id: 'actor-cheap' }), execution: 'partial', actual: 'looks done',
        }, { clock }));
        parsed.payload.report.authorizing = true;
        assert.throws(() => validateDraftV3(parsed, store.state), /executor words are not evidence/);
        assert.throws(() => appendV3(root, `${JSON.stringify(parsed)}\n`, { clock }), /executor words are not evidence/);
        store = readV3Journal(root);
        assert.equal(store.events.at(-1).sequence, before);
        assert.equal(store.state.attemptReports.length, 0);
        assert.equal(store.state.evidence.length, 0);
        appendV3(root, recipeAttemptReport(store, {
          actor: actor('subagent', { id: 'actor-cheap' }), execution: 'partial', actual: 'looks done',
        }, { clock }), { clock });
        store = readV3Journal(root);
        assert.equal(store.events.at(-1).sequence, before + 1);
        assert.equal(store.state.attemptReports.length, 1);
        assert.equal(store.state.attemptReports[0].authorizing, false);
        assert.equal(store.state.evidence.length, 0);
        assert.equal(store.state.evidence.some((item) => item.authorizing === true), false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-034-planned-backlog-persist-no-effect',
    requirement: 'requirement 1: planning the sole required-criterion task as backlog is journal no-effect',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        const store = readV3Journal(root);
        const before = persistenceFingerprint(root);
        const draft = recipeTask(store, {
          actor: actor(), title: 'Hidden required work', priority: 'backlog',
        }, { clock });
        assert.throws(() => appendV3(root, draft, { clock }), /required-criterion-cannot-hide-in-backlog/);
        assert.deepEqual(persistenceFingerprint(root), before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-035-parked-coverage-terminal-transition-no-effect',
    requirement: 'requirement 1: after A is parked, B cannot fail or be superseded and hide required coverage',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, { actor: actor(), title: 'Coverage A' }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeTask(store, { actor: actor(), title: 'Coverage B' }, { clock }), { clock });
        store = readV3Journal(root);
        const [taskA, taskB] = store.state.tasks;
        appendV3(root, recipeBacklog(store, {
          actor: actor(), task: taskA.taskId, why: 'B remains active coverage',
        }, { clock }), { clock });
        const before = persistenceFingerprint(root);
        for (const execution of ['failed', 'superseded']) {
          const draft = {
            eventType: 'task.status_changed',
            occurredAt: clock().toISOString(),
            actor: actor(),
            subject: { type: 'task', id: taskB.taskId },
            taskId: taskB.taskId,
            supersedes: [],
            contradicts: [],
            evidenceRefs: [],
            sensitivity: 'internal',
            payload: { execution, reason: 'would remove the remaining active coverage' },
          };
          assert.throws(
            () => appendV3(root, `${JSON.stringify(draft)}\n`, { clock }),
            /required-criterion-cannot-hide-in-backlog/,
          );
          assert.deepEqual(persistenceFingerprint(root), before);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-036-parked-coverage-all-status-writes-no-effect',
    requirement: 'requirement 1: failure and failed Result writes cannot strand required work in backlog',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, { actor: actor(), title: 'Parked coverage' }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeTask(store, { actor: actor(), title: 'Active coverage' }, { clock }), { clock });
        store = readV3Journal(root);
        const [parked, active] = store.state.tasks;
        appendV3(root, recipeBacklog(store, {
          actor: actor(), task: parked.taskId, why: 'active task carries the criterion',
        }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeStart(store, {
          actor: actor('subagent', { id: 'actor-cheap' }), task: active.taskId, approach: 'attempt coverage',
        }, { clock }), { clock });
        store = readV3Journal(root);
        const before = persistenceFingerprint(root);
        const failedRun = runProjectMemory(root, [
          'record', 'fail', '--as', 'subagent', '--why', 'failed',
          '--impact', 'coverage lost', '--next', 'replace task',
        ]);
        assert.notEqual(failedRun.status, 0);
        assert.match(failedRun.stderr, /required-criterion-cannot-hide-in-backlog/);
        assert.deepEqual(persistenceFingerprint(root), before);
        store = readV3Journal(root);
        const failedResult = recipeResult(store, {
          actor: actor('subagent', { id: 'actor-cheap' }), execution: 'failed',
          expected: 'coverage remains', actual: 'attempt failed',
        }, { clock });
        assert.throws(
          () => appendV3(root, failedResult, { clock }),
          /required-criterion-cannot-hide-in-backlog/,
        );
        assert.deepEqual(persistenceFingerprint(root), before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-037-backlog-requires-fresh-authorizing-pass',
    requirement: 'requirement 1: historical passed verification cannot authorize park unless command evidence is fresh',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const runCompletedTask = (root, { workspace, head } = {}) => {
        const writeOptions = workspace ? { clock, workspace } : { clock };
        initializeV3(root, JSON.stringify(INIT), writeOptions);
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, {
          actor: actor(), title: 'Verified core', class: 'function', capabilities: ['implementation'],
        }, { clock }), writeOptions);
        store = readV3Journal(root);
        appendV3(root, recipeStart(store, {
          actor: actor('subagent', { id: 'actor-cheap' }), approach: 'implement verified core',
        }, { clock }), writeOptions);
        store = readV3Journal(root);
        appendV3(root, recipeEvidence(store, {
          actor: actor('subagent', { id: 'actor-cheap' }), kind: 'command', source: 'node --test',
          expected: 'command passes', actual: 'found=1 executed=1 passed=1 failed=0', exitCode: 0,
          ...(head ? { head } : {}),
        }, { clock }), writeOptions);
        store = readV3Journal(root);
        appendV3(root, recipeResult(store, {
          actor: actor('subagent', { id: 'actor-cheap' }), expected: 'core works', actual: 'core works',
        }, { clock }), writeOptions);
        store = readV3Journal(root);
        appendV3(root, `${JSON.stringify(agentRegistration(AGENTS[1]))}\n`, writeOptions);
        store = readV3Journal(root);
        appendV3(root, recipeVerify(store, {
          actor: actor('subagent', { id: 'actor-deep', runId: 'run-independent' }),
          result: store.state.results[0].resultId,
          found: 1, executed: 1, passed: 1, failed: 0, skipped: 0,
        }, { clock }), writeOptions);
        return readV3Journal(root);
      };

      const historicalRoot = makeRepo();
      const freshRoot = makeRepo();
      try {
        let historical = runCompletedTask(historicalRoot);
        const historicalBefore = persistenceFingerprint(historicalRoot);
        assert.throws(
          () => appendV3(historicalRoot, recipeBacklog(historical, {
            actor: actor(), task: historical.state.tasks[0].taskId, why: 'historical pass only',
          }, { clock }), { clock }),
          /required-criterion-cannot-hide-in-backlog/,
        );
        assert.deepEqual(persistenceFingerprint(historicalRoot), historicalBefore);

        const head = 'a'.repeat(40);
        const workspace = {
          head,
          branch: 'main',
          dirty: false,
          statusFingerprint: 'b'.repeat(64),
          fingerprintPartial: false,
          capturedAt: clock().toISOString(),
        };
        let fresh = runCompletedTask(freshRoot, { workspace, head });
        const freshBefore = fresh.events.at(-1).sequence;
        appendV3(freshRoot, recipeBacklog(fresh, {
          actor: actor(), task: fresh.state.tasks[0].taskId, why: 'fresh command evidence authorizes park',
        }, { clock }), { clock, workspace });
        fresh = readV3Journal(freshRoot);
        assert.equal(fresh.events.at(-1).sequence, freshBefore + 1);
        assert.equal(fresh.state.tasks[0].priority, 'backlog');
      } finally {
        rmSync(historicalRoot, { recursive: true, force: true });
        rmSync(freshRoot, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-038-assignment-path-policy-no-effect',
    requirement: 'requirement 4: traversal UNC home absolute and drive ownership paths are rejected with no-effect',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, {
          actor: actor(), title: 'Owned core', size: 'S', complexity: 'low',
          pathOwnership: ['src/core'], moduleId: 'core',
        }, { clock }), { clock });
        store = readV3Journal(root);
        const taskId = store.state.tasks[0].taskId;
        appendV3(root, recipePacket(store, { actor: actor(), task: taskId }, { clock }), { clock });
        store = readV3Journal(root);
        const registered = loadAgentRegistry([AGENTS[0]]).agents[0];
        const registration = {
          eventType: 'agent.registered',
          occurredAt: clock().toISOString(),
          actor: actor(),
          subject: { type: 'agent', id: registered.actorId },
          supersedes: [],
          contradicts: [],
          evidenceRefs: [],
          sensitivity: 'internal',
          payload: { agent: registered },
        };
        appendV3(root, `${JSON.stringify(registration)}\n`, { clock });
        store = readV3Journal(root);
        const before = persistenceFingerprint(root);
        const invalidPaths = [
          '../src', 'src/../core', '\\\\server\\share', '~/src', '/absolute', 'C:\\absolute', '\\rooted',
          'src/file:stream',
        ];
        for (const [index, invalidPath] of invalidPaths.entries()) {
          const draft = {
            eventType: 'assignment.recorded',
            occurredAt: clock().toISOString(),
            actor: actor(),
            subject: { type: 'assignment', id: `assignment-invalid-${index}` },
            taskId,
            supersedes: [],
            contradicts: [],
            evidenceRefs: [],
            sensitivity: 'internal',
            payload: {
              assignment: {
                assignmentId: `assignment-invalid-${index}`,
                packetId: store.state.packages[0].packetId,
                taskIds: [taskId],
                actorId: registered.actorId,
                generation: store.events.length + 1,
                pathOwnership: [invalidPath],
              },
            },
          };
          assert.throws(
            () => appendV3(root, `${JSON.stringify(draft)}\n`, { clock }),
            /ownership.*repository-relative|repository-relative.*ownership/,
          );
          assert.deepEqual(persistenceFingerprint(root), before);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-039-ownership-inheritance-prefix-and-module-conflict',
    requirement: 'requirement 4: missing ownership inherits task paths or module and prefix conflicts cannot run in parallel',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        for (const record of loadAgentRegistry(AGENTS.slice(0, 2)).agents) {
          const registration = {
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
          appendV3(root, `${JSON.stringify(registration)}\n`, { clock });
          store = readV3Journal(root);
        }
        appendV3(root, recipeTask(store, {
          actor: actor(), title: 'Own src', class: 'function', size: 'S', complexity: 'low', moduleId: 'root', pathOwnership: ['src'],
        }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeTask(store, {
          actor: actor(), title: 'Own src core', class: 'function', size: 'S', complexity: 'low', moduleId: 'core', pathOwnership: ['src/core'],
        }, { clock }), { clock });
        store = readV3Journal(root);
        const [rootTask, nestedTask] = store.state.tasks;
        const wave = buildCoordinatorView(store, {}, { agents: AGENTS, slots: 2, view: 'wave' });
        assert.equal(wave.wave.wave.length, 1);
        for (const task of [rootTask, nestedTask]) {
          appendV3(root, recipePacket(store, { actor: actor(), task: task.taskId }, { clock }), { clock });
          store = readV3Journal(root);
        }
        const rawAssignment = (idValue, packetId, taskId, actorId) => ({
          eventType: 'assignment.recorded',
          occurredAt: clock().toISOString(),
          actor: actor(),
          subject: { type: 'assignment', id: idValue },
          taskId,
          supersedes: [],
          contradicts: [],
          evidenceRefs: [],
          sensitivity: 'internal',
          payload: {
            assignment: {
              assignmentId: idValue,
              packetId,
              taskIds: [taskId],
              actorId,
              generation: store.events.length + 1,
            },
          },
        });
        appendV3(root, `${JSON.stringify(rawAssignment(
          'assignment-root', store.state.packages[0].packetId, rootTask.taskId, 'actor-cheap',
        ))}\n`, { clock });
        store = readV3Journal(root);
        assert.deepEqual(store.state.assignments[0].pathOwnership, ['src']);
        const prefixBefore = persistenceFingerprint(root);
        assert.throws(
          () => appendV3(root, `${JSON.stringify(rawAssignment(
            'assignment-nested', store.state.packages[1].packetId, nestedTask.taskId, 'actor-deep',
          ))}\n`, { clock }),
          /ownership conflict|conflicting assignment ownership/,
        );
        assert.deepEqual(persistenceFingerprint(root), prefixBefore);

        appendV3(root, recipeTask(store, {
          actor: actor(), title: 'Own case-folded SRC core', class: 'function', size: 'S', complexity: 'low',
          moduleId: 'case-core', pathOwnership: ['SRC/core'],
        }, { clock }), { clock });
        store = readV3Journal(root);
        const caseTask = store.state.tasks.at(-1);
        const caseView = buildCoordinatorView(store, {}, { agents: AGENTS, slots: 2, view: 'ready' });
        assert.equal(caseView.availableTasks.some((item) => item.id === caseTask.taskId), false);
        assert.equal(caseView.excludedTasks.some((item) => (
          item.taskId === caseTask.taskId && item.reason === 'ownership-conflict'
        )), true);
        appendV3(root, recipePacket(store, { actor: actor(), task: caseTask.taskId }, { clock }), { clock });
        store = readV3Journal(root);
        const casePacket = store.state.packages.at(-1);
        const caseBefore = persistenceFingerprint(root);
        assert.throws(
          () => appendV3(root, `${JSON.stringify(rawAssignment(
            'assignment-case-folded', casePacket.packetId, caseTask.taskId, 'actor-deep',
          ))}\n`, { clock }),
          /ownership conflict|conflicting assignment ownership/,
        );
        assert.deepEqual(persistenceFingerprint(root), caseBefore);

        for (const title of ['Module one', 'Module two']) {
          appendV3(root, recipeTask(store, {
            actor: actor(), title, class: 'function', size: 'S', complexity: 'low', moduleId: 'shared-module', pathOwnership: [],
          }, { clock }), { clock });
          store = readV3Journal(root);
        }
        const moduleTasks = store.state.tasks.slice(-2);
        for (const task of moduleTasks) {
          appendV3(root, recipePacket(store, { actor: actor(), task: task.taskId }, { clock }), { clock });
          store = readV3Journal(root);
        }
        const modulePackets = store.state.packages.slice(-2);
        appendV3(root, `${JSON.stringify(rawAssignment(
          'assignment-module-one', modulePackets[0].packetId, moduleTasks[0].taskId, 'actor-deep',
        ))}\n`, { clock });
        store = readV3Journal(root);
        assert.deepEqual(store.state.assignments.at(-1).pathOwnership, ['shared-module']);
        const moduleBefore = persistenceFingerprint(root);
        assert.throws(
          () => appendV3(root, `${JSON.stringify(rawAssignment(
            'assignment-module-two', modulePackets[1].packetId, moduleTasks[1].taskId, 'actor-cheap',
          ))}\n`, { clock }),
          /ownership conflict|conflicting assignment ownership/,
        );
        assert.deepEqual(persistenceFingerprint(root), moduleBefore);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-040-packet-persist-scheduler-policy-no-effect',
    requirement: 'requirement 5: persisted packets enforce XL batching capability and isolation scheduler rules',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        const definitions = [
          { title: 'Mixed module A', size: 'XS', moduleId: 'alpha', capabilities: ['implementation'], pathOwnership: ['src/a'] },
          { title: 'Mixed module B', size: 'XS', moduleId: 'beta', capabilities: ['implementation'], pathOwnership: ['src/b'] },
          { title: 'Mixed capability', size: 'XS', moduleId: 'alpha', capabilities: ['integration'], pathOwnership: ['src/c'] },
          { title: 'Complex task', size: 'XS', moduleId: 'alpha', complexity: 'high', capabilities: ['implementation'], pathOwnership: ['src/d'] },
          { title: 'Critical task', size: 'XS', moduleId: 'alpha', risk: 'critical', capabilities: ['implementation'], pathOwnership: ['src/e'] },
          { title: 'Large task', size: 'L', moduleId: 'alpha', capabilities: ['implementation'], pathOwnership: ['src/f'] },
          { title: 'XL task', size: 'XL', moduleId: 'alpha', capabilities: ['implementation'], pathOwnership: ['src/g'] },
        ];
        for (const definition of definitions) {
          appendV3(root, recipeTask(store, {
            actor: actor(), class: 'function', complexity: 'low', risk: 'routine', ...definition,
          }, { clock }), { clock });
          store = readV3Journal(root);
        }
        const tasks = store.state.tasks;
        const scenarios = [
          { taskIds: [tasks[0].taskId, tasks[1].taskId], error: /same module|batch|isolation/i },
          { taskIds: [tasks[0].taskId, tasks[2].taskId], error: /capabil|batch|isolation/i },
          { taskIds: [tasks[0].taskId, tasks[3].taskId], error: /complex|batch|isolation/i },
          { taskIds: [tasks[0].taskId, tasks[4].taskId], error: /critical|batch|isolation/i },
          { taskIds: [tasks[0].taskId, tasks[5].taskId], error: /large|batch|isolation/i },
          { taskIds: [tasks[6].taskId], error: /XL.*split|split.*XL/i },
        ];
        const before = persistenceFingerprint(root);
        for (const { taskIds, error } of scenarios) {
          const draft = recipePacket(store, { actor: actor(), taskIds }, { clock });
          assert.throws(
            () => appendV3(root, draft, { clock }),
            error,
          );
          assert.deepEqual(persistenceFingerprint(root), before);
        }
        const isolated = recipePacket(store, { actor: actor(), taskIds: [tasks[4].taskId] }, { clock });
        appendV3(root, isolated, { clock });
        store = readV3Journal(root);
        assert.deepEqual(store.state.packages.at(-1).taskIds, [tasks[4].taskId]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-041-assignment-persist-actor-capability-and-packet-policy',
    requirement: 'requirement 5: persisted assignments reject XL invalid actors packet mismatch and critical capability gaps',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        for (const record of loadAgentRegistry(AGENTS).agents) {
          const registration = {
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
          appendV3(root, `${JSON.stringify(registration)}\n`, { clock });
          store = readV3Journal(root);
        }
        const definitions = [
          {
            title: 'Critical security', size: 'S', complexity: 'low', risk: 'critical',
            capabilities: ['security_critical'], moduleId: 'security', pathOwnership: ['src/security'],
          },
          {
            title: 'Routine implementation', size: 'S', complexity: 'low', risk: 'routine',
            capabilities: ['implementation'], moduleId: 'routine', pathOwnership: ['src/routine'],
          },
          {
            title: 'Unsplit XL', size: 'XL', complexity: 'high', risk: 'routine',
            capabilities: ['implementation'], moduleId: 'large', pathOwnership: ['src/large'],
          },
        ];
        for (const definition of definitions) {
          appendV3(root, recipeTask(store, { actor: actor(), class: 'function', ...definition }, { clock }), { clock });
          store = readV3Journal(root);
        }
        const [criticalTask, routineTask, xlTask] = store.state.tasks;
        const xlBeforePacket = persistenceFingerprint(root);
        assert.throws(
          () => appendV3(root, recipePacket(store, { actor: actor(), task: xlTask.taskId }, { clock }), { clock }),
          /XL.*split|split.*XL/i,
        );
        assert.deepEqual(persistenceFingerprint(root), xlBeforePacket);
        for (const task of [criticalTask, routineTask]) {
          appendV3(root, recipePacket(store, { actor: actor(), task: task.taskId }, { clock }), { clock });
          store = readV3Journal(root);
        }
        const [criticalPacket, routinePacket] = store.state.packages;
        const assignment = (idValue, packetId, task, actorId) => ({
          eventType: 'assignment.recorded',
          occurredAt: clock().toISOString(),
          actor: actor(),
          subject: { type: 'assignment', id: idValue },
          taskId: task.taskId,
          supersedes: [],
          contradicts: [],
          evidenceRefs: [],
          sensitivity: 'internal',
          payload: {
            assignment: {
              assignmentId: idValue,
              packetId,
              taskIds: [task.taskId],
              actorId,
              generation: store.events.length + 1,
            },
          },
        });
        const rejected = [
          assignment('assignment-invalid-actor', routinePacket.packetId, routineTask, 'actor-missing'),
          assignment('assignment-unknown-critical', criticalPacket.packetId, criticalTask, 'actor-unknown'),
          assignment('assignment-insufficient-critical', criticalPacket.packetId, criticalTask, 'actor-cheap'),
          assignment('assignment-packet-mismatch', routinePacket.packetId, criticalTask, 'actor-deep'),
        ];
        const before = persistenceFingerprint(root);
        for (const draft of rejected) {
          assert.throws(
            () => appendV3(root, `${JSON.stringify(draft)}\n`, { clock }),
            /invalid actor|unregistered|unknown|insufficient|capabil|packet|XL|split/i,
          );
          assert.deepEqual(persistenceFingerprint(root), before);
        }
        appendV3(root, `${JSON.stringify(assignment(
          'assignment-critical-valid', criticalPacket.packetId, criticalTask, 'actor-deep',
        ))}\n`, { clock });
        store = readV3Journal(root);
        assert.equal(store.state.assignments.at(-1).actorId, 'actor-deep');
        assert.deepEqual(store.state.assignments.at(-1).pathOwnership, ['src/security']);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-042-verification-counts-public-no-effect',
    requirement: 'requirement 2: passed verification requires explicit honest counts and rejected CLI or raw drafts are journal no-effect',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, {
          actor: actor(), title: 'Counted verification', class: 'function',
        }, { clock }), { clock });
        store = readV3Journal(root);
        const executor = actor('subagent', { id: 'actor-cheap', runId: 'run-executor' });
        appendV3(root, recipeStart(store, { actor: executor, approach: 'produce a verifiable result' }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeEvidence(store, {
          actor: executor, kind: 'command', source: 'node --test', expected: 'one test passes',
          actual: 'found=1 executed=1 passed=1 failed=0', exitCode: 0,
        }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeResult(store, {
          actor: executor, expected: 'one test passes', actual: 'implementation result recorded',
        }, { clock }), { clock });
        store = readV3Journal(root);
        const resultId = store.state.results[0].resultId;
        appendV3(root, `${JSON.stringify(agentRegistration(AGENTS[1]))}\n`, { clock });
        store = readV3Journal(root);
        const before = persistenceFingerprint(root);

        const missingCounts = runProjectMemory(root, [
          'record', 'verify', '--as', 'subagent', '--result', resultId,
        ]);
        assert.notEqual(missingCounts.status, 0);
        assert.match(missingCounts.stderr, /count|found|executed|passed|failed/i);
        assert.deepEqual(persistenceFingerprint(root), before);

        const verifier = actor('subagent', { id: 'actor-deep', runId: 'run-verifier' });
        const badCounts = JSON.parse(recipeVerify(store, {
          actor: verifier, result: resultId,
          found: 1, executed: 1, passed: 1, failed: 0, skipped: 0,
        }, { clock }));
        badCounts.payload.report.outcome = 'passed';
        badCounts.payload.report.counts = { found: 1, executed: 1, passed: 0, failed: 99, skipped: 0 };
        const badCountsFile = path.join(os.tmpdir(), `${path.basename(root)}-bad-counts.json`);
        try {
          writeFileSync(badCountsFile, `${JSON.stringify(badCounts)}\n`);
          const cliBadCounts = runProjectMemory(root, ['record', '--file', badCountsFile]);
          assert.notEqual(cliBadCounts.status, 0);
          assert.match(cliBadCounts.stderr, /passed verification requires passed counts and no failures/);
          assert.deepEqual(persistenceFingerprint(root), before);
        } finally {
          rmSync(badCountsFile, { force: true });
        }
        assert.throws(
          () => appendV3(root, `${JSON.stringify(badCounts)}\n`, { clock }),
          /passed verification requires passed counts and no failures/,
        );
        assert.deepEqual(persistenceFingerprint(root), before);

        const missingFailed = JSON.parse(JSON.stringify(badCounts));
        missingFailed.subject.id = 'verification-missing-failed';
        missingFailed.payload.report.verificationId = 'verification-missing-failed';
        missingFailed.payload.report.counts = { found: 1, executed: 1, passed: 1, skipped: 0 };
        assert.throws(
          () => appendV3(root, `${JSON.stringify(missingFailed)}\n`, { clock }),
          /report\.counts.*missing required|failed.*required|failed.*zero/i,
        );
        assert.deepEqual(persistenceFingerprint(root), before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-043-verifier-attempt-identity-public-no-effect',
    requirement: 'requirement 3: Result and VerificationReport preserve executor attempt identity and rejected self-verification is journal no-effect',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, { actor: actor(), title: 'Identity-bound result' }, { clock }), { clock });
        store = readV3Journal(root);
        const executor = actor('subagent', { id: 'actor-cheap', runId: 'run-executor' });
        appendV3(root, recipeStart(store, { actor: executor, approach: 'identity-bound attempt' }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeEvidence(store, {
          actor: executor, kind: 'command', source: 'node --test', expected: 'identity test passes',
          actual: 'found=1 executed=1 passed=1 failed=0', exitCode: 0,
        }, { clock }), { clock });
        store = readV3Journal(root);

        const validResult = JSON.parse(recipeResult(store, {
          actor: executor, expected: 'identity test passes', actual: 'executor result',
        }, { clock }));
        const substitutedResult = JSON.parse(JSON.stringify(validResult));
        substitutedResult.payload.result.actor = actor('subagent', { id: 'actor-deep', runId: 'run-other' });
        substitutedResult.actor = substitutedResult.payload.result.actor;
        const beforeResult = persistenceFingerprint(root);
        assert.throws(
          () => appendV3(root, `${JSON.stringify(substitutedResult)}\n`, { clock }),
          /Result actor.*Attempt owner|attempt owner/i,
        );
        assert.deepEqual(persistenceFingerprint(root), beforeResult);

        appendV3(root, `${JSON.stringify(validResult)}\n`, { clock });
        store = readV3Journal(root);
        appendV3(root, `${JSON.stringify(agentRegistration(AGENTS[1]))}\n`, { clock });
        store = readV3Journal(root);
        const beforeVerification = persistenceFingerprint(root);
        const verifier = actor('subagent', { id: 'actor-deep', runId: 'run-verifier' });
        const validVerification = JSON.parse(recipeVerify(store, {
          actor: verifier, result: store.state.results[0].resultId,
          found: 1, executed: 1, passed: 1, failed: 0, skipped: 0,
        }, { clock }));

        const eventActorMismatch = JSON.parse(JSON.stringify(validVerification));
        eventActorMismatch.actor = actor('subagent', { id: 'actor-other', runId: 'run-other' });
        assert.throws(
          () => appendV3(root, `${JSON.stringify(eventActorMismatch)}\n`, { clock }),
          /event actor.*verifier|verifier.*event actor/i,
        );
        assert.deepEqual(persistenceFingerprint(root), beforeVerification);

        const sameOwner = JSON.parse(JSON.stringify(validVerification));
        sameOwner.subject.id = 'verification-same-owner';
        sameOwner.payload.report.verificationId = 'verification-same-owner';
        sameOwner.actor = actor('subagent', { id: executor.id, runId: 'run-independent' });
        sameOwner.payload.report.verifier = sameOwner.actor;
        assert.throws(
          () => appendV3(root, `${JSON.stringify(sameOwner)}\n`, { clock }),
          /Attempt owner|own work|independently verify/i,
        );
        assert.deepEqual(persistenceFingerprint(root), beforeVerification);

        const sameRun = JSON.parse(JSON.stringify(validVerification));
        sameRun.subject.id = 'verification-same-run';
        sameRun.payload.report.verificationId = 'verification-same-run';
        sameRun.actor = actor('subagent', { id: 'actor-deep', runId: executor.runId });
        sameRun.payload.report.verifier = sameRun.actor;
        assert.throws(
          () => appendV3(root, `${JSON.stringify(sameRun)}\n`, { clock }),
          /executor run|own work|independently verify/i,
        );
        assert.deepEqual(persistenceFingerprint(root), beforeVerification);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-044-build-first-authorized-core-path',
    requirement: 'requirement 6: Build-First requires a succeeded core function path with linked command or test evidence and task classes fail closed',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        const unclassifiedDraft = recipeTask(store, {
          actor: actor(), title: 'Unclassified library task', pathOwnership: ['src/unclassified'],
        }, { clock });
        assert.equal(JSON.parse(unclassifiedDraft).payload.task.class, 'unclassified');
        appendV3(root, unclassifiedDraft, { clock });
        store = readV3Journal(root);
        assert.equal(store.state.tasks.at(-1).class, 'unclassified');
        assert.equal(buildFirstState(store.state).passed, false);

        appendV3(root, recipeTask(store, {
          actor: actor(), title: 'Core function', class: 'function', priority: 'core', pathOwnership: ['src/core'],
        }, { clock }), { clock });
        store = readV3Journal(root);
        const coreTask = store.state.tasks.find((item) => item.title === 'Core function');

        const cliTask = runProjectMemory(root, ['record', 'task', '--title', 'CLI unclassified task']);
        assert.equal(cliTask.status, 0, cliTask.stderr);
        store = readV3Journal(root);
        assert.equal(store.state.tasks.find((item) => item.title === 'CLI unclassified task').class, 'unclassified');

        const unknownClass = recipeTask(store, {
          actor: actor(), title: 'Unknown class', class: 'mystery', pathOwnership: ['src/mystery'],
        }, { clock });
        const beforeInvalidTasks = persistenceFingerprint(root);
        assert.throws(() => appendV3(root, unknownClass, { clock }), /task\.class|unknown task class|allowed enum/i);
        assert.deepEqual(persistenceFingerprint(root), beforeInvalidTasks);

        for (const forbiddenClass of ['documentation', 'tests', 'plugin', 'cosmetic']) {
          const forbiddenEnable = recipeTask(store, {
            actor: actor(), title: `${forbiddenClass} cannot enable core`, class: forbiddenClass,
            enablesTaskIds: [coreTask.taskId], pathOwnership: [`scope/${forbiddenClass}`],
          }, { clock });
          assert.throws(
            () => appendV3(root, forbiddenEnable, { clock }),
            /enablesTaskIds.*wrapper|enablesTaskIds.*infrastructure|only wrapper/i,
          );
          assert.deepEqual(persistenceFingerprint(root), beforeInvalidTasks);
        }

        const executor = actor('subagent', { id: 'actor-cheap', runId: 'run-executor' });
        appendV3(root, recipeStart(store, {
          actor: executor, task: coreTask.taskId, approach: 'build the first core path',
        }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeEvidence(store, {
          actor: executor, task: coreTask.taskId, kind: 'command', source: 'node --test',
          expected: 'core command passes', actual: 'found=1 executed=1 passed=1 failed=0', exitCode: 0,
        }, { clock }), { clock });
        store = readV3Journal(root);
        const coreEvidenceId = store.state.evidence.at(-1).evidenceId;

        appendV3(root, recipeResult(store, {
          actor: executor, execution: 'failed', expected: 'core works', actual: 'failed execution', evidence: coreEvidenceId,
        }, { clock }), { clock });
        store = readV3Journal(root);
        assert.equal(buildFirstState(store.state).passed, false);
        appendV3(root, recipeResult(store, {
          actor: executor, execution: 'partial', expected: 'core works', actual: 'partial execution', evidence: coreEvidenceId,
        }, { clock }), { clock });
        store = readV3Journal(root);
        assert.equal(buildFirstState(store.state).passed, false);

        appendV3(root, recipeTask(store, {
          actor: actor(), title: 'Unrelated evidence task', class: 'function', priority: 'core', pathOwnership: ['src/other'],
        }, { clock }), { clock });
        store = readV3Journal(root);
        const otherTask = store.state.tasks.at(-1);
        appendV3(root, recipeEvidence(store, {
          actor: executor, task: otherTask.taskId, kind: 'test', source: 'node --test other',
          expected: 'other test passes', actual: 'found=1 executed=1 passed=1 failed=0', exitCode: 0,
        }, { clock }), { clock });
        store = readV3Journal(root);
        const unrelatedEvidenceId = store.state.evidence.at(-1).evidenceId;
        const beforeUnrelatedResult = persistenceFingerprint(root);
        assert.throws(
          () => appendV3(root, recipeResult(store, {
            actor: executor, task: coreTask.taskId, execution: 'succeeded',
            expected: 'core works', actual: 'claimed with unrelated evidence', evidence: unrelatedEvidenceId,
          }, { clock }), { clock }),
          /evidence must belong to the Result task/,
        );
        assert.deepEqual(persistenceFingerprint(root), beforeUnrelatedResult);
        assert.equal(buildFirstState(store.state).passed, false);

        appendV3(root, recipeResult(store, {
          actor: executor, task: coreTask.taskId, execution: 'succeeded',
          expected: 'core works', actual: 'linked command proves core', evidence: coreEvidenceId,
        }, { clock }), { clock });
        store = readV3Journal(root);
        assert.equal(buildFirstState(store.state).passed, true);

        for (const classValue of ['handoff', 'blocker']) {
          const task = memTask({ taskId: `task-${classValue}`, class: classValue, priority: 'core' });
          const state = memState([task], {
            attempts: [{ attemptId: 'attempt-one' }],
            evidence: [{
              evidenceId: 'evidence-one', kind: 'command', taskId: task.taskId,
              criterionIds: ['criterion-honest'], outcome: 'passed', authorizing: true,
            }],
            results: [{
              taskId: task.taskId, criterionIds: ['criterion-honest'], execution: 'succeeded',
              evidenceIds: ['evidence-one'],
            }],
          });
          assert.equal(buildFirstState(state).passed, false);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-045-authorizing-evidence-and-truth-axes',
    requirement: 'requirement 7: words never authorize, verification requires its report, and only user acceptance can leave pending',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, {
          actor: actor(), title: 'Truth axes', class: 'function', priority: 'core', pathOwnership: ['src/truth'],
        }, { clock }), { clock });
        store = readV3Journal(root);
        const executor = actor('coordinator', { id: 'actor-coordinator', runId: 'run-executor' });
        appendV3(root, recipeStart(store, { actor: executor, approach: 'record bounded evidence' }, { clock }), { clock });
        store = readV3Journal(root);

        const words = JSON.parse(recipeEvidence(store, {
          actor: executor, expected: 'implementation is complete', actual: 'executor says it is complete',
        }, { clock }));
        assert.equal(words.payload.evidence.authorizing, false);
        assert.notEqual(words.payload.evidence.outcome, 'passed');

        const forgedWords = JSON.parse(recipeEvidence(store, {
          actor: executor, kind: 'agent_report', source: 'executor statement',
          expected: 'implementation is complete', actual: 'executor says it is complete', exitCode: 0,
        }, { clock }));
        forgedWords.payload.evidence.authorizing = true;
        forgedWords.payload.evidence.outcome = 'passed';
        const beforeForgedWords = persistenceFingerprint(root);
        assert.throws(
          () => appendV3(root, `${JSON.stringify(forgedWords)}\n`, { clock }),
          /agent_report|command or test|authorizing evidence kind/i,
        );
        assert.deepEqual(persistenceFingerprint(root), beforeForgedWords);

        appendV3(root, `${JSON.stringify(words)}\n`, { clock });
        store = readV3Journal(root);
        const wordsId = store.state.evidence.at(-1).evidenceId;
        const beforeWordsResult = persistenceFingerprint(root);
        assert.throws(
          () => appendV3(root, recipeResult(store, {
            actor: executor, expected: 'implementation is complete', actual: 'words only', evidence: wordsId,
          }, { clock }), { clock }),
          /non-authorizing evidence|cannot authorize success|authorizing evidence/i,
        );
        assert.deepEqual(persistenceFingerprint(root), beforeWordsResult);

        const verifier = actor('subagent', { id: 'actor-deep', runId: 'run-verifier' });
        appendV3(root, `${JSON.stringify(agentRegistration(AGENTS[1]))}\n`, { clock });
        store = readV3Journal(root);
        appendV3(root, recipeEvidence(store, {
          actor: executor, verifier, kind: 'command', source: 'node --test',
          expected: 'one command passes', actual: 'found=1 executed=1 passed=1 failed=0', exitCode: 0,
        }, { clock }), { clock });
        store = readV3Journal(root);
        const commandEvidenceId = store.state.evidence.at(-1).evidenceId;
        const resultDraft = JSON.parse(recipeResult(store, {
          actor: executor, expected: 'one command passes', actual: 'command-backed result', evidence: commandEvidenceId,
        }, { clock }));
        const prematurePass = JSON.parse(JSON.stringify(resultDraft));
        prematurePass.payload.result.verification = 'passed';
        const beforePrematurePass = persistenceFingerprint(root);
        assert.throws(
          () => appendV3(root, `${JSON.stringify(prematurePass)}\n`, { clock }),
          /verification\.recorded|VerificationReport|counts/i,
        );
        assert.deepEqual(persistenceFingerprint(root), beforePrematurePass);

        appendV3(root, `${JSON.stringify(resultDraft)}\n`, { clock });
        store = readV3Journal(root);
        const resultId = store.state.results[0].resultId;
        const coordinatorAccept = {
          eventType: 'feedback.recorded',
          occurredAt: clock().toISOString(),
          actor: executor,
          subject: { type: 'result', id: resultId },
          supersedes: [],
          contradicts: [],
          evidenceRefs: [commandEvidenceId],
          sensitivity: 'internal',
          payload: {
            feedback: {
              feedbackId: 'feedback-coordinator-accept', subjectId: resultId,
              disposition: 'satisfied', acceptance: 'accepted', statement: 'Coordinator cannot accept',
              evidenceId: commandEvidenceId,
            },
          },
        };
        const beforeAcceptance = persistenceFingerprint(root);
        assert.throws(
          () => appendV3(root, `${JSON.stringify(coordinatorAccept)}\n`, { clock }),
          /only the user may set acceptance/,
        );
        assert.deepEqual(persistenceFingerprint(root), beforeAcceptance);

        appendV3(root, recipeVerify(store, {
          actor: verifier, result: resultId,
          found: 1, executed: 1, passed: 1, failed: 0, skipped: 0,
        }, { clock }), { clock });
        store = readV3Journal(root);
        assert.equal(store.state.results[0].verification, 'passed');
        assert.equal(store.state.results[0].acceptance, 'pending');
        const view = buildCoordinatorView(store, {}, { view: 'ready' });
        assert.equal(view.userAcceptance, 'pending');
        assert.notEqual(view.taskAccumulator.tasks[0].freshness, 'fresh');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-046-agent-registry-exact-persist-no-effect',
    requirement: 'requirement 8: in-memory and persisted agent records share exact normalization without secrets or calibration trust promotion',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        const base = {
          actorId: 'actor-candidate',
          providerFamily: 'local',
          modelFamily: 'candidate',
          capabilityProfiles: ['implementation'],
          calibrationStatus: 'limited',
          trustTier: 'standard',
        };
        const rejected = [
          { ...base, apiKey: 'synthetic-key' },
          { ...base, platformLimitations: [{ token: 'synthetic-token' }] },
          { ...base, metadata: { billing: { secret: 'synthetic-secret' } } },
          { ...base, calibrationStatus: 'limited', trustTier: 'high' },
          { ...base, calibrationStatus: 'untested', trustTier: 'high' },
          { ...base, notes: 'unknown fields are not registry data' },
        ];
        const before = persistenceFingerprint(root);
        for (const record of rejected) {
          assert.throws(
            () => loadAgentRegistry([record]),
            /must not store|unknown field|platformLimitations|high trust|calibration/i,
          );
          assert.throws(
            () => appendV3(root, `${JSON.stringify(agentRegistration(record))}\n`, { clock }),
            /must not store|unknown field|platformLimitations|high trust|calibration|secret/i,
          );
          assert.deepEqual(persistenceFingerprint(root), before);
        }

        const calibratedWithoutTrust = { ...base, calibrationStatus: 'calibrated' };
        delete calibratedWithoutTrust.trustTier;
        const normalized = loadAgentRegistry([calibratedWithoutTrust]).agents[0];
        assert.equal(normalized.trustTier, 'unknown');
        appendV3(root, `${JSON.stringify(agentRegistration(calibratedWithoutTrust))}\n`, { clock });
        const store = readV3Journal(root);
        assert.deepEqual(store.state.agents[0], normalized);
        assert.equal(store.state.agents[0].calibrationStatus, 'calibrated');
        assert.equal(store.state.agents[0].trustTier, 'unknown');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-047-verifier-registry-policy-public-no-effect',
    requirement: 'blocking review 1: persisted verification requires a registered verifier with sufficient task capability and risk policy',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        let store = readV3Journal(root);
        appendV3(root, recipeTask(store, {
          actor: actor(), title: 'Registry-bound verification', class: 'function',
          capabilities: ['implementation'], risk: 'routine',
        }, { clock }), { clock });
        store = readV3Journal(root);
        const executor = actor('subagent', { id: 'actor-cheap', runId: 'run-executor' });
        appendV3(root, recipeStart(store, { actor: executor, approach: 'implement' }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeEvidence(store, {
          actor: executor, kind: 'command', source: 'node --test', exitCode: 0,
          expected: 'pass', actual: 'pass',
        }, { clock }), { clock });
        store = readV3Journal(root);
        appendV3(root, recipeResult(store, {
          actor: executor, execution: 'succeeded', expected: 'pass', actual: 'pass',
        }, { clock }), { clock });
        store = readV3Journal(root);
        const resultId = store.state.results.at(-1).resultId;
        const unregisteredBefore = persistenceFingerprint(root);
        assert.throws(() => appendV3(root, recipeVerify(store, {
          actor: actor('subagent', { id: 'actor-deep', runId: 'run-verifier' }), result: resultId,
          found: 1, executed: 1, passed: 1, failed: 0,
        }, { clock }), { clock }), /registered verifier/i);
        assert.deepEqual(persistenceFingerprint(root), unregisteredBefore);

        appendV3(root, `${JSON.stringify(agentRegistration(AGENTS[2]))}\n`, { clock });
        store = readV3Journal(root);
        const insufficientBefore = persistenceFingerprint(root);
        assert.throws(() => appendV3(root, recipeVerify(store, {
          actor: actor('subagent', { id: 'actor-unknown', runId: 'run-verifier-unknown' }), result: resultId,
          found: 1, executed: 1, passed: 1, failed: 0,
        }, { clock }), { clock }), /verifier.*capability|capability.*verifier/i);
        assert.deepEqual(persistenceFingerprint(root), insufficientBefore);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-048-public-record-task-class',
    requirement: 'public record task --class function is inspect-ready and assignable before Build-First; omission stays unclassified; unknown class is no-effect',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        const created = runProjectMemory(root, [
          'record', 'task',
          '--title', 'Public core function',
          '--priority', 'core',
          '--size', 'S',
          '--class', 'function',
        ]);
        assert.equal(created.status, 0, created.stderr);
        assert.match(created.stdout, /event recorded: sequence=/);

        const inspectView = JSON.parse(runProjectMemory(root, ['inspect', '--json']).stdout);
        const taskId = inspectView.activeTasks.find((item) => item.title === 'Public core function')?.taskId;
        assert.equal(typeof taskId, 'string');

        const ready = runProjectMemory(root, ['inspect', 'ready', '--json']);
        assert.equal(ready.status, 0, ready.stderr);
        const readyView = JSON.parse(ready.stdout);
        assert.equal(readyView.buildFirst.passed, false);
        assert.equal(readyView.availableTasks.find((item) => item.id === taskId)?.class, 'function');
        assert.equal(readyView.excludedTasks.some((item) => item.taskId === taskId), false);

        const omitted = runProjectMemory(root, ['record', 'task', '--title', 'Omitted class task']);
        assert.equal(omitted.status, 0, omitted.stderr);
        const omittedId = JSON.parse(runProjectMemory(root, ['inspect', '--json']).stdout)
          .activeTasks.find((item) => item.title === 'Omitted class task')?.taskId;
        const omittedReady = JSON.parse(runProjectMemory(root, ['inspect', 'ready', '--json']).stdout);
        assert.equal(omittedReady.availableTasks.some((item) => item.id === omittedId), false);
        assert.equal(
          omittedReady.excludedTasks.some((item) => item.taskId === omittedId && item.reason === 'unclassified-task-class'),
          true,
        );
        assert.equal(readV3Journal(root).state.tasks.find((item) => item.taskId === omittedId).class, 'unclassified');

        const docs = runProjectMemory(root, [
          'record', 'task', '--title', 'Docs only', '--priority', 'core', '--class', 'documentation',
        ]);
        assert.equal(docs.status, 0, docs.stderr);
        const docsId = JSON.parse(runProjectMemory(root, ['inspect', '--json']).stdout)
          .activeTasks.find((item) => item.title === 'Docs only')?.taskId;
        const docsReady = JSON.parse(runProjectMemory(root, ['inspect', 'ready', '--json']).stdout);
        assert.equal(docsReady.buildFirst.passed, false);
        assert.equal(docsReady.availableTasks.some((item) => item.id === docsId), false);

        const beforeUnknown = persistenceFingerprint(root);
        const unknown = runProjectMemory(root, ['record', 'task', '--title', 'Mystery', '--class', 'mystery']);
        assert.notEqual(unknown.status, 0, unknown.stdout);
        assert.equal(unknown.stdout, '');
        assert.match(unknown.stderr, /task\.class is not an allowed enum/i);
        assert.deepEqual(persistenceFingerprint(root), beforeUnknown);

        const coordinatorAgent = loadAgentRegistry([{
          actorId: 'actor-coordinator',
          capabilityProfiles: ['implementation'],
          trustTier: 'standard',
          calibrationStatus: 'calibrated',
          kind: 'coordinator',
        }]).agents[0];
        appendV3(root, `${JSON.stringify(agentRegistration(coordinatorAgent))}\n`, { clock });
        const packet = runProjectMemory(root, ['record', 'packet', '--task', taskId]);
        assert.equal(packet.status, 0, packet.stderr);
        const assign = runProjectMemory(root, [
          'record', 'assign', '--task', taskId, '--assignee', 'actor-coordinator',
        ]);
        assert.equal(assign.status, 0, assign.stderr);
        const assignedReady = JSON.parse(runProjectMemory(root, ['inspect', 'ready', '--json']).stdout);
        assert.equal(assignedReady.availableTasks.some((item) => item.id === taskId), false);
        assert.equal(
          assignedReady.excludedTasks.some((item) => item.taskId === taskId && item.reason === 'already-assigned'),
          true,
        );
        assert.equal(assignedReady.buildFirst.passed, false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'COORD-049-misplaced-class-flag-no-effect',
    requirement: 'misplaced --class on record start, record assign, and inspect ready is rejected with empty stdout and unchanged journal/projection',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      try {
        initializeV3(root, JSON.stringify(INIT), { clock });
        const created = runProjectMemory(root, [
          'record', 'task',
          '--title', 'Public core function',
          '--priority', 'core',
          '--class', 'function',
        ]);
        assert.equal(created.status, 0, created.stderr);
        const taskId = JSON.parse(runProjectMemory(root, ['inspect', '--json']).stdout)
          .activeTasks.find((item) => item.title === 'Public core function')?.taskId;
        const before = persistenceFingerprint(root);
        const misplaced = [
          ['inspect', 'ready', '--class', 'function'],
          ['record', 'start', '--task', taskId, '--approach', 'One sentence', '--class', 'function'],
          ['record', 'assign', '--task', taskId, '--assignee', 'actor-coordinator', '--class', 'function'],
        ];
        for (const args of misplaced) {
          const result = runProjectMemory(root, args);
          assert.notEqual(result.status, 0, `${args.join(' ')} must be rejected: ${result.stdout}`);
          assert.equal(result.stdout, '', `${args.join(' ')} must not write stdout`);
          assert.match(result.stderr, /--class is only valid for record task/i);
          assert.deepEqual(persistenceFingerprint(root), before, `${args.join(' ')} must be no-effect`);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
]);

function PRIORITY_RANK_GUARD(record) {
  return ({ blocker: 0, core: 1, verification: 2, backlog: 3 }[record.priority]);
}

export async function runCases(selected = CASES) {
  const totals = { found: selected.length, executed: 0, passed: 0, failed: 0, skipped: 0 };
  const reasons = [];
  for (const testCase of selected) {
    try {
      await testCase.run();
      totals.executed += 1;
      totals.passed += 1;
      console.log(`PASS ${testCase.id} ${testCase.requirement}`);
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
  console.log(`coordination cases: found=${totals.found} executed=${totals.executed} passed=${totals.passed} failed=${totals.failed} skipped=${totals.skipped}`);
  return { ...totals, reasons, ok: totals.found > 0 && totals.failed === 0 && totals.executed > 0 };
}

export async function run() {
  const report = await runCases();
  if (!report.ok) throw new Error(`coordination cases failed found=${report.found} passed=${report.passed} failed=${report.failed} skipped=${report.skipped}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runCases();
  if (!report.ok) process.exitCode = 1;
}
