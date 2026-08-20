import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { MemoryError, ZERO_HASH, buildEnvelope, foldV2, validateDraft } from '../../continuity/scripts/lib/core/domain-v2.mjs';

const actor = (kind, id) => ({ kind, id, role: kind });
const workspaceAtRecord = { head: 'a'.repeat(40), branch: 'main', dirty: false, statusFingerprint: 'b'.repeat(64), fingerprintPartial: false, capturedAt: '2026-08-15T00:00:00.000Z' };
const draft = (eventType, subject, payload, by = actor('coordinator', 'actor-coordinator')) => ({ eventType, occurredAt: '2026-08-15T00:00:00.000Z', actor: by, subject, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal', payload });

export async function run() {
  const epochId = 'epoch-transition-fixture';
  const events = [];
  const add = (value) => {
    const previous = events.at(-1)?.eventHash ?? ZERO_HASH;
    const event = buildEnvelope(value, { epochId, sequence: events.length + 1, recordedAt: '2026-08-15T00:00:00.000Z', workspaceAtRecord, previousEventHash: previous });
    foldV2([...events, event]);
    events.push(event);
    return event;
  };
  const evidence = (evidenceId, subjectId, kind = 'test', outcome = 'passed', verifierActor = actor('tool', 'actor-test-tool')) => draft('evidence.recorded', { type: subjectId.split('-')[0], id: subjectId }, { evidence: { evidenceId, kind, subjectId, scope: 'synthetic transition fixture', locator: `checks/${evidenceId}`, observedAt: '2026-08-15T00:00:00.000Z', verifier: { kind: verifierActor.kind, id: verifierActor.id }, method: 'public reducer seam', outcome, policy: kind === 'user_message' ? { kind: 'immutable_until_superseded' } : { kind: 'max_age', maxAgeSeconds: 3600 }, sourceRefs: [], sensitivity: 'internal' } }, verifierActor);

  add(draft('project.initialized', { type: 'project', id: 'project-fixture' }, { project: { projectId: 'project-fixture', name: 'Fixture', identity: 'Transition fixture', implementationBoundaries: ['Synthetic only'], operatingRules: ['No network'] }, initialization: 'new' }));
  const goalDeclared = add(draft('goal.declared', { type: 'goal', id: 'goal-final' }, { goal: { goalId: 'goal-final', title: 'Finish', outcome: 'Pass all criteria', isFinal: true, authority: 'user', basis: 'user_stated', criterionIds: ['criterion-core'] }, evidenceRef: 'evidence-user-goal' }));
  const criterionDeclared = add(draft('criterion.declared', { type: 'criterion', id: 'criterion-core' }, { criterion: { criterionId: 'criterion-core', ownerType: 'goal', ownerId: 'goal-final', condition: 'Core check passes', scope: 'core', requiredEvidenceKinds: ['test'], freshnessPolicy: { kind: 'max_age', maxAgeSeconds: 3600 }, waivableByUser: false } }));
  add(draft('task.planned', { type: 'task', id: 'task-core' }, { task: { taskId: 'task-core', goalId: 'goal-final', title: 'Implement core', scope: 'core', pathOwnership: ['src/core'], owner: 'actor-subagent', dependencyIds: [], criterionIds: ['criterion-core'], userFacing: true, requiredForGoal: true } }));
  add(draft('attempt.started', { type: 'attempt', id: 'attempt-one' }, { attempt: { attemptId: 'attempt-one', taskId: 'task-core', ordinal: 1, owner: 'actor-subagent', approachId: 'approach-one', hypothesisId: 'hypothesis-one', approachSummary: 'First bounded approach' } }, actor('subagent', 'actor-subagent')));
  add(draft('task.started', { type: 'task', id: 'task-core' }, { attemptId: 'attempt-one' }, actor('subagent', 'actor-subagent')));
  add(evidence('evidence-deliverable', 'task-core'));
  add(draft('task.implemented', { type: 'task', id: 'task-core' }, { attemptId: 'attempt-one', deliverableEvidenceRefs: ['evidence-deliverable'] }, actor('subagent', 'actor-subagent')));
  add(evidence('evidence-criterion', 'criterion-core'));
  add(draft('criterion.revised', { type: 'criterion', id: 'criterion-core' }, { criterion: { criterionId: 'criterion-core', ownerType: 'goal', ownerId: 'goal-final', condition: 'Revised core check passes', scope: 'core', requiredEvidenceKinds: ['test'], freshnessPolicy: { kind: 'max_age', maxAgeSeconds: 3600 }, waivableByUser: false }, replacesEventId: criterionDeclared.eventId, reason: 'Clarify the condition without erasing evidence' }));
  let revisedState = foldV2(events);
  assert.equal(revisedState.criteria[0].verification, 'passed');
  assert.deepEqual(revisedState.criteria[0].evidenceRefs, ['evidence-criterion']);
  add(evidence('evidence-wrong-kind', 'criterion-core', 'agent_report'));
  add(draft('attempt.reported', { type: 'attempt', id: 'attempt-one' }, { attemptId: 'attempt-one', outcome: 'succeeded', endedAt: '2026-08-15T00:00:00.000Z', summary: 'Implementation passed', evidenceRefs: ['evidence-criterion'] }, actor('subagent', 'actor-subagent')));
  revisedState = foldV2(events);
  assert.throws(() => validateDraft(draft('task.completed', { type: 'task', id: 'task-core' }, { attemptId: 'attempt-one', criterionEvidenceRefs: ['evidence-wrong-kind'] }), revisedState), MemoryError);
  const staleCompletion = draft('task.completed', { type: 'task', id: 'task-core' }, { attemptId: 'attempt-one', criterionEvidenceRefs: ['evidence-criterion'] });
  staleCompletion.occurredAt = '2026-08-15T02:00:01.000Z';
  assert.doesNotThrow(() => validateDraft(staleCompletion, revisedState));
  add(evidence('evidence-criterion-failed', 'criterion-core', 'test', 'failed'));
  assert.throws(() => validateDraft(draft('task.completed', { type: 'task', id: 'task-core' }, { attemptId: 'attempt-one', criterionEvidenceRefs: ['evidence-criterion'] }), foldV2(events)), MemoryError);
  add(evidence('evidence-criterion-recovered', 'criterion-core'));
  const completion = draft('task.completed', { type: 'task', id: 'task-core' }, { attemptId: 'attempt-one', criterionEvidenceRefs: ['evidence-criterion-recovered'] });
  assert.doesNotThrow(() => validateDraft(completion, foldV2(events)));
  add(completion);
  add(evidence('evidence-user-task', 'task-core', 'user_message', 'observed', actor('user', 'actor-user')));
  add(draft('feedback.satisfied', { type: 'task', id: 'task-core' }, { feedback: { feedbackId: 'feedback-task', subjectId: 'task-core', disposition: 'satisfied', acceptanceEffect: 'accept', statement: 'Task accepted', evidenceRef: 'evidence-user-task' } }, actor('user', 'actor-user')));
  assert.throws(() => validateDraft(draft('goal.achieved', { type: 'goal', id: 'goal-final' }, { criterionEvidenceRefs: ['evidence-criterion'], acceptanceFeedbackId: 'feedback-task' }, actor('user', 'actor-user')), foldV2(events)), MemoryError);
  add(evidence('evidence-user-goal', 'goal-final', 'user_message', 'observed', actor('user', 'actor-user')));
  add(draft('feedback.satisfied', { type: 'goal', id: 'goal-final' }, { feedback: { feedbackId: 'feedback-goal', subjectId: 'goal-final', disposition: 'satisfied', acceptanceEffect: 'accept', statement: 'Goal accepted', evidenceRef: 'evidence-user-goal' } }, actor('user', 'actor-user')));
  add(draft('goal.revised', { type: 'goal', id: 'goal-final' }, { goal: { goalId: 'goal-final', title: 'Finish truthfully', outcome: 'Pass all criteria', isFinal: true, authority: 'user', basis: 'user_stated', criterionIds: ['criterion-core'] }, replacesEventId: goalDeclared.eventId, reason: 'Clarify wording without erasing acceptance', evidenceRef: 'evidence-user-goal' }, actor('user', 'actor-user')));
  const demotion = draft('goal.revised', { type: 'goal', id: 'goal-final' }, { goal: { goalId: 'goal-final', title: 'Finish truthfully', outcome: 'Pass all criteria', isFinal: false, authority: 'user', basis: 'user_stated', criterionIds: ['criterion-core'] }, replacesEventId: goalDeclared.eventId, reason: 'Invalid finality demotion', evidenceRef: 'evidence-user-goal' }, actor('user', 'actor-user'));
  assert.throws(() => validateDraft(demotion, foldV2(events)), MemoryError);
  const supportingGoal = add(draft('goal.declared', { type: 'goal', id: 'goal-supporting' }, { goal: { goalId: 'goal-supporting', title: 'Supporting goal', outcome: 'Remain non-final', isFinal: false, parentGoalId: 'goal-final', authority: 'user', basis: 'user_stated', criterionIds: [] }, evidenceRef: 'evidence-user-goal' }, actor('user', 'actor-user')));
  const promotion = draft('goal.revised', { type: 'goal', id: 'goal-supporting' }, { goal: { goalId: 'goal-supporting', title: 'Supporting goal', outcome: 'Invalid promotion', isFinal: true, parentGoalId: 'goal-final', authority: 'user', basis: 'user_stated', criterionIds: [] }, replacesEventId: supportingGoal.eventId, reason: 'Invalid finality promotion', evidenceRef: 'evidence-user-goal' }, actor('user', 'actor-user'));
  assert.throws(() => validateDraft(promotion, foldV2(events)), MemoryError);
  revisedState = foldV2(events);
  assert.equal(revisedState.goals[0].acceptance, 'accepted');
  assert.deepEqual(revisedState.goals[0].failureIds, []);
  assert.equal(foldV2(events).criteria.find((item) => item.criterionId === 'criterion-core').verification, 'passed');
  const achievement = draft('goal.achieved', { type: 'goal', id: 'goal-final' }, { criterionEvidenceRefs: ['evidence-criterion-recovered'], acceptanceFeedbackId: 'feedback-goal' }, actor('user', 'actor-user'));
  assert.doesNotThrow(() => validateDraft(achievement, foldV2(events)));
  add(achievement);

  const state = foldV2(events);
  assert.equal(state.goals[0].lifecycle, 'achieved');
  assert.equal(state.tasks[0].execution, 'completed');
  assert.equal(state.tasks[0].verification, 'passed');
  assert.equal(state.tasks[0].acceptance, 'accepted');

  const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../continuity');
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(JSON.parse(readFileSync(path.join(skillRoot, 'references', 'v2-contract.schema.json'), 'utf8')));
  const validateProjection = ajv.compile(JSON.parse(readFileSync(path.join(skillRoot, 'references', 'projection-v2.schema.json'), 'utf8')));
  assert.equal(validateProjection(state), true, JSON.stringify(validateProjection.errors));

  const badFeedback = draft('feedback.rejected', { type: 'task', id: 'task-core' }, { feedback: { feedbackId: 'feedback-bad', subjectId: 'task-core', disposition: 'rejected', acceptanceEffect: 'reject', statement: 'Rejected without action', evidenceRef: 'evidence-user-task' } }, actor('user', 'actor-user'));
  assert.throws(() => validateDraft(badFeedback, state), MemoryError);
}
