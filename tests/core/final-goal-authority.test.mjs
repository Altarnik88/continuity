import assert from 'node:assert/strict';

import { MemoryError, ZERO_HASH, buildEnvelope, foldV2, validateDraft } from '../../continuity/scripts/lib/core/domain-v2.mjs';

const at = '2026-08-16T03:10:00.000Z';
const workspace = { head: '3'.repeat(40), branch: 'main', dirty: false, statusFingerprint: '4'.repeat(64), fingerprintPartial: false, capturedAt: at };
const actor = (kind, id = `actor-${kind}`) => ({ kind, id, role: kind });
const draft = (eventType, subject, payload, by = actor('coordinator')) => ({ eventType, occurredAt: at, actor: by, subject, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal', payload });

export async function run() {
  const events = [];
  const add = (value) => {
    const event = buildEnvelope(value, { epochId: 'epoch-final-authority', sequence: events.length + 1, recordedAt: at, workspaceAtRecord: workspace, previousEventHash: events.at(-1)?.eventHash ?? ZERO_HASH });
    foldV2([...events, event]); events.push(event); return event;
  };
  add(draft('project.initialized', { type: 'project', id: 'project-final' }, { project: { projectId: 'project-final', name: 'Final authority', identity: 'Goal revision authority seam', implementationBoundaries: ['Synthetic only'], operatingRules: ['Keep final goal user-backed'] }, initialization: 'new' }));
  const declared = add(draft('goal.declared', { type: 'goal', id: 'goal-final' }, { goal: { goalId: 'goal-final', title: 'User goal', outcome: 'Remain user-backed', isFinal: true, authority: 'user', basis: 'user_stated', criterionIds: [] }, evidenceRef: 'evidence-user-goal' }));
  add(draft('evidence.recorded', { type: 'goal', id: 'goal-final' }, { evidence: { evidenceId: 'evidence-user-goal', kind: 'user_message', subjectId: 'goal-final', scope: 'final goal revision', locator: 'messages/final-goal', observedAt: at, verifier: { kind: 'user', id: 'actor-user' }, method: 'synthetic user statement', outcome: 'observed', policy: { kind: 'immutable_until_superseded' }, sourceRefs: [], sensitivity: 'internal' } }, actor('user')));
  const revised = (overrides) => draft('goal.revised', { type: 'goal', id: 'goal-final' }, { goal: { goalId: 'goal-final', title: 'Revised user goal', outcome: 'Remain user-backed', isFinal: true, authority: 'user', basis: 'user_stated', criterionIds: [], ...overrides }, replacesEventId: declared.eventId, reason: 'Exercise final authority guard', evidenceRef: 'evidence-user-goal' }, actor('user'));
  assert.throws(() => validateDraft(revised({ authority: 'coordinator' }), foldV2(events)), MemoryError);
  assert.throws(() => validateDraft(revised({ basis: 'agent_inferred' }), foldV2(events)), MemoryError);
  const coordinatorRevision = revised({}); coordinatorRevision.actor = actor('coordinator');
  assert.throws(() => validateDraft(coordinatorRevision, foldV2(events)), MemoryError);
  assert.throws(() => validateDraft(revised({ parentGoalId: 'goal-missing' }), foldV2(events)), /parent goal/);
  assert.throws(() => validateDraft(revised({ criterionIds: ['criterion-missing'] }), foldV2(events)), /goal criterion/);
  assert.equal(foldV2(events).finalGoalId, 'goal-final');
}
