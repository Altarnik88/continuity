import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { MemoryError, validateDraft, validateDraftShape } from '../../continuity/scripts/lib/core/domain-v2.mjs';

export async function run() {
  const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../continuity');
  const contract = JSON.parse(readFileSync(path.join(skillRoot, 'references', 'v2-contract.schema.json'), 'utf8'));
  const projection = JSON.parse(readFileSync(path.join(skillRoot, 'references', 'projection-v2.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(contract);
  ajv.addSchema(projection);
  const validateFailure = ajv.compile({ $ref: `${contract.$id}#/$defs/FailureDef` });
  const goalFailure = {
    failureId: 'failure-goal', subject: { type: 'goal', id: 'goal-final' }, terminal: 'blocked',
    approachId: 'approach-one', hypothesisId: 'hypothesis-one', symptomClass: 'dependency',
    observedSymptom: 'Synthetic blocker observed', impact: 'Goal cannot proceed', unchanged: ['No unrelated state changed'],
    rootCause: { state: 'unknown', summary: 'Cause is not confirmed' }, evidenceRefs: ['evidence-failure'], retryCount: 0,
    nextAction: 'Resolve the responsible boundary',
  };
  assert.equal(validateFailure(goalFailure), false, 'AJV accepted a goal failure without owner or responsibleBoundary');
  assert.equal(validateFailure({ ...goalFailure, owner: 'actor-coordinator' }), true, JSON.stringify(validateFailure.errors));
  assert.equal(validateFailure({ ...goalFailure, responsibleBoundary: 'upstream service' }), true, JSON.stringify(validateFailure.errors));
  assert.equal(validateFailure({ ...goalFailure, subject: { type: 'claim', id: 'claim-one' }, owner: 'actor-coordinator' }), false, 'AJV accepted a failure subject outside goal/task');
  const validateFailureState = ajv.compile({ $ref: `${projection.$id}#/$defs/FailureState` });
  assert.equal(validateFailureState({ ...goalFailure, derivedFromEventIds: ['event-failure'] }), false, 'projection FailureState weakened goal responsibility');

  const taskFailure = { ...goalFailure, failureId: 'failure-task', subject: { type: 'task', id: 'task-core' }, attemptId: 'attempt-one' };
  const taskFailureDraft = {
    eventType: 'failure.recorded', occurredAt: '2026-08-16T04:00:00.000Z',
    actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
    subject: { type: 'task', id: 'task-core' }, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal',
    payload: { failure: taskFailure },
  };
  const validateEventDraft = ajv.getSchema(`${contract.$id}#/$defs/EventDraft`);
  const state = {
    project: { projectId: 'project-failure' }, finalGoalId: 'goal-final', criteria: [], claims: [], failures: [], handoffs: [], lessons: [], decisions: [], feedback: [],
    goals: [{ goalId: 'goal-final', lifecycle: 'active', criterionIds: [] }],
    tasks: [{ taskId: 'task-core', goalId: 'goal-final', owner: 'actor-subagent', execution: 'in_progress', criterionIds: [] }],
    attempts: [{ attemptId: 'attempt-one', taskId: 'task-core', owner: 'actor-subagent', outcome: 'in_progress' }],
    evidence: [{ evidenceId: 'evidence-failure', kind: 'test', subjectId: 'task-core', outcome: 'failed' }],
  };
  assert.equal(validateEventDraft(taskFailureDraft), false, 'AJV accepted task failure without its responsible owner');
  assert.throws(() => validateDraftShape(taskFailureDraft), MemoryError, 'event lint accepted task failure without its responsible owner');
  assert.throws(() => validateDraft(taskFailureDraft, state), MemoryError, 'runtime accepted task failure without its responsible owner');
}
