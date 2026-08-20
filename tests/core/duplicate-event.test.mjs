import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { MemoryError, ZERO_HASH, buildEnvelope, canonicalV2, foldV2 } from '../../continuity/scripts/lib/core/domain-v2.mjs';

const occurredAt = '2026-08-16T00:00:00.000Z';
const actor = { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' };
const workspaceAtRecord = { head: '1'.repeat(40), branch: 'main', dirty: false, statusFingerprint: '2'.repeat(64), fingerprintPartial: false, capturedAt: occurredAt };
const draft = (eventType, subject, payload) => ({ eventType, occurredAt, actor, subject, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal', payload });

export async function run() {
  const first = buildEnvelope(draft('project.initialized', { type: 'project', id: 'project-duplicate' }, { project: { projectId: 'project-duplicate', name: 'Duplicate', identity: 'Duplicate event fixture', implementationBoundaries: ['Synthetic only'], operatingRules: ['Unique event IDs'] }, initialization: 'new' }), { epochId: 'epoch-duplicate-fixture', sequence: 1, recordedAt: occurredAt, workspaceAtRecord, previousEventHash: ZERO_HASH });
  const second = buildEnvelope(draft('goal.declared', { type: 'goal', id: 'goal-final' }, { goal: { goalId: 'goal-final', title: 'Reject duplicates', outcome: 'Keep event IDs unique', isFinal: true, authority: 'user', basis: 'user_stated', criterionIds: [] }, evidenceRef: 'evidence-user-goal' }), { epochId: 'epoch-duplicate-fixture', sequence: 2, recordedAt: occurredAt, workspaceAtRecord, previousEventHash: first.eventHash });
  const duplicate = { ...second, eventId: first.eventId };
  const material = { ...duplicate }; delete material.eventHash;
  duplicate.eventHash = createHash('sha256').update(canonicalV2(material)).digest('hex');
  assert.throws(() => foldV2([first, duplicate]), MemoryError);
}
