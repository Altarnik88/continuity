import { createHash } from 'node:crypto';

export const MAX_EVENT_BYTES = 64 * 1024;
export const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
export const MAX_STRING = 2_000;
export const MAX_ITEMS = 50;
export const ZERO_HASH = '0'.repeat(64);

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ID = /^[a-z][a-z0-9_]*-[a-z0-9][a-z0-9-]{1,72}$/;
const HASH = /^[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PREDICATE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*)+$/;
const MIGRATION_MODE = Symbol('migrationMode');
const MIGRATION_PROGRESS = Symbol('migrationProgress');
const EVENT_IDS = Symbol('eventIds');
const EVENT_META = Symbol('eventMeta');
const CLAIM_ASSERTORS = Symbol('claimAssertors');
const VALIDATED_DRAFT_SNAPSHOTS = new WeakSet();

export class MemoryError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = 'MemoryError';
    this.exitCode = exitCode;
  }
}

function snapshotCallerValue(value, label, exitCode = 2) {
  try {
    return structuredClone(value);
  } catch {
    throw new MemoryError(`${label} could not be snapshotted`, exitCode);
  }
}

function assertAcyclicSnapshot(value, label, ancestors = new Set(), visited = new Set()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return;
  if (ancestors.has(value)) throw new MemoryError(`${label} contains a cyclic value`);
  ancestors.add(value);
  for (const child of Object.values(value)) assertAcyclicSnapshot(child, label, ancestors, visited);
  ancestors.delete(value);
  visited.add(value);
}

function freezeSnapshot(value, visited = new WeakSet()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return value;
  visited.add(value);
  for (const child of Object.values(value)) freezeSnapshot(child, visited);
  return Object.freeze(value);
}

export const EVENT_TYPES = Object.freeze([
  'project.initialized',
  'goal.declared', 'goal.revised', 'goal.blocked', 'goal.reopened', 'goal.abandoned', 'goal.retired', 'goal.achieved',
  'criterion.declared', 'criterion.revised', 'criterion.waived_by_user', 'criterion.reactivated', 'criterion.retired',
  'task.planned', 'task.revised', 'task.started', 'task.implemented', 'task.blocked', 'task.failed', 'task.completed', 'task.abandoned', 'task.reopened',
  'attempt.started', 'attempt.reported',
  'claim.asserted', 'claim.verified', 'claim.disputed', 'claim.superseded', 'claim.retracted',
  'evidence.recorded', 'failure.recorded',
  'feedback.satisfied', 'feedback.dissatisfied', 'feedback.rejected', 'feedback.correction',
  'handoff.assigned', 'handoff.reported', 'handoff.accepted', 'handoff.rejected', 'handoff.cancelled',
  'lesson.recorded', 'decision.recorded', 'decision.revised',
  'migration.v1_imported', 'migration.v1_records_imported',
]);

const ACTOR_KINDS = new Set(['user', 'coordinator', 'subagent', 'tool', 'migration']);
const AUTHORITIES = new Set(['user', 'repository', 'tool', 'coordinator', 'subagent', 'migration']);
const BASES = new Set(['user_stated', 'source_observed', 'tool_observed', 'agent_reported', 'agent_inferred', 'legacy_unverified']);
const EVIDENCE_KINDS = new Set(['git_blob', 'file', 'command', 'test', 'browser_render', 'url', 'user_message', 'agent_report', 'graphify_receipt']);
const EVIDENCE_OUTCOMES = new Set(['passed', 'failed', 'inconclusive', 'observed']);
const SENSITIVITIES = new Set(['public', 'internal', 'restricted']);
const ATTEMPT_OUTCOMES = new Set(['succeeded', 'failed', 'blocked', 'inconclusive', 'abandoned']);
const ROOT_CAUSE_STATES = new Set(['confirmed', 'hypothesis', 'unknown']);
const FAILURE_TERMINALS = new Set(['failed', 'blocked', 'abandoned', 'inconclusive']);
const FEEDBACK_PAIRS = new Map([
  ['satisfied', new Set(['accept'])],
  ['dissatisfied', new Set(['keep_pending', 'reject'])],
  ['rejected', new Set(['reject'])],
]);
const EVIDENCE_POLICY_RULES = Object.freeze({
  immutable_until_superseded: Object.freeze({ requiresSources: false }),
  source_digest: Object.freeze({ requiresSources: true }),
  max_age: Object.freeze({ requiresSources: false }),
  not_applicable: Object.freeze({ requiresSources: false }),
});
const MUTABLE_EVIDENCE_KINDS = new Set(['browser_render', 'url']);
const AUTHORITY_VERIFIER_KINDS = Object.freeze({
  user: new Set(['user']), repository: new Set(['tool']), tool: new Set(['tool']),
  coordinator: new Set(['coordinator']), subagent: new Set(['subagent']), migration: new Set(['migration']),
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function unicodeCodePointLength(value) {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return null;
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      return null;
    }
    length += 1;
  }
  return length;
}

export function canonicalV2(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') { string(value, 'JCS string'); return JSON.stringify(value); }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new MemoryError('v2 canonical JSON permits safe integers only');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ITEMS) throw new MemoryError('JCS array exceeds the item limit');
    return `[${value.map(canonicalV2).join(',')}]`;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value);
    if (keys.length > MAX_ITEMS) throw new MemoryError('JCS object exceeds the property limit');
    for (const key of keys) string(key, 'JCS object key');
    return `{${keys.sort().map((key) => `${JSON.stringify(key)}:${canonicalV2(value[key])}`).join(',')}}`;
  }
  throw new MemoryError('value is not JCS-compatible JSON');
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new MemoryError(`${label} must be an object`);
  }
}

function exact(value, allowed, required, label) {
  assertObject(value, label);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) throw new MemoryError(`${label} contains unknown fields`);
  if (required.some((key) => !keys.includes(key))) throw new MemoryError(`${label} is missing required fields`);
}

function string(value, label, { max = MAX_STRING, pattern } = {}) {
  const length = typeof value === 'string' ? unicodeCodePointLength(value) : null;
  if (length === null || length < 1 || length > max
    || value !== value.trim() || value !== value.normalize('NFC')
    || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) || (pattern && !pattern.test(value))) {
    throw new MemoryError(`${label} must be a bounded single-line string`);
  }
}

function id(value, label) {
  string(value, label, { max: 80, pattern: ID });
}

function timestamp(value, label) {
  string(value, label, { max: 24 });
  if (!ISO_UTC.test(value) || new Date(value).toISOString() !== value) throw new MemoryError(`${label} must be strict ISO-8601 UTC`);
}

function array(value, label, check, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > MAX_ITEMS) throw new MemoryError(`${label} must be a bounded array`);
  value.forEach((item, index) => check(item, `${label}[${index}]`));
}

function uniqueIds(value, label, { min = 0 } = {}) {
  array(value, label, id, { min });
  if (new Set(value).size !== value.length) throw new MemoryError(`${label} must contain unique IDs`);
}

function enumValue(value, values, label) {
  if (!values.has(value)) throw new MemoryError(`${label} is not an allowed enum`);
}

function repoPath(value, label) {
  string(value, label, { max: 500 });
  const normalized = value.replaceAll('\\', '/');
  if (value !== normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new MemoryError(`${label} must be a canonical repository-relative path`);
  }
}

const SENSITIVE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/i,
  /\bwhsec_[A-Za-z0-9]{12,}\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bSK[0-9a-f]{32}\b/i,
  /\bSG\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/i,
  /\b(?:authorization|proxy-authorization)\s*[:=]\s*[^\s,;]+(?:\s+[^\s,;]+)?/i,
  /\b(?:cookie|set-cookie|session|session-id|sessionid)\s*[:=]\s*[^\s,;]+/i,
  /\b(?:password|passwd|secret|token|api[_-]?key|session[_-]?id|database_url|direct_url)\s*[:=]\s*[^\s,;{}\[\]]+/i,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/i,
  /(?:^|["'])\s*[A-Z][A-Z0-9_]{2,}\s*=\s*[^\s<][^"']*/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\+\d(?:[ ().-]*\d){9,14}/,
  /\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/,
  /\b(?:\d[ .()-]*){3}\d[ .()-]*\d{3}[ .()-]*\d{2}[ .()-]*\d{2}\b/,
  /https?:\/\/[^/\s:@]+:[^@\s/]+@/i,
  /\bdiff --git\b/i,
  /^@@\s+-\d/m,
  /\*\*\* (?:Begin|End) Patch/i,
  /^Index:\s+\S+/im,
  /(?:^|\s)(?:[A-Za-z]:[\\/]|\/(?:Users|home)\/)/i,
];

function scanSafe(value, key = '', pathParts = [], eventType = '') {
  const forbidden = new Set([
    'password', 'passwd', 'secret', 'token', 'accesstoken', 'refreshtoken', 'apikey',
    'cookie', 'setcookie', 'authorization', 'databaseurl', 'directurl', 'privatekey',
    'session', 'sessionid', 'stdout', 'stderr', 'commandoutput', 'logoutput', 'stacktrace',
    'rawdiff', 'patch', 'rawrows', 'rows', 'records', 'customeremail', 'customerphone',
    'customeraddress', 'email', 'phone', 'address', 'orderid', 'orderpayload',
  ]);
  const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const migrationRecords = normalizedKey === 'records' && eventType === 'migration.v1_records_imported' && pathParts.join('.') === 'payload.records';
  if (forbidden.has(normalizedKey) && !migrationRecords) throw new MemoryError('event rejected: sensitive or disallowed material detected');
  if (typeof value === 'string') {
    string(value, 'event string');
    if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(value))) throw new MemoryError('event rejected: sensitive or disallowed material detected');
  } else if (Array.isArray(value)) {
    if (value.length > MAX_ITEMS) throw new MemoryError('event contains an oversized array');
    value.forEach((item) => scanSafe(item, key, pathParts, eventType));
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([childKey, child]) => scanSafe(child, childKey, [...pathParts, childKey], eventType));
  } else if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new MemoryError('event numbers must be safe integers');
  }
}

function actor(value, label = 'actor') {
  exact(value, ['kind', 'id', 'role', 'runId', 'parentRunId'], ['kind', 'id', 'role'], label);
  enumValue(value.kind, ACTOR_KINDS, `${label}.kind`);
  id(value.id, `${label}.id`);
  string(value.role, `${label}.role`, { max: 120 });
  if (value.runId !== undefined) id(value.runId, `${label}.runId`);
  if (value.parentRunId !== undefined) id(value.parentRunId, `${label}.parentRunId`);
}

function subject(value, label = 'subject') {
  exact(value, ['type', 'id'], ['type', 'id'], label);
  string(value.type, `${label}.type`, { max: 40, pattern: /^[a-z][a-z0-9_]*$/ });
  id(value.id, `${label}.id`);
}

function sourceRef(value, label) {
  exact(value, ['path', 'purpose', 'contentSha256'], ['path', 'purpose', 'contentSha256'], label);
  repoPath(value.path, `${label}.path`);
  string(value.purpose, `${label}.purpose`);
  if (!HASH.test(value.contentSha256)) throw new MemoryError(`${label}.contentSha256 must be sha256`);
}

function workspace(value, label) {
  exact(value, ['head', 'branch', 'dirty', 'statusFingerprint', 'fingerprintPartial', 'capturedAt'], ['head', 'branch', 'dirty', 'statusFingerprint', 'fingerprintPartial', 'capturedAt'], label);
  if (!(value.head === 'unavailable' || GIT_OBJECT_ID.test(value.head))) throw new MemoryError(`${label}.head is invalid`);
  string(value.branch, `${label}.branch`, { max: 250 });
  if (typeof value.dirty !== 'boolean' || typeof value.fingerprintPartial !== 'boolean') throw new MemoryError(`${label} flags must be boolean`);
  if (!HASH.test(value.statusFingerprint)) throw new MemoryError(`${label}.statusFingerprint must be sha256`);
  timestamp(value.capturedAt, `${label}.capturedAt`);
}

function projectDef(value, label) {
  exact(value, ['projectId', 'name', 'identity', 'implementationBoundaries', 'operatingRules'], ['projectId', 'name', 'identity', 'implementationBoundaries', 'operatingRules'], label);
  id(value.projectId, `${label}.projectId`);
  string(value.name, `${label}.name`, { max: 120 });
  string(value.identity, `${label}.identity`);
  array(value.implementationBoundaries, `${label}.implementationBoundaries`, string);
  array(value.operatingRules, `${label}.operatingRules`, string);
}

function goalDef(value, label) {
  exact(value, ['goalId', 'title', 'outcome', 'isFinal', 'parentGoalId', 'authority', 'basis', 'criterionIds'], ['goalId', 'title', 'outcome', 'isFinal', 'authority', 'basis', 'criterionIds'], label);
  id(value.goalId, `${label}.goalId`); string(value.title, `${label}.title`); string(value.outcome, `${label}.outcome`);
  if (typeof value.isFinal !== 'boolean') throw new MemoryError(`${label}.isFinal must be boolean`);
  if (value.parentGoalId !== undefined) id(value.parentGoalId, `${label}.parentGoalId`);
  enumValue(value.authority, AUTHORITIES, `${label}.authority`); enumValue(value.basis, BASES, `${label}.basis`);
  uniqueIds(value.criterionIds, `${label}.criterionIds`);
}

function freshnessPolicy(value, label) {
  exact(value, ['kind', 'maxAgeSeconds'], ['kind'], label);
  const kinds = new Set(['immutable_until_superseded', 'source_digest', 'max_age', 'not_applicable']);
  enumValue(value.kind, kinds, `${label}.kind`);
  if (value.kind === 'max_age') {
    if (!Number.isInteger(value.maxAgeSeconds) || value.maxAgeSeconds < 1 || value.maxAgeSeconds > 31_536_000) throw new MemoryError(`${label}.maxAgeSeconds is invalid`);
  } else if (value.maxAgeSeconds !== undefined) throw new MemoryError(`${label}.maxAgeSeconds is forbidden`);
}

function criterionDef(value, label) {
  exact(value, ['criterionId', 'ownerType', 'ownerId', 'condition', 'scope', 'requiredEvidenceKinds', 'freshnessPolicy', 'waivableByUser'], ['criterionId', 'ownerType', 'ownerId', 'condition', 'scope', 'requiredEvidenceKinds', 'freshnessPolicy', 'waivableByUser'], label);
  id(value.criterionId, `${label}.criterionId`); enumValue(value.ownerType, new Set(['goal', 'task']), `${label}.ownerType`); id(value.ownerId, `${label}.ownerId`);
  string(value.condition, `${label}.condition`); string(value.scope, `${label}.scope`);
  array(value.requiredEvidenceKinds, `${label}.requiredEvidenceKinds`, (item, itemLabel) => enumValue(item, EVIDENCE_KINDS, itemLabel), { min: 1 });
  if (new Set(value.requiredEvidenceKinds).size !== value.requiredEvidenceKinds.length) throw new MemoryError(`${label}.requiredEvidenceKinds must be unique`);
  freshnessPolicy(value.freshnessPolicy, `${label}.freshnessPolicy`);
  if (typeof value.waivableByUser !== 'boolean') throw new MemoryError(`${label}.waivableByUser must be boolean`);
}

function taskDef(value, label) {
  exact(value, ['taskId', 'goalId', 'title', 'scope', 'pathOwnership', 'owner', 'dependencyIds', 'criterionIds', 'userFacing', 'requiredForGoal'], ['taskId', 'goalId', 'title', 'scope', 'pathOwnership', 'owner', 'dependencyIds', 'criterionIds', 'userFacing', 'requiredForGoal'], label);
  id(value.taskId, `${label}.taskId`); id(value.goalId, `${label}.goalId`); string(value.title, `${label}.title`); string(value.scope, `${label}.scope`);
  if (typeof value.userFacing !== 'boolean' || typeof value.requiredForGoal !== 'boolean') throw new MemoryError(`${label} flags must be boolean`);
  array(value.pathOwnership, `${label}.pathOwnership`, repoPath); if (new Set(value.pathOwnership).size !== value.pathOwnership.length) throw new MemoryError(`${label}.pathOwnership must be unique`); id(value.owner, `${label}.owner`); uniqueIds(value.dependencyIds, `${label}.dependencyIds`); uniqueIds(value.criterionIds, `${label}.criterionIds`, { min: value.userFacing || value.requiredForGoal ? 1 : 0 });
}

