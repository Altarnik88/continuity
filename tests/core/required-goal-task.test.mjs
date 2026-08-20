import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { MemoryError, validateDraft } from '../../continuity/scripts/lib/core/domain-v2.mjs';

const at = '2026-08-16T02:00:00.000Z';
const draft = (eventType, subject, payload) => ({
  eventType, occurredAt: at,
  actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
  subject, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal', payload,
});

export async function run() {
  const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../continuity');
  const contract = JSON.parse(readFileSync(path.join(skillRoot, 'references', 'v2-contract.schema.json'), 'utf8'));
  const projection = JSON.parse(readFileSync(path.join(skillRoot, 'references', 'projection-v2.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(contract);
  ajv.addSchema(projection);
  const validateTask = ajv.compile({ $ref: `${contract.$id}#/$defs/TaskDef` });
  const task = { taskId: 'task-infrastructure', goalId: 'goal-final', title: 'Prepare infrastructure', scope: 'Synthetic seam', pathOwnership: ['src/core'], owner: 'actor-subagent', dependencyIds: [], criterionIds: [], userFacing: false };
  assert.equal(validateTask(task), false, 'closed TaskDef accepted missing requiredForGoal');
  const validateTaskState = ajv.compile({ $ref: `${projection.$id}#/$defs/TaskState` });
  assert.equal(validateTaskState({ ...task, requiredForGoal: true, userFacing: true, execution: 'planned', verification: 'not_run', acceptance: 'pending', attemptIds: [], failureIds: [], feedbackIds: [], evidenceRefs: [], derivedFromEventIds: ['event-planned'] }), false, 'projection TaskState accepted a user-facing task without criteria');
  const requiredNonUiTask = { ...task, requiredForGoal: true };
  const requiredNonUiState = { ...requiredNonUiTask, execution: 'planned', verification: 'not_run', acceptance: 'pending', attemptIds: [], failureIds: [], feedbackIds: [], evidenceRefs: [], derivedFromEventIds: ['event-planned'] };
  const planningState = {
    project: { projectId: 'project-fixture' }, finalGoalId: 'goal-final', criteria: [], tasks: [], attempts: [], claims: [], failures: [], handoffs: [], lessons: [], decisions: [], evidence: [], feedback: [],
    goals: [{ goalId: 'goal-final', lifecycle: 'active', criterionIds: [] }],
  };
  let runtimeAccepted = true;
  try { validateDraft(draft('task.planned', { type: 'task', id: requiredNonUiTask.taskId }, { task: requiredNonUiTask }), planningState); }
  catch (error) { assert.ok(error instanceof MemoryError); runtimeAccepted = false; }
  assert.deepEqual(
    { contractAccepted: validateTask(requiredNonUiTask), projectionAccepted: validateTaskState(requiredNonUiState), runtimeAccepted },
    { contractAccepted: false, projectionAccepted: false, runtimeAccepted: false },
    'a required non-UI task without criteria crossed a public schema/runtime seam',
  );

  const state = {
    project: { projectId: 'project-fixture' }, finalGoalId: 'goal-final', criteria: [], attempts: [], claims: [], failures: [], handoffs: [], lessons: [], decisions: [],
    goals: [{ goalId: 'goal-final', lifecycle: 'active', criterionIds: [] }],
    tasks: [{ ...task, requiredForGoal: true, execution: 'planned' }],
    evidence: [
      { evidenceId: 'evidence-placeholder', kind: 'test', subjectId: 'goal-final', outcome: 'passed' },
      { evidenceId: 'evidence-user-goal', kind: 'user_message', subjectId: 'goal-final', verifier: { kind: 'user' } },
    ],
    feedback: [{ feedbackId: 'feedback-goal', subjectId: 'goal-final', acceptanceEffect: 'accept', evidenceRef: 'evidence-user-goal', lifecycle: 'active' }],
  };
  const achievement = draft('goal.achieved', { type: 'goal', id: 'goal-final' }, { criterionEvidenceRefs: ['evidence-placeholder'], acceptanceFeedbackId: 'feedback-goal' });
  assert.throws(
    () => validateDraft(achievement, state),
    (error) => error instanceof MemoryError && /goal tasks are not completed/.test(error.message),
  );
}
