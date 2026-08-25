import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_PROJECTION_BYTES,
  MemoryError,
  encodeProjection,
  emptyProjectStateV3,
} from '../../continuity/scripts/lib/core/domain-v3.mjs';
import { readV3Journal, rebuildV3 } from '../../continuity/scripts/lib/core/journal-v3.mjs';
import { parseRecordedEvent } from '../../continuity/scripts/lib/protocol/index.mjs';
import { makeRepository, runCli } from '../helpers/repository.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const continuityCli = path.join(repoRoot, 'continuity', 'scripts', 'continuity.mjs');
const initTemplate = path.join(repoRoot, 'continuity', 'assets', 'init-v3.template.json');

export async function run() {
  assert.ok(MAX_PROJECTION_BYTES > 64 * 1024, 'CURRENT bound must exceed the previous 64 KiB cap');
  assert.ok(MAX_PROJECTION_BYTES <= 512 * 1024, 'CURRENT bound must stay fail-closed at or below 512 KiB');

  const authorizingRoot = makeRepository('projection-bound-authorizing');
  const oversizeRoot = makeRepository('projection-bound-oversize');
  try {
    seedMultiTaskAuthorizingJournal(authorizingRoot);
    const historyBeforeRebuild = readFileSync(path.join(authorizingRoot, '.continuity', 'HISTORY.ndjson'));
    const rebuilt = runCli(continuityCli, authorizingRoot, ['rebuild']);
    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    assert.equal(
      readFileSync(path.join(authorizingRoot, '.continuity', 'HISTORY.ndjson')).equals(historyBeforeRebuild),
      true,
      'rebuild must not rewrite HISTORY',
    );
    const store = readV3Journal(authorizingRoot);
    assert.equal(store.projection, 'current');
    assert.ok(store.state.tasks.length >= 3, 'multi-task journal must keep every recorded task');
    assert.equal(store.state.evidence.filter((item) => item.authorizing === true).length, store.state.tasks.length);
    assert.ok(store.state.results.every((item) => item.evidenceIds.length > 0));
    assert.ok(store.state.results.every((item) => item.verification === 'unverified'));
    assert.ok(store.state.results.every((item) => item.acceptance === 'pending'));
    assert.ok(store.state.tasks.every((item) => (
      item.focusedVerification === undefined || Array.isArray(item.focusedVerification)
    )));
    const ready = JSON.parse(runCli(continuityCli, authorizingRoot, ['inspect', 'ready', '--json']).stdout);
    assert.equal(ready.plan?.missing?.length ?? 0, 0, 'inspect ready must stay schedulable');
    assert.equal(ready.userAcceptance, 'pending');
    const hoursLong = hoursLongProjection();
    const hoursLongBytes = encodeProjection(hoursLong);
    assert.ok(hoursLongBytes.length > 64 * 1024, 'hours-long fixture must exceed the previous 64 KiB CURRENT cap');
    assert.ok(hoursLongBytes.length <= MAX_PROJECTION_BYTES);
    console.log('projection-bound authorizing-journal-rebuilds-current: PASS');

    seedSmallJournal(oversizeRoot);
    const historyBeforeOversize = readFileSync(path.join(oversizeRoot, '.continuity', 'HISTORY.ndjson'));
    const beforeRebuild = rebuildV3(oversizeRoot, { dryRun: true });
    assert.equal(beforeRebuild.dryRun, true);
    const fat = fatProjectionOverBound();
    assert.throws(
      () => encodeProjection(fat),
      (error) => error instanceof MemoryError && /CURRENT projection exceeds the size limit/.test(error.message),
    );
    assert.throws(() => {
      const state = readV3Journal(oversizeRoot).state;
      state.tasks.push(...fat.tasks);
      encodeProjection(state);
    }, /CURRENT projection exceeds the size limit/);
    assert.equal(rebuildV3(oversizeRoot, { dryRun: true }).sequence, beforeRebuild.sequence);
    assert.equal(
      readFileSync(path.join(oversizeRoot, '.continuity', 'HISTORY.ndjson')).equals(historyBeforeOversize),
      true,
      'oversize projection must leave HISTORY unchanged',
    );
    console.log('projection-bound oversize-projection-fail-closes: PASS');
  } finally {
    rmSync(authorizingRoot, { recursive: true, force: true });
    rmSync(oversizeRoot, { recursive: true, force: true });
  }
}

function seedSmallJournal(repo) {
  const init = runCli(continuityCli, repo, ['init', '--schema', '3', '--file', initTemplate]);
  assert.equal(init.status, 0, init.stderr);
}

function seedMultiTaskAuthorizingJournal(repo) {
  seedSmallJournal(repo);
  for (let index = 0; index < 5; index += 1) {
    const task = runCli(continuityCli, repo, [
      'record', 'task',
      '--title', `Authorizing projection task ${index + 1}`,
      '--priority', 'core', '--size', 'S', '--class', 'function',
      '--as', 'coordinator', '--actor-id', 'actor-coord', '--run-id', 'run-coord-01',
    ]);
    assert.equal(task.status, 0, task.stderr);
    const taskId = parseRecordedEvent(task.stdout)?.subjectId;
    assert.ok(taskId, task.stdout);
    assert.equal(runCli(continuityCli, repo, [
      'record', 'start', '--task', taskId, '--approach', 'Record authorizing evidence',
      '--as', 'subagent', '--actor-id', `actor-exec-0${index + 1}`, '--run-id', `run-exec-0${index + 1}`,
    ]).status, 0);
    const evidence = runCli(continuityCli, repo, [
      'record', 'evidence', '--task', taskId, '--run', '-e process.exit(0)',
      '--expected', 'check passes', '--kind', 'command',
      '--as', 'subagent', '--actor-id', `actor-exec-0${index + 1}`, '--run-id', `run-exec-0${index + 1}`,
    ]);
    assert.equal(evidence.status, 0, evidence.stderr);
    const recorded = runCli(continuityCli, repo, [
      'record', 'result', '--expected', 'check passes', '--actual', 'exit 0',
      '--execution', 'succeeded',
      '--as', 'subagent', '--actor-id', `actor-exec-0${index + 1}`, '--run-id', `run-exec-0${index + 1}`,
    ]);
    assert.equal(recorded.status, 0, recorded.stderr);
  }
}

