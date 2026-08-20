import assert from 'node:assert/strict';

import { MemoryError, ZERO_HASH, buildEnvelope, foldV2, validateDraft } from '../../continuity/scripts/lib/core/domain-v2.mjs';

const occurredAt = '2026-08-15T02:00:00.000Z';
const actor = { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' };
const workspaceAtRecord = { head: 'e'.repeat(40), branch: 'main', dirty: false, statusFingerprint: 'f'.repeat(64), fingerprintPartial: false, capturedAt: occurredAt };
const draft = (eventType, subject, payload, extras = {}) => ({ eventType, occurredAt, actor, subject, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal', payload, ...extras });

export async function run() {
  const events = [];
  const add = (value) => {
    const event = buildEnvelope(value, { epochId: 'epoch-binding-fixture', sequence: events.length + 1, recordedAt: occurredAt, workspaceAtRecord, previousEventHash: events.at(-1)?.eventHash ?? ZERO_HASH });
    foldV2([...events, event]);
    events.push(event);
    return event;
  };

  const initialized = add(draft('project.initialized', { type: 'project', id: 'project-bindings' }, { project: { projectId: 'project-bindings', name: 'Bindings', identity: 'Binding fixture', implementationBoundaries: ['Synthetic only'], operatingRules: ['Reject mismatches'] }, initialization: 'new' }));
  add(draft('goal.declared', { type: 'goal', id: 'goal-final' }, { goal: { goalId: 'goal-final', title: 'Bind events', outcome: 'Reject mismatched ownership', isFinal: true, authority: 'user', basis: 'user_stated', criterionIds: [] }, evidenceRef: 'evidence-user-goal' }));
  const state = foldV2(events);
  const task = { taskId: 'task-bindings', goalId: 'goal-final', title: 'Binding task', scope: 'binding seam', pathOwnership: ['src/bindings'], owner: 'actor-subagent', dependencyIds: [], criterionIds: [], userFacing: false, requiredForGoal: false };

  assert.throws(() => validateDraft(draft('task.planned', { type: 'task', id: 'task-other' }, { task }), state), MemoryError);
  assert.throws(() => validateDraft(draft('task.planned', { type: 'task', id: task.taskId }, { task }, { goalId: 'goal-other', taskId: task.taskId }), state), MemoryError);
  assert.throws(() => validateDraft(draft('criterion.declared', { type: 'criterion', id: 'criterion-other' }, { criterion: { criterionId: 'criterion-bindings', ownerType: 'goal', ownerId: 'goal-final', condition: 'Bindings pass', scope: 'core', requiredEvidenceKinds: ['test'], freshnessPolicy: { kind: 'max_age', maxAgeSeconds: 60 }, waivableByUser: false } }), state), MemoryError);

  const evidence = { evidenceId: 'evidence-bindings', kind: 'test', subjectId: 'goal-final', scope: 'binding seam', locator: 'checks/bindings', observedAt: occurredAt, verifier: { kind: 'tool', id: 'actor-test-tool' }, method: 'public validator seam', outcome: 'passed', policy: { kind: 'max_age', maxAgeSeconds: 60 }, sourceRefs: [], sensitivity: 'internal' };
  assert.throws(() => validateDraft(draft('evidence.recorded', { type: 'task', id: 'goal-final' }, { evidence }), state), MemoryError);
  assert.throws(() => validateDraft(draft('evidence.recorded', { type: 'goal', id: 'goal-final' }, { evidence }, { evidenceRefs: ['evidence-missing'] }), state), MemoryError);
  assert.throws(() => validateDraft(draft('evidence.recorded', { type: 'goal', id: 'goal-final' }, { evidence }, { supersedes: ['event-does-not-exist'] }), state), MemoryError);
  assert.doesNotThrow(() => validateDraft(draft('evidence.recorded', { type: 'goal', id: 'goal-final' }, { evidence }, { contradicts: [initialized.eventId] }), state));
}