function attemptDef(value, label) {
  const keys = ['attemptId', 'taskId', 'ordinal', 'owner', 'approachId', 'hypothesisId', 'approachSummary', 'changeSummary', 'retryJustification', 'respondsToFailureId', 'respondsToFeedbackId'];
  exact(value, keys, keys.slice(0, 7), label);
  id(value.attemptId, `${label}.attemptId`); id(value.taskId, `${label}.taskId`);
  if (!Number.isInteger(value.ordinal) || value.ordinal < 1 || value.ordinal > 10_000) throw new MemoryError(`${label}.ordinal is invalid`);
  id(value.owner, `${label}.owner`); id(value.approachId, `${label}.approachId`); id(value.hypothesisId, `${label}.hypothesisId`); string(value.approachSummary, `${label}.approachSummary`);
  for (const field of ['changeSummary', 'retryJustification']) if (value[field] !== undefined) string(value[field], `${label}.${field}`);
  for (const field of ['respondsToFailureId', 'respondsToFeedbackId']) if (value[field] !== undefined) id(value[field], `${label}.${field}`);
}

function claimDef(value, label) {
  exact(value, ['claimId', 'subject', 'predicate', 'scopeKey', 'cardinality', 'value', 'valueKey', 'basis', 'authority'], ['claimId', 'subject', 'predicate', 'scopeKey', 'cardinality', 'value', 'basis', 'authority'], label);
  id(value.claimId, `${label}.claimId`); subject(value.subject, `${label}.subject`); string(value.predicate, `${label}.predicate`, { max: 160, pattern: PREDICATE }); string(value.scopeKey, `${label}.scopeKey`, { max: 240 });
  enumValue(value.cardinality, new Set(['one', 'many']), `${label}.cardinality`);
  canonicalV2(value.value);
  if (value.cardinality === 'many') id(value.valueKey, `${label}.valueKey`); else if (value.valueKey !== undefined) throw new MemoryError(`${label}.valueKey is forbidden for cardinality one`);
  enumValue(value.basis, BASES, `${label}.basis`); enumValue(value.authority, AUTHORITIES, `${label}.authority`);
}

function verifier(value, label) {
  exact(value, ['kind', 'id', 'version'], ['kind', 'id'], label); enumValue(value.kind, ACTOR_KINDS, `${label}.kind`); id(value.id, `${label}.id`); if (value.version !== undefined) string(value.version, `${label}.version`, { max: 120 });
}

