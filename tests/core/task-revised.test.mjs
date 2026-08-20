import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { MemoryError, ZERO_HASH, buildEnvelope, foldV2, validateDraft } from '../../continuity/scripts/lib/core/domain-v2.mjs';

const at = '2026-08-16T02:10:00.000Z';
const workspace = { head: '1'.repeat(40), branch: 'main', dirty: false, statusFingerprint: '2'.repeat(64), fingerprintPartial: false, capturedAt: at };
const actor = (kind = 'coordinator', id = `actor-${kind}`) => ({ kind, id, role: kind });
const draft = (eventType, subject, payload, by = actor()) => ({ eventType, occurredAt: at, actor: by, subject, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal', payload });

export async function run() {
  const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../continuity');
  const contract = JSON.parse(readFileSync(path.join(skillRoot, 'references', 'v2-contract.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validateEvent = ajv.compile(contract);
  const events = [];
  const add = (value) => {
    const event = buildEnvelope(value, { epochId: 'epoch-task-revision', sequence: events.length + 1, recordedAt: at, workspaceAtRecord: workspace, previousEventHash: events.at(-1)?.eventHash ?? ZERO_HASH });
    foldV2([...events, event]); events.push(event); return event;
  };

  add(draft('project.initialized', { type: 'project', id: 'project-revision' }, { project: { projectId: 'project-revision', name: 'Revision', identity: 'Task revision seam', implementationBoundaries: ['Synthetic only'], operatingRules: ['Resolve references first'] }, initialization: 'new' }));
  add(draft('goal.declared', { type: 'goal', id: 'goal-final' }, { goal: { goalId: 'goal-final', title: 'Revise planned task', outcome: 'Attach task-owned criteria safely', isFinal: true, authority: 'user', basis: 'user_stated', criterionIds: ['criterion-goal'] }, evidenceRef: 'evidence-user-goal' }));
  add(draft('criterion.declared', { type: 'criterion', id: 'criterion-goal' }, { criterion: { criterionId: 'criterion-goal', ownerType: 'goal', ownerId: 'goal-final', condition: 'Goal criterion exists', scope: 'goal', requiredEvidenceKinds: ['test'], freshnessPolicy: { kind: 'max_age', maxAgeSeconds: 3600 }, waivableByUser: false } }));
  const planned = add(draft('task.planned', { type: 'task', id: 'task-core' }, { task: { taskId: 'task-core', goalId: 'goal-final', title: 'Initial task', scope: 'initial scope', pathOwnership: ['src/core'], owner: 'actor-subagent', dependencyIds: [], criterionIds: ['criterion-goal'], userFacing: true, requiredForGoal: true } }));
  add(draft('criterion.declared', { type: 'criterion', id: 'criterion-task' }, { criterion: { criterionId: 'criterion-task', ownerType: 'task', ownerId: 'task-core', condition: 'Task-owned check passes', scope: 'task', requiredEvidenceKinds: ['test'], freshnessPolicy: { kind: 'max_age', maxAgeSeconds: 3600 }, waivableByUser: false } }));

  const revisedTask = { taskId: 'task-core', goalId: 'goal-final', title: 'Revised task', scope: 'revised scope', pathOwnership: ['src/core', 'src/checks'], owner: 'actor-subagent', dependencyIds: [], criterionIds: ['criterion-goal', 'criterion-task'], userFacing: true, requiredForGoal: true };
  const revision = draft('task.revised', { type: 'task', id: 'task-core' }, { task: revisedTask, replacesEventId: planned.eventId, reason: 'Attach the declared task-owned criterion' });
  assert.equal(validateEvent(revision), true, JSON.stringify(validateEvent.errors));
  assert.doesNotThrow(() => validateDraft(revision, foldV2(events)));
  add(revision);
  assert.deepEqual(foldV2(events).tasks[0].criterionIds, ['criterion-goal', 'criterion-task']);

  const changedRequiredness = structuredClone(revision); changedRequiredness.payload.task.requiredForGoal = false;
  assert.throws(() => validateDraft(changedRequiredness, foldV2(events)), MemoryError);
  const missingReference = structuredClone(revision); missingReference.payload.task.criterionIds.push('criterion-missing');
  assert.throws(() => validateDraft(missingReference, foldV2(events)), MemoryError);
  const noCriteria = structuredClone(revision); noCriteria.payload.task.criterionIds = [];
  assert.equal(validateEvent(noCriteria), false, 'AJV accepted a user-facing task without criteria');

  add(draft('attempt.started', { type: 'attempt', id: 'attempt-one' }, { attempt: { attemptId: 'attempt-one', taskId: 'task-core', ordinal: 1, owner: 'actor-subagent', approachId: 'approach-one', hypothesisId: 'hypothesis-one', approachSummary: 'Start the revised task' } }, actor('subagent')));
  add(draft('task.started', { type: 'task', id: 'task-core' }, { attemptId: 'attempt-one' }, actor('subagent')));
  assert.throws(() => validateDraft(revision, foldV2(events)), MemoryError);
}