function hoursLongProjection() {
  const state = emptyProjectStateV3();
  const paths = [
    'continuity/scripts/lib/core/journal-v3.mjs',
    'continuity/scripts/lib/core/domain-v3.mjs',
    'continuity/scripts/lib/core/recipes-v3.mjs',
    'continuity/scripts/lib/core/inspect-v3.mjs',
    'continuity/scripts/lib/core/cli-v3.mjs',
    'continuity/scripts/lib/core/coordination/schedule.mjs',
    'continuity/scripts/lib/core/coordination/persist-policy.mjs',
    'ARCHITECTURE.md',
    'tests/core/long-life.test.mjs',
    'tests/core/projection-bound.test.mjs',
  ];
  state.project = {
    projectId: 'project-continuity',
    name: 'Continuity',
    identity: 'Hours-long journal projection',
    implementationBoundaries: ['Do not invent user acceptance'],
    operatingRules: ['Success requires evidence'],
  };
  state.tasks = Array.from({ length: 20 }, (_, index) => ({
    taskId: `task-hours-${index}`,
    goalId: 'goal-final',
    title: `Make CURRENT rebuildable for hours-long journals without compacting HISTORY ${index + 1}`,
    scope: 'Slim folded projection duplicate ownership released-assignment bloat and repeated actor blobs',
    owner: 'actor-coord',
    criterionIds: ['criterion-honest'],
    userFacing: true,
    pathOwnership: paths,
    ownershipScope: paths,
    requiredCapabilities: ['implementation'],
    capabilities: ['implementation'],
    focusedVerification: ['node scripts/test-continuity.mjs --suite core'],
    acceptanceCriteria: ['A 122-event journal rebuilds CURRENT', 'Oversize CURRENT still fail-closes'],
    sourceContext: 'Hours-long Continuity recording keeps authorizing evidence, verification, and acceptance in the folded projection.'.repeat(8),
    recommendedNextAction: 'Rebuild CURRENT from HISTORY without compacting the journal and keep inspect ready schedulable.'.repeat(8),
    evidenceIds: [`evidence-hours-${index}`],
    resultIds: [`result-hours-${index}`],
    execution: 'succeeded',
    verification: 'unverified',
    acceptance: 'pending',
  }));
  state.evidence = Array.from({ length: 20 }, (_, index) => ({
    evidenceId: `evidence-hours-${index}`,
    kind: 'command',
    authorizing: true,
    outcome: 'passed',
    taskId: `task-hours-${index}`,
    evidenceIds: [`evidence-hours-${index}`],
    actor: { kind: 'subagent', id: 'actor-exec-01', role: 'subagent', runId: `run-exec-${index}` },
    verifier: { kind: 'subagent', id: 'actor-exec-01', role: 'subagent', runId: `run-exec-${index}` },
    expected: 'core suite passes including long-life freshness and V3-008',
    actual: 'exit 0',
  }));
  state.results = Array.from({ length: 20 }, (_, index) => ({
    resultId: `result-hours-${index}`,
    taskId: `task-hours-${index}`,
    evidenceIds: [`evidence-hours-${index}`],
    execution: 'succeeded',
    verification: 'unverified',
    acceptance: 'pending',
    actor: { kind: 'subagent', id: 'actor-exec-01', role: 'subagent', runId: `run-exec-${index}` },
    expected: 'core suite passes including long-life freshness and V3-008',
    actual: 'exit 0',
  }));
  state.assignments = Array.from({ length: 20 }, (_, index) => ({
    assignmentId: `assignment-hours-${index}`,
    packetId: `packet-hours-${index}`,
    taskIds: [`task-hours-${index}`],
    actorId: 'actor-cheap',
    state: 'released',
    generation: index + 1,
    pathOwnership: paths,
    derivedFromEventIds: [`event-assign-${index}`, `event-release-${index}`],
  }));
  state.agents = [
    {
      actorId: 'actor-cheap',
      providerFamily: 'local',
      modelFamily: 'small',
      capabilityProfiles: ['mechanical', 'implementation'],
      costTier: 'lowest',
      trustTier: 'standard',
      calibrationStatus: 'calibrated',
    },
  ];
  return state;
}

function fatProjectionOverBound() {
  const state = emptyProjectStateV3();
  const path = `src/${'n'.repeat(180)}`;
  state.tasks = Array.from({ length: 80 }, (_, index) => ({
    taskId: `task-oversize-${index}`,
    title: 'Oversize projection task',
    scope: 'synthetic oversize',
    pathOwnership: Array.from({ length: 50 }, (unused, pathIndex) => `${path}/${index}/${pathIndex}`),
    ownershipScope: Array.from({ length: 50 }, (unused, pathIndex) => `${path}/${index}/${pathIndex}`),
    requiredCapabilities: ['implementation'],
    capabilities: ['implementation'],
    focusedVerification: ['node scripts/test-continuity.mjs --suite core'],
    criterionIds: ['criterion-honest'],
    evidenceIds: [`evidence-oversize-${index}`],
  }));
  return state;
}