function evidenceDef(value, label) {
  const keys = ['evidenceId', 'kind', 'subjectId', 'scope', 'locator', 'sourceVersion', 'contentDigest', 'observedAt', 'verifier', 'method', 'outcome', 'policy', 'sourceRefs', 'workspaceAtObservation', 'sensitivity'];
  exact(value, keys, ['evidenceId', 'kind', 'subjectId', 'scope', 'locator', 'observedAt', 'verifier', 'method', 'outcome', 'policy', 'sourceRefs', 'sensitivity'], label);
  id(value.evidenceId, `${label}.evidenceId`); enumValue(value.kind, EVIDENCE_KINDS, `${label}.kind`); id(value.subjectId, `${label}.subjectId`); string(value.scope, `${label}.scope`);
  if (/^https?:\/\//i.test(value.locator)) { string(value.locator, `${label}.locator`, { max: 500 }); if (/^https?:\/\/[^/\s:@]+:[^@\s/]+@/i.test(value.locator)) throw new MemoryError(`${label}.locator contains credentials`); }
  else repoPath(value.locator, `${label}.locator`);
  if (value.sourceVersion !== undefined) string(value.sourceVersion, `${label}.sourceVersion`, { max: 160 });
  if (value.contentDigest !== undefined && !HASH.test(value.contentDigest)) throw new MemoryError(`${label}.contentDigest must be sha256`);
  timestamp(value.observedAt, `${label}.observedAt`); verifier(value.verifier, `${label}.verifier`); string(value.method, `${label}.method`); enumValue(value.outcome, EVIDENCE_OUTCOMES, `${label}.outcome`); freshnessPolicy(value.policy, `${label}.policy`);
  array(value.sourceRefs, `${label}.sourceRefs`, sourceRef);
  if (value.workspaceAtObservation !== undefined) workspace(value.workspaceAtObservation, `${label}.workspaceAtObservation`);
  enumValue(value.sensitivity, SENSITIVITIES, `${label}.sensitivity`);
  evidencePolicyFacts(value, label);
}

export function evidencePolicyFacts(evidence, label = 'evidence') {
  const rule = EVIDENCE_POLICY_RULES[evidence?.policy?.kind];
  if (!rule) throw new MemoryError(`${label}.policy is invalid`);
  if (MUTABLE_EVIDENCE_KINDS.has(evidence.kind) && evidence.policy.kind !== 'max_age') {
    throw new MemoryError(`${label}.policy must be max_age for mutable evidence`);
  }
  const sourceBound = !rule.requiresSources || (Array.isArray(evidence.sourceRefs) && evidence.sourceRefs.length > 0);
  const positive = evidence.outcome === 'passed';
  return Object.freeze({ sourceBound, positive, authorizing: sourceBound && positive });
}

function failureDef(value, label) {
  const keys = ['failureId', 'subject', 'attemptId', 'owner', 'responsibleBoundary', 'terminal', 'approachId', 'hypothesisId', 'symptomClass', 'observedSymptom', 'impact', 'unchanged', 'rootCause', 'evidenceRefs', 'retryCount', 'lessonId', 'nextAction'];
  exact(value, keys, ['failureId', 'subject', 'terminal', 'approachId', 'hypothesisId', 'symptomClass', 'observedSymptom', 'impact', 'unchanged', 'rootCause', 'evidenceRefs', 'retryCount'], label);
  id(value.failureId, `${label}.failureId`); subject(value.subject, `${label}.subject`);
  if (!['goal', 'task'].includes(value.subject.type)) throw new MemoryError(`${label}.subject.type is invalid`);
  if (value.subject.type === 'task' && value.attemptId === undefined) throw new MemoryError(`${label}.attemptId is required for task failure`);
  if (value.subject.type === 'task' && value.owner === undefined) throw new MemoryError(`${label}.owner is required for task failure`);
  if (value.subject.type === 'goal' && value.owner === undefined && value.responsibleBoundary === undefined) throw new MemoryError(`${label} requires owner or responsibleBoundary`);
  if (value.subject.type === 'goal' && value.attemptId !== undefined) throw new MemoryError(`${label}.attemptId is forbidden for goal failure`);
  if (value.attemptId !== undefined) id(value.attemptId, `${label}.attemptId`); if (value.owner !== undefined) id(value.owner, `${label}.owner`); if (value.responsibleBoundary !== undefined) string(value.responsibleBoundary, `${label}.responsibleBoundary`);
  enumValue(value.terminal, FAILURE_TERMINALS, `${label}.terminal`); id(value.approachId, `${label}.approachId`); id(value.hypothesisId, `${label}.hypothesisId`);
  string(value.symptomClass, `${label}.symptomClass`, { max: 160 }); string(value.observedSymptom, `${label}.observedSymptom`); string(value.impact, `${label}.impact`); array(value.unchanged, `${label}.unchanged`, string, { min: 1 });
  exact(value.rootCause, ['state', 'summary'], ['state', 'summary'], `${label}.rootCause`); enumValue(value.rootCause.state, ROOT_CAUSE_STATES, `${label}.rootCause.state`); string(value.rootCause.summary, `${label}.rootCause.summary`);
  uniqueIds(value.evidenceRefs, `${label}.evidenceRefs`, { min: 1 }); if (!Number.isInteger(value.retryCount) || value.retryCount < 0) throw new MemoryError(`${label}.retryCount is invalid`);
  if (value.lessonId !== undefined) id(value.lessonId, `${label}.lessonId`); if (value.nextAction !== undefined) string(value.nextAction, `${label}.nextAction`);
  if (value.lessonId === undefined && value.nextAction === undefined) throw new MemoryError(`${label} requires lessonId or nextAction`);
}

function feedbackDef(value, label, eventType) {
  const baseKeys = ['feedbackId', 'subjectId', 'disposition', 'acceptanceEffect', 'statement', 'evidenceRef'];
  const adverseKeys = ['baselineApproachId', 'baselineHypothesisId', 'lessonId', 'nextAction', 'correctionPlan'];
  const allowed = eventType === 'feedback.correction' ? [...baseKeys, ...adverseKeys, 'supersedesFeedbackId'] : [...baseKeys, ...adverseKeys];
  exact(value, allowed, baseKeys, label);
  id(value.feedbackId, `${label}.feedbackId`); id(value.subjectId, `${label}.subjectId`); enumValue(value.disposition, new Set(FEEDBACK_PAIRS.keys()), `${label}.disposition`);
  if (!FEEDBACK_PAIRS.get(value.disposition).has(value.acceptanceEffect)) throw new MemoryError(`${label}.acceptanceEffect does not match disposition`);
  string(value.statement, `${label}.statement`); id(value.evidenceRef, `${label}.evidenceRef`);
  for (const field of ['baselineApproachId', 'baselineHypothesisId', 'lessonId', 'supersedesFeedbackId']) if (value[field] !== undefined) id(value[field], `${label}.${field}`);
  for (const field of ['nextAction', 'correctionPlan']) if (value[field] !== undefined) string(value[field], `${label}.${field}`);
  if (eventType !== 'feedback.correction' && value.disposition !== eventType.split('.')[1]) throw new MemoryError(`${label}.disposition does not match eventType`);
  if (eventType === 'feedback.correction' && value.supersedesFeedbackId === undefined) throw new MemoryError(`${label}.supersedesFeedbackId is required`);
  if (['dissatisfied', 'rejected'].includes(value.disposition)) {
    if (!value.baselineApproachId || !value.baselineHypothesisId) throw new MemoryError(`${label} requires retry baselines`);
    if (!value.lessonId && !value.nextAction && !value.correctionPlan) throw new MemoryError(`${label} requires a lesson or next action`);
  }
}

function handoffDef(value, label) {
  exact(value, ['handoffId', 'taskId', 'assignmentId', 'parentRunId', 'owner', 'scope', 'pathOwnership', 'criterionIds', 'deliverables', 'prohibitedActions'], ['handoffId', 'taskId', 'assignmentId', 'parentRunId', 'owner', 'scope', 'pathOwnership', 'criterionIds', 'deliverables', 'prohibitedActions'], label);
  for (const field of ['handoffId', 'taskId', 'assignmentId', 'parentRunId', 'owner']) id(value[field], `${label}.${field}`);
  string(value.scope, `${label}.scope`); array(value.pathOwnership, `${label}.pathOwnership`, repoPath); if (new Set(value.pathOwnership).size !== value.pathOwnership.length) throw new MemoryError(`${label}.pathOwnership must be unique`); uniqueIds(value.criterionIds, `${label}.criterionIds`); array(value.deliverables, `${label}.deliverables`, string); array(value.prohibitedActions, `${label}.prohibitedActions`, string);
}

function artifactRef(value, label) {
  exact(value, ['path', 'contentSha256'], ['path'], label); repoPath(value.path, `${label}.path`); if (value.contentSha256 !== undefined && !HASH.test(value.contentSha256)) throw new MemoryError(`${label}.contentSha256 must be sha256`);
}

function handoffReport(value, label) {
  exact(value, ['handoffId', 'attemptId', 'outcome', 'summary', 'changedArtifacts', 'evidenceRefs', 'failureIds', 'uncertainties', 'nextAction'], ['handoffId', 'attemptId', 'outcome', 'summary', 'changedArtifacts', 'evidenceRefs', 'failureIds', 'uncertainties'], label);
  id(value.handoffId, `${label}.handoffId`); id(value.attemptId, `${label}.attemptId`); enumValue(value.outcome, new Set(['succeeded', 'failed', 'blocked', 'inconclusive', 'abandoned']), `${label}.outcome`); string(value.summary, `${label}.summary`);
  array(value.changedArtifacts, `${label}.changedArtifacts`, artifactRef); uniqueIds(value.evidenceRefs, `${label}.evidenceRefs`); uniqueIds(value.failureIds, `${label}.failureIds`); array(value.uncertainties, `${label}.uncertainties`, string); if (value.nextAction !== undefined) string(value.nextAction, `${label}.nextAction`);
}

function lessonDef(value, label) {
  exact(value, ['lessonId', 'taskId', 'failureId', 'summary', 'nextDifferentAction', 'evidenceRefs'], ['lessonId', 'summary', 'evidenceRefs'], label); id(value.lessonId, `${label}.lessonId`); if (value.taskId !== undefined) id(value.taskId, `${label}.taskId`); if (value.failureId !== undefined) id(value.failureId, `${label}.failureId`); string(value.summary, `${label}.summary`); if (value.nextDifferentAction !== undefined) string(value.nextDifferentAction, `${label}.nextDifferentAction`); uniqueIds(value.evidenceRefs, `${label}.evidenceRefs`);
}

function decisionDef(value, label) {
  exact(value, ['decisionId', 'subjectId', 'choice', 'rationale', 'evidenceRefs'], ['decisionId', 'subjectId', 'choice', 'rationale', 'evidenceRefs'], label); id(value.decisionId, `${label}.decisionId`); id(value.subjectId, `${label}.subjectId`); string(value.choice, `${label}.choice`); string(value.rationale, `${label}.rationale`); uniqueIds(value.evidenceRefs, `${label}.evidenceRefs`);
}

function legacyRecord(value, label) {
  exact(value, ['legacyId', 'kind', 'summary', 'legacyStatus', 'checkedAt', 'sourceRefs'], ['legacyId', 'kind', 'summary', 'sourceRefs'], label); id(value.legacyId, `${label}.legacyId`); string(value.kind, `${label}.kind`, { max: 80 }); string(value.summary, `${label}.summary`); if (value.legacyStatus !== undefined) string(value.legacyStatus, `${label}.legacyStatus`, { max: 160 }); if (value.checkedAt !== undefined) timestamp(value.checkedAt, `${label}.checkedAt`); array(value.sourceRefs, `${label}.sourceRefs`, sourceRef);
}

const PAYLOAD_VALIDATORS = {
  'project.initialized': (p) => { exact(p, ['project', 'initialization'], ['project', 'initialization'], 'payload'); projectDef(p.project, 'payload.project'); enumValue(p.initialization, new Set(['new', 'migration']), 'payload.initialization'); },
  'goal.declared': (p) => { exact(p, ['goal', 'evidenceRef'], ['goal', 'evidenceRef'], 'payload'); goalDef(p.goal, 'payload.goal'); id(p.evidenceRef, 'payload.evidenceRef'); },
  'goal.revised': (p) => { exact(p, ['goal', 'replacesEventId', 'reason', 'evidenceRef'], ['goal', 'replacesEventId', 'reason', 'evidenceRef'], 'payload'); goalDef(p.goal, 'payload.goal'); id(p.replacesEventId, 'payload.replacesEventId'); string(p.reason, 'payload.reason'); id(p.evidenceRef, 'payload.evidenceRef'); },
  'goal.blocked': (p) => idOnly(p, 'failureId'),
  'goal.reopened': (p) => reasonEvidence(p, ['priorEventId']),
  'goal.abandoned': (p) => reasonlessFailureEvidence(p),
  'goal.retired': (p) => { exact(p, ['reason', 'evidenceRef'], ['reason', 'evidenceRef'], 'payload'); string(p.reason, 'payload.reason'); id(p.evidenceRef, 'payload.evidenceRef'); },
  'goal.achieved': (p) => { exact(p, ['criterionEvidenceRefs', 'acceptanceFeedbackId'], ['criterionEvidenceRefs', 'acceptanceFeedbackId'], 'payload'); uniqueIds(p.criterionEvidenceRefs, 'payload.criterionEvidenceRefs', { min: 1 }); id(p.acceptanceFeedbackId, 'payload.acceptanceFeedbackId'); },
  'criterion.declared': (p) => definitionPayload(p, 'criterion', criterionDef),
  'criterion.revised': (p) => revisionPayload(p, 'criterion', criterionDef),
  'criterion.waived_by_user': (p) => simpleReasonEvidence(p),
  'criterion.reactivated': (p) => simpleReasonEvidence(p),
  'criterion.retired': (p) => { exact(p, ['reason', 'replacementCriterionId'], ['reason'], 'payload'); string(p.reason, 'payload.reason'); if (p.replacementCriterionId !== undefined) id(p.replacementCriterionId, 'payload.replacementCriterionId'); },
  'task.planned': (p) => definitionPayload(p, 'task', taskDef),
  'task.revised': (p) => revisionPayload(p, 'task', taskDef),
  'task.started': (p) => idOnly(p, 'attemptId'),
  'task.implemented': (p) => { exact(p, ['attemptId', 'deliverableEvidenceRefs'], ['attemptId', 'deliverableEvidenceRefs'], 'payload'); id(p.attemptId, 'payload.attemptId'); uniqueIds(p.deliverableEvidenceRefs, 'payload.deliverableEvidenceRefs', { min: 1 }); },
  'task.blocked': taskFailurePayload,
  'task.failed': taskFailurePayload,
  'task.completed': (p) => { exact(p, ['attemptId', 'criterionEvidenceRefs'], ['attemptId', 'criterionEvidenceRefs'], 'payload'); id(p.attemptId, 'payload.attemptId'); uniqueIds(p.criterionEvidenceRefs, 'payload.criterionEvidenceRefs', { min: 1 }); },
  'task.abandoned': (p) => { exact(p, ['attemptId', 'reason', 'evidenceRefs'], ['reason', 'evidenceRefs'], 'payload'); if (p.attemptId !== undefined) id(p.attemptId, 'payload.attemptId'); string(p.reason, 'payload.reason'); uniqueIds(p.evidenceRefs, 'payload.evidenceRefs'); },
  'task.reopened': (p) => { exact(p, ['priorEventId', 'reason', 'evidenceRefs', 'triggerFeedbackId'], ['priorEventId', 'reason', 'evidenceRefs'], 'payload'); id(p.priorEventId, 'payload.priorEventId'); string(p.reason, 'payload.reason'); uniqueIds(p.evidenceRefs, 'payload.evidenceRefs'); if (p.triggerFeedbackId !== undefined) id(p.triggerFeedbackId, 'payload.triggerFeedbackId'); },
  'attempt.started': (p) => definitionPayload(p, 'attempt', attemptDef),
  'attempt.reported': (p) => { exact(p, ['attemptId', 'outcome', 'endedAt', 'summary', 'evidenceRefs', 'failureId'], ['attemptId', 'outcome', 'endedAt', 'summary', 'evidenceRefs'], 'payload'); id(p.attemptId, 'payload.attemptId'); enumValue(p.outcome, ATTEMPT_OUTCOMES, 'payload.outcome'); timestamp(p.endedAt, 'payload.endedAt'); string(p.summary, 'payload.summary'); uniqueIds(p.evidenceRefs, 'payload.evidenceRefs'); if (p.failureId !== undefined) id(p.failureId, 'payload.failureId'); if (['failed', 'blocked', 'inconclusive'].includes(p.outcome) !== Boolean(p.failureId)) throw new MemoryError('payload.failureId does not match outcome'); },
  'claim.asserted': (p) => { exact(p, ['claim', 'evidenceRefs'], ['claim', 'evidenceRefs'], 'payload'); claimDef(p.claim, 'payload.claim'); uniqueIds(p.evidenceRefs, 'payload.evidenceRefs'); },
  'claim.verified': (p) => claimEvidence(p),
  'claim.disputed': (p) => { exact(p, ['claimIds', 'reason', 'evidenceRefs'], ['claimIds', 'reason', 'evidenceRefs'], 'payload'); uniqueIds(p.claimIds, 'payload.claimIds', { min: 2 }); string(p.reason, 'payload.reason'); uniqueIds(p.evidenceRefs, 'payload.evidenceRefs', { min: 1 }); },
  'claim.superseded': (p) => { exact(p, ['claimId', 'replacementClaimId', 'evidenceRefs'], ['claimId', 'replacementClaimId', 'evidenceRefs'], 'payload'); id(p.claimId, 'payload.claimId'); id(p.replacementClaimId, 'payload.replacementClaimId'); uniqueIds(p.evidenceRefs, 'payload.evidenceRefs', { min: 1 }); },
  'claim.retracted': (p) => { exact(p, ['claimId', 'reason', 'evidenceRefs'], ['claimId', 'reason', 'evidenceRefs'], 'payload'); id(p.claimId, 'payload.claimId'); string(p.reason, 'payload.reason'); uniqueIds(p.evidenceRefs, 'payload.evidenceRefs', { min: 1 }); },
  'evidence.recorded': (p) => definitionPayload(p, 'evidence', evidenceDef),
  'failure.recorded': (p) => definitionPayload(p, 'failure', failureDef),
  'feedback.satisfied': (p) => feedbackPayload(p, 'feedback.satisfied'),
  'feedback.dissatisfied': (p) => feedbackPayload(p, 'feedback.dissatisfied'),
  'feedback.rejected': (p) => feedbackPayload(p, 'feedback.rejected'),
  'feedback.correction': (p) => feedbackPayload(p, 'feedback.correction'),
  'handoff.assigned': (p) => definitionPayload(p, 'handoff', handoffDef),
  'handoff.reported': (p) => definitionPayload(p, 'report', handoffReport),
  'handoff.accepted': handoffDecisionPayload,
  'handoff.rejected': handoffDecisionPayload,
  'handoff.cancelled': (p) => { exact(p, ['handoffId', 'reason', 'evidenceRefs'], ['handoffId', 'reason', 'evidenceRefs'], 'payload'); id(p.handoffId, 'payload.handoffId'); string(p.reason, 'payload.reason'); uniqueIds(p.evidenceRefs, 'payload.evidenceRefs', { min: 1 }); },
  'lesson.recorded': (p) => definitionPayload(p, 'lesson', lessonDef),
  'decision.recorded': (p) => definitionPayload(p, 'decision', decisionDef),
  'decision.revised': (p) => revisionPayload(p, 'decision', decisionDef),
  'migration.v1_imported': (p) => { const keys = ['archiveHistory', 'archiveCurrent', 'historyBytes', 'historySha256', 'currentSha256', 'eventCount', 'finalEventHash', 'recordChunkCount']; exact(p, keys, ['archiveHistory', 'historyBytes', 'historySha256', 'eventCount', 'finalEventHash', 'recordChunkCount'], 'payload'); repoPath(p.archiveHistory, 'payload.archiveHistory'); if (p.archiveCurrent !== undefined) repoPath(p.archiveCurrent, 'payload.archiveCurrent'); for (const field of ['historySha256', 'finalEventHash']) if (!HASH.test(p[field])) throw new MemoryError(`payload.${field} must be sha256`); if (p.currentSha256 !== undefined && !HASH.test(p.currentSha256)) throw new MemoryError('payload.currentSha256 must be sha256'); for (const field of ['historyBytes', 'eventCount', 'recordChunkCount']) if (!Number.isSafeInteger(p[field]) || p[field] < 0) throw new MemoryError(`payload.${field} is invalid`); },
  'migration.v1_records_imported': (p) => { exact(p, ['importEventId', 'chunkIndex', 'records'], ['importEventId', 'chunkIndex', 'records'], 'payload'); id(p.importEventId, 'payload.importEventId'); if (!Number.isInteger(p.chunkIndex) || p.chunkIndex < 0) throw new MemoryError('payload.chunkIndex is invalid'); array(p.records, 'payload.records', legacyRecord, { min: 1 }); },
};

function idOnly(payload, field) { exact(payload, [field], [field], 'payload'); id(payload[field], `payload.${field}`); }
function definitionPayload(payload, field, validator) { exact(payload, [field], [field], 'payload'); validator(payload[field], `payload.${field}`); }
function revisionPayload(payload, field, validator) { exact(payload, [field, 'replacesEventId', 'reason'], [field, 'replacesEventId', 'reason'], 'payload'); validator(payload[field], `payload.${field}`); id(payload.replacesEventId, 'payload.replacesEventId'); string(payload.reason, 'payload.reason'); }
function simpleReasonEvidence(payload) { exact(payload, ['reason', 'evidenceRef'], ['reason', 'evidenceRef'], 'payload'); string(payload.reason, 'payload.reason'); id(payload.evidenceRef, 'payload.evidenceRef'); }
function reasonEvidence(payload, extra) { exact(payload, [...extra, 'reason', 'evidenceRef'], [...extra, 'reason', 'evidenceRef'], 'payload'); extra.forEach((field) => id(payload[field], `payload.${field}`)); string(payload.reason, 'payload.reason'); id(payload.evidenceRef, 'payload.evidenceRef'); }
function reasonlessFailureEvidence(payload) { exact(payload, ['failureId', 'evidenceRef'], ['failureId', 'evidenceRef'], 'payload'); id(payload.failureId, 'payload.failureId'); id(payload.evidenceRef, 'payload.evidenceRef'); }
function taskFailurePayload(payload) { exact(payload, ['attemptId', 'failureId'], ['attemptId', 'failureId'], 'payload'); id(payload.attemptId, 'payload.attemptId'); id(payload.failureId, 'payload.failureId'); }
function claimEvidence(payload) { exact(payload, ['claimId', 'evidenceRefs'], ['claimId', 'evidenceRefs'], 'payload'); id(payload.claimId, 'payload.claimId'); uniqueIds(payload.evidenceRefs, 'payload.evidenceRefs', { min: 1 }); }
function feedbackPayload(payload, eventType) { exact(payload, ['feedback'], ['feedback'], 'payload'); feedbackDef(payload.feedback, 'payload.feedback', eventType); }
function handoffDecisionPayload(payload) { exact(payload, ['handoffId', 'reportEventId', 'reason', 'evidenceRefs'], ['handoffId', 'reportEventId', 'reason', 'evidenceRefs'], 'payload'); id(payload.handoffId, 'payload.handoffId'); id(payload.reportEventId, 'payload.reportEventId'); string(payload.reason, 'payload.reason'); uniqueIds(payload.evidenceRefs, 'payload.evidenceRefs', { min: 1 }); }

function validateTerminalActorAuthority(draft) {
  if (draft.eventType === 'goal.achieved' && !['user', 'coordinator'].includes(draft.actor.kind)) {
    throw new MemoryError('goal.achieved requires user or coordinator actor');
  }
  if (draft.eventType === 'task.completed' && draft.actor.kind !== 'coordinator') {
    throw new MemoryError('task.completed requires coordinator actor');
  }
}

function validateDraftSnapshot(draft) {
  const fields = ['eventType', 'occurredAt', 'actor', 'subject', 'goalId', 'taskId', 'supersedes', 'contradicts', 'evidenceRefs', 'sensitivity', 'payload'];
  exact(draft, fields, ['eventType', 'occurredAt', 'actor', 'subject', 'supersedes', 'contradicts', 'evidenceRefs', 'sensitivity', 'payload'], 'event draft');
  assertAcyclicSnapshot(draft, 'event draft');
  enumValue(draft.eventType, new Set(EVENT_TYPES), 'eventType'); timestamp(draft.occurredAt, 'occurredAt'); actor(draft.actor); subject(draft.subject);
  validateTerminalActorAuthority(draft);
  if (draft.goalId !== undefined) id(draft.goalId, 'goalId'); if (draft.taskId !== undefined) id(draft.taskId, 'taskId'); uniqueIds(draft.supersedes, 'supersedes'); uniqueIds(draft.contradicts, 'contradicts'); uniqueIds(draft.evidenceRefs, 'evidenceRefs'); enumValue(draft.sensitivity, SENSITIVITIES, 'sensitivity');
  scanSafe(draft, '', [], draft.eventType);
  PAYLOAD_VALIDATORS[draft.eventType](draft.payload);
  if (Buffer.byteLength(canonicalV2(draft), 'utf8') > MAX_EVENT_BYTES) throw new MemoryError('event draft exceeds the size limit');
  return draft;
}

export function validateDraftShape(draft) {
  if (draft && typeof draft === 'object' && VALIDATED_DRAFT_SNAPSHOTS.has(draft)) return draft;
  const snapshot = snapshotCallerValue(draft, 'event draft');
  validateDraftSnapshot(snapshot);
  freezeSnapshot(snapshot);
  VALIDATED_DRAFT_SNAPSHOTS.add(snapshot);
  return snapshot;
}

function byId(state, collection, wanted) { return state[collection].find((item) => item[`${collection.slice(0, -1)}Id`] === wanted); }
function evidenceById(state, wanted) { return state.evidence.find((item) => item.evidenceId === wanted); }
function requireEvidence(state, refs, label, { allowBootstrap = false } = {}) { for (const ref of refs) if (!evidenceById(state, ref) && !allowBootstrap) throw new MemoryError(`${label} references missing evidence`); }
function entity(state, collection, key, wanted, label) { const found = state[collection].find((item) => item[key] === wanted); if (!found) throw new MemoryError(`${label} does not exist`); return found; }
function absent(state, collection, key, wanted, label) { if (state[collection].some((item) => item[key] === wanted)) throw new MemoryError(`${label} already exists`); }
function transition(current, allowed, eventType) { if (!allowed.includes(current)) throw new MemoryError(`${eventType} is forbidden from ${current ?? 'absent'}`); }

function requireCriterionEvidence(state, criteria, refs, label, { evaluateEvidence, requireFreshness = false, independentFrom = [] } = {}) {
  requireEvidence(state, refs, label);
  const excludedVerifierIds = new Set(independentFrom);
  for (const criterion of criteria.filter((item) => item.lifecycle === 'active')) {
    for (const requiredKind of criterion.requiredEvidenceKinds) {
      const latest = [...criterion.evidenceRefs].reverse().map((ref) => evidenceById(state, ref)).find((evidence) => evidence?.kind === requiredKind);
      if (!latest || !evidencePolicyFacts(latest).authorizing || !refs.includes(latest.evidenceId)) throw new MemoryError(`${label} requires latest passing evidence of every required kind`);
      if (excludedVerifierIds.has(latest.verifier.id)) throw new MemoryError(`${label} requires a verifier independent of the task and attempt owners`);
      if (requireFreshness) {
        if (typeof evaluateEvidence !== 'function') throw new MemoryError(`${label} requires internal live freshness evaluation`);
        let freshness;
        try { freshness = evaluateEvidence(structuredClone(latest), structuredClone(criterion)); } catch { throw new MemoryError(`${label} live freshness evaluation failed`); }
        if (freshness !== 'fresh') throw new MemoryError(`${label} requires latest live-fresh evidence of every required kind`);
      }
    }
  }
}

export function validateDraft(draft, state = emptyProjectState()) {
  const valid = validateDraftShape(draft);
  validateTransition(valid, state);
  return valid;
}

export function validateDraftForPersistence(draft, state, evaluateEvidence) {
  const valid = validateDraftShape(draft);
  validateTransition(valid, state, { evaluateEvidence, requireFreshness: true });
  return valid;
}

function isCanonicalInspectPath(value) {
  const length = typeof value === 'string' ? unicodeCodePointLength(value) : null;
  if (length === null || length < 1 || length > 500 || value !== value.trim() || value !== value.normalize('NFC')
    || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) || value.includes('\\')
    || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((part) => part && part !== '.' && part !== '..');
}

const INSPECT_TIMESTAMP_FIELDS = new Set(['generatedAt', 'capturedAt', 'observedAt', 'checkedAt']);

function isStrictInspectTimestamp(value) {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function canonicalInspectFields(value, field = '', depth = 0) {
  if (depth > 8) return false;
  if (typeof value === 'string') {
    const length = unicodeCodePointLength(value);
    if (length === null || length < 1 || length > MAX_STRING
      || value !== value.trim() || value !== value.normalize('NFC')
      || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return false;
    return !INSPECT_TIMESTAMP_FIELDS.has(field) || isStrictInspectTimestamp(value);
  }
  if (Array.isArray(value)) {
    return value.length <= MAX_ITEMS && value.every((item) => canonicalInspectFields(item, field, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).every(([childField, child]) => (
      unicodeCodePointLength(childField) !== null
      && canonicalInspectFields(child, childField, depth + 1)
    ));
  }
  return value === null || typeof value === 'boolean' || Number.isSafeInteger(value);
}

function repeatedInspectEntitiesAgree(view) {
  const register = (registry, item, idField, fields) => {
    const itemId = item[idField];
    let facts = registry.get(itemId);
    if (!facts) { facts = new Map(); registry.set(itemId, facts); }
    for (const field of fields) {
      const encoded = Object.hasOwn(item, field) ? JSON.stringify(item[field]) : null;
      if (facts.has(field) && facts.get(field) !== encoded) return false;
      facts.set(field, encoded);
    }
    return true;
  };
  const taskFields = [
    'taskId', 'title', 'owner', 'execution', 'verification', 'acceptance', 'freshness', 'nextAction',
  ];
  const taskRegistry = new Map();
  for (const task of view.tasks) if (!register(taskRegistry, task, 'taskId', taskFields)) return false;
  for (const category of ['blocked', 'failed', 'verificationFailed', 'rejected']) {
    for (const task of view.attention[category]) if (!register(taskRegistry, task, 'taskId', taskFields)) return false;
  }
  const evidenceFields = [
    'evidenceId', 'kind', 'subjectId', 'outcome', 'observedAt', 'freshness', 'scope', 'limitation',
  ];
  const evidenceRegistry = new Map();
  for (const evidence of view.evidenceSummary) {
    if (!register(evidenceRegistry, evidence, 'evidenceId', evidenceFields)) return false;
  }
  for (const evidence of view.attention.stale) {
    if (!register(evidenceRegistry, evidence, 'evidenceId', evidenceFields)) return false;
  }
  for (const evidence of view.selectedEvidence ?? []) {
    if (!register(evidenceRegistry, evidence, 'evidenceId', evidenceFields)) return false;
  }
  return true;
}

function graphifyReceiptSemantics(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
  const required = [
    'receiptId', 'adapterVersion', 'state', 'graphifyVersion', 'graphPath', 'repositoryHead',
    'workspaceDirty', 'observedAt', 'scope', 'limitations',
  ];
  const allowed = new Set([...required, 'byteSize', 'rawSha256', 'builtAtCommit']);
  if (!canonicalInspectFields(receipt)
    || required.some((field) => !Object.hasOwn(receipt, field))
    || Object.keys(receipt).some((field) => !allowed.has(field))
    || !ID.test(receipt.receiptId) || receipt.adapterVersion !== 1
    || !['not_present', 'observed_unverified', 'commit_aligned_only', 'stale_known'].includes(receipt.state)
    || !(receipt.graphifyVersion === null || typeof receipt.graphifyVersion === 'string')
    || !isCanonicalInspectPath(receipt.graphPath)
    || !(receipt.repositoryHead === 'unavailable' || GIT_OBJECT_ID.test(receipt.repositoryHead))
    || !(typeof receipt.workspaceDirty === 'boolean' || receipt.workspaceDirty === null)
    || typeof receipt.observedAt !== 'string' || !ISO_UTC.test(receipt.observedAt)
    || typeof receipt.scope !== 'string'
    || !Array.isArray(receipt.limitations) || receipt.limitations.length < 1 || receipt.limitations.length > MAX_ITEMS
    || new Set(receipt.limitations).size !== receipt.limitations.length
    || receipt.limitations.some((item) => typeof item !== 'string')) return false;
  const hasBytes = Object.hasOwn(receipt, 'byteSize');
  const hasHash = Object.hasOwn(receipt, 'rawSha256');
  const hasBuiltAt = Object.hasOwn(receipt, 'builtAtCommit');
  if (hasBytes && (!Number.isInteger(receipt.byteSize) || receipt.byteSize < 0 || receipt.byteSize > 64 * 1024 * 1024)) return false;
  if (hasHash && !HASH.test(receipt.rawSha256)) return false;
  if (hasBuiltAt && !GIT_OBJECT_ID.test(receipt.builtAtCommit)) return false;
  if (receipt.state === 'not_present') return !hasBytes && !hasHash && !hasBuiltAt;
  if (!hasBytes || !hasHash) return false;
  if (receipt.state === 'commit_aligned_only') {
    return hasBuiltAt && receipt.repositoryHead === receipt.builtAtCommit;
  }
  return true;
}

export function validateInspectSemantics(view) {
  const invalid = () => { throw new MemoryError('inspect semantics are invalid', 3); };
  if (!view || typeof view !== 'object') invalid();
  if (Object.hasOwn(view, 'adapterVersion') || Object.hasOwn(view, 'receiptId')) {
    if (!graphifyReceiptSemantics(view)) invalid();
    return view;
  }
  if (!['coordinator', 'handoff'].includes(view.view)
    || view.store?.schemaVersion !== 2
    || !Object.hasOwn(view.project ?? {}, 'finalGoal')
    || (view.view === 'handoff' && view.project.finalGoal === null)) invalid();
  if (!canonicalInspectFields(view)) invalid();
  if (view.view === 'coordinator' && view.project.finalGoal === null
    && !view.warnings?.some((warning) => warning.severity === 'blocking')) invalid();
  const identifiedArrays = {
    criteria: 'criterionId', tasks: 'taskId', nextActions: 'subjectId', handoffs: 'handoffId',
    feedback: 'feedbackId', evidenceSummary: 'evidenceId', sourceDrift: 'path',
    graphifyReceipts: 'receiptId', legacy: 'legacyId', warnings: 'warningId',
  };
  for (const [field, idField] of Object.entries(identifiedArrays)) {
    const items = view[field];
    if (!Array.isArray(items)) invalid();
    const seen = new Set();
    for (const item of items) {
      if (!item || typeof item !== 'object' || typeof item[idField] !== 'string' || seen.has(item[idField])) invalid();
      seen.add(item[idField]);
    }
  }
  const attentionIds = {
    goalFailures: 'failureId', blocked: 'taskId', failed: 'taskId', verificationFailed: 'taskId',
    rejected: 'taskId', contested: 'contradictionId', stale: 'evidenceId',
  };
  for (const [category, idField] of Object.entries(attentionIds)) {
    const items = view.attention?.[category];
    if (!Array.isArray(items) || new Set(items.map((item) => item[idField])).size !== items.length) invalid();
  }
  if (view.project.finalGoal !== null) {
    const finalFailureIds = new Set(view.project.finalGoal.failureIds);
    for (const failure of view.attention.goalFailures) {
      if (failure.subject?.type !== 'goal' || failure.subject.id !== view.project.finalGoal.goalId
        || !finalFailureIds.has(failure.failureId)) invalid();
    }
  } else if (view.attention.goalFailures.length > 0) invalid();
  if (!repeatedInspectEntitiesAgree(view)) invalid();
  for (const receipt of view.graphifyReceipts) if (!graphifyReceiptSemantics(receipt)) invalid();
  if (view.view !== 'handoff') return view;
  if (!Array.isArray(view.tasks) || view.tasks.length !== 1
    || !Array.isArray(view.handoffs) || view.handoffs.length !== 1
    || !Array.isArray(view.criteria) || !Array.isArray(view.selectedEvidence)
    || !Array.isArray(view.evidenceSummary)) invalid();
  const task = view.tasks[0]; const handoff = view.handoffs[0];
  if (handoff.taskId !== task.taskId || handoff.owner !== task.owner) invalid();
  const handoffCriterionIds = new Set(handoff.criterionIds);
  const criteriaById = new Map(view.criteria.map((criterion) => [criterion.criterionId, criterion]));
  const criterionEvidenceIds = new Map(view.criteria.map((criterion) => [criterion.criterionId, new Set(criterion.evidenceRefs)]));
  const viewCriterionIds = new Set(criteriaById.keys());
  const taskCriterionIds = new Set(task.criterionIds);
  if (handoffCriterionIds.size !== handoff.criterionIds.length
    || viewCriterionIds.size !== view.criteria.length
    || handoffCriterionIds.size !== viewCriterionIds.size
    || [...handoffCriterionIds].some((criterionId) => !viewCriterionIds.has(criterionId) || !taskCriterionIds.has(criterionId))) invalid();
  const linkedSubjects = new Set([task.taskId, ...handoffCriterionIds]);
  const selectedEvidenceIds = new Set();
  const evidenceById = new Map();
  for (const evidence of view.evidenceSummary) {
    const matches = evidenceById.get(evidence.evidenceId) ?? [];
    matches.push(evidence);
    evidenceById.set(evidence.evidenceId, matches);
  }
  const commonEvidenceFields = [
    'evidenceId', 'kind', 'subjectId', 'outcome', 'observedAt', 'freshness', 'scope', 'limitation',
  ];
  const selectedEvidenceFields = new Set([...commonEvidenceFields, 'locator']);
  if (!view.selectedEvidence.length || view.evidenceSummary.length !== view.selectedEvidence.length) invalid();
  for (const evidence of view.selectedEvidence) {
    if (!isCanonicalInspectPath(evidence.locator) || Object.keys(evidence).some((field) => !selectedEvidenceFields.has(field))
      || !linkedSubjects.has(evidence.subjectId)
      || selectedEvidenceIds.has(evidence.evidenceId)) invalid();
    selectedEvidenceIds.add(evidence.evidenceId);
    const matches = evidenceById.get(evidence.evidenceId) ?? [];
    if (matches.length !== 1 || commonEvidenceFields.some((field) => (
      Object.hasOwn(evidence, field) !== Object.hasOwn(matches[0], field)
      || evidence[field] !== matches[0][field]
    ))) invalid();
    if (handoffCriterionIds.has(evidence.subjectId)) {
      if (!criterionEvidenceIds.get(evidence.subjectId).has(evidence.evidenceId)) invalid();
    }
  }
  if ([...evidenceById.keys()].some((evidenceId) => !selectedEvidenceIds.has(evidenceId))) invalid();
  return view;
}

function validateTransition(draft, state, context = {}) {
  const { eventType: type, payload: p } = draft;
  if (!state.project && type !== 'project.initialized') throw new MemoryError('project.initialized must be the first event');
  if (state.project && type === 'project.initialized') throw new MemoryError('project.initialized can occur only once');
  if (!state.finalGoalId && !['project.initialized', 'goal.declared', 'goal.revised', 'migration.v1_imported', 'migration.v1_records_imported'].includes(type)) throw new MemoryError('a user-backed final goal is required');
  if (type.startsWith('migration.') && draft.actor.kind !== 'migration') throw new MemoryError('migration events require migration actor');
  if (type.startsWith('feedback.') && draft.actor.kind !== 'user') throw new MemoryError('feedback events require user actor');
  if (['criterion.waived_by_user', 'criterion.reactivated'].includes(type) && draft.actor.kind !== 'user') throw new MemoryError(`${type} requires user actor`);
  if (['handoff.assigned', 'handoff.accepted', 'handoff.rejected', 'handoff.cancelled'].includes(type) && draft.actor.kind !== 'coordinator') throw new MemoryError(`${type} requires coordinator actor`);
  if (['claim.disputed', 'claim.superseded', 'claim.retracted'].includes(type) && draft.actor.kind !== 'coordinator') {
    throw new MemoryError(`${type} requires coordinator actor`);
  }
  if (type === 'handoff.reported' && draft.actor.kind !== 'subagent') throw new MemoryError('handoff.reported requires subagent actor');
  if (type === 'goal.declared' && state[MIGRATION_PROGRESS] && state[MIGRATION_PROGRESS].nextChunk !== state[MIGRATION_PROGRESS].expectedChunks) throw new MemoryError('migration chunks are incomplete');
  validateInvariantGraph(draft, state, context);
  TRANSITION_VALIDATORS[type](draft, state, context);
}

function knownSubject(state, subjectId) {
  if (state.project?.projectId === subjectId) return { type: 'project', id: subjectId };
  const definitions = [
    ['goal', 'goals', 'goalId'], ['criterion', 'criteria', 'criterionId'], ['task', 'tasks', 'taskId'],
    ['attempt', 'attempts', 'attemptId'], ['claim', 'claims', 'claimId'], ['evidence', 'evidence', 'evidenceId'],
    ['failure', 'failures', 'failureId'], ['feedback', 'feedback', 'feedbackId'], ['handoff', 'handoffs', 'handoffId'],
    ['lesson', 'lessons', 'lessonId'], ['decision', 'decisions', 'decisionId'],
  ];
  for (const [type, collection, key] of definitions) {
    const value = state[collection].find((item) => item[key] === subjectId);
    if (value) return { type, id: subjectId, value };
  }
  return null;
}

function ownershipFor(state, target) {
  if (!target) return {};
  if (target.type === 'goal') return { goalId: target.id };
  if (target.type === 'task') {
    const task = target.value ?? state.tasks.find((item) => item.taskId === target.id);
    return { taskId: target.id, goalId: task?.goalId };
  }
  if (target.type === 'attempt') {
    const attempt = target.value ?? state.attempts.find((item) => item.attemptId === target.id);
    const task = state.tasks.find((item) => item.taskId === attempt?.taskId);
    return { taskId: attempt?.taskId, goalId: task?.goalId };
  }
  if (target.type === 'criterion') {
    const criterion = target.value ?? state.criteria.find((item) => item.criterionId === target.id);
    if (criterion?.ownerType === 'goal') return { goalId: criterion.ownerId };
    const task = state.tasks.find((item) => item.taskId === criterion?.ownerId);
    return { taskId: criterion?.ownerId, goalId: task?.goalId };
  }
  if (target.type === 'handoff') {
    const handoff = target.value ?? state.handoffs.find((item) => item.handoffId === target.id);
    const task = state.tasks.find((item) => item.taskId === handoff?.taskId);
    return { taskId: handoff?.taskId, goalId: task?.goalId };
  }
  return {};
}

function draftTarget(draft, state) {
  const { eventType: type, payload: p } = draft;
  if (type === 'project.initialized') return { type: 'project', id: p.project.projectId };
  if (type === 'goal.declared' || type === 'goal.revised') return { type: 'goal', id: p.goal.goalId, value: p.goal };
  if (type.startsWith('goal.')) return knownSubject(state, draft.subject.id);
  if (type === 'criterion.declared' || type === 'criterion.revised') return { type: 'criterion', id: p.criterion.criterionId, value: p.criterion };
  if (type.startsWith('criterion.')) return knownSubject(state, draft.subject.id);
  if (type === 'task.planned') return { type: 'task', id: p.task.taskId, value: p.task };
  if (type.startsWith('task.')) return knownSubject(state, draft.subject.id);
  if (type === 'attempt.started') return { type: 'attempt', id: p.attempt.attemptId, value: p.attempt };
  if (type === 'attempt.reported') return knownSubject(state, p.attemptId);
  if (type === 'claim.asserted') return knownSubject(state, p.claim.subject.id);
  if (type.startsWith('claim.')) {
    const claimId = p.claimId ?? p.claimIds?.[0];
    const claim = state.claims.find((item) => item.claimId === claimId);
    return claim ? knownSubject(state, claim.subject.id) : null;
  }
  if (type === 'evidence.recorded') return knownSubject(state, p.evidence.subjectId);
  if (type === 'failure.recorded') return knownSubject(state, p.failure.subject.id);
  if (type.startsWith('feedback.')) return knownSubject(state, p.feedback.subjectId);
  if (type === 'handoff.assigned') return { type: 'handoff', id: p.handoff.handoffId, value: p.handoff };
  if (type.startsWith('handoff.')) return knownSubject(state, p.report?.handoffId ?? p.handoffId);
  if (type === 'lesson.recorded') return { type: 'lesson', id: p.lesson.lessonId, value: p.lesson };
  if (type === 'decision.recorded' || type === 'decision.revised') return knownSubject(state, p.decision.subjectId);
  if (type.startsWith('migration.')) return { type: 'migration', id: draft.subject.id };
  return null;
}

function validateBindings(draft, state) {
  const knownEvents = state[EVENT_IDS] ?? new Set();
  for (const eventId of [...draft.supersedes, ...draft.contradicts]) if (!knownEvents.has(eventId)) throw new MemoryError('event references an unknown history event');
  for (const field of ['replacesEventId', 'priorEventId', 'reportEventId']) {
    const eventId = draft.payload[field];
    if (eventId !== undefined && !knownEvents.has(eventId)) throw new MemoryError(`${field} references an unknown history event`);
  }
  const bootstrapGoal = draft.eventType === 'goal.declared' && state.goals.length === 0;
  requireEvidence(state, draft.evidenceRefs, 'event', { allowBootstrap: bootstrapGoal });

  const target = draftTarget(draft, state);
  if (!target || target.type !== draft.subject.type || target.id !== draft.subject.id) throw new MemoryError('event subject does not match its payload entity');
  const ownership = ownershipFor(state, target);
  if (draft.goalId !== undefined && draft.goalId !== ownership.goalId) throw new MemoryError('event goalId does not match subject ownership');
  if (draft.taskId !== undefined && draft.taskId !== ownership.taskId) throw new MemoryError('event taskId does not match subject ownership');
}

function verifyFailureAttemptReference(draft, state) {
  const failure = draft.payload.failure;
  if (failure.subject.type !== 'task') return;
  const attempt = entity(state, 'attempts', 'attemptId', failure.attemptId, 'failure attempt');
  if (attempt.taskId !== failure.subject.id || attempt.owner !== failure.owner
    || attempt.approachId !== failure.approachId || attempt.hypothesisId !== failure.hypothesisId) {
    throw new MemoryError('task failure does not match its attempt lineage');
  }
}

function verifyLessonFailureReference(draft, state) {
  const lesson = draft.payload.lesson;
  if (!lesson.failureId) return;
  const failure = entity(state, 'failures', 'failureId', lesson.failureId, 'lesson failure');
  if (failure.lessonId !== lesson.lessonId) throw new MemoryError('lesson does not match the failure lesson reference');
  if (failure.subject.type === 'task' && lesson.taskId !== failure.subject.id) {
    throw new MemoryError('lesson task does not match its failure task');
  }
  if (failure.subject.type === 'goal' && lesson.taskId !== undefined) {
    throw new MemoryError('goal failure lesson cannot claim task ownership');
  }
}

function verifyHandoffReportFailureReferences(draft, state) {
  const report = draft.payload.report;
  const handoff = entity(state, 'handoffs', 'handoffId', report.handoffId, 'handoff');
  const attempt = entity(state, 'attempts', 'attemptId', report.attemptId, 'handoff attempt');
  const failures = report.failureIds.map((failureId) => entity(state, 'failures', 'failureId', failureId, 'handoff report failure'));
  if (failures.some((failure) => failure.subject.type !== 'task'
    || failure.subject.id !== handoff.taskId || failure.attemptId !== attempt.attemptId)) {
    throw new MemoryError('handoff report failure does not belong to its task and attempt');
  }
  const requiresFailure = ['failed', 'blocked', 'inconclusive'].includes(report.outcome);
  if (requiresFailure) {
    if (!attempt.failureId || report.failureIds.length !== 1 || report.failureIds[0] !== attempt.failureId) {
      throw new MemoryError('adverse handoff report must name its canonical attempt failure');
    }
  } else if (report.failureIds.length) {
    throw new MemoryError('non-adverse handoff report cannot name failures');
  }
}

function verifyClaimEvidenceReference(draft, state) {
  const claim = entity(state, 'claims', 'claimId', draft.payload.claimId, 'claim');
  verifyClaimEvidence(state, claim, draft.payload.evidenceRefs, [claim], 'claim verification');
}

function verifyClaimEvidence(state, claim, evidenceRefs, independentClaims, label) {
  const assertorIds = new Set(independentClaims.map((item) => {
    const assertor = state[CLAIM_ASSERTORS]?.get(item.claimId);
    if (!assertor) throw new MemoryError(`${label} claim authority lineage is unavailable`);
    return assertor.id;
  }));
  for (const evidenceRef of evidenceRefs) {
    const evidence = entity(state, 'evidence', 'evidenceId', evidenceRef, `${label} evidence`);
    if (evidence.subjectId !== claim.subject.id || !evidencePolicyFacts(evidence).authorizing
      || !AUTHORITY_VERIFIER_KINDS[claim.authority]?.has(evidence.verifier.kind)
      || assertorIds.has(evidence.verifier.id)) {
      throw new MemoryError(`${label} evidence does not match subject, authority, outcome, and independence`);
    }
  }
}

function verifyClaimResolutionEvidence(draft, state) {
  const affected = entity(state, 'claims', 'claimId', draft.payload.claimId, 'claim');
  const replacement = draft.eventType === 'claim.superseded'
    ? entity(state, 'claims', 'claimId', draft.payload.replacementClaimId, 'replacement claim')
    : null;
  const contestedMembers = state.contradictions
    .filter((item) => item.state === 'contested' && item.claimIds.includes(affected.claimId))
    .flatMap((item) => item.claimIds.map((claimId) => entity(state, 'claims', 'claimId', claimId, 'contested claim')));
  const independentClaims = [...new Map(
    [affected, replacement, ...contestedMembers].filter(Boolean).map((claim) => [claim.claimId, claim]),
  ).values()];
  const authorityClaims = draft.eventType === 'claim.superseded'
    ? [affected, replacement]
    : [affected, ...contestedMembers.filter((claim) => claim.claimId !== affected.claimId)];
  const requiredAuthorities = new Set(authorityClaims.map((claim) => claim.authority));
  if (authorityClaims.some((claim) => claim.subject.type !== affected.subject.type || claim.subject.id !== affected.subject.id)) {
    throw new MemoryError('claim resolution members do not share one subject');
  }
  const assertorIds = new Set(independentClaims.map((claim) => {
    const assertor = state[CLAIM_ASSERTORS]?.get(claim.claimId);
    if (!assertor) throw new MemoryError('claim resolution authority lineage is unavailable');
    return assertor.id;
  }));
  const coveredAuthorities = new Set();
  for (const evidenceRef of draft.payload.evidenceRefs) {
    const evidence = entity(state, 'evidence', 'evidenceId', evidenceRef, 'claim resolution evidence');
    if (evidence.subjectId !== affected.subject.id || !evidencePolicyFacts(evidence).authorizing
      || assertorIds.has(evidence.verifier.id)) {
      throw new MemoryError('claim resolution evidence does not match subject, outcome, and independence');
    }
    const matches = [...requiredAuthorities].filter((authority) => (
      AUTHORITY_VERIFIER_KINDS[authority]?.has(evidence.verifier.kind)
    ));
    if (!matches.length) throw new MemoryError('claim resolution evidence does not match an affected authority');
    matches.forEach((authority) => coveredAuthorities.add(authority));
  }
  if ([...requiredAuthorities].some((authority) => !coveredAuthorities.has(authority))) {
    throw new MemoryError('claim resolution evidence does not cover every affected authority');
  }
}

const TASK_TERMINAL_EVENTS = Object.freeze({
  blocked: 'task.blocked',
  failed: 'task.failed',
  completed: 'task.completed',
  abandoned: 'task.abandoned',
});
const TASK_TERMINAL_EVENT_TYPES = new Set(Object.values(TASK_TERMINAL_EVENTS));

function currentTaskTerminalEvent(state, task) {
  const metadata = state[EVENT_META];
  if (!(metadata instanceof Map)) throw new MemoryError('task terminal event lineage is unavailable');
  let latest = null;
  for (const [eventId, meta] of metadata) {
    if (!TASK_TERMINAL_EVENT_TYPES.has(meta.eventType)
      || meta.subject?.type !== 'task' || meta.subject.id !== task.taskId) continue;
    if (!latest || meta.sequence > latest.sequence) latest = { eventId, ...meta };
  }
  if (!latest || latest.eventType !== TASK_TERMINAL_EVENTS[task.execution]) {
    throw new MemoryError('task current terminal event does not match its execution state');
  }
  return latest;
}

function taskReopenTransition(draft, state) {
  const task = entity(state, 'tasks', 'taskId', draft.subject.id, 'task');
  transition(task.execution, ['blocked', 'failed', 'completed', 'abandoned'], draft.eventType);
  const terminal = currentTaskTerminalEvent(state, task);
  if (draft.payload.priorEventId !== terminal.eventId) {
    throw new MemoryError('task.reopened must name the task current terminal event');
  }
  const triggerRequired = task.execution === 'completed' || task.acceptance === 'rejected';
  if (triggerRequired && !draft.payload.triggerFeedbackId) {
    throw new MemoryError('reopening completed or rejected work requires feedback');
  }
  if (draft.payload.triggerFeedbackId) {
    const feedback = entity(state, 'feedback', 'feedbackId', draft.payload.triggerFeedbackId, 'trigger feedback');
    const feedbackEventId = feedback.derivedFromEventIds[0];
    const feedbackMeta = state[EVENT_META]?.get(feedbackEventId);
    const newCriterion = ['feedback.dissatisfied', 'feedback.rejected'].includes(feedbackMeta?.eventType)
      && Boolean(feedback.lessonId || feedback.nextAction || feedback.correctionPlan);
    if (feedback.lifecycle !== 'active' || feedback.subjectId !== task.taskId
      || feedbackMeta?.actor?.kind !== 'user' || feedbackMeta.subject?.type !== 'task'
      || feedbackMeta.subject.id !== task.taskId || feedbackMeta.sequence <= terminal.sequence
      || (feedbackMeta.eventType !== 'feedback.correction' && !newCriterion)) {
      throw new MemoryError('task reopening feedback must be active, task-bound, user corrective, and newer than the terminal event');
    }
    const evidence = entity(state, 'evidence', 'evidenceId', feedback.evidenceRef, 'trigger feedback evidence');
    if (evidence.kind !== 'user_message' || evidence.subjectId !== task.taskId
      || evidence.verifier.kind !== 'user' || evidence.verifier.id !== feedbackMeta.actor.id
      || !draft.payload.evidenceRefs.includes(feedback.evidenceRef)
      || !draft.evidenceRefs.includes(feedback.evidenceRef)) {
      throw new MemoryError('task reopening feedback evidence does not match the task and user');
    }
  }
  requireEvidence(state, draft.payload.evidenceRefs, draft.eventType);
}

const INVARIANT_REFERENCE_GRAPH = Object.freeze({
  '*': Object.freeze([validateBindings]),
  'failure.recorded': Object.freeze([verifyFailureAttemptReference]),
  'lesson.recorded': Object.freeze([verifyLessonFailureReference]),
  'handoff.reported': Object.freeze([verifyHandoffReportFailureReferences]),
  'claim.verified': Object.freeze([verifyClaimEvidenceReference]),
  'claim.superseded': Object.freeze([verifyClaimResolutionEvidence]),
  'claim.retracted': Object.freeze([verifyClaimResolutionEvidence]),
});

function validateInvariantGraph(draft, state, context) {
  for (const validator of [...INVARIANT_REFERENCE_GRAPH['*'], ...(INVARIANT_REFERENCE_GRAPH[draft.eventType] ?? [])]) {
    validator(draft, state, context);
  }
}

const TRANSITION_VALIDATORS = Object.fromEntries(EVENT_TYPES.map((type) => [type, () => {}]));
Object.assign(TRANSITION_VALIDATORS, {
  'project.initialized': (d) => { if ((d.payload.initialization === 'migration') !== (d.actor.kind === 'migration')) throw new MemoryError('migration initialization requires migration actor'); },
  'goal.declared': (d, s) => { const g = d.payload.goal; absent(s, 'goals', 'goalId', g.goalId, 'goal'); if (g.isFinal) { if (s.finalGoalId) throw new MemoryError('only one final goal is allowed'); if (g.authority !== 'user' || g.basis !== 'user_stated') throw new MemoryError('final goal requires user authority and user_stated basis'); } if (g.parentGoalId) entity(s, 'goals', 'goalId', g.parentGoalId, 'parent goal'); requireEvidence(s, [d.payload.evidenceRef], 'goal.declared', { allowBootstrap: !s.finalGoalId }); },
  'goal.revised': (d, s) => { const g = entity(s, 'goals', 'goalId', d.payload.goal.goalId, 'goal'); const replacement = d.payload.goal; transition(g.lifecycle, ['active'], d.eventType); if (g.isFinal !== replacement.isFinal) throw new MemoryError('goal.revised cannot change final-goal identity'); if (g.isFinal && (d.actor.kind !== 'user' || replacement.authority !== 'user' || replacement.basis !== 'user_stated')) throw new MemoryError('final goal revision requires user actor, authority, and user_stated basis'); if (replacement.parentGoalId) entity(s, 'goals', 'goalId', replacement.parentGoalId, 'parent goal'); replacement.criterionIds.forEach((value) => entity(s, 'criteria', 'criterionId', value, 'goal criterion')); requireEvidence(s, [d.payload.evidenceRef], d.eventType); },
  'goal.blocked': (d, s) => goalFailureTransition(d, s, 'active', 'blocked'),
  'goal.reopened': (d, s) => { const g = entity(s, 'goals', 'goalId', d.subject.id, 'goal'); transition(g.lifecycle, ['blocked', 'abandoned', 'achieved'], d.eventType); if (g.isFinal && ['abandoned', 'achieved'].includes(g.lifecycle) && d.actor.kind !== 'user') throw new MemoryError('reopening final goal requires user actor'); requireEvidence(s, [d.payload.evidenceRef], d.eventType); },
  'goal.abandoned': (d, s) => goalFailureTransition(d, s, ['active', 'blocked'], 'abandoned'),
  'goal.retired': (d, s) => { const g = entity(s, 'goals', 'goalId', d.subject.id, 'goal'); transition(g.lifecycle, ['active', 'blocked', 'abandoned'], d.eventType); if (g.isFinal) throw new MemoryError('final goal cannot be retired'); requireEvidence(s, [d.payload.evidenceRef], d.eventType); },
  'goal.achieved': (d, s, context) => { const g = entity(s, 'goals', 'goalId', d.subject.id, 'goal'); transition(g.lifecycle, ['active'], d.eventType); const feedback = entity(s, 'feedback', 'feedbackId', d.payload.acceptanceFeedbackId, 'feedback'); const acceptanceEvidence = evidenceById(s, feedback.evidenceRef); if (feedback.lifecycle !== 'active' || feedback.subjectId !== g.goalId || feedback.acceptanceEffect !== 'accept' || !acceptanceEvidence || acceptanceEvidence.kind !== 'user_message' || acceptanceEvidence.subjectId !== g.goalId) throw new MemoryError('goal achievement requires user acceptance evidence bound to the same goal'); const criteria = g.criterionIds.map((criterionId) => entity(s, 'criteria', 'criterionId', criterionId, 'criterion')); const criterionTaskIds = new Set(criteria.filter((criterion) => criterion.ownerType === 'task').map((criterion) => criterion.ownerId)); const relevantTasks = s.tasks.filter((task) => task.goalId === g.goalId && (task.requiredForGoal || criterionTaskIds.has(task.taskId))); const relevantTaskIds = new Set(relevantTasks.map((task) => task.taskId)); const independentFrom = [...relevantTasks.map((task) => task.owner), ...s.attempts.filter((attempt) => relevantTaskIds.has(attempt.taskId)).map((attempt) => attempt.owner)]; requireCriterionEvidence(s, criteria, d.payload.criterionEvidenceRefs, d.eventType, { ...context, independentFrom }); if (s.tasks.some((t) => t.goalId === g.goalId && t.requiredForGoal && t.execution !== 'completed')) throw new MemoryError('goal tasks are not completed'); },
  'criterion.declared': (d, s) => { const c = d.payload.criterion; absent(s, 'criteria', 'criterionId', c.criterionId, 'criterion'); entity(s, c.ownerType === 'goal' ? 'goals' : 'tasks', `${c.ownerType}Id`, c.ownerId, 'criterion owner'); },
  'criterion.revised': (d, s) => { const replacement = d.payload.criterion; const c = entity(s, 'criteria', 'criterionId', replacement.criterionId, 'criterion'); transition(c.lifecycle, ['active'], d.eventType); entity(s, replacement.ownerType === 'goal' ? 'goals' : 'tasks', `${replacement.ownerType}Id`, replacement.ownerId, 'criterion owner'); },
  'criterion.waived_by_user': (d, s) => { const c = entity(s, 'criteria', 'criterionId', d.subject.id, 'criterion'); transition(c.lifecycle, ['active'], d.eventType); if (!c.waivableByUser) throw new MemoryError('criterion is not waivable'); requireEvidence(s, [d.payload.evidenceRef], d.eventType); },
  'criterion.reactivated': (d, s) => { const c = entity(s, 'criteria', 'criterionId', d.subject.id, 'criterion'); transition(c.lifecycle, ['waived_by_user'], d.eventType); requireEvidence(s, [d.payload.evidenceRef], d.eventType); },
  'criterion.retired': (d, s) => { const c = entity(s, 'criteria', 'criterionId', d.subject.id, 'criterion'); transition(c.lifecycle, ['active', 'waived_by_user'], d.eventType); if (d.payload.replacementCriterionId) entity(s, 'criteria', 'criterionId', d.payload.replacementCriterionId, 'replacement criterion'); if (s.tasks.some((t) => t.criterionIds.includes(c.criterionId) && !['completed', 'failed', 'abandoned'].includes(t.execution)) && !d.payload.replacementCriterionId) throw new MemoryError('active task criterion requires replacement'); },
  'task.planned': (d, s) => { const t = d.payload.task; absent(s, 'tasks', 'taskId', t.taskId, 'task'); entity(s, 'goals', 'goalId', t.goalId, 'task goal'); t.dependencyIds.forEach((value) => entity(s, 'tasks', 'taskId', value, 'task dependency')); t.criterionIds.forEach((value) => entity(s, 'criteria', 'criterionId', value, 'task criterion')); },
  'task.revised': (d, s) => { const current = entity(s, 'tasks', 'taskId', d.payload.task.taskId, 'task'); transition(current.execution, ['planned'], d.eventType); const replacement = d.payload.task; for (const key of ['goalId', 'owner', 'userFacing', 'requiredForGoal']) if (replacement[key] !== current[key]) throw new MemoryError(`task.revised cannot change ${key}`); entity(s, 'goals', 'goalId', replacement.goalId, 'task goal'); replacement.dependencyIds.forEach((value) => entity(s, 'tasks', 'taskId', value, 'task dependency')); replacement.criterionIds.forEach((value) => entity(s, 'criteria', 'criterionId', value, 'task criterion')); },
  'attempt.started': attemptStartTransition,
  'attempt.reported': attemptReportTransition,
  'task.started': (d, s) => { const t = entity(s, 'tasks', 'taskId', d.subject.id, 'task'); transition(t.execution, ['planned'], d.eventType); const a = entity(s, 'attempts', 'attemptId', d.payload.attemptId, 'attempt'); if (t.currentAttemptId !== a.attemptId || a.taskId !== t.taskId || a.owner !== t.owner || a.outcome !== 'in_progress') throw new MemoryError('task.started requires its current matching open attempt and owner'); },
  'task.implemented': (d, s) => { const t = taskAttempt(d, s, ['in_progress'], ['in_progress']); requireEvidence(s, d.payload.deliverableEvidenceRefs, d.eventType); if (!d.payload.deliverableEvidenceRefs.length) throw new MemoryError('task.implemented requires deliverable evidence'); return t; },
  'task.blocked': (d, s) => taskFailureTransition(d, s, ['planned', 'in_progress', 'implemented'], 'blocked'),
  'task.failed': (d, s) => taskFailureTransition(d, s, ['in_progress', 'implemented'], 'failed'),
  'task.completed': (d, s, context) => { const t = taskAttempt(d, s, ['implemented'], ['succeeded']); const a = entity(s, 'attempts', 'attemptId', d.payload.attemptId, 'attempt'); const criteria = t.criterionIds.map((criterionId) => entity(s, 'criteria', 'criterionId', criterionId, 'criterion')); requireCriterionEvidence(s, criteria, d.payload.criterionEvidenceRefs, d.eventType, { ...context, independentFrom: [t.owner, a.owner] }); },
  'task.abandoned': (d, s) => {
    const t = entity(s, 'tasks', 'taskId', d.subject.id, 'task');
    transition(t.execution, ['planned', 'in_progress', 'implemented', 'blocked'], d.eventType);
    if (d.payload.attemptId !== undefined) {
      const a = entity(s, 'attempts', 'attemptId', d.payload.attemptId, 'attempt');
      if (t.currentAttemptId !== a.attemptId || a.taskId !== t.taskId || a.owner !== t.owner || a.outcome !== 'abandoned') {
        throw new MemoryError('task.abandoned attempt must be the task current matching abandoned attempt');
      }
    } else if (t.currentAttemptId) {
      const a = entity(s, 'attempts', 'attemptId', t.currentAttemptId, 'attempt');
      if (a.outcome === 'in_progress') throw new MemoryError('open attempt must be reported abandoned first');
    }
    requireEvidence(s, d.payload.evidenceRefs, d.eventType);
  },
  'task.reopened': taskReopenTransition,
  'evidence.recorded': (d, s) => { absent(s, 'evidence', 'evidenceId', d.payload.evidence.evidenceId, 'evidence'); if (!subjectExists(s, d.payload.evidence.subjectId)) throw new MemoryError('evidence subject does not exist'); },
  'failure.recorded': failureTransition,
  'feedback.satisfied': feedbackTransition,
  'feedback.dissatisfied': feedbackTransition,
  'feedback.rejected': feedbackTransition,
  'feedback.correction': feedbackTransition,
  'claim.asserted': claimAssertTransition,
  'claim.verified': (d, s) => { entity(s, 'claims', 'claimId', d.payload.claimId, 'claim'); requireEvidence(s, d.payload.evidenceRefs, d.eventType); },
  'claim.disputed': (d, s) => {
    const claims = d.payload.claimIds.map((value) => entity(s, 'claims', 'claimId', value, 'claim'));
    const first = claims[0];
    if (claims.some((claim) => claim.lifecycle !== 'active' || !compatibleClaimMember(first, claim))) {
      throw new MemoryError('manual claim dispute members are incompatible or inactive');
    }
    requireEvidence(s, d.payload.evidenceRefs, d.eventType);
  },
  'claim.superseded': (d, s) => {
    const old = entity(s, 'claims', 'claimId', d.payload.claimId, 'claim');
    const replacement = entity(s, 'claims', 'claimId', d.payload.replacementClaimId, 'replacement claim');
    const contestedSets = s.contradictions.filter((item) => item.state === 'contested' && item.claimIds.includes(old.claimId));
    if (!['active', 'contested'].includes(old.lifecycle) || !['active', 'contested'].includes(replacement.lifecycle)
      || old.claimId === replacement.claimId || !compatibleClaimMember(old, replacement)
      || contestedSets.some((item) => !item.claimIds.includes(replacement.claimId))) {
      throw new MemoryError('claim supersession is invalid');
    }
    requireEvidence(s, d.payload.evidenceRefs, d.eventType);
  },
  'claim.retracted': (d, s) => { const c = entity(s, 'claims', 'claimId', d.payload.claimId, 'claim'); if (!['active', 'contested'].includes(c.lifecycle)) throw new MemoryError('claim cannot be retracted'); requireEvidence(s, d.payload.evidenceRefs, d.eventType); },
  'handoff.assigned': (d, s) => { const h = d.payload.handoff; absent(s, 'handoffs', 'handoffId', h.handoffId, 'handoff'); const task = entity(s, 'tasks', 'taskId', h.taskId, 'handoff task'); h.criterionIds.forEach((value) => { entity(s, 'criteria', 'criterionId', value, 'handoff criterion'); if (!task.criterionIds.includes(value)) throw new MemoryError('handoff criterion is not linked to its task'); }); },
  'handoff.reported': (d, s) => { const h = entity(s, 'handoffs', 'handoffId', d.payload.report.handoffId, 'handoff'); transition(h.state, ['assigned'], d.eventType); if (h.owner !== d.actor.id) throw new MemoryError('handoff report actor does not match owner'); const attempt = entity(s, 'attempts', 'attemptId', d.payload.report.attemptId, 'handoff attempt'); if (attempt.taskId !== h.taskId || attempt.owner !== h.owner || !ATTEMPT_OUTCOMES.has(attempt.outcome) || attempt.outcome !== d.payload.report.outcome) throw new MemoryError('handoff report attempt does not match the terminal task, owner, and outcome'); requireEvidence(s, d.payload.report.evidenceRefs, d.eventType); },
  'handoff.accepted': handoffDecisionTransition,
  'handoff.rejected': handoffDecisionTransition,
  'handoff.cancelled': (d, s) => { const h = entity(s, 'handoffs', 'handoffId', d.payload.handoffId, 'handoff'); transition(h.state, ['assigned', 'reported'], d.eventType); requireEvidence(s, d.payload.evidenceRefs, d.eventType); },
  'lesson.recorded': (d, s) => { const l = d.payload.lesson; absent(s, 'lessons', 'lessonId', l.lessonId, 'lesson'); if (l.taskId) entity(s, 'tasks', 'taskId', l.taskId, 'lesson task'); if (l.failureId) entity(s, 'failures', 'failureId', l.failureId, 'lesson failure'); requireEvidence(s, l.evidenceRefs, d.eventType); },
  'decision.recorded': (d, s) => { absent(s, 'decisions', 'decisionId', d.payload.decision.decisionId, 'decision'); requireEvidence(s, d.payload.decision.evidenceRefs, d.eventType); },
  'decision.revised': (d, s) => { entity(s, 'decisions', 'decisionId', d.payload.decision.decisionId, 'decision'); requireEvidence(s, d.payload.decision.evidenceRefs, d.eventType); },
  'migration.v1_imported': (d, s) => { if (s[MIGRATION_MODE] !== 'migration' || s.generatedFrom?.sequence !== 1 || s[MIGRATION_PROGRESS]) throw new MemoryError('migration marker must follow migration initialization exactly once'); },
  'migration.v1_records_imported': (d, s) => { const progress = s[MIGRATION_PROGRESS]; if (!progress || s.finalGoalId || d.payload.importEventId !== progress.receiptEventId || d.payload.chunkIndex !== progress.nextChunk || progress.nextChunk >= progress.expectedChunks) throw new MemoryError('migration chunk order, count, or linkage is invalid'); for (const record of d.payload.records) if (s.legacyImports.some((item) => item.legacyId === record.legacyId)) throw new MemoryError('legacy record ID is duplicated'); },
});

function goalFailureTransition(d, s, allowed, terminal) { const g = entity(s, 'goals', 'goalId', d.subject.id, 'goal'); transition(g.lifecycle, Array.isArray(allowed) ? allowed : [allowed], d.eventType); const f = entity(s, 'failures', 'failureId', d.payload.failureId, 'failure'); if (f.subject.type !== 'goal' || f.subject.id !== g.goalId || f.terminal !== terminal) throw new MemoryError('goal failure does not match transition'); if (d.payload.evidenceRef) requireEvidence(s, [d.payload.evidenceRef], d.eventType); }
function taskAttempt(d, s, allowed, outcomes) { const t = entity(s, 'tasks', 'taskId', d.subject.id, 'task'); transition(t.execution, allowed, d.eventType); const a = entity(s, 'attempts', 'attemptId', d.payload.attemptId, 'attempt'); if (t.currentAttemptId !== a.attemptId || a.taskId !== t.taskId || a.owner !== t.owner || !outcomes.includes(a.outcome)) throw new MemoryError(`${d.eventType} requires the task current attempt, matching owner, and matching outcome`); return t; }
function taskFailureTransition(d, s, allowed, terminal) { const t = taskAttempt(d, s, allowed, [terminal]); const f = entity(s, 'failures', 'failureId', d.payload.failureId, 'failure'); const a = entity(s, 'attempts', 'attemptId', d.payload.attemptId, 'attempt'); if (f.subject.id !== t.taskId || f.attemptId !== a.attemptId || f.terminal !== terminal) throw new MemoryError('task failure does not match attempt'); }
function attemptStartTransition(d, s) {
  const a = d.payload.attempt;
  absent(s, 'attempts', 'attemptId', a.attemptId, 'attempt');
  const t = entity(s, 'tasks', 'taskId', a.taskId, 'task');
  transition(t.execution, ['planned'], d.eventType);
  if (s.attempts.some((item) => item.taskId === t.taskId && item.outcome === 'in_progress')) throw new MemoryError('task already has an open attempt');
  const prior = s.attempts.filter((item) => item.taskId === t.taskId);
  if (a.ordinal !== prior.length + 1) throw new MemoryError('attempt ordinal must be sequential');
  const descendantTaskIds = new Set(s.tasks.filter((item) => item.goalId === t.goalId).map((item) => item.taskId));
  const adverseFailures = s.failures.filter((failure) => !failure.resolvedByAttemptId && (
    (failure.subject.type === 'goal' && failure.subject.id === t.goalId)
    || (failure.subject.type === 'task' && descendantTaskIds.has(failure.subject.id))
  ));
  const adverseFeedback = s.feedback.filter((feedback) => feedback.lifecycle === 'active' && ['dissatisfied', 'rejected'].includes(feedback.disposition) && (feedback.subjectId === t.goalId || descendantTaskIds.has(feedback.subjectId)));
  if (!adverseFailures.length && !adverseFeedback.length) return;
  const referenced = a.respondsToFailureId
    ? adverseFailures.find((failure) => failure.failureId === a.respondsToFailureId)
    : a.respondsToFeedbackId
      ? adverseFeedback.find((feedback) => feedback.feedbackId === a.respondsToFeedbackId)
      : null;
  if (!referenced) throw new MemoryError('retry must link an active goal/task ancestry failure or feedback');
  const oldApproach = referenced.approachId ?? referenced.baselineApproachId;
  const oldHypothesis = referenced.hypothesisId ?? referenced.baselineHypothesisId;
  const changed = a.approachId !== oldApproach || a.hypothesisId !== oldHypothesis;
  if (!a.changeSummary) throw new MemoryError('retry must record auditable changed fields');
  if (!changed) {
    const priorEvidence = new Set(referenced.evidenceRefs ?? [referenced.evidenceRef].filter(Boolean));
    const newEvidence = d.evidenceRefs.filter((ref) => !priorEvidence.has(ref));
    requireEvidence(s, newEvidence, 'retry environment evidence');
    const adverseId = referenced.failureId ?? referenced.feedbackId;
    const adverseMeta = s[EVENT_META].get(referenced.derivedFromEventIds[0]);
    const qualifying = newEvidence.map((ref) => evidenceById(s, ref)).some((evidence) => {
      const evidenceMeta = s[EVENT_META].get(evidence.derivedFromEventIds[0]);
      const expectedSubject = referenced.subject?.id ?? referenced.subjectId;
      return ['git_blob', 'file', 'command', 'test', 'browser_render'].includes(evidence.kind)
        && ['passed', 'observed'].includes(evidence.outcome)
        && evidence.verifier.kind === 'tool'
        && evidence.subjectId === expectedSubject
        && evidence.scope === adverseId
        && evidence.workspaceAtObservation?.fingerprintPartial === false
        && evidence.workspaceAtObservation.head !== 'unavailable'
        && evidenceMeta?.sequence > adverseMeta?.sequence
        && Date.parse(evidence.observedAt) > Date.parse(adverseMeta?.recordedAt ?? '');
    });
    if (!a.retryJustification || !qualifying) throw new MemoryError('same-ID retry requires linked, recent, qualifying environment evidence');
  }
}
function attemptReportTransition(d, s) { const a = entity(s, 'attempts', 'attemptId', d.payload.attemptId, 'attempt'); transition(a.outcome, ['in_progress'], d.eventType); if (Date.parse(d.payload.endedAt) < Date.parse(a.startedAt)) throw new MemoryError('attempt endedAt precedes its start'); requireEvidence(s, d.payload.evidenceRefs, d.eventType); if (d.payload.outcome === 'succeeded' && a.respondsToFailureId && !d.payload.evidenceRefs.length) throw new MemoryError('successful retry resolution requires outcome evidence'); if (d.payload.failureId) { const f = entity(s, 'failures', 'failureId', d.payload.failureId, 'attempt failure'); if (f.attemptId !== a.attemptId || f.terminal !== d.payload.outcome) throw new MemoryError('attempt failure does not match outcome'); } }
function subjectExists(s, wanted) { return s.project?.projectId === wanted || ['goals', 'criteria', 'tasks', 'attempts', 'claims', 'evidence', 'failures', 'feedback', 'handoffs', 'lessons', 'decisions'].some((collection) => s[collection].some((item) => Object.values(item).includes(wanted))); }
function failureTransition(d, s) { const f = d.payload.failure; absent(s, 'failures', 'failureId', f.failureId, 'failure'); if (f.subject.type === 'task') entity(s, 'tasks', 'taskId', f.subject.id, 'failure task'); else entity(s, 'goals', 'goalId', f.subject.id, 'failure goal'); requireEvidence(s, f.evidenceRefs, d.eventType); }
function feedbackTransition(d, s) { const f = d.payload.feedback; absent(s, 'feedback', 'feedbackId', f.feedbackId, 'feedback'); if (!subjectExists(s, f.subjectId)) throw new MemoryError('feedback subject does not exist'); const evidence = entity(s, 'evidence', 'evidenceId', f.evidenceRef, 'feedback evidence'); if (evidence.kind !== 'user_message' || evidence.subjectId !== f.subjectId || evidence.verifier.kind !== 'user' || evidence.verifier.id !== d.actor.id) throw new MemoryError('feedback requires matching user_message evidence'); const active = [...s.feedback].reverse().find((item) => item.subjectId === f.subjectId && item.lifecycle === 'active'); if (d.eventType === 'feedback.correction') { if (!active || active.feedbackId !== f.supersedesFeedbackId) throw new MemoryError('feedback correction must supersede current active feedback'); } else if (active) throw new MemoryError('active feedback requires explicit correction'); }
function claimAssertTransition(d, s) {
  const c = d.payload.claim;
  absent(s, 'claims', 'claimId', c.claimId, 'claim');
  requireEvidence(s, d.payload.evidenceRefs, d.eventType);
  const authorityMatrix = {
    user_stated: new Set(['user']),
    source_observed: new Set(['repository']),
    tool_observed: new Set(['tool']),
    agent_reported: new Set(['coordinator', 'subagent']),
    agent_inferred: new Set(['coordinator', 'subagent']),
    legacy_unverified: new Set(['migration']),
  };
  if (!authorityMatrix[c.basis]?.has(c.authority)) throw new MemoryError('claim basis and authority do not match');
  if (['agent_reported', 'agent_inferred'].includes(c.basis) && d.actor.kind !== c.authority) {
    throw new MemoryError('agent claim actor and authority do not match');
  }
  if (c.basis === 'legacy_unverified' && d.actor.kind !== 'migration') throw new MemoryError('legacy claim requires migration actor');
  if (c.basis === 'user_stated' && !['user', 'coordinator'].includes(d.actor.kind)) throw new MemoryError('user claim requires user or coordinator actor');
  if (['source_observed', 'tool_observed'].includes(c.basis) && !['coordinator', 'subagent', 'tool'].includes(d.actor.kind)) {
    throw new MemoryError('observed claim actor is invalid');
  }
  if (['user', 'tool', 'repository'].includes(c.authority)) {
    const evidence = d.payload.evidenceRefs.map((ref) => evidenceById(s, ref));
    const matches = evidence.some((item) => {
      if (!item || item.subjectId !== c.subject.id || !evidencePolicyFacts(item).sourceBound) return false;
      if (c.authority === 'user') return item.kind === 'user_message' && item.verifier.kind === 'user';
      if (c.authority === 'tool') return ['command', 'test', 'browser_render', 'graphify_receipt'].includes(item.kind) && item.verifier.kind === 'tool';
      return ['git_blob', 'file', 'url'].includes(item.kind) && item.verifier.kind === 'tool';
    });
    if (!matches) throw new MemoryError('authoritative claim requires matching evidence');
  }
  const key = claimKey(c);
  const existing = s.claims.filter((item) => item.claimKey === key);
  if (existing.some((item) => item.cardinality !== c.cardinality)) throw new MemoryError('claim cardinality cannot change');
}
function compatibleClaimMember(left, right) {
  return left.claimKey === right.claimKey
    && left.cardinality === right.cardinality
    && (left.cardinality !== 'many' || left.valueKey === right.valueKey);
}
function handoffDecisionTransition(d, s) { const h = entity(s, 'handoffs', 'handoffId', d.payload.handoffId, 'handoff'); transition(h.state, ['reported'], d.eventType); if (h.derivedFromEventIds.at(-1) !== d.payload.reportEventId) throw new MemoryError('handoff decision report does not match'); requireEvidence(s, d.payload.evidenceRefs, d.eventType); }

function cloneDefinition(definition, eventId, derived = {}) { return { ...structuredClone(definition), ...derived, derivedFromEventIds: [eventId] }; }
function addDerived(item, eventId) { item.derivedFromEventIds.push(eventId); }
function pushUnique(target, values) { for (const value of values) if (!target.includes(value)) target.push(value); }
const GOAL_DEFINITION_KEYS = ['goalId', 'title', 'outcome', 'isFinal', 'parentGoalId', 'authority', 'basis', 'criterionIds'];
const CRITERION_DEFINITION_KEYS = ['criterionId', 'ownerType', 'ownerId', 'condition', 'scope', 'requiredEvidenceKinds', 'freshnessPolicy', 'waivableByUser'];
const TASK_DEFINITION_KEYS = ['taskId', 'goalId', 'title', 'scope', 'pathOwnership', 'owner', 'dependencyIds', 'criterionIds', 'userFacing', 'requiredForGoal'];
const DECISION_DEFINITION_KEYS = ['decisionId', 'subjectId', 'choice', 'rationale', 'evidenceRefs'];
function replaceDefinition(current, definition, eventId, definitionKeys) {
  for (const key of definitionKeys) delete current[key];
  Object.assign(current, structuredClone(definition));
  addDerived(current, eventId);
}
function compareText(left, right) { return left === right ? 0 : left < right ? -1 : 1; }
function setDerivedAxis(item, field, value, eventId) {
  if (item[field] === value) return;
  item[field] = value;
  if (item.derivedFromEventIds && !item.derivedFromEventIds.includes(eventId)) addDerived(item, eventId);
}
function criterionVerification(state, criterion) {
  if (criterion.lifecycle !== 'active') return 'not_applicable';
  const latestByKind = criterion.requiredEvidenceKinds.map((kind) => (
    [...criterion.evidenceRefs].reverse()
      .map((evidenceId) => evidenceById(state, evidenceId))
      .find((evidence) => evidence?.kind === kind)
  ));
  if (latestByKind.some((evidence) => !evidence)) return 'not_run';
  if (latestByKind.some((evidence) => evidence.outcome === 'failed')) return 'failed';
  if (latestByKind.some((evidence) => !evidencePolicyFacts(evidence).authorizing)) return 'inconclusive';
  return 'passed';
}
function aggregateVerification(values, { noCriteria = 'not_run' } = {}) {
  if (!values.length) return noCriteria;
  if (values.includes('failed')) return 'failed';
  if (values.includes('inconclusive')) return 'inconclusive';
  if (values.includes('not_run')) return 'not_run';
  return values.every((value) => value === 'passed') ? 'passed' : 'not_applicable';
}
function acceptanceFromFeedback(state, subjectId, fallback) {
  const feedback = [...state.feedback].reverse().find((item) => item.subjectId === subjectId && item.lifecycle === 'active');
  if (!feedback) return fallback;
  if (feedback.acceptanceEffect === 'accept') return 'accepted';
  if (feedback.acceptanceEffect === 'reject') return 'rejected';
  return 'pending';
}
function recomputeProjectionTruthAxes(state, eventId) {
  for (const criterion of state.criteria) {
    setDerivedAxis(criterion, 'verification', criterionVerification(state, criterion), eventId);
  }
  for (const task of state.tasks) {
    const criteria = task.criterionIds
      .map((criterionId) => state.criteria.find((criterion) => criterion.criterionId === criterionId))
      .filter(Boolean);
    const active = criteria.filter((criterion) => criterion.lifecycle === 'active');
    const noCriteria = criteria.length ? 'not_applicable' : 'not_run';
    setDerivedAxis(task, 'verification', aggregateVerification(active.map((criterion) => criterion.verification), { noCriteria }), eventId);
    setDerivedAxis(task, 'acceptance', acceptanceFromFeedback(state, task.taskId, task.userFacing ? 'pending' : 'not_requested'), eventId);
  }
  for (const goal of state.goals) {
    setDerivedAxis(goal, 'acceptance', acceptanceFromFeedback(state, goal.goalId, 'pending'), eventId);
  }
}
function sortState(state) {
  const stableKeys = {
    goals: ['goalId'], criteria: ['criterionId'], tasks: ['taskId'], attempts: ['attemptId'], claims: ['claimId'], evidence: ['evidenceId'],
    failures: ['failureId'], feedback: ['feedbackId'], handoffs: ['handoffId'], lessons: ['lessonId'], decisions: ['decisionId'],
    contradictions: ['contradictionId'], legacyImports: ['legacyId', 'archiveHistory'], sourceRefs: ['path'],
  };
  for (const [collection, keys] of Object.entries(stableKeys)) {
    state[collection].sort((left, right) => {
      for (const key of keys) { const compared = compareText(String(left[key] ?? ''), String(right[key] ?? '')); if (compared) return compared; }
      return compareText(String(left.derivedFromEventIds?.[0] ?? ''), String(right.derivedFromEventIds?.[0] ?? ''));
    });
  }
  return state;
}

function assertProjectionCollectionBounds(value) {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      if (current.length > MAX_ITEMS) throw new MemoryError('projection collection exceeds the schema bound', 3);
      pending.push(...current);
    } else if (current && typeof current === 'object') {
      pending.push(...Object.values(current));
    }
  }
}
function claimKey(claim) { return sha256(canonicalV2({ subject: claim.subject, predicate: claim.predicate, scopeKey: claim.scopeKey })); }
function contradictionId(claimIds) { return `contradiction-${sha256(canonicalV2([...claimIds].sort())).slice(0, 24)}`; }

export function emptyProjectState() {
  const state = { schemaVersion: 2, projectionVersion: 1, generatedFrom: null, projectedAt: null, project: null, finalGoalId: null, goals: [], criteria: [], tasks: [], attempts: [], claims: [], evidence: [], failures: [], feedback: [], handoffs: [], lessons: [], decisions: [], contradictions: [], legacyImports: [], sourceRefs: [], workspaceAtLastEvent: null };
  Object.defineProperty(state, MIGRATION_MODE, { value: null, writable: true, enumerable: false });
  Object.defineProperty(state, MIGRATION_PROGRESS, { value: null, writable: true, enumerable: false });
  Object.defineProperty(state, EVENT_IDS, { value: new Set(), writable: false, enumerable: false });
  Object.defineProperty(state, EVENT_META, { value: new Map(), writable: false, enumerable: false });
  Object.defineProperty(state, CLAIM_ASSERTORS, { value: new Map(), writable: false, enumerable: false });
  return state;
}

export const REDUCER_HANDLERS = Object.fromEntries(EVENT_TYPES.map((type) => [type, (state, event) => applyEvent(state, event)]));
export const TRANSITION_TABLE = Object.freeze({ ...TRANSITION_VALIDATORS });
export const TEMPLATE_REGISTRY = Object.freeze(Object.fromEntries(EVENT_TYPES.map((type) => [type, Object.freeze({ eventType: type })])));

function applyEvent(s, e) {
  const p = e.payload; const derived = (collection, key, wanted) => entity(s, collection, key, wanted, key);
  switch (e.eventType) {
    case 'project.initialized': s.project = structuredClone(p.project); s[MIGRATION_MODE] = p.initialization; break;
    case 'goal.declared': { const g = cloneDefinition(p.goal, e.eventId, { lifecycle: 'active', acceptance: 'pending', failureIds: [] }); s.goals.push(g); if (g.isFinal) s.finalGoalId = g.goalId; break; }
    case 'goal.revised': replaceDefinition(derived('goals', 'goalId', p.goal.goalId), p.goal, e.eventId, GOAL_DEFINITION_KEYS); break;
    case 'goal.blocked': { const g = derived('goals', 'goalId', e.subject.id); g.lifecycle = 'blocked'; g.failureIds.push(p.failureId); g.nextAction = derived('failures', 'failureId', p.failureId).nextAction; addDerived(g, e.eventId); break; }
    case 'goal.reopened': { const g = derived('goals', 'goalId', e.subject.id); g.lifecycle = 'active'; addDerived(g, e.eventId); break; }
    case 'goal.abandoned': { const g = derived('goals', 'goalId', e.subject.id); g.lifecycle = 'abandoned'; g.failureIds.push(p.failureId); addDerived(g, e.eventId); break; }
    case 'goal.retired': { const g = derived('goals', 'goalId', e.subject.id); g.lifecycle = 'retired'; addDerived(g, e.eventId); break; }
    case 'goal.achieved': { const g = derived('goals', 'goalId', e.subject.id); g.lifecycle = 'achieved'; g.acceptance = 'accepted'; addDerived(g, e.eventId); break; }
    case 'criterion.declared': s.criteria.push(cloneDefinition(p.criterion, e.eventId, { lifecycle: 'active', verification: 'not_run', evidenceRefs: [] })); break;
    case 'criterion.revised': replaceDefinition(derived('criteria', 'criterionId', p.criterion.criterionId), p.criterion, e.eventId, CRITERION_DEFINITION_KEYS); break;
    case 'criterion.waived_by_user': { const c = derived('criteria', 'criterionId', e.subject.id); c.lifecycle = 'waived_by_user'; c.verification = 'not_applicable'; addDerived(c, e.eventId); break; }
    case 'criterion.reactivated': { const c = derived('criteria', 'criterionId', e.subject.id); c.lifecycle = 'active'; addDerived(c, e.eventId); break; }
    case 'criterion.retired': { const c = derived('criteria', 'criterionId', e.subject.id); c.lifecycle = 'retired'; addDerived(c, e.eventId); break; }
    case 'task.planned': s.tasks.push(cloneDefinition(p.task, e.eventId, { execution: 'planned', verification: 'not_run', acceptance: p.task.userFacing ? 'pending' : 'not_requested', attemptIds: [], failureIds: [], feedbackIds: [], evidenceRefs: [] })); break;
    case 'task.revised': replaceDefinition(derived('tasks', 'taskId', p.task.taskId), p.task, e.eventId, TASK_DEFINITION_KEYS); break;
    case 'attempt.started': { const a = cloneDefinition(p.attempt, e.eventId, { outcome: 'in_progress', startedAt: e.occurredAt, evidenceRefs: [] }); s.attempts.push(a); const t = derived('tasks', 'taskId', a.taskId); t.currentAttemptId = a.attemptId; t.attemptIds.push(a.attemptId); addDerived(t, e.eventId); break; }
    case 'attempt.reported': { const a = derived('attempts', 'attemptId', p.attemptId); Object.assign(a, { outcome: p.outcome, endedAt: p.endedAt, summary: p.summary, evidenceRefs: [...p.evidenceRefs] }); if (p.failureId) a.failureId = p.failureId; addDerived(a, e.eventId); if (p.outcome === 'succeeded' && a.respondsToFailureId) { const failure = derived('failures', 'failureId', a.respondsToFailureId); failure.resolvedByAttemptId = a.attemptId; failure.resolvedByEventId = e.eventId; addDerived(failure, e.eventId); } break; }
    case 'task.started': updateTask(s, e, 'in_progress'); break;
    case 'task.implemented': { const t = updateTask(s, e, 'implemented'); pushUnique(t.evidenceRefs, p.deliverableEvidenceRefs); break; }
    case 'task.blocked': { const t = updateTask(s, e, 'blocked'); t.failureIds.push(p.failureId); t.nextAction = derived('failures', 'failureId', p.failureId).nextAction; break; }
    case 'task.failed': { const t = updateTask(s, e, 'failed'); t.failureIds.push(p.failureId); t.nextAction = derived('failures', 'failureId', p.failureId).nextAction; break; }
    case 'task.completed': { const t = updateTask(s, e, 'completed'); pushUnique(t.evidenceRefs, p.criterionEvidenceRefs); delete t.currentAttemptId; break; }
    case 'task.abandoned': { const t = updateTask(s, e, 'abandoned'); delete t.currentAttemptId; break; }
    case 'task.reopened': { const t = updateTask(s, e, 'planned'); delete t.currentAttemptId; break; }
    case 'evidence.recorded': { const evidence = cloneDefinition(p.evidence, e.eventId); s.evidence.push(evidence); s.sourceRefs.push(...p.evidence.sourceRefs.filter((ref) => !s.sourceRefs.some((known) => known.path === ref.path))); for (const c of s.criteria.filter((item) => item.criterionId === evidence.subjectId)) { c.evidenceRefs.push(evidence.evidenceId); addDerived(c, e.eventId); } break; }
    case 'failure.recorded': s.failures.push(cloneDefinition(p.failure, e.eventId)); break;
    case 'feedback.satisfied': case 'feedback.dissatisfied': case 'feedback.rejected': case 'feedback.correction': { if (p.feedback.supersedesFeedbackId) { const old = derived('feedback', 'feedbackId', p.feedback.supersedesFeedbackId); old.lifecycle = 'superseded'; addDerived(old, e.eventId); } const f = cloneDefinition(p.feedback, e.eventId, { lifecycle: 'active' }); s.feedback.push(f); const task = s.tasks.find((t) => t.taskId === f.subjectId); if (task) { task.feedbackIds.push(f.feedbackId); if (f.nextAction) task.nextAction = f.nextAction; addDerived(task, e.eventId); } const goal = s.goals.find((g) => g.goalId === f.subjectId); if (goal) { if (f.nextAction) goal.nextAction = f.nextAction; addDerived(goal, e.eventId); } break; }
    case 'claim.asserted': { const c = cloneDefinition(p.claim, e.eventId, { lifecycle: 'active', claimKey: claimKey(p.claim), evidenceRefs: [...p.evidenceRefs] }); s.claims.push(c); s[CLAIM_ASSERTORS].set(c.claimId, structuredClone(e.actor)); recomputeAutomaticContradictions(s, e.eventId); break; }
    case 'claim.verified': { const c = derived('claims', 'claimId', p.claimId); pushUnique(c.evidenceRefs, p.evidenceRefs); addDerived(c, e.eventId); break; }
    case 'claim.disputed': {
      const ids = [...p.claimIds].sort();
      const idValue = contradictionId(ids);
      for (const claimId of ids) {
        const c = derived('claims', 'claimId', claimId);
        c.lifecycle = 'contested';
        c.contradictionId = idValue;
        addDerived(c, e.eventId);
      }
      let contradiction = s.contradictions.find((item) => item.contradictionId === idValue);
      if (!contradiction) {
        contradiction = {
          contradictionId: idValue, claimKey: derived('claims', 'claimId', ids[0]).claimKey,
          claimIds: ids, state: 'contested',
          reason: p.reason, evidenceRefs: [...p.evidenceRefs], derivedFromEventIds: [e.eventId],
        };
        s.contradictions.push(contradiction);
      } else {
        contradiction.state = 'contested';
        delete contradiction.resolvedByEventId;
        contradiction.reason = p.reason;
        contradiction.evidenceRefs = [...new Set([...(contradiction.evidenceRefs ?? []), ...p.evidenceRefs])];
        addDerived(contradiction, e.eventId);
      }
      break;
    }
    case 'claim.superseded': { const c = derived('claims', 'claimId', p.claimId); c.lifecycle = 'superseded'; addDerived(c, e.eventId); recomputeAutomaticContradictions(s, e.eventId); resolveManualContradictions(s, c.claimId, e.eventId); break; }
    case 'claim.retracted': { const c = derived('claims', 'claimId', p.claimId); c.lifecycle = 'retracted'; addDerived(c, e.eventId); recomputeAutomaticContradictions(s, e.eventId); resolveManualContradictions(s, c.claimId, e.eventId); break; }
    case 'handoff.assigned': s.handoffs.push(cloneDefinition(p.handoff, e.eventId, { state: 'assigned', evidenceRefs: [] })); break;
    case 'handoff.reported': { const h = derived('handoffs', 'handoffId', p.report.handoffId); h.state = 'reported'; h.report = structuredClone(p.report); addDerived(h, e.eventId); break; }
    case 'handoff.accepted': case 'handoff.rejected': { const h = derived('handoffs', 'handoffId', p.handoffId); h.state = e.eventType.split('.')[1]; h.decisionReason = p.reason; pushUnique(h.evidenceRefs, p.evidenceRefs); addDerived(h, e.eventId); break; }
    case 'handoff.cancelled': { const h = derived('handoffs', 'handoffId', p.handoffId); h.state = 'cancelled'; h.decisionReason = p.reason; pushUnique(h.evidenceRefs, p.evidenceRefs); addDerived(h, e.eventId); break; }
    case 'lesson.recorded': s.lessons.push(cloneDefinition(p.lesson, e.eventId)); break;
    case 'decision.recorded': s.decisions.push(cloneDefinition(p.decision, e.eventId)); break;
    case 'decision.revised': replaceDefinition(derived('decisions', 'decisionId', p.decision.decisionId), p.decision, e.eventId, DECISION_DEFINITION_KEYS); break;
    case 'migration.v1_imported': s.legacyImports.push({ ...structuredClone(p), freshness: 'unknown', derivedFromEventIds: [e.eventId] }); s[MIGRATION_PROGRESS] = { receiptEventId: e.eventId, expectedChunks: p.recordChunkCount, nextChunk: 0 }; break;
    case 'migration.v1_records_imported': for (const record of p.records) s.legacyImports.push({ ...structuredClone(record), freshness: 'unknown', derivedFromEventIds: [e.eventId] }); s[MIGRATION_PROGRESS].nextChunk += 1; break;
    default: throw new MemoryError('event has no reducer handler', 3);
  }
}

function updateTask(s, e, execution) { const t = entity(s, 'tasks', 'taskId', e.subject.id, 'task'); t.execution = execution; addDerived(t, e.eventId); return t; }
function recomputeAutomaticContradictions(s, eventId) {
  const groups = new Map();
  for (const claim of s.claims.filter((item) => ['active', 'contested'].includes(item.lifecycle))) {
    const bucket = `${claim.claimKey}\0${claim.cardinality === 'many' ? claim.valueKey : ''}`;
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(claim);
  }
  for (const claims of groups.values()) {
    if (new Set(claims.map((claim) => canonicalV2(claim.value))).size <= 1) continue;
    const ids = claims.map((claim) => claim.claimId).sort();
    const idValue = contradictionId(ids);
    let contradiction = s.contradictions.find((item) => item.contradictionId === idValue);
    if (!contradiction) {
      contradiction = {
        contradictionId: idValue, claimKey: claims[0].claimKey, claimIds: ids,
        state: 'contested', derivedFromEventIds: [eventId],
      };
      s.contradictions.push(contradiction);
    }
    for (const claim of claims) {
      claim.lifecycle = 'contested';
      claim.contradictionId = idValue;
    }
  }
  for (const contradiction of s.contradictions.filter((item) => item.state === 'contested' && item.reason === undefined)) {
    const active = contradiction.claimIds
      .map((idValue) => s.claims.find((claim) => claim.claimId === idValue))
      .filter((claim) => claim && ['active', 'contested'].includes(claim.lifecycle));
    if (new Set(active.map((claim) => canonicalV2(claim.value))).size > 1) continue;
    contradiction.state = 'resolved';
    contradiction.resolvedByEventId = eventId;
    addDerived(contradiction, eventId);
    for (const claim of active) {
      claim.lifecycle = 'active';
      if (claim.contradictionId === contradiction.contradictionId) delete claim.contradictionId;
    }
  }
}

function resolveManualContradictions(s, claimId, eventId) {
  for (const contradiction of s.contradictions.filter((item) => (
    item.state === 'contested' && item.reason !== undefined && item.claimIds.includes(claimId)
  ))) {
    const members = contradiction.claimIds
      .map((idValue) => s.claims.find((claim) => claim.claimId === idValue))
      .filter(Boolean);
    const active = members.filter((claim) => ['active', 'contested'].includes(claim.lifecycle));
    if (active.length > 1) continue;
    contradiction.state = 'resolved';
    contradiction.resolvedByEventId = eventId;
    addDerived(contradiction, eventId);
    for (const claim of members) {
      if (claim.lifecycle === 'contested') claim.lifecycle = 'active';
      if (claim.contradictionId === contradiction.contradictionId) delete claim.contradictionId;
    }
  }
}

export function foldV2(events) {
  const state = emptyProjectState();
  let previous = ZERO_HASH;
  events.forEach((candidate, index) => {
    const event = validatedEnvelopeSnapshot(candidate, index, previous);
    if (state[EVENT_IDS].has(event.eventId)) throw new MemoryError('history contains a duplicate eventId', 3);
    validateTransition(event, state, { replay: true });
    REDUCER_HANDLERS[event.eventType](state, event);
    recomputeProjectionTruthAxes(state, event.eventId);
    assertProjectionCollectionBounds(state);
    state[EVENT_IDS].add(event.eventId);
    state[EVENT_META].set(event.eventId, {
      sequence: event.sequence,
      eventType: event.eventType,
      actor: structuredClone(event.actor),
      subject: structuredClone(event.subject),
      recordedAt: event.recordedAt,
      occurredAt: event.occurredAt,
    });
    state.generatedFrom = { epochId: event.epochId, sequence: event.sequence, eventHash: event.eventHash };
    state.projectedAt = event.recordedAt;
    state.workspaceAtLastEvent = structuredClone(event.workspaceAtRecord);
    previous = event.eventHash;
  });
  return sortState(state);
}

function validatedEnvelopeSnapshot(candidate, index, previousHash) {
  const event = snapshotCallerValue(candidate, `history event ${index + 1}`, 3);
  const fields = ['schemaVersion', 'epochId', 'sequence', 'eventId', 'eventType', 'recordedAt', 'occurredAt', 'actor', 'subject', 'goalId', 'taskId', 'supersedes', 'contradicts', 'evidenceRefs', 'sensitivity', 'payload', 'workspaceAtRecord', 'previousEventHash', 'eventHash'];
  exact(event, fields, fields.filter((field) => !['goalId', 'taskId'].includes(field)), `history event ${index + 1}`);
  if (event.schemaVersion !== 2 || event.sequence !== index + 1) throw new MemoryError(`history event ${index + 1} version or sequence mismatch`, 3);
  id(event.epochId, 'epochId'); id(event.eventId, 'eventId'); timestamp(event.recordedAt, 'recordedAt'); workspace(event.workspaceAtRecord, 'workspaceAtRecord');
  if (Date.parse(event.occurredAt) > Date.parse(event.recordedAt) + 300_000) throw new MemoryError('occurredAt is more than five minutes in the future');
  if (event.previousEventHash !== previousHash || !HASH.test(event.eventHash)) throw new MemoryError('history hash chain mismatch', 3);
  validateDraftSnapshot(Object.fromEntries(fields.filter((field) => ['eventType', 'occurredAt', 'actor', 'subject', 'goalId', 'taskId', 'supersedes', 'contradicts', 'evidenceRefs', 'sensitivity', 'payload'].includes(field) && event[field] !== undefined).map((field) => [field, event[field]])));
  const material = { ...event }; delete material.eventHash;
  if (sha256(canonicalV2(material)) !== event.eventHash) throw new MemoryError('history event hash mismatch', 3);
  return freezeSnapshot(event);
}

export function validateEnvelope(event, index, previousHash) {
  validatedEnvelopeSnapshot(event, index, previousHash);
}

export function buildEnvelope(draft, { epochId, sequence, recordedAt, workspaceAtRecord, previousEventHash }) {
  const valid = validateDraftShape(draft);
  if (Date.parse(valid.occurredAt) > Date.parse(recordedAt) + 300_000) throw new MemoryError('occurredAt is more than five minutes in the future');
  const eventId = `event-${epochId.slice(6, 30)}-${String(sequence).padStart(6, '0')}`;
  const envelopeDraft = structuredClone(valid);
  const material = { schemaVersion: 2, epochId, sequence, eventId, ...envelopeDraft, recordedAt, workspaceAtRecord, previousEventHash };
  const ordered = { schemaVersion: material.schemaVersion, epochId: material.epochId, sequence: material.sequence, eventId: material.eventId, eventType: material.eventType, recordedAt: material.recordedAt, occurredAt: material.occurredAt, actor: material.actor, subject: material.subject, ...(material.goalId ? { goalId: material.goalId } : {}), ...(material.taskId ? { taskId: material.taskId } : {}), supersedes: material.supersedes, contradicts: material.contradicts, evidenceRefs: material.evidenceRefs, sensitivity: material.sensitivity, payload: material.payload, workspaceAtRecord: material.workspaceAtRecord, previousEventHash: material.previousEventHash };
  return { ...ordered, eventHash: sha256(canonicalV2(ordered)) };
}

export function createDraftTemplate(eventType) {
  if (!EVENT_TYPES.includes(eventType)) throw new MemoryError('unknown event type');
  return { eventType, actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' }, subject: { type: eventType.split('.')[0], id: `${eventType.split('.')[0]}-replace-me` }, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal', payload: {} };
}
