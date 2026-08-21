import { createHash } from 'node:crypto';

import { MemoryError } from './errors.mjs';
import { canonicalV3, isBrandedV3 } from './input-v3.mjs';
import { TASK_CLASSES } from './coordination/contract.mjs';
import {
  persistedAssignmentPolicy,
  persistedAgentSatisfies,
  normalizePersistedAgent,
  persistedPacketPolicy,
  persistedEvidenceFreshness,
  requiredCriterionBacklogViolations,
  taskOwnershipClaims,
} from './coordination/persist-policy.mjs';

export { MemoryError };

export const SCHEMA_VERSION = 3;
export const PROJECTION_VERSION = 3;
export const ZERO_HASH = '0'.repeat(64);
export const MAX_EVENT_BYTES = 64 * 1024;
export const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
export const MAX_STRING = 2_000;
export const MAX_ITEMS = 50;
export const HANDOFF_TEXT_BYTES = 16 * 1024;
export const HANDOFF_JSON_BYTES = 32 * 1024;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ID = /^[a-z][a-z0-9_]*-[a-z0-9][a-z0-9-]{1,72}$/;
const HASH = /^[a-f0-9]{64}$/;
const GIT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export const EXECUTION = Object.freeze([
  'planned', 'in_progress', 'succeeded', 'failed', 'blocked', 'partial', 'unknown', 'superseded',
]);
export const VERIFICATION = Object.freeze([
  'unverified', 'passed', 'failed', 'inconclusive', 'expired',
]);
export const ACCEPTANCE = Object.freeze(['pending', 'accepted', 'rejected', 'needs_changes']);
export const FRESHNESS = Object.freeze(['fresh', 'stale', 'unknown', 'not_applicable']);
export const ACTOR_KINDS = Object.freeze([
  'user', 'coordinator', 'subagent', 'tool', 'migration', 'external_source',
]);
export const RISK_CLASSES = Object.freeze(['routine', 'significant', 'critical']);
export const EVENT_TYPES = Object.freeze([
  'project.initialized',
  'goal.declared', 'goal.status_changed',
  'criterion.declared', 'criterion.status_changed',
  'task.planned', 'task.status_changed',
  'attempt.started', 'attempt.finished', 'attempt.reported',
  'result.recorded', 'result.superseded',
  'evidence.recorded', 'evidence.reverified',
  'work_package.recorded', 'verification.recorded',
  'assignment.recorded', 'assignment.released',
  'context_handoff.recorded', 'backlog.parked', 'agent.registered',
  'failure.recorded',
  'feedback.recorded', 'feedback.corrected',
  'decision.recorded', 'decision.revised',
  'claim.asserted', 'claim.disputed', 'claim.superseded', 'claim.retracted',
  'conflict.recorded', 'conflict.resolved',
  'lesson.recorded',
  'next_action.recorded', 'next_action.status_changed',
  'handoff.created', 'handoff.reported', 'handoff.accepted', 'handoff.rejected', 'handoff.cancelled',
  'migration.receipt_recorded',
  'graphify.receipt_recorded',
]);

const EVENT_SET = new Set(EVENT_TYPES);
const EXECUTION_SET = new Set(EXECUTION);
const VERIFICATION_SET = new Set(VERIFICATION);
const ACCEPTANCE_SET = new Set(ACCEPTANCE);
const FRESHNESS_SET = new Set(FRESHNESS);
const ACTOR_SET = new Set(ACTOR_KINDS);
const RISK_SET = new Set(RISK_CLASSES);
const EVIDENCE_KIND_SET = new Set([
  'git_blob', 'file', 'command', 'test', 'browser_render', 'url',
  'user_message', 'agent_report', 'graphify_receipt',
]);
const AUTHORIZING_EVIDENCE_KIND_SET = new Set(['command', 'test']);

function fail(message, exitCode = 2) {
  throw new MemoryError(message, exitCode);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function unicodeLength(value) {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return null;
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) return null;
    length += 1;
  }
  return length;
}

function text(value, label, { max = MAX_STRING } = {}) {
  const length = typeof value === 'string' ? unicodeLength(value) : null;
  if (length === null || length < 1 || length > max
    || value !== value.trim() || value !== value.normalize('NFC')
    || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
    fail(`${label} must be a bounded single-line string`);
  }
}

function id(value, label) {
  text(value, label, { max: 80 });
  if (!ID.test(value)) fail(`${label} is not a stable ID`);
}

function timestamp(value, label) {
  text(value, label, { max: 24 });
  if (!ISO.test(value) || new Date(value).toISOString() !== value) fail(`${label} must be strict ISO-8601 UTC`);
}

function hash(value, label) {
  text(value, label, { max: 64 });
  if (!HASH.test(value)) fail(`${label} must be SHA-256 hex`);
}

