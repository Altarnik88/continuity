import assert from 'node:assert/strict';

import { ZERO_HASH, buildEnvelope, foldV2 } from '../../continuity/scripts/lib/core/domain-v2.mjs';

const occurredAt = '2026-08-16T00:00:00.000Z';
const actor = { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' };
const workspaceAtRecord = { head: '3'.repeat(40), branch: 'main', dirty: false, statusFingerprint: '4'.repeat(64), fingerprintPartial: false, capturedAt: occurredAt };
const draft = (eventType, subject, payload) => ({ eventType, occurredAt, actor, subject, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal', payload });
const goal = (goalId, isFinal = false) => ({ goalId, title: goalId, outcome: 'Stable ID ordering', isFinal, ...(isFinal ? {} : { parentGoalId: 'goal-final' }), authority: 'user', basis: 'user_stated', criterionIds: [] });

export async function run() {
  const events = [];
  const add = (value) => { const event = buildEnvelope(value, { epochId: 'epoch-order-fixture', sequence: events.length + 1, recordedAt: occurredAt, workspaceAtRecord, previousEventHash: events.at(-1)?.eventHash ?? ZERO_HASH }); events.push(event); };
  add(draft('project.initialized', { type: 'project', id: 'project-order' }, { project: { projectId: 'project-order', name: 'Ordering', identity: 'Stable ordering fixture', implementationBoundaries: ['Synthetic only'], operatingRules: ['Sort by stable ID'] }, initialization: 'new' }));
  add(draft('goal.declared', { type: 'goal', id: 'goal-final' }, { goal: goal('goal-final', true), evidenceRef: 'evidence-user-goal' }));
  add(draft('evidence.recorded', { type: 'goal', id: 'goal-final' }, { evidence: { evidenceId: 'evidence-user-goal', kind: 'user_message', subjectId: 'goal-final', scope: 'goal declaration', locator: 'messages/goal', observedAt: occurredAt, verifier: { kind: 'user', id: 'actor-user' }, method: 'synthetic fixture', outcome: 'observed', policy: { kind: 'immutable_until_superseded' }, sourceRefs: [], sensitivity: 'internal' } }));
  add(draft('goal.declared', { type: 'goal', id: 'goal-zulu' }, { goal: goal('goal-zulu'), evidenceRef: 'evidence-user-goal' }));
  add(draft('goal.declared', { type: 'goal', id: 'goal-alpha' }, { goal: goal('goal-alpha'), evidenceRef: 'evidence-user-goal' }));
  assert.deepEqual(foldV2(events).goals.map((item) => item.goalId), ['goal-alpha', 'goal-final', 'goal-zulu']);
}
