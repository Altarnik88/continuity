import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { MemoryError, ZERO_HASH, buildEnvelope, foldV2, validateDraft } from '../../continuity/scripts/lib/core/domain-v2.mjs';

const workspaceAtRecord = { head: 'c'.repeat(40), branch: 'main', dirty: false, statusFingerprint: 'd'.repeat(64), fingerprintPartial: false, capturedAt: '2026-08-15T01:00:00.000Z' };
const actor = (kind, id) => ({ kind, id, role: kind });
const makeDraft = (eventType, subject, payload, by = actor('coordinator', 'actor-coordinator')) => ({ eventType, occurredAt: '2026-08-15T01:00:00.000Z', actor: by, subject, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal', payload });

export async function run() {
  const events = [];
  const add = (draft) => {
    const event = buildEnvelope(draft, { epochId: 'epoch-adverse-fixture', sequence: events.length + 1, recordedAt: '2026-08-15T01:00:00.000Z', workspaceAtRecord, previousEventHash: events.at(-1)?.eventHash ?? ZERO_HASH });
    foldV2([...events, event]); events.push(event); return event;
  };
  const evidence = (evidenceId, subjectId, outcome = 'passed', options = {}) => {
    const observedAt = options.observedAt ?? '2026-08-15T01:00:00.000Z';
    const value = makeDraft('evidence.recorded', { type: subjectId.split('-')[0], id: subjectId }, { evidence: { evidenceId, kind: options.kind ?? 'test', subjectId, scope: options.scope ?? 'adverse fixture', locator: `checks/${evidenceId}`, observedAt, verifier: { kind: 'tool', id: 'actor-test-tool' }, method: 'synthetic public seam', outcome, policy: { kind: 'max_age', maxAgeSeconds: 3600 }, sourceRefs: [], ...(options.workspace ? { workspaceAtObservation: { ...workspaceAtRecord, capturedAt: observedAt } } : {}), sensitivity: 'internal' } }, actor('tool', 'actor-test-tool'));
    value.occurredAt = observedAt;
    return value;
  };

  add(makeDraft('project.initialized', { type: 'project', id: 'project-adverse' }, { project: { projectId: 'project-adverse', name: 'Adverse fixture', identity: 'Failure retention fixture', implementationBoundaries: ['Synthetic only'], operatingRules: ['Keep failures'] }, initialization: 'new' }));
  add(makeDraft('goal.declared', { type: 'goal', id: 'goal-final' }, { goal: { goalId: 'goal-final', title: 'Recover truthfully', outcome: 'Retain failure and change retry', isFinal: true, authority: 'user', basis: 'user_stated', criterionIds: [] }, evidenceRef: 'evidence-user-goal' }));
  add(evidence('evidence-goal-failure', 'goal-final', 'failed'));
  add(makeDraft('failure.recorded', { type: 'goal', id: 'goal-final' }, { failure: { failureId: 'failure-goal', subject: { type: 'goal', id: 'goal-final' }, responsibleBoundary: 'upstream dependency', terminal: 'blocked', approachId: 'approach-goal', hypothesisId: 'hypothesis-goal', symptomClass: 'dependency', observedSymptom: 'The goal was blocked', impact: 'Descendant work needs a changed response', unchanged: ['Recorded scope remains bounded'], rootCause: { state: 'unknown', summary: 'The upstream cause is not confirmed' }, evidenceRefs: ['evidence-goal-failure'], retryCount: 0, nextAction: 'Use an auditable descendant response' } }));
  add(makeDraft('goal.blocked', { type: 'goal', id: 'goal-final' }, { failureId: 'failure-goal' }));
  add(makeDraft('goal.reopened', { type: 'goal', id: 'goal-final' }, { priorEventId: events.at(-1).eventId, reason: 'Descendant retry is available', evidenceRef: 'evidence-goal-failure' }));
  add(makeDraft('task.planned', { type: 'task', id: 'task-retry' }, { task: { taskId: 'task-retry', goalId: 'goal-final', title: 'Retry safely', scope: 'core retry seam', pathOwnership: ['src/retry'], owner: 'actor-subagent', dependencyIds: [], criterionIds: [], userFacing: false, requiredForGoal: false } }));
  const unlinkedDescendant = makeDraft('attempt.started', { type: 'attempt', id: 'attempt-unlinked' }, { attempt: { attemptId: 'attempt-unlinked', taskId: 'task-retry', ordinal: 1, owner: 'actor-subagent', approachId: 'approach-one', hypothesisId: 'hypothesis-one', approachSummary: 'Unlinked descendant attempt' } }, actor('subagent', 'actor-subagent'));
  assert.throws(() => validateDraft(unlinkedDescendant, foldV2(events)), MemoryError);
  add(makeDraft('attempt.started', { type: 'attempt', id: 'attempt-one' }, { attempt: { attemptId: 'attempt-one', taskId: 'task-retry', ordinal: 1, owner: 'actor-subagent', approachId: 'approach-one', hypothesisId: 'hypothesis-one', approachSummary: 'First attempt', changeSummary: 'Responds to the goal blocker with a bounded descendant task', respondsToFailureId: 'failure-goal' } }, actor('subagent', 'actor-subagent')));
  add(makeDraft('task.started', { type: 'task', id: 'task-retry' }, { attemptId: 'attempt-one' }, actor('subagent', 'actor-subagent')));
  add(evidence('evidence-failure', 'task-retry', 'failed'));
  add(makeDraft('failure.recorded', { type: 'task', id: 'task-retry' }, { failure: { failureId: 'failure-one', subject: { type: 'task', id: 'task-retry' }, attemptId: 'attempt-one', owner: 'actor-subagent', terminal: 'failed', approachId: 'approach-one', hypothesisId: 'hypothesis-one', symptomClass: 'assertion', observedSymptom: 'The first check failed', impact: 'The task is not complete', unchanged: ['No unrelated files changed'], rootCause: { state: 'hypothesis', summary: 'The first approach was incomplete' }, evidenceRefs: ['evidence-failure'], retryCount: 0, nextAction: 'Use the bounded second approach' } }, actor('subagent', 'actor-subagent')));
  add(makeDraft('attempt.reported', { type: 'attempt', id: 'attempt-one' }, { attemptId: 'attempt-one', outcome: 'failed', endedAt: '2026-08-15T01:00:00.000Z', summary: 'First attempt failed', evidenceRefs: ['evidence-failure'], failureId: 'failure-one' }, actor('subagent', 'actor-subagent')));
  const failed = add(makeDraft('task.failed', { type: 'task', id: 'task-retry' }, { attemptId: 'attempt-one', failureId: 'failure-one' }));
  add(makeDraft('task.reopened', { type: 'task', id: 'task-retry' }, { priorEventId: failed.eventId, reason: 'A different retry is ready', evidenceRefs: ['evidence-failure'] }));

  const stateBeforeRetry = foldV2(events);
  const selfSameRetry = makeDraft('attempt.started', { type: 'attempt', id: 'attempt-two' }, { attempt: { attemptId: 'attempt-two', taskId: 'task-retry', ordinal: 2, owner: 'actor-subagent', approachId: 'approach-one', hypothesisId: 'hypothesis-one', approachSummary: 'Same retry', respondsToFailureId: 'failure-one' } }, actor('subagent', 'actor-subagent'));
  assert.throws(() => validateDraft(selfSameRetry, stateBeforeRetry), MemoryError);
  add(evidence('evidence-environment', 'task-retry'));
  const sameEnvironmentRetry = makeDraft('attempt.started', { type: 'attempt', id: 'attempt-environment' }, { attempt: { attemptId: 'attempt-environment', taskId: 'task-retry', ordinal: 2, owner: 'actor-subagent', approachId: 'approach-one', hypothesisId: 'hypothesis-one', approachSummary: 'Same IDs after environment change', changeSummary: 'Environment evidence changed', retryJustification: 'The bounded environment evidence changed', respondsToFailureId: 'failure-one' } }, actor('subagent', 'actor-subagent'));
  assert.throws(() => validateDraft(sameEnvironmentRetry, foldV2(events)), MemoryError);
  sameEnvironmentRetry.evidenceRefs = ['evidence-environment'];
  assert.throws(() => validateDraft(sameEnvironmentRetry, foldV2(events)), MemoryError);
  add(evidence('evidence-retry-qualified', 'task-retry', 'passed', { scope: 'failure-one', workspace: true, observedAt: '2026-08-15T01:00:01.000Z' }));
  sameEnvironmentRetry.evidenceRefs = ['evidence-retry-qualified'];
  assert.doesNotThrow(() => validateDraft(sameEnvironmentRetry, foldV2(events)));
  add(makeDraft('attempt.started', { type: 'attempt', id: 'attempt-two' }, { attempt: { attemptId: 'attempt-two', taskId: 'task-retry', ordinal: 2, owner: 'actor-subagent', approachId: 'approach-two', hypothesisId: 'hypothesis-one', approachSummary: 'Different bounded attempt', changeSummary: 'Changed the approach ID and bounded implementation', respondsToFailureId: 'failure-one' } }, actor('subagent', 'actor-subagent')));
  const resolution = add(makeDraft('attempt.reported', { type: 'attempt', id: 'attempt-two' }, { attemptId: 'attempt-two', outcome: 'succeeded', endedAt: '2026-08-15T01:00:01.000Z', summary: 'Changed retry succeeded', evidenceRefs: ['evidence-retry-qualified'] }, actor('subagent', 'actor-subagent')));
  let resolvedState = foldV2(events);
  assert.equal(resolvedState.failures.find((failure) => failure.failureId === 'failure-one').resolvedByAttemptId, 'attempt-two');
  assert.equal(resolvedState.failures.find((failure) => failure.failureId === 'failure-one').resolvedByEventId, resolution.eventId);

  add(evidence('evidence-claim', 'project-adverse'));
  add(makeDraft('claim.asserted', { type: 'project', id: 'project-adverse' }, { claim: { claimId: 'claim-one', subject: { type: 'project', id: 'project-adverse' }, predicate: 'project.release_state', scopeKey: 'main', cardinality: 'one', value: 'ready', basis: 'tool_observed', authority: 'tool' }, evidenceRefs: ['evidence-claim'] }));
  add(makeDraft('claim.asserted', { type: 'project', id: 'project-adverse' }, { claim: { claimId: 'claim-two', subject: { type: 'project', id: 'project-adverse' }, predicate: 'project.release_state', scopeKey: 'main', cardinality: 'one', value: 'blocked', basis: 'tool_observed', authority: 'tool' }, evidenceRefs: ['evidence-claim'] }));
  let state = foldV2(events);
  assert.deepEqual(state.claims.map((claim) => claim.lifecycle), ['contested', 'contested']);
  assert.equal(state.contradictions[0].state, 'contested');
  add(makeDraft('claim.superseded', { type: 'project', id: 'project-adverse' }, { claimId: 'claim-one', replacementClaimId: 'claim-two', evidenceRefs: ['evidence-claim'] }));
  state = foldV2(events);
  assert.equal(state.failures.length, 2);
  assert.deepEqual(state.failures.map((failure) => failure.failureId), ['failure-goal', 'failure-one']);
  assert.equal(state.contradictions[0].state, 'resolved');
  assert.equal(state.claims.find((claim) => claim.claimId === 'claim-two').lifecycle, 'active');
  const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../continuity');
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(JSON.parse(readFileSync(path.join(skillRoot, 'references', 'v2-contract.schema.json'), 'utf8')));
  const validateProjection = ajv.compile(JSON.parse(readFileSync(path.join(skillRoot, 'references', 'projection-v2.schema.json'), 'utf8')));
  assert.equal(validateProjection(state), true, JSON.stringify(validateProjection.errors));
}