function enumOf(value, allowed, label) {
  if (!allowed.has(value)) fail(`${label} is not an allowed enum`);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be an object`);
  }
}

function exact(value, allowed, required, label) {
  object(value, label);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) fail(`${label} contains unknown fields`);
  if (required.some((key) => !keys.includes(key))) fail(`${label} is missing required fields`);
}

function uniqueIds(value, label, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > MAX_ITEMS) fail(`${label} must be a bounded ID array`);
  value.forEach((item, index) => id(item, `${label}[${index}]`));
  if (new Set(value).size !== value.length) fail(`${label} must contain unique IDs`);
}

function optionalIds(value, label) {
  if (value !== undefined) uniqueIds(value, label);
}

export function combineFreshness(values) {
  const list = values.filter((value) => FRESHNESS_SET.has(value));
  if (list.includes('stale')) return 'stale';
  if (list.includes('unknown')) return 'unknown';
  if (list.includes('fresh')) return 'fresh';
  return 'not_applicable';
}

export function classifyRisk(eventType, payload = {}) {
  if (!EVENT_SET.has(eventType)) fail('eventType is not in the v3 registry');
  if (eventType === 'feedback.recorded' || eventType === 'feedback.corrected') {
    const acceptance = payload.feedback?.acceptance;
    if (acceptance === 'accepted' || acceptance === 'rejected' || acceptance === 'needs_changes') return 'critical';
  }
  if (eventType === 'goal.declared' && payload.goal?.isFinal === true) return 'critical';
  if (eventType === 'criterion.status_changed' && payload.status === 'waived') return 'critical';
  if (eventType === 'migration.receipt_recorded') return 'critical';
  if (eventType === 'result.recorded' || eventType === 'result.superseded') return 'significant';
  if (eventType === 'failure.recorded') return 'significant';
  if (eventType === 'verification.recorded') return 'significant';
  if (eventType === 'context_handoff.recorded' || eventType === 'backlog.parked') return 'significant';
  if (eventType === 'evidence.recorded' && payload.evidence?.authorizing === true) return 'significant';
  if (eventType === 'evidence.reverified') return 'significant';
  if (eventType === 'claim.disputed' || eventType === 'conflict.recorded') return 'significant';
  if (eventType === 'handoff.accepted' || eventType === 'handoff.rejected') return 'significant';
  if (eventType === 'next_action.recorded') return 'significant';
  return 'routine';
}

function actor(value, label) {
  exact(value, ['kind', 'id', 'role', 'runId', 'parentRunId'], ['kind', 'id', 'role'], label);
  enumOf(value.kind, ACTOR_SET, `${label}.kind`);
  id(value.id, `${label}.id`);
  text(value.role, `${label}.role`, { max: 80 });
  if (value.runId !== undefined) id(value.runId, `${label}.runId`);
  if (value.parentRunId !== undefined) id(value.parentRunId, `${label}.parentRunId`);
  if (value.kind === 'external_source') fail('external_source cannot write journal events');
}

function sameActorIdentity(left, right) {
  return left?.kind === right?.kind
    && left?.id === right?.id
    && (left?.runId ?? null) === (right?.runId ?? null);
}

function subject(value, label) {
  exact(value, ['type', 'id'], ['type', 'id'], label);
  text(value.type, `${label}.type`, { max: 40 });
  id(value.id, `${label}.id`);
}

function workspace(value, label) {
  exact(value, ['head', 'branch', 'dirty', 'statusFingerprint', 'fingerprintPartial', 'capturedAt'],
    ['head', 'branch', 'dirty', 'statusFingerprint', 'fingerprintPartial', 'capturedAt'], label);
  if (value.head !== 'unavailable' && !GIT_ID.test(value.head)) fail(`${label}.head is invalid`);
  text(value.branch, `${label}.branch`, { max: 200 });
  if (typeof value.dirty !== 'boolean') fail(`${label}.dirty must be boolean`);
  hash(value.statusFingerprint, `${label}.statusFingerprint`);
  if (typeof value.fingerprintPartial !== 'boolean') fail(`${label}.fingerprintPartial must be boolean`);
  timestamp(value.capturedAt, `${label}.capturedAt`);
}

function find(state, collection, key, wanted) {
  return state[collection].find((item) => item[key] === wanted);
}

function requireEntity(state, collection, key, wanted, label) {
  const found = find(state, collection, key, wanted);
  if (!found) fail(`${label} ${wanted} does not exist`);
  return found;
}

function authorizingEvidence(state, evidenceIds, {
  ownerRunId, ownerActorId, taskId, criterionIds = [],
} = {}) {
  if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) return [];
  return evidenceIds.map((evidenceId) => {
    const evidence = requireEntity(state, 'evidence', 'evidenceId', evidenceId, 'evidence');
    if (evidence.kind === 'graphify_receipt' || evidence.authorizing !== true) {
      fail('Graphify or non-authorizing evidence cannot authorize success');
    }
    if (!AUTHORIZING_EVIDENCE_KIND_SET.has(evidence.kind)) {
      fail('only command or test evidence can authorize success');
    }
    if (evidence.outcome !== 'passed') fail('authorizing evidence outcome must be passed');
    if (taskId && evidence.taskId !== taskId) fail('authorizing evidence must belong to the Result task');
    if (criterionIds.length && !criterionIds.every((criterionId) => (
      (evidence.criterionIds ?? []).includes(criterionId)
    ))) {
      fail('authorizing evidence must cover the Result criteria');
    }
    if (ownerRunId && evidence.actor?.runId && evidence.actor.runId === ownerRunId
      && evidence.verifier?.runId === ownerRunId) {
      fail('independent verification requires a different verifier run');
    }
    if (ownerActorId && evidence.verifier?.id === ownerActorId && evidence.actor?.id === ownerActorId
      && evidence.verifier?.kind === 'subagent') {
      fail('a subagent cannot independently verify its own run');
    }
    return evidence;
  });
}

function validateProject(project) {
  exact(project, ['projectId', 'name', 'identity', 'implementationBoundaries', 'operatingRules'],
    ['projectId', 'name', 'identity', 'implementationBoundaries', 'operatingRules'], 'project');
  id(project.projectId, 'project.projectId');
  text(project.name, 'project.name', { max: 120 });
  text(project.identity, 'project.identity');
  if (!Array.isArray(project.implementationBoundaries) || project.implementationBoundaries.length < 1) {
    fail('project.implementationBoundaries is required');
  }
  project.implementationBoundaries.forEach((item, index) => text(item, `project.implementationBoundaries[${index}]`));
  if (!Array.isArray(project.operatingRules) || project.operatingRules.length < 1) fail('project.operatingRules is required');
  project.operatingRules.forEach((item, index) => text(item, `project.operatingRules[${index}]`));
}

function validateGoal(goal) {
  exact(goal, ['goalId', 'title', 'outcome', 'isFinal', 'parentGoalId', 'authority', 'basis', 'criterionIds'],
    ['goalId', 'title', 'outcome', 'isFinal', 'authority', 'basis', 'criterionIds'], 'goal');
  id(goal.goalId, 'goal.goalId');
  text(goal.title, 'goal.title');
  text(goal.outcome, 'goal.outcome');
  if (typeof goal.isFinal !== 'boolean') fail('goal.isFinal must be boolean');
  if (goal.parentGoalId !== undefined) id(goal.parentGoalId, 'goal.parentGoalId');
  enumOf(goal.authority, ACTOR_SET, 'goal.authority');
  text(goal.basis, 'goal.basis', { max: 40 });
  uniqueIds(goal.criterionIds, 'goal.criterionIds');
  if (goal.isFinal && (goal.authority !== 'user' || goal.basis !== 'user_stated')) {
    fail('final goal must be user-stated');
  }
}

function validateCriterion(criterion) {
  exact(criterion, ['criterionId', 'ownerType', 'ownerId', 'condition', 'scope', 'requiredEvidenceKinds', 'freshnessPolicy', 'waivableByUser'],
    ['criterionId', 'ownerType', 'ownerId', 'condition', 'scope', 'requiredEvidenceKinds', 'freshnessPolicy', 'waivableByUser'], 'criterion');
  id(criterion.criterionId, 'criterion.criterionId');
  text(criterion.ownerType, 'criterion.ownerType', { max: 20 });
  id(criterion.ownerId, 'criterion.ownerId');
  text(criterion.condition, 'criterion.condition');
  text(criterion.scope, 'criterion.scope');
  if (!Array.isArray(criterion.requiredEvidenceKinds) || criterion.requiredEvidenceKinds.length < 1) {
    fail('criterion.requiredEvidenceKinds is required');
  }
  criterion.requiredEvidenceKinds.forEach((item, index) => text(item, `criterion.requiredEvidenceKinds[${index}]`, { max: 40 }));
  object(criterion.freshnessPolicy, 'criterion.freshnessPolicy');
  if (typeof criterion.waivableByUser !== 'boolean') fail('criterion.waivableByUser must be boolean');
}

function optionalTextList(value, label, { max = MAX_STRING } = {}) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MAX_ITEMS) fail(`${label} is invalid`);
  value.forEach((item, index) => text(item, `${label}[${index}]`, { max }));
}

function validateTask(task) {
  exact(task, [
    'taskId', 'goalId', 'title', 'scope', 'owner', 'criterionIds', 'userFacing',
    'dependencyIds', 'capabilities', 'requiredCapabilities', 'pathOwnership', 'ownershipScope',
    'priority', 'size', 'complexity', 'risk', 'sourceContext', 'acceptanceCriteria',
    'focusedVerification', 'recommendedNextAction', 'moduleId', 'class', 'enablesTaskIds',
    'createdAt',
  ], ['taskId', 'goalId', 'title', 'scope', 'owner', 'criterionIds', 'userFacing'], 'task');
  id(task.taskId, 'task.taskId');
  id(task.goalId, 'task.goalId');
  text(task.title, 'task.title');
  text(task.scope, 'task.scope');
  id(task.owner, 'task.owner');
  uniqueIds(task.criterionIds, 'task.criterionIds', { min: 1 });
  if (typeof task.userFacing !== 'boolean') fail('task.userFacing must be boolean');
  optionalIds(task.dependencyIds, 'task.dependencyIds');
  optionalIds(task.enablesTaskIds, 'task.enablesTaskIds');
  optionalTextList(task.capabilities, 'task.capabilities', { max: 80 });
  optionalTextList(task.requiredCapabilities, 'task.requiredCapabilities', { max: 80 });
  optionalTextList(task.pathOwnership, 'task.pathOwnership', { max: 200 });
  optionalTextList(task.ownershipScope, 'task.ownershipScope', { max: 200 });
  optionalTextList(task.acceptanceCriteria, 'task.acceptanceCriteria');
  optionalTextList(task.focusedVerification, 'task.focusedVerification');
  if (task.priority !== undefined) enumOf(task.priority, new Set(['blocker', 'core', 'verification', 'backlog']), 'task.priority');
  if (task.size !== undefined) enumOf(task.size, new Set(['XS', 'S', 'M', 'L', 'XL']), 'task.size');
  if (task.complexity !== undefined) enumOf(task.complexity, new Set(['low', 'medium', 'high', 'unknown']), 'task.complexity');
  if (task.risk !== undefined) enumOf(task.risk, RISK_SET, 'task.risk');
  if (task.sourceContext !== undefined) text(task.sourceContext, 'task.sourceContext');
  if (task.recommendedNextAction !== undefined) text(task.recommendedNextAction, 'task.recommendedNextAction');
  if (task.moduleId !== undefined) text(task.moduleId, 'task.moduleId', { max: 80 });
  if (task.class !== undefined) enumOf(task.class, new Set(TASK_CLASSES), 'task.class');
  if ((task.enablesTaskIds?.length ?? 0) > 0 && !['wrapper', 'infrastructure'].includes(task.class)) {
    fail('task.enablesTaskIds is allowed only for wrapper or infrastructure tasks');
  }
  if (task.createdAt !== undefined) timestamp(task.createdAt, 'task.createdAt');
  const ownership = taskOwnershipClaims(task);
  if (!ownership.ok) fail(ownership.reason);
}

function validateAttempt(attempt) {
  exact(attempt, ['attemptId', 'taskId', 'ordinal', 'owner', 'ownerRunId', 'approachId', 'hypothesisId', 'approachSummary'],
    ['attemptId', 'taskId', 'ordinal', 'owner', 'approachId', 'hypothesisId', 'approachSummary'], 'attempt');
  id(attempt.attemptId, 'attempt.attemptId');
  id(attempt.taskId, 'attempt.taskId');
  if (!Number.isSafeInteger(attempt.ordinal) || attempt.ordinal < 1) fail('attempt.ordinal must be a positive integer');
  id(attempt.owner, 'attempt.owner');
  if (attempt.ownerRunId !== undefined) id(attempt.ownerRunId, 'attempt.ownerRunId');
  id(attempt.approachId, 'attempt.approachId');
  id(attempt.hypothesisId, 'attempt.hypothesisId');
  text(attempt.approachSummary, 'attempt.approachSummary');
}

function validateEvidence(evidence) {
  exact(evidence, [
    'evidenceId', 'kind', 'source', 'expected', 'actual', 'observedAt', 'actor', 'verifier',
    'method', 'outcome', 'criterionIds', 'taskId', 'commit', 'worktree', 'sourceRefs',
    'freshnessPolicy', 'limitations', 'authorizing',
  ], [
    'evidenceId', 'kind', 'source', 'expected', 'actual', 'observedAt', 'actor', 'method',
    'outcome', 'criterionIds', 'authorizing',
  ], 'evidence');
  id(evidence.evidenceId, 'evidence.evidenceId');
  enumOf(evidence.kind, EVIDENCE_KIND_SET, 'evidence.kind');
  text(evidence.source, 'evidence.source');
  text(evidence.expected, 'evidence.expected');
  text(evidence.actual, 'evidence.actual');
  timestamp(evidence.observedAt, 'evidence.observedAt');
  actor(evidence.actor, 'evidence.actor');
  if (evidence.verifier !== undefined) actor(evidence.verifier, 'evidence.verifier');
  text(evidence.method, 'evidence.method');
  enumOf(evidence.outcome, new Set(['passed', 'failed', 'inconclusive', 'observed']), 'evidence.outcome');
  uniqueIds(evidence.criterionIds, 'evidence.criterionIds');
  if (evidence.taskId !== undefined) id(evidence.taskId, 'evidence.taskId');
  if (evidence.commit !== undefined && evidence.commit !== 'unavailable' && !GIT_ID.test(evidence.commit)) {
    fail('evidence.commit is invalid');
  }
  if (evidence.worktree !== undefined) text(evidence.worktree, 'evidence.worktree', { max: 80 });
  if (evidence.sourceRefs !== undefined) {
    if (!Array.isArray(evidence.sourceRefs) || evidence.sourceRefs.length > MAX_ITEMS) fail('evidence.sourceRefs is invalid');
  }
  if (evidence.freshnessPolicy !== undefined) object(evidence.freshnessPolicy, 'evidence.freshnessPolicy');
  if (evidence.limitations !== undefined) {
    if (!Array.isArray(evidence.limitations)) fail('evidence.limitations must be an array');
    evidence.limitations.forEach((item, index) => text(item, `evidence.limitations[${index}]`));
  }
  if (typeof evidence.authorizing !== 'boolean') fail('evidence.authorizing must be boolean');
  if (evidence.authorizing === true
    && (!AUTHORIZING_EVIDENCE_KIND_SET.has(evidence.kind) || evidence.outcome !== 'passed')) {
    fail('authorizing evidence kind must be a passed command or test');
  }
  if (evidence.kind === 'graphify_receipt' && evidence.authorizing !== false) {
    fail('Graphify evidence cannot be authorizing');
  }
}

function validateResult(result) {
  exact(result, [
    'resultId', 'goalId', 'criterionIds', 'taskId', 'attemptId', 'actor',
    'expected', 'actual', 'execution', 'verification', 'acceptance',
    'evidenceIds', 'verificationMethod', 'verifiedAt', 'context',
    'failureId', 'blockerReason', 'impact', 'lessonId', 'nextActionId',
    'relatedEntityIds', 'derivedFromEventIds',
  ], [
    'resultId', 'goalId', 'criterionIds', 'taskId', 'attemptId', 'actor',
    'expected', 'actual', 'execution', 'verification', 'acceptance',
    'evidenceIds', 'verificationMethod',
  ], 'result');
  id(result.resultId, 'result.resultId');
  id(result.goalId, 'result.goalId');
  uniqueIds(result.criterionIds, 'result.criterionIds', { min: 1 });
  id(result.taskId, 'result.taskId');
  id(result.attemptId, 'result.attemptId');
  actor(result.actor, 'result.actor');
  text(result.expected, 'result.expected');
  text(result.actual, 'result.actual');
  enumOf(result.execution, EXECUTION_SET, 'result.execution');
  enumOf(result.verification, VERIFICATION_SET, 'result.verification');
  enumOf(result.acceptance, ACCEPTANCE_SET, 'result.acceptance');
  uniqueIds(result.evidenceIds, 'result.evidenceIds');
  text(result.verificationMethod, 'result.verificationMethod');
  if (result.verifiedAt !== undefined) timestamp(result.verifiedAt, 'result.verifiedAt');
  if (result.context !== undefined) object(result.context, 'result.context');
  if (result.failureId !== undefined) id(result.failureId, 'result.failureId');
  if (result.blockerReason !== undefined) text(result.blockerReason, 'result.blockerReason');
  if (result.impact !== undefined) text(result.impact, 'result.impact');
  if (result.lessonId !== undefined) id(result.lessonId, 'result.lessonId');
  if (result.nextActionId !== undefined) id(result.nextActionId, 'result.nextActionId');
  optionalIds(result.relatedEntityIds, 'result.relatedEntityIds');
  optionalIds(result.derivedFromEventIds, 'result.derivedFromEventIds');
  if (result.acceptance !== 'pending') fail('result.acceptance may only become non-pending through user feedback');
}

function validateFailure(failure) {
  exact(failure, [
    'failureId', 'subject', 'attemptId', 'owner', 'terminal', 'approachId', 'hypothesisId',
    'symptom', 'impact', 'unchanged', 'rootCause', 'evidenceIds', 'lessonId', 'nextActionId',
  ], [
    'failureId', 'subject', 'terminal', 'symptom', 'impact', 'unchanged', 'rootCause', 'evidenceIds',
  ], 'failure');
  id(failure.failureId, 'failure.failureId');
  subject(failure.subject, 'failure.subject');
  if (failure.attemptId !== undefined) id(failure.attemptId, 'failure.attemptId');
  if (failure.owner !== undefined) id(failure.owner, 'failure.owner');
  enumOf(failure.terminal, new Set(['failed', 'blocked', 'abandoned', 'inconclusive']), 'failure.terminal');
  text(failure.symptom, 'failure.symptom');
  text(failure.impact, 'failure.impact');
  if (!Array.isArray(failure.unchanged) || failure.unchanged.length < 1) fail('failure.unchanged is required');
  failure.unchanged.forEach((item, index) => text(item, `failure.unchanged[${index}]`));
  exact(failure.rootCause, ['state', 'summary'], ['state', 'summary'], 'failure.rootCause');
  enumOf(failure.rootCause.state, new Set(['confirmed', 'hypothesis', 'unknown']), 'failure.rootCause.state');
  text(failure.rootCause.summary, 'failure.rootCause.summary');
  uniqueIds(failure.evidenceIds, 'failure.evidenceIds');
  if (failure.lessonId === undefined && failure.nextActionId === undefined) {
    fail('failure requires lessonId or nextActionId');
  }
}

function validateNextAction(nextAction) {
  exact(nextAction, [
    'nextActionId', 'goalId', 'criterionIds', 'taskId', 'attemptId', 'actor', 'ownerActor',
    'action', 'rationale', 'expectedOutcome', 'verificationMethod', 'execution',
    'sourceFailureIds', 'sourceFeedbackIds', 'sourceLessonIds', 'evidenceIds',
    'relatedEntityIds', 'derivedFromEventIds',
  ], [
    'nextActionId', 'goalId', 'criterionIds', 'actor', 'ownerActor',
    'action', 'rationale', 'expectedOutcome', 'verificationMethod', 'execution',
  ], 'nextAction');
  id(nextAction.nextActionId, 'nextAction.nextActionId');
  id(nextAction.goalId, 'nextAction.goalId');
  uniqueIds(nextAction.criterionIds, 'nextAction.criterionIds');
  actor(nextAction.actor, 'nextAction.actor');
  actor(nextAction.ownerActor, 'nextAction.ownerActor');
  text(nextAction.action, 'nextAction.action');
  text(nextAction.rationale, 'nextAction.rationale');
  text(nextAction.expectedOutcome, 'nextAction.expectedOutcome');
  text(nextAction.verificationMethod, 'nextAction.verificationMethod');
  enumOf(nextAction.execution, EXECUTION_SET, 'nextAction.execution');
  optionalIds(nextAction.sourceFailureIds, 'nextAction.sourceFailureIds');
  optionalIds(nextAction.sourceFeedbackIds, 'nextAction.sourceFeedbackIds');
  optionalIds(nextAction.sourceLessonIds, 'nextAction.sourceLessonIds');
  optionalIds(nextAction.evidenceIds, 'nextAction.evidenceIds');
}

function validateFeedback(feedback) {
  exact(feedback, [
    'feedbackId', 'subjectId', 'disposition', 'acceptance', 'statement', 'evidenceId',
    'lessonId', 'nextActionId',
  ], ['feedbackId', 'subjectId', 'disposition', 'acceptance', 'statement', 'evidenceId'], 'feedback');
  id(feedback.feedbackId, 'feedback.feedbackId');
  id(feedback.subjectId, 'feedback.subjectId');
  enumOf(feedback.disposition, new Set(['satisfied', 'dissatisfied', 'rejected', 'correction']), 'feedback.disposition');
  enumOf(feedback.acceptance, ACCEPTANCE_SET, 'feedback.acceptance');
  text(feedback.statement, 'feedback.statement');
  id(feedback.evidenceId, 'feedback.evidenceId');
  if (feedback.acceptance !== 'pending' && feedback.disposition === 'satisfied' && feedback.acceptance !== 'accepted') {
    fail('satisfied feedback must accept or stay pending');
  }
  if ((feedback.disposition === 'rejected' || feedback.disposition === 'dissatisfied')
    && feedback.lessonId === undefined && feedback.nextActionId === undefined) {
    fail('negative feedback requires a lesson or next action');
  }
}

export function emptyProjectStateV3() {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectionVersion: PROJECTION_VERSION,
    generatedFrom: null,
    projectedAt: null,
    project: null,
    finalGoalId: null,
    goals: [],
    criteria: [],
    tasks: [],
    attempts: [],
    results: [],
    evidence: [],
    failures: [],
    feedback: [],
    decisions: [],
    claims: [],
    conflicts: [],
    lessons: [],
    nextActions: [],
    handoffs: [],
    packages: [],
    attemptReports: [],
    verificationReports: [],
    assignments: [],
    agents: [],
    backlogItems: [],
    contextHandoffs: [],
    migrationReceipts: [],
    graphifyReceipts: [],
    workspaceAtLastEvent: null,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function applyEvent(state, event) {
  const payload = event.payload;
  switch (event.eventType) {
    case 'project.initialized':
      state.project = clone(payload.project);
      break;
    case 'goal.declared': {
      const goal = {
        ...clone(payload.goal),
        execution: 'planned',
        verification: 'unverified',
        acceptance: 'pending',
        derivedFromEventIds: [event.eventId],
      };
      state.goals.push(goal);
      if (goal.isFinal) state.finalGoalId = goal.goalId;
      break;
    }
    case 'criterion.declared':
      state.criteria.push({
        ...clone(payload.criterion),
        verification: 'unverified',
        derivedFromEventIds: [event.eventId],
      });
      break;
    case 'task.planned': {
      const ownership = taskOwnershipClaims(payload.task);
      if (!ownership.ok) fail(ownership.reason);
      state.tasks.push({
        ...clone(payload.task),
        execution: 'planned',
        verification: 'unverified',
        acceptance: payload.task.userFacing ? 'pending' : 'pending',
        attemptIds: [],
        resultIds: [],
        failureIds: [],
        dependencyIds: [...(payload.task.dependencyIds ?? [])],
        capabilities: [...(payload.task.requiredCapabilities ?? payload.task.capabilities ?? [])],
        requiredCapabilities: [...(payload.task.requiredCapabilities ?? payload.task.capabilities ?? [])],
        pathOwnership: [...ownership.claims],
        ownershipScope: [...ownership.claims],
        priority: payload.task.priority ?? 'core',
        size: payload.task.size ?? 'M',
        complexity: payload.task.complexity ?? 'unknown',
        risk: payload.task.risk ?? 'routine',
        class: payload.task.class ?? 'unclassified',
        enablesTaskIds: [...(payload.task.enablesTaskIds ?? [])],
        createdAt: payload.task.createdAt ?? event.occurredAt,
        derivedFromEventIds: [event.eventId],
      });
      break;
    }
    case 'task.status_changed': {
      const task = requireEntity(state, 'tasks', 'taskId', event.subject.id, 'task');
      enumOf(payload.execution, EXECUTION_SET, 'task.execution');
      if (payload.execution === 'succeeded') fail('task success is recorded through a Result, not a raw status change');
      task.execution = payload.execution;
      task.derivedFromEventIds = [...task.derivedFromEventIds, event.eventId].slice(-MAX_ITEMS);
      break;
    }
    case 'attempt.started': {
      const attempt = {
        ...clone(payload.attempt),
        ...(event.actor.runId ? { ownerRunId: event.actor.runId } : {}),
        execution: 'in_progress',
        derivedFromEventIds: [event.eventId],
      };
      state.attempts.push(attempt);
      const task = requireEntity(state, 'tasks', 'taskId', attempt.taskId, 'task');
      task.currentAttemptId = attempt.attemptId;
      task.attemptIds.push(attempt.attemptId);
      task.execution = 'in_progress';
      break;
    }
    case 'attempt.finished': {
      const attempt = requireEntity(state, 'attempts', 'attemptId', payload.attemptId, 'attempt');
      enumOf(payload.execution, EXECUTION_SET, 'attempt.execution');
      attempt.execution = payload.execution;
      attempt.summary = payload.summary;
      break;
    }
    case 'evidence.recorded':
      state.evidence.push({ ...clone(payload.evidence), derivedFromEventIds: [event.eventId] });
      break;
    case 'result.recorded': {
      const result = { ...clone(payload.result), derivedFromEventIds: [event.eventId] };
      state.results.push(result);
      const task = requireEntity(state, 'tasks', 'taskId', result.taskId, 'task');
      task.resultIds.push(result.resultId);
      task.execution = result.execution;
      task.verification = result.verification;
      break;
    }
    case 'failure.recorded': {
      const failure = { ...clone(payload.failure), derivedFromEventIds: [event.eventId] };
      state.failures.push(failure);
      if (failure.subject.type === 'task') {
        const task = requireEntity(state, 'tasks', 'taskId', failure.subject.id, 'task');
        task.failureIds.push(failure.failureId);
        task.execution = failure.terminal === 'blocked' ? 'blocked' : 'failed';
      }
      break;
    }
    case 'lesson.recorded':
      state.lessons.push({ ...clone(payload.lesson), derivedFromEventIds: [event.eventId] });
      break;
    case 'next_action.recorded':
      state.nextActions.push({ ...clone(payload.nextAction), derivedFromEventIds: [event.eventId] });
      break;
    case 'feedback.recorded': {
      const feedback = { ...clone(payload.feedback), derivedFromEventIds: [event.eventId] };
      state.feedback.push(feedback);
      const result = find(state, 'results', 'resultId', feedback.subjectId);
      if (result && feedback.acceptance !== 'pending') result.acceptance = feedback.acceptance;
      break;
    }
    case 'decision.recorded':
      state.decisions.push({ ...clone(payload.decision), derivedFromEventIds: [event.eventId] });
      break;
    case 'handoff.created':
      state.handoffs.push({ ...clone(payload.handoff), state: 'assigned', derivedFromEventIds: [event.eventId] });
      break;
    case 'handoff.reported': {
      const handoff = requireEntity(state, 'handoffs', 'handoffId', payload.handoffId, 'handoff');
      handoff.state = 'reported';
      handoff.report = clone(payload.report);
      break;
    }
    case 'claim.asserted':
      state.claims.push({ ...clone(payload.claim), lifecycle: 'active', derivedFromEventIds: [event.eventId] });
      break;
    case 'conflict.recorded':
      state.conflicts.push({ ...clone(payload.conflict), state: 'open', derivedFromEventIds: [event.eventId] });
      break;
    case 'migration.receipt_recorded':
      state.migrationReceipts.push({ ...clone(payload.receipt), derivedFromEventIds: [event.eventId] });
      break;
    case 'graphify.receipt_recorded':
      state.graphifyReceipts.push({
        ...clone(payload.receipt),
        orientationOnly: true,
        authorizesTruth: false,
        derivedFromEventIds: [event.eventId],
      });
      break;
    case 'work_package.recorded': {
      const tasks = payload.packet.taskIds
        .map((taskId) => requireEntity(state, 'tasks', 'taskId', taskId, 'task'));
      const policy = persistedPacketPolicy(payload.packet, tasks);
      if (!policy.ok) fail(policy.reason);
      state.packages.push({
        ...clone(payload.packet),
        ...policy.normalized,
        derivedFromEventIds: [event.eventId],
      });
      break;
    }
    case 'assignment.recorded': {
      const taskRecords = payload.assignment.taskIds
        .map((taskId) => requireEntity(state, 'tasks', 'taskId', taskId, 'task'));
      const packet = requireEntity(state, 'packages', 'packetId', payload.assignment.packetId, 'packet');
      const policy = persistedAssignmentPolicy({
        assignment: payload.assignment,
        packet,
        tasks: taskRecords,
        agents: state.agents ?? [],
        held: state.assignments ?? [],
      });
      if (!policy.ok) fail(policy.reason);
      const assignment = {
        ...clone(payload.assignment),
        pathOwnership: [...policy.normalized.pathOwnership],
        state: 'held',
        generation: payload.assignment.generation ?? event.sequence,
        derivedFromEventIds: [event.eventId],
      };
      state.assignments.push(assignment);
      for (const taskId of assignment.taskIds) {
        const task = requireEntity(state, 'tasks', 'taskId', taskId, 'task');
        task.assignmentId = assignment.assignmentId;
        task.assignmentGeneration = assignment.generation;
        task.owner = assignment.actorId;
      }
      break;
    }
    case 'assignment.released': {
      const assignment = requireEntity(state, 'assignments', 'assignmentId', payload.assignmentId, 'assignment');
      assignment.state = 'released';
      assignment.releaseReason = payload.reason;
      assignment.derivedFromEventIds = [...assignment.derivedFromEventIds, event.eventId].slice(-MAX_ITEMS);
      for (const taskId of assignment.taskIds) {
        const task = find(state, 'tasks', 'taskId', taskId);
        if (task?.assignmentId === assignment.assignmentId) {
          task.assignmentId = null;
          task.assignmentGeneration = null;
        }
      }
      break;
    }
    case 'attempt.reported':
      state.attemptReports.push({ ...clone(payload.report), derivedFromEventIds: [event.eventId] });
      break;
    case 'verification.recorded': {
      const report = { ...clone(payload.report), derivedFromEventIds: [event.eventId] };
      state.verificationReports.push(report);
      const result = find(state, 'results', 'resultId', report.resultId);
      if (result) {
        result.verification = report.outcome === 'passed' ? 'passed' : report.outcome === 'failed' ? 'failed' : 'inconclusive';
        result.verifiedAt = report.verifiedAt;
        const task = find(state, 'tasks', 'taskId', result.taskId);
        if (task) task.verification = result.verification;
      }
      break;
    }
    case 'context_handoff.recorded': {
      const handoff = { ...clone(payload.handoff), derivedFromEventIds: [event.eventId] };
      state.contextHandoffs.push(handoff);
      const assignment = find(state, 'assignments', 'assignmentId', handoff.assignmentId);
      if (assignment) assignment.state = 'handed_off';
      const task = find(state, 'tasks', 'taskId', handoff.taskId);
      if (task && task.execution === 'in_progress') task.execution = 'partial';
      break;
    }
    case 'backlog.parked': {
      const task = requireEntity(state, 'tasks', 'taskId', payload.taskId, 'task');
      task.priority = 'backlog';
      state.backlogItems.push({
        taskId: payload.taskId,
        source: payload.source,
        actorId: event.actor.id,
        reason: payload.reason,
        expectedBenefit: payload.expectedBenefit,
        criterionIds: [...(payload.criterionIds ?? task.criterionIds)],
        revisitWhen: payload.revisitWhen,
        dependencies: [...(payload.dependencies ?? task.dependencyIds ?? [])],
        freshness: payload.freshness ?? 'unknown',
        derivedFromEventIds: [event.eventId],
      });
      break;
    }
    case 'agent.registered': {
      const policy = normalizePersistedAgent(payload.agent);
      if (!policy.ok) fail(policy.reason);
      state.agents.push(clone(policy.normalized));
      break;
    }
    default:
      fail(`${event.eventType} is not implemented in the MVP reducer`);
  }
  state.workspaceAtLastEvent = event.workspaceAtRecord;
  state.generatedFrom = event.eventHash;
  state.projectedAt = event.recordedAt;
}

const REQUIRED_COVERAGE_MUTATIONS = new Set([
  'task.planned', 'task.status_changed', 'result.recorded', 'failure.recorded', 'backlog.parked',
]);

function validateProspectiveRequiredCoverage(draft, state, workspaceAtRecord) {
  if (!REQUIRED_COVERAGE_MUTATIONS.has(draft.eventType)) return;
  const prospective = clone(state);
  applyEvent(prospective, {
    ...draft,
    eventId: 'event-prospective-required-coverage',
    recordedAt: draft.occurredAt,
    workspaceAtRecord: workspaceAtRecord ?? state.workspaceAtLastEvent ?? {},
  });
  if (requiredCriterionBacklogViolations(
    prospective,
    workspaceAtRecord ?? state.workspaceAtLastEvent ?? {},
  ).length) {
    fail('required-criterion-cannot-hide-in-backlog');
  }
}

export function validateDraftV3(draft, state = emptyProjectStateV3(), context = {}) {
  if (!isBrandedV3(draft) && (draft === null || typeof draft !== 'object')) fail('v3 draft must be a branded snapshot');
  exact(draft, [
    'eventType', 'occurredAt', 'actor', 'subject', 'goalId', 'taskId',
    'supersedes', 'contradicts', 'evidenceRefs', 'sensitivity', 'payload', 'riskClass',
  ], ['eventType', 'occurredAt', 'actor', 'subject', 'supersedes', 'contradicts', 'evidenceRefs', 'sensitivity', 'payload'], 'draft');
  if (!EVENT_SET.has(draft.eventType)) fail('eventType is not in the v3 registry');
  timestamp(draft.occurredAt, 'occurredAt');
  actor(draft.actor, 'actor');
  subject(draft.subject, 'subject');
  if (draft.goalId !== undefined) id(draft.goalId, 'goalId');
  if (draft.taskId !== undefined) id(draft.taskId, 'taskId');
  uniqueIds(draft.supersedes, 'supersedes');
  uniqueIds(draft.contradicts, 'contradicts');
  uniqueIds(draft.evidenceRefs, 'evidenceRefs');
  enumOf(draft.sensitivity, new Set(['public', 'internal', 'restricted']), 'sensitivity');
  object(draft.payload, 'payload');
  const computedRisk = classifyRisk(draft.eventType, draft.payload);
  if (draft.riskClass !== undefined) {
    enumOf(draft.riskClass, RISK_SET, 'riskClass');
    const rank = { routine: 0, significant: 1, critical: 2 };
    if (rank[draft.riskClass] < rank[computedRisk]) fail('risk class cannot be lowered by the caller');
  }
  if (computedRisk === 'critical' && ['accepted', 'rejected', 'needs_changes'].includes(draft.payload.feedback?.acceptance)
    && draft.actor.kind !== 'user') {
    fail('only the user may set acceptance');
  }
  if (draft.actor.kind === 'subagent' && (draft.eventType === 'result.recorded'
    && (draft.payload.result?.verification === 'passed' || draft.payload.result?.acceptance === 'accepted'))) {
    fail('a subagent cannot accept or independently verify its own work');
  }

  switch (draft.eventType) {
    case 'project.initialized':
      if (state.project) fail('project is already initialized');
      exact(draft.payload, ['project', 'initialization'], ['project', 'initialization'], 'payload');
      validateProject(draft.payload.project);
      enumOf(draft.payload.initialization, new Set(['new', 'migration']), 'initialization');
      break;
    case 'goal.declared':
      exact(draft.payload, ['goal'], ['goal'], 'payload');
      validateGoal(draft.payload.goal);
      if (draft.payload.goal.isFinal && draft.actor.kind !== 'user' && draft.actor.kind !== 'coordinator') {
        fail('final goal requires user or coordinator actor');
      }
      if (draft.payload.goal.isFinal && draft.actor.kind === 'coordinator' && draft.payload.goal.authority !== 'user') {
        fail('coordinator may record a user-backed final goal only');
      }
      break;
    case 'criterion.declared':
      exact(draft.payload, ['criterion'], ['criterion'], 'payload');
      validateCriterion(draft.payload.criterion);
      break;
    case 'task.planned':
      if (!state.finalGoalId) fail('a final goal is required before planning tasks');
      exact(draft.payload, ['task'], ['task'], 'payload');
      validateTask(draft.payload.task);
      requireEntity(state, 'goals', 'goalId', draft.payload.task.goalId, 'goal');
      for (const criterionId of draft.payload.task.criterionIds) {
        requireEntity(state, 'criteria', 'criterionId', criterionId, 'criterion');
      }
      break;
    case 'task.status_changed':
      exact(draft.payload, ['execution', 'reason'], ['execution'], 'payload');
      requireEntity(state, 'tasks', 'taskId', draft.subject.id, 'task');
      enumOf(draft.payload.execution, EXECUTION_SET, 'execution');
      if (draft.payload.execution === 'succeeded') fail('task success requires a Result with evidence');
      break;
    case 'attempt.started':
      exact(draft.payload, ['attempt'], ['attempt'], 'payload');
      validateAttempt(draft.payload.attempt);
      requireEntity(state, 'tasks', 'taskId', draft.payload.attempt.taskId, 'task');
      if (draft.payload.attempt.owner !== draft.actor.id) fail('Attempt owner must match the event actor');
      if (draft.payload.attempt.ownerRunId !== undefined
        && draft.payload.attempt.ownerRunId !== draft.actor.runId) {
        fail('Attempt owner run must match the event actor run');
      }
      break;
    case 'attempt.finished':
      exact(draft.payload, ['attemptId', 'execution', 'summary'], ['attemptId', 'execution', 'summary'], 'payload');
      requireEntity(state, 'attempts', 'attemptId', draft.payload.attemptId, 'attempt');
      enumOf(draft.payload.execution, EXECUTION_SET, 'execution');
      text(draft.payload.summary, 'summary');
      break;
    case 'evidence.recorded':
      exact(draft.payload, ['evidence'], ['evidence'], 'payload');
      validateEvidence(draft.payload.evidence);
      if (!sameActorIdentity(draft.actor, draft.payload.evidence.actor)) {
        fail('event actor must match the Evidence actor');
      }
      break;
    case 'result.recorded': {
      exact(draft.payload, ['result'], ['result'], 'payload');
      validateResult(draft.payload.result);
      const result = draft.payload.result;
      requireEntity(state, 'tasks', 'taskId', result.taskId, 'task');
      const attempt = requireEntity(state, 'attempts', 'attemptId', result.attemptId, 'attempt');
      requireEntity(state, 'goals', 'goalId', result.goalId, 'goal');
      if (attempt.taskId !== result.taskId) fail('Result task must match its Attempt task');
      if (result.actor.id !== attempt.owner) fail('Result actor must match the Attempt owner');
      if (attempt.ownerRunId && result.actor.runId !== attempt.ownerRunId) {
        fail('Result actor run must match the Attempt owner run');
      }
      if (!sameActorIdentity(draft.actor, result.actor)) fail('event actor must match the Result actor');
      if (result.verification === 'passed') {
        fail('verification=passed requires verification.recorded with VerificationReport counts');
      }
      if (result.execution === 'succeeded') {
        if (result.evidenceIds.length < 1) fail('succeeded requires authorizing evidence');
        authorizingEvidence(state, result.evidenceIds, {
          ownerRunId: result.verification === 'passed' ? result.actor.runId : undefined,
          ownerActorId: result.verification === 'passed' ? result.actor.id : undefined,
          taskId: result.taskId,
          criterionIds: result.criterionIds,
        });
      }
      if (result.verification === 'passed') {
        if (result.evidenceIds.length < 1) fail('verification=passed requires authorizing evidence');
        authorizingEvidence(state, result.evidenceIds, {
          ownerRunId: result.actor.runId,
          ownerActorId: result.actor.id,
          taskId: result.taskId,
          criterionIds: result.criterionIds,
        });
      }
      break;
    }
    case 'failure.recorded':
      exact(draft.payload, ['failure'], ['failure'], 'payload');
      validateFailure(draft.payload.failure);
      if (draft.payload.failure.nextActionId) {
        requireEntity(state, 'nextActions', 'nextActionId', draft.payload.failure.nextActionId, 'nextAction');
      }
      break;
    case 'lesson.recorded':
      exact(draft.payload, ['lesson'], ['lesson'], 'payload');
      object(draft.payload.lesson, 'lesson');
      id(draft.payload.lesson.lessonId, 'lesson.lessonId');
      text(draft.payload.lesson.summary, 'lesson.summary');
      break;
    case 'next_action.recorded':
      exact(draft.payload, ['nextAction'], ['nextAction'], 'payload');
      validateNextAction(draft.payload.nextAction);
      if ((draft.payload.nextAction.sourceFailureIds?.length ?? 0)
        + (draft.payload.nextAction.sourceFeedbackIds?.length ?? 0)
        + (draft.payload.nextAction.sourceLessonIds?.length ?? 0) < 1) {
        fail('nextAction requires a source failure, feedback, or lesson');
      }
      break;
    case 'feedback.recorded':
      exact(draft.payload, ['feedback'], ['feedback'], 'payload');
      validateFeedback(draft.payload.feedback);
      if (draft.payload.feedback.acceptance !== 'pending' && draft.actor.kind !== 'user') {
        fail('only the user may set acceptance');
      }
      break;
    case 'decision.recorded':
      exact(draft.payload, ['decision'], ['decision'], 'payload');
      object(draft.payload.decision, 'decision');
      id(draft.payload.decision.decisionId, 'decision.decisionId');
      text(draft.payload.decision.choice, 'decision.choice');
      text(draft.payload.decision.rationale, 'decision.rationale');
      break;
    case 'handoff.created':
      exact(draft.payload, ['handoff'], ['handoff'], 'payload');
      object(draft.payload.handoff, 'handoff');
      id(draft.payload.handoff.handoffId, 'handoff.handoffId');
      id(draft.payload.handoff.taskId, 'handoff.taskId');
      requireEntity(state, 'tasks', 'taskId', draft.payload.handoff.taskId, 'task');
      break;
    case 'handoff.reported':
      exact(draft.payload, ['handoffId', 'report'], ['handoffId', 'report'], 'payload');
      requireEntity(state, 'handoffs', 'handoffId', draft.payload.handoffId, 'handoff');
      break;
    case 'work_package.recorded': {
      exact(draft.payload, ['packet'], ['packet'], 'payload');
      const packet = draft.payload.packet;
      object(packet, 'packet');
      id(packet.packetId, 'packet.packetId');
      uniqueIds(packet.taskIds, 'packet.taskIds', { min: 1 });
      if (packet.taskIds.length > 4) fail('work packet exceeds the small-task batch limit');
      const tasks = [];
      for (const taskId of packet.taskIds) {
        const task = requireEntity(state, 'tasks', 'taskId', taskId, 'task');
        tasks.push(task);
      }
      const policy = persistedPacketPolicy(packet, tasks);
      if (!policy.ok) fail(policy.reason);
      if (packet.weight !== undefined && (!Number.isSafeInteger(packet.weight) || packet.weight < 1)) {
        fail('packet.weight is invalid');
      }
      break;
    }
    case 'assignment.recorded': {
      exact(draft.payload, ['assignment'], ['assignment'], 'payload');
      const assignment = draft.payload.assignment;
      object(assignment, 'assignment');
      id(assignment.assignmentId, 'assignment.assignmentId');
      id(assignment.packetId, 'assignment.packetId');
      uniqueIds(assignment.taskIds, 'assignment.taskIds', { min: 1 });
      id(assignment.actorId, 'assignment.actorId');
      if (draft.actor.kind === 'user') fail('user actors are not assigned implementation packets');
      const tasks = assignment.taskIds.map((taskId) => (
        requireEntity(state, 'tasks', 'taskId', taskId, 'task')
      ));
      const packet = find(state, 'packages', 'packetId', assignment.packetId);
      const policy = persistedAssignmentPolicy({
        assignment,
        packet,
        tasks,
        agents: state.agents ?? [],
        held: state.assignments ?? [],
      });
      if (!policy.ok) fail(policy.reason);
      break;
    }
    case 'assignment.released': {
      exact(draft.payload, ['assignmentId', 'reason'], ['assignmentId', 'reason'], 'payload');
      const assignment = requireEntity(state, 'assignments', 'assignmentId', draft.payload.assignmentId, 'assignment');
      if (assignment.state !== 'held') fail('stale assignment');
      text(draft.payload.reason, 'reason');
      break;
    }
    case 'attempt.reported': {
      exact(draft.payload, ['report'], ['report'], 'payload');
      object(draft.payload.report, 'report');
      id(draft.payload.report.attemptId, 'report.attemptId');
      requireEntity(state, 'attempts', 'attemptId', draft.payload.report.attemptId, 'attempt');
      enumOf(draft.payload.report.execution, EXECUTION_SET, 'report.execution');
      text(draft.payload.report.summary, 'report.summary');
      if (draft.payload.report.authorizing === true) fail('executor words are not evidence');
      break;
    }
    case 'verification.recorded': {
      exact(draft.payload, ['report'], ['report'], 'payload');
      const report = draft.payload.report;
      object(report, 'report');
      id(report.verificationId, 'report.verificationId');
      id(report.resultId, 'report.resultId');
      const result = requireEntity(state, 'results', 'resultId', report.resultId, 'result');
      const attempt = requireEntity(state, 'attempts', 'attemptId', result.attemptId, 'attempt');
      const task = requireEntity(state, 'tasks', 'taskId', result.taskId, 'task');
      actor(report.verifier, 'report.verifier');
      if (!sameActorIdentity(draft.actor, report.verifier)) fail('event actor must match the report verifier');
      if (attempt.taskId !== result.taskId) fail('Verification Result must match its Attempt task');
      if (report.verifier.id === result.actor.id || report.verifier.id === attempt.owner) {
        fail('a subagent cannot independently verify its own work');
      }
      const executorRunIds = new Set([result.actor.runId, attempt.ownerRunId].filter(Boolean));
      if (report.verifier.runId && executorRunIds.has(report.verifier.runId)) {
        fail('verifier run must differ from the executor run');
      }
      const registeredVerifier = (state.agents ?? []).find((item) => item.actorId === report.verifier.id);
      if (!registeredVerifier) fail('verification requires a registered verifier');
      if (!persistedAgentSatisfies(
        registeredVerifier,
        task.requiredCapabilities ?? task.capabilities ?? [],
        { risk: task.risk ?? 'routine' },
      )) {
        fail('registered verifier has insufficient capability for the task risk');
      }
      enumOf(report.outcome, new Set(['passed', 'failed', 'inconclusive']), 'report.outcome');
      exact(report.counts ?? {}, ['found', 'executed', 'passed', 'failed', 'skipped'],
        ['found', 'executed', 'passed', 'failed'], 'report.counts');
      const counts = report.counts ?? {};
      for (const key of ['found', 'executed', 'passed', 'failed', 'skipped']) {
        if (counts[key] !== undefined && (!Number.isSafeInteger(counts[key]) || counts[key] < 0)) {
          fail(`report.counts.${key} is invalid`);
        }
      }
      if (report.outcome === 'passed' && ((counts.found ?? 0) < 1 || (counts.executed ?? 0) < 1)) {
        fail('empty test set is not success');
      }
      if (report.outcome === 'passed' && (counts.failed !== 0 || counts.passed < 1)) {
        fail('passed verification requires passed counts and no failures');
      }
      text(report.method, 'report.method');
      text(report.expected, 'report.expected');
      text(report.actual, 'report.actual');
      break;
    }
    case 'context_handoff.recorded': {
      exact(draft.payload, ['handoff'], ['handoff'], 'payload');
      const handoff = draft.payload.handoff;
      object(handoff, 'handoff');
      id(handoff.handoffId, 'handoff.handoffId');
      id(handoff.taskId, 'handoff.taskId');
      requireEntity(state, 'tasks', 'taskId', handoff.taskId, 'task');
      text(handoff.lastCompletedStep, 'handoff.lastCompletedStep');
      text(handoff.actualState, 'handoff.actualState');
      text(handoff.nextStep, 'handoff.nextStep');
      optionalIds(handoff.evidenceIds, 'handoff.evidenceIds');
      if (Array.isArray(handoff.changedPaths)) {
        handoff.changedPaths.forEach((pathValue, index) => {
          text(pathValue, `handoff.changedPaths[${index}]`, { max: 200 });
          if (pathValue.startsWith('/') || pathValue.includes(':') || pathValue.includes('..')) {
            fail('context handoff must not store private absolute paths');
          }
        });
      }
      if (handoff.diff || handoff.rawDiff || handoff.logs) fail('context handoff must not store raw diffs or unbounded logs');
      break;
    }
    case 'backlog.parked': {
      exact(draft.payload, ['taskId', 'reason', 'source', 'expectedBenefit', 'revisitWhen', 'criterionIds', 'dependencies', 'freshness'],
        ['taskId', 'reason', 'source', 'expectedBenefit', 'revisitWhen'], 'payload');
      const task = requireEntity(state, 'tasks', 'taskId', draft.payload.taskId, 'task');
      text(draft.payload.reason, 'reason');
      text(draft.payload.source, 'source');
      break;
    }
    case 'agent.registered': {
      exact(draft.payload, ['agent'], ['agent'], 'payload');
      const agent = draft.payload.agent;
      const policy = normalizePersistedAgent(agent);
      if (!policy.ok) fail(policy.reason);
      if (draft.subject.id !== policy.normalized.actorId) fail('agent subject must match agent.actorId');
      if ((state.agents ?? []).some((item) => item.actorId === policy.normalized.actorId)) {
        fail('agent is already registered');
      }
      break;
    }
    default:
      fail(`${draft.eventType} is not part of the MVP write set`);
  }
  validateProspectiveRequiredCoverage(draft, state, context.workspaceAtRecord);
  return draft;
}

export function buildEnvelopeV3(draft, {
  epochId, sequence, recordedAt, workspaceAtRecord, previousEventHash, state,
}) {
  validateDraftV3(draft, state ?? emptyProjectStateV3(), { workspaceAtRecord });
  id(epochId, 'epochId');
  if (!Number.isSafeInteger(sequence) || sequence < 1) fail('sequence must be a positive integer');
  timestamp(recordedAt, 'recordedAt');
  workspace(workspaceAtRecord, 'workspaceAtRecord');
  hash(previousEventHash, 'previousEventHash');
  const eventId = `event-${sha256(`${epochId}:${sequence}:${draft.eventType}:${draft.subject.id}`).slice(0, 24)}`;
  const riskClass = draft.riskClass && RISK_SET.has(draft.riskClass)
    ? (classifyRisk(draft.eventType, draft.payload) === 'critical' ? 'critical' : draft.riskClass)
    : classifyRisk(draft.eventType, draft.payload);
  const material = {
    schemaVersion: SCHEMA_VERSION,
    epochId,
    sequence,
    eventId,
    eventType: draft.eventType,
    recordedAt,
    occurredAt: draft.occurredAt,
    actor: draft.actor,
    subject: draft.subject,
    ...(draft.goalId ? { goalId: draft.goalId } : {}),
    ...(draft.taskId ? { taskId: draft.taskId } : {}),
    supersedes: draft.supersedes,
    contradicts: draft.contradicts,
    evidenceRefs: draft.evidenceRefs,
    sensitivity: draft.sensitivity,
    riskClass,
    payload: draft.payload,
    workspaceAtRecord,
    previousEventHash,
  };
  const eventHash = sha256(canonicalV3(material));
  return { ...material, eventHash };
}

export function validateEnvelopeV3(event, index, previousHash) {
  object(event, `event ${index + 1}`);
  if (event.schemaVersion !== SCHEMA_VERSION) fail(`history event ${index + 1} version mismatch`, 5);
  if (event.sequence !== index + 1) fail(`history event ${index + 1} sequence mismatch`, 3);
  hash(event.previousEventHash, 'previousEventHash');
  hash(event.eventHash, 'eventHash');
  if (event.previousEventHash !== previousHash) fail(`history event ${index + 1} hash-chain break`, 3);
  const { eventHash, ...material } = event;
  if (sha256(canonicalV3(material)) !== eventHash) fail(`history event ${index + 1} hash mismatch`, 3);
}

export function foldV3(events) {
  if (!Array.isArray(events)) fail('v3 journal must be an event array', 3);
  const state = emptyProjectStateV3();
  const seen = new Set();
  let previous = ZERO_HASH;
  events.forEach((event, index) => {
    validateEnvelopeV3(event, index, previous);
    if (seen.has(event.eventId)) fail('duplicate eventId', 3);
    seen.add(event.eventId);
    const draft = {
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      actor: event.actor,
      subject: event.subject,
      ...(event.goalId ? { goalId: event.goalId } : {}),
      ...(event.taskId ? { taskId: event.taskId } : {}),
      supersedes: event.supersedes,
      contradicts: event.contradicts,
      evidenceRefs: event.evidenceRefs,
      sensitivity: event.sensitivity,
      payload: event.payload,
      riskClass: event.riskClass,
    };
    validateDraftV3(draft, state, { workspaceAtRecord: event.workspaceAtRecord });
    applyEvent(state, event);
    previous = event.eventHash;
  });
  return state;
}

export function evaluateFreshness(live, evidence) {
  return persistedEvidenceFreshness(live, evidence);
}
