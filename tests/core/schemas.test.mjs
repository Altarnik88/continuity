import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { EVENT_TYPES } from '../../continuity/scripts/lib/core/domain-v2.mjs';
import { EXPECTED_EVENT_TYPES } from '../helpers/v2-contract-fixture.mjs';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../continuity');
const readJson = (relative) => JSON.parse(readFileSync(path.join(skillRoot, relative), 'utf8'));

export async function run() {
  const contract = readJson('references/v2-contract.schema.json');
  const projection = readJson('references/projection-v2.schema.json');
  const inspect = readJson('references/inspect-v1.schema.json');
  const template = readJson('assets/init-v2.template.json');
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  for (const schema of [contract, projection, inspect]) ajv.addSchema(schema);
  assert.equal(ajv.validate('urn:continuity:schema:v2-contract#/$defs/InitV2Input', template), true, JSON.stringify(ajv.errors));
  const draftBranches = contract.$defs.EventDraft.oneOf;
  const branchTypes = draftBranches.map((branch) => branch.properties.eventType.const);
  assert.deepEqual([...branchTypes].sort(), [...EXPECTED_EVENT_TYPES].sort());
  assert.deepEqual([...EVENT_TYPES].sort(), [...EXPECTED_EVENT_TYPES].sort());
  assert.equal(new Set(branchTypes).size, EXPECTED_EVENT_TYPES.length);
  const validateDraft = ajv.getSchema('urn:continuity:schema:v2-contract#/$defs/EventDraft');
  const taskStarted = { eventType: 'task.started', occurredAt: '2026-08-15T00:00:00.000Z', actor: { kind: 'subagent', id: 'actor-subagent', role: 'subagent' }, subject: { type: 'task', id: 'task-example' }, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal', payload: { attemptId: 'attempt-example' } };
  assert.equal(validateDraft(taskStarted), true, JSON.stringify(validateDraft.errors));
  assert.equal(validateDraft({ ...taskStarted, payload: { failureId: 'failure-example' } }), false);
  const feedback = (eventType, value) => ({ eventType, occurredAt: '2026-08-15T00:00:00.000Z', actor: { kind: 'user', id: 'actor-user', role: 'user' }, subject: { type: 'task', id: 'task-example' }, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal', payload: { feedback: { feedbackId: 'feedback-example', subjectId: 'task-example', statement: 'Synthetic feedback', evidenceRef: 'evidence-user-message', ...value } } });
  const satisfied = feedback('feedback.satisfied', { disposition: 'satisfied', acceptanceEffect: 'accept' });
  assert.equal(validateDraft(satisfied), true, JSON.stringify(validateDraft.errors));
  assert.equal(validateDraft(feedback('feedback.satisfied', { disposition: 'dissatisfied', acceptanceEffect: 'keep_pending', baselineApproachId: 'approach-old', baselineHypothesisId: 'hypothesis-old', nextAction: 'Revise' })), false);
  assert.equal(validateDraft(feedback('feedback.satisfied', { disposition: 'satisfied', acceptanceEffect: 'accept', supersedesFeedbackId: 'feedback-old' })), false);
  assert.equal(validateDraft(feedback('feedback.dissatisfied', { disposition: 'dissatisfied', acceptanceEffect: 'keep_pending', baselineApproachId: 'approach-old', baselineHypothesisId: 'hypothesis-old', nextAction: 'Revise' })), true, JSON.stringify(validateDraft.errors));
  assert.equal(validateDraft(feedback('feedback.rejected', { disposition: 'rejected', acceptanceEffect: 'keep_pending', baselineApproachId: 'approach-old', baselineHypothesisId: 'hypothesis-old', nextAction: 'Revise' })), false);
  assert.equal(validateDraft(feedback('feedback.correction', { disposition: 'satisfied', acceptanceEffect: 'accept', supersedesFeedbackId: 'feedback-old' })), true, JSON.stringify(validateDraft.errors));
  assert.equal(validateDraft(feedback('feedback.correction', { disposition: 'satisfied', acceptanceEffect: 'accept' })), false);
}
