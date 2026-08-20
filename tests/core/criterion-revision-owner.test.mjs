import assert from 'node:assert/strict';

import { MemoryError, ZERO_HASH, buildEnvelope, foldV2, validateDraft } from '../../continuity/scripts/lib/core/domain-v2.mjs';

const at = '2026-08-16T03:20:00.000Z';
const workspace = { head: '5'.repeat(40), branch: 'main', dirty: false, statusFingerprint: '6'.repeat(64), fingerprintPartial: false, capturedAt: at };
const draft = (eventType, subject, payload) => ({ eventType, occurredAt: at, actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' }, subject, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal', payload });

export async function run() {
  const events = [];
  const add = (value) => {
    const event = buildEnvelope(value, { epochId: 'epoch-criterion-owner', sequence: events.length + 1, recordedAt: at, workspaceAtRecord: workspace, previousEventHash: events.at(-1)?.eventHash ?? ZERO_HASH });
    foldV2([...events, event]); events.push(event); return event;
  };
  add(draft('project.initialized', { type: 'project', id: 'project-owner' }, { project: { projectId: 'project-owner', name: 'Owner', identity: 'Criterion owner seam', implementationBoundaries: ['Synthetic only'], operatingRules: ['Resolve revised references'] }, initialization: 'new' }));
  add(draft('goal.declared', { type: 'goal', id: 'goal-final' }, { goal: { goalId: 'goal-final', title: 'Resolve owners', outcome: 'No dangling revised criterion owner', isFinal: true, authority: 'user', basis: 'user_stated', criterionIds: ['criterion-core'] }, evidenceRef: 'evidence-user-goal' }));
  const declared = add(draft('criterion.declared', { type: 'criterion', id: 'criterion-core' }, { criterion: { criterionId: 'criterion-core', ownerType: 'goal', ownerId: 'goal-final', condition: 'Owner exists', scope: 'core', requiredEvidenceKinds: ['test'], freshnessPolicy: { kind: 'max_age', maxAgeSeconds: 3600 }, waivableByUser: false } }));
  const revision = draft('criterion.revised', { type: 'criterion', id: 'criterion-core' }, { criterion: { criterionId: 'criterion-core', ownerType: 'task', ownerId: 'task-missing', condition: 'Owner still exists', scope: 'core', requiredEvidenceKinds: ['test'], freshnessPolicy: { kind: 'max_age', maxAgeSeconds: 3600 }, waivableByUser: false }, replacesEventId: declared.eventId, reason: 'Exercise revised owner reference' });
  assert.throws(() => validateDraft(revision, foldV2(events)), (error) => error instanceof MemoryError && /criterion owner/.test(error.message));
}
