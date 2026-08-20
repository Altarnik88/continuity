import assert from 'node:assert/strict';

import { MemoryError, ZERO_HASH, buildEnvelope, foldV2 } from '../../continuity/scripts/lib/core/domain-v2.mjs';
import { EXPECTED_EVENT_TYPES } from '../helpers/v2-contract-fixture.mjs';

const at = '2026-08-16T01:00:00.000Z';
const workspaceAtRecord = { head: '5'.repeat(40), branch: 'main', dirty: false, statusFingerprint: '6'.repeat(64), fingerprintPartial: false, capturedAt: at };
const actor = (kind, id = `actor-${kind}`) => ({ kind, id, role: kind });
const draft = (eventType, subject, payload, by = actor('coordinator')) => ({ eventType, occurredAt: at, actor: by, subject, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal', payload });

function scenario(epochId, observedTypes) {
  const events = [];
  const add = (value) => {
    const event = buildEnvelope(value, { epochId, sequence: events.length + 1, recordedAt: at, workspaceAtRecord, previousEventHash: events.at(-1)?.eventHash ?? ZERO_HASH });
    foldV2([...events, event]);
    events.push(event);
    observedTypes.add(event.eventType);
    return event;
  };
  return { events, add };
}

export async function run() {
  const observed = new Set();
  const { events, add } = scenario('epoch-all-events-main', observed);
  const evidence = (evidenceId, subject, kind = 'test', outcome = 'passed', by = actor('tool')) => add(draft('evidence.recorded', subject, { evidence: { evidenceId, kind, subjectId: subject.id, scope: 'all event path fixture', locator: `checks/${evidenceId}`, observedAt: at, verifier: { kind: by.kind, id: by.id }, method: 'synthetic fold seam', outcome, policy: kind === 'user_message' ? { kind: 'immutable_until_superseded' } : { kind: 'max_age', maxAgeSeconds: 3600 }, sourceRefs: [], sensitivity: 'internal' } }, by));
  const goal = (goalId, isFinal = false) => ({ goalId, title: goalId, outcome: 'Exercise a real event path', isFinal, ...(isFinal ? {} : { parentGoalId: 'goal-final' }), authority: 'user', basis: 'user_stated', criterionIds: [] });
  const task = (taskId) => ({ taskId, goalId: 'goal-final', title: taskId, scope: 'all event paths', pathOwnership: [`src/${taskId}`], owner: 'actor-subagent', dependencyIds: [], criterionIds: [], userFacing: false, requiredForGoal: false });
  const attempt = (attemptId, taskId) => ({ attemptId, taskId, ordinal: 1, owner: 'actor-subagent', approachId: `approach-${attemptId.slice(8)}`, hypothesisId: `hypothesis-${attemptId.slice(8)}`, approachSummary: 'Synthetic bounded approach' });
  const failure = (failureId, subject, terminal, attemptId) => ({ failureId, subject, ...(attemptId ? { attemptId, owner: 'actor-subagent' } : { responsibleBoundary: 'synthetic boundary' }), terminal, approachId: `approach-${(attemptId ?? failureId).slice(8)}`, hypothesisId: `hypothesis-${(attemptId ?? failureId).slice(8)}`, symptomClass: 'synthetic', observedSymptom: 'Synthetic adverse outcome', impact: 'Exercises retained adversity', unchanged: ['No external effects'], rootCause: { state: 'unknown', summary: 'Synthetic fixture cause' }, evidenceRefs: [`evidence-${failureId}`], retryCount: 0, nextAction: 'Continue through the explicit transition' });

  add(draft('project.initialized', { type: 'project', id: 'project-all-events' }, { project: { projectId: 'project-all-events', name: 'All events', identity: 'Every event path fixture', implementationBoundaries: ['Synthetic only'], operatingRules: ['No external effects'] }, initialization: 'new' }));
  const finalDeclared = add(draft('goal.declared', { type: 'goal', id: 'goal-final' }, { goal: goal('goal-final', true), evidenceRef: 'evidence-user-final' }));
  evidence('evidence-user-final', { type: 'goal', id: 'goal-final' }, 'user_message', 'observed', actor('user'));
  add(draft('goal.revised', { type: 'goal', id: 'goal-final' }, { goal: { ...goal('goal-final', true), title: 'Revised final goal' }, replacesEventId: finalDeclared.eventId, reason: 'Exercise final goal revision', evidenceRef: 'evidence-user-final' }, actor('user')));

  const blockedGoal = add(draft('goal.declared', { type: 'goal', id: 'goal-blocked' }, { goal: goal('goal-blocked'), evidenceRef: 'evidence-user-final' }));
  evidence('evidence-failure-goal-blocked', { type: 'goal', id: 'goal-blocked' }, 'test', 'failed');
  add(draft('failure.recorded', { type: 'goal', id: 'goal-blocked' }, { failure: failure('failure-goal-blocked', { type: 'goal', id: 'goal-blocked' }, 'blocked') }));
  const goalBlocked = add(draft('goal.blocked', { type: 'goal', id: 'goal-blocked' }, { failureId: 'failure-goal-blocked' }));
  add(draft('goal.reopened', { type: 'goal', id: 'goal-blocked' }, { priorEventId: goalBlocked.eventId, reason: 'Exercise reopen', evidenceRef: 'evidence-failure-goal-blocked' }));

  add(draft('goal.declared', { type: 'goal', id: 'goal-abandoned' }, { goal: goal('goal-abandoned'), evidenceRef: 'evidence-user-final' }));
  evidence('evidence-failure-goal-abandoned', { type: 'goal', id: 'goal-abandoned' }, 'test', 'failed');
  add(draft('failure.recorded', { type: 'goal', id: 'goal-abandoned' }, { failure: failure('failure-goal-abandoned', { type: 'goal', id: 'goal-abandoned' }, 'abandoned') }));
  add(draft('goal.abandoned', { type: 'goal', id: 'goal-abandoned' }, { failureId: 'failure-goal-abandoned', evidenceRef: 'evidence-failure-goal-abandoned' }));
  add(draft('goal.declared', { type: 'goal', id: 'goal-retired' }, { goal: goal('goal-retired'), evidenceRef: 'evidence-user-final' }));
  add(draft('goal.retired', { type: 'goal', id: 'goal-retired' }, { reason: 'Exercise retirement', evidenceRef: 'evidence-user-final' }));

  const criterionDeclared = add(draft('criterion.declared', { type: 'criterion', id: 'criterion-lifecycle' }, { criterion: { criterionId: 'criterion-lifecycle', ownerType: 'goal', ownerId: 'goal-final', condition: 'Exercise criterion events', scope: 'all events', requiredEvidenceKinds: ['test'], freshnessPolicy: { kind: 'max_age', maxAgeSeconds: 3600 }, waivableByUser: true } }));
  add(draft('criterion.revised', { type: 'criterion', id: 'criterion-lifecycle' }, { criterion: { criterionId: 'criterion-lifecycle', ownerType: 'goal', ownerId: 'goal-final', condition: 'Exercise revised criterion', scope: 'all events', requiredEvidenceKinds: ['test'], freshnessPolicy: { kind: 'max_age', maxAgeSeconds: 3600 }, waivableByUser: true }, replacesEventId: criterionDeclared.eventId, reason: 'Exercise criterion revision' }));
  evidence('evidence-user-criterion', { type: 'criterion', id: 'criterion-lifecycle' }, 'user_message', 'observed', actor('user'));
  add(draft('criterion.waived_by_user', { type: 'criterion', id: 'criterion-lifecycle' }, { reason: 'Exercise waiver', evidenceRef: 'evidence-user-criterion' }, actor('user')));
  add(draft('criterion.reactivated', { type: 'criterion', id: 'criterion-lifecycle' }, { reason: 'Exercise reactivation', evidenceRef: 'evidence-user-criterion' }, actor('user')));
  add(draft('criterion.retired', { type: 'criterion', id: 'criterion-lifecycle' }, { reason: 'Exercise retirement' }));

  const plannedTasks = new Map();
  for (const taskId of ['task-complete', 'task-blocked', 'task-failed', 'task-abandoned']) plannedTasks.set(taskId, add(draft('task.planned', { type: 'task', id: taskId }, { task: task(taskId) })));
  add(draft('task.revised', { type: 'task', id: 'task-complete' }, { task: { ...task('task-complete'), title: 'Revised complete task' }, replacesEventId: plannedTasks.get('task-complete').eventId, reason: 'Exercise planned task revision' }));
  for (const [attemptId, taskId] of [['attempt-complete', 'task-complete'], ['attempt-blocked', 'task-blocked'], ['attempt-failed', 'task-failed']]) {
    add(draft('attempt.started', { type: 'attempt', id: attemptId }, { attempt: attempt(attemptId, taskId) }, actor('subagent')));
    add(draft('task.started', { type: 'task', id: taskId }, { attemptId }, actor('subagent')));
  }
  evidence('evidence-deliverable', { type: 'task', id: 'task-complete' });
  add(draft('task.implemented', { type: 'task', id: 'task-complete' }, { attemptId: 'attempt-complete', deliverableEvidenceRefs: ['evidence-deliverable'] }, actor('subagent')));
  add(draft('attempt.reported', { type: 'attempt', id: 'attempt-complete' }, { attemptId: 'attempt-complete', outcome: 'succeeded', endedAt: at, summary: 'Synthetic success', evidenceRefs: ['evidence-deliverable'] }, actor('subagent')));
  add(draft('task.completed', { type: 'task', id: 'task-complete' }, { attemptId: 'attempt-complete', criterionEvidenceRefs: ['evidence-deliverable'] }));

  evidence('evidence-failure-task-blocked', { type: 'task', id: 'task-blocked' }, 'test', 'failed');
  add(draft('failure.recorded', { type: 'task', id: 'task-blocked' }, { failure: failure('failure-task-blocked', { type: 'task', id: 'task-blocked' }, 'blocked', 'attempt-blocked') }, actor('subagent')));
  add(draft('attempt.reported', { type: 'attempt', id: 'attempt-blocked' }, { attemptId: 'attempt-blocked', outcome: 'blocked', endedAt: at, summary: 'Synthetic block', evidenceRefs: ['evidence-failure-task-blocked'], failureId: 'failure-task-blocked' }, actor('subagent')));
  add(draft('task.blocked', { type: 'task', id: 'task-blocked' }, { attemptId: 'attempt-blocked', failureId: 'failure-task-blocked' }));

  evidence('evidence-failure-task-failed', { type: 'task', id: 'task-failed' }, 'test', 'failed');
  const crossAttemptFailure = buildEnvelope(draft('failure.recorded', { type: 'task', id: 'task-failed' }, { failure: failure('failure-task-failed', { type: 'task', id: 'task-failed' }, 'failed', 'attempt-blocked') }, actor('subagent')), { epochId: 'epoch-all-events-main', sequence: events.length + 1, recordedAt: at, workspaceAtRecord, previousEventHash: events.at(-1).eventHash });
  assert.throws(
    () => foldV2([...events, crossAttemptFailure]),
    (error) => error instanceof MemoryError && ['task failure owner/attempt mismatch', 'task failure does not match its attempt lineage'].includes(error.message),
  );
  add(draft('failure.recorded', { type: 'task', id: 'task-failed' }, { failure: { ...failure('failure-task-failed', { type: 'task', id: 'task-failed' }, 'failed', 'attempt-failed'), lessonId: 'lesson-failure' } }, actor('subagent')));
  add(draft('attempt.reported', { type: 'attempt', id: 'attempt-failed' }, { attemptId: 'attempt-failed', outcome: 'failed', endedAt: at, summary: 'Synthetic failure', evidenceRefs: ['evidence-failure-task-failed'], failureId: 'failure-task-failed' }, actor('subagent')));
  const taskFailed = add(draft('task.failed', { type: 'task', id: 'task-failed' }, { attemptId: 'attempt-failed', failureId: 'failure-task-failed' }));
  add(draft('task.reopened', { type: 'task', id: 'task-failed' }, { priorEventId: taskFailed.eventId, reason: 'Exercise task reopen', evidenceRefs: ['evidence-failure-task-failed'] }));
  add(draft('task.abandoned', { type: 'task', id: 'task-abandoned' }, { reason: 'Exercise abandonment', evidenceRefs: ['evidence-user-final'] }));

  evidence('evidence-claim', { type: 'project', id: 'project-all-events' });
  const claim = (claimId, value) => ({ claimId, subject: { type: 'project', id: 'project-all-events' }, predicate: 'project.synthetic_state', scopeKey: 'all-events', cardinality: 'one', value, basis: 'tool_observed', authority: 'tool' });
  add(draft('claim.asserted', { type: 'project', id: 'project-all-events' }, { claim: claim('claim-alpha', 'alpha'), evidenceRefs: ['evidence-claim'] }));
  add(draft('claim.asserted', { type: 'project', id: 'project-all-events' }, { claim: claim('claim-beta', 'alpha'), evidenceRefs: ['evidence-claim'] }));
  add(draft('claim.verified', { type: 'project', id: 'project-all-events' }, { claimId: 'claim-alpha', evidenceRefs: ['evidence-claim'] }));
  add(draft('claim.disputed', { type: 'project', id: 'project-all-events' }, { claimIds: ['claim-alpha', 'claim-beta'], reason: 'Exercise explicit dispute', evidenceRefs: ['evidence-claim'] }));
  add(draft('claim.superseded', { type: 'project', id: 'project-all-events' }, { claimId: 'claim-alpha', replacementClaimId: 'claim-beta', evidenceRefs: ['evidence-claim'] }));
  add(draft('claim.retracted', { type: 'project', id: 'project-all-events' }, { claimId: 'claim-beta', reason: 'Exercise retraction', evidenceRefs: ['evidence-claim'] }));

  const handoff = (handoffId) => ({ handoffId, taskId: 'task-complete', assignmentId: `assignment-${handoffId.slice(8)}`, parentRunId: 'run-parent', owner: 'actor-subagent', scope: 'Synthetic handoff', pathOwnership: ['src/task-complete'], criterionIds: [], deliverables: ['Synthetic report'], prohibitedActions: ['No external effects'] });
  const reportHandoff = (handoffId) => add(draft('handoff.reported', { type: 'handoff', id: handoffId }, { report: { handoffId, attemptId: 'attempt-complete', outcome: 'succeeded', summary: 'Synthetic handoff report', changedArtifacts: [], evidenceRefs: ['evidence-deliverable'], failureIds: [], uncertainties: [] } }, actor('subagent')));
  add(draft('handoff.assigned', { type: 'handoff', id: 'handoff-accepted' }, { handoff: handoff('handoff-accepted') }));
  const acceptedReport = reportHandoff('handoff-accepted');
  add(draft('handoff.accepted', { type: 'handoff', id: 'handoff-accepted' }, { handoffId: 'handoff-accepted', reportEventId: acceptedReport.eventId, reason: 'Exercise handoff acceptance', evidenceRefs: ['evidence-deliverable'] }));
  add(draft('handoff.assigned', { type: 'handoff', id: 'handoff-rejected' }, { handoff: handoff('handoff-rejected') }));
  const rejectedReport = reportHandoff('handoff-rejected');
  add(draft('handoff.rejected', { type: 'handoff', id: 'handoff-rejected' }, { handoffId: 'handoff-rejected', reportEventId: rejectedReport.eventId, reason: 'Exercise handoff rejection', evidenceRefs: ['evidence-deliverable'] }));
  add(draft('handoff.assigned', { type: 'handoff', id: 'handoff-cancelled' }, { handoff: handoff('handoff-cancelled') }));
  add(draft('handoff.cancelled', { type: 'handoff', id: 'handoff-cancelled' }, { handoffId: 'handoff-cancelled', reason: 'Exercise cancellation', evidenceRefs: ['evidence-deliverable'] }));

  add(draft('lesson.recorded', { type: 'lesson', id: 'lesson-failure' }, { lesson: { lessonId: 'lesson-failure', taskId: 'task-failed', failureId: 'failure-task-failed', summary: 'Synthetic retained lesson', nextDifferentAction: 'Use a different bounded approach', evidenceRefs: ['evidence-failure-task-failed'] } }));
  const decisionRecorded = add(draft('decision.recorded', { type: 'project', id: 'project-all-events' }, { decision: { decisionId: 'decision-synthetic', subjectId: 'project-all-events', choice: 'Initial synthetic choice', rationale: 'Exercise decision recording', evidenceRefs: ['evidence-claim'] } }));
  add(draft('decision.revised', { type: 'project', id: 'project-all-events' }, { decision: { decisionId: 'decision-synthetic', subjectId: 'project-all-events', choice: 'Revised synthetic choice', rationale: 'Exercise decision revision', evidenceRefs: ['evidence-claim'] }, replacesEventId: decisionRecorded.eventId, reason: 'Exercise decision replacement' }));

  const userFeedbackEvidence = (evidenceId, subject) => evidence(evidenceId, subject, 'user_message', 'observed', actor('user'));
  userFeedbackEvidence('evidence-feedback-task', { type: 'task', id: 'task-complete' });
  add(draft('feedback.satisfied', { type: 'task', id: 'task-complete' }, { feedback: { feedbackId: 'feedback-satisfied', subjectId: 'task-complete', disposition: 'satisfied', acceptanceEffect: 'accept', statement: 'Synthetic acceptance', evidenceRef: 'evidence-feedback-task' } }, actor('user')));
  userFeedbackEvidence('evidence-feedback-correction', { type: 'task', id: 'task-complete' });
  add(draft('feedback.correction', { type: 'task', id: 'task-complete' }, { feedback: { feedbackId: 'feedback-correction', subjectId: 'task-complete', disposition: 'satisfied', acceptanceEffect: 'accept', statement: 'Synthetic correction', evidenceRef: 'evidence-feedback-correction', supersedesFeedbackId: 'feedback-satisfied' } }, actor('user')));
  userFeedbackEvidence('evidence-feedback-dissatisfied', { type: 'task', id: 'task-abandoned' });
  add(draft('feedback.dissatisfied', { type: 'task', id: 'task-abandoned' }, { feedback: { feedbackId: 'feedback-dissatisfied', subjectId: 'task-abandoned', disposition: 'dissatisfied', acceptanceEffect: 'keep_pending', statement: 'Synthetic dissatisfaction', evidenceRef: 'evidence-feedback-dissatisfied', baselineApproachId: 'approach-old', baselineHypothesisId: 'hypothesis-old', nextAction: 'Use a changed approach' } }, actor('user')));
  userFeedbackEvidence('evidence-feedback-rejected', { type: 'goal', id: 'goal-retired' });
  add(draft('feedback.rejected', { type: 'goal', id: 'goal-retired' }, { feedback: { feedbackId: 'feedback-rejected', subjectId: 'goal-retired', disposition: 'rejected', acceptanceEffect: 'reject', statement: 'Synthetic rejection', evidenceRef: 'evidence-feedback-rejected', baselineApproachId: 'approach-old', baselineHypothesisId: 'hypothesis-old', correctionPlan: 'Keep explicit rejection' } }, actor('user')));

  userFeedbackEvidence('evidence-feedback-goal', { type: 'goal', id: 'goal-final' });
  add(draft('feedback.satisfied', { type: 'goal', id: 'goal-final' }, { feedback: { feedbackId: 'feedback-goal', subjectId: 'goal-final', disposition: 'satisfied', acceptanceEffect: 'accept', statement: 'Synthetic goal acceptance', evidenceRef: 'evidence-feedback-goal' } }, actor('user')));
  add(draft('goal.achieved', { type: 'goal', id: 'goal-final' }, { criterionEvidenceRefs: ['evidence-user-final'], acceptanceFeedbackId: 'feedback-goal' }));

  const migration = scenario('epoch-all-events-migration', observed);
  migration.add(draft('project.initialized', { type: 'project', id: 'project-migration' }, { project: { projectId: 'project-migration', name: 'Migration', identity: 'Migration event path fixture', implementationBoundaries: ['Synthetic only'], operatingRules: ['No inference'] }, initialization: 'migration' }, actor('migration')));
  const marker = migration.add(draft('migration.v1_imported', { type: 'migration', id: 'migration-marker' }, { archiveHistory: 'archive/HISTORY.v1.ndjson', historyBytes: 1, historySha256: '7'.repeat(64), eventCount: 1, finalEventHash: '8'.repeat(64), recordChunkCount: 1 }, actor('migration')));
  migration.add(draft('migration.v1_records_imported', { type: 'migration', id: 'migration-chunk' }, { importEventId: marker.eventId, chunkIndex: 0, records: [{ legacyId: 'legacy-record', kind: 'goal', summary: 'Synthetic legacy record', sourceRefs: [] }] }, actor('migration')));

  assert.deepEqual([...observed].sort(), [...EXPECTED_EVENT_TYPES].sort());
  assert.equal(events.length > EXPECTED_EVENT_TYPES.length, true);
}
