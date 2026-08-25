import {
  ASSIGNMENT_STATES,
  CAPABILITY_PROFILES,
  COORDINATION_CONTRACT_ID,
  COORDINATION_CONTRACT_VERSION,
  PACKET_ISOLATION_REASONS,
  REPORT_STATUSES,
  RUN_STATES,
  TASK_RISKS,
} from './compatibility.mjs';
import {
  ProtocolError,
  assertKnownFields,
  assertSafePayload,
  rejectPrivatePaths,
} from './secrets.mjs';

const ID = /^[a-z][a-z0-9_]*-[a-z0-9][a-z0-9-]{1,72}$/;

function fail(message) {
  throw new ProtocolError(message, 2);
}

function requireId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) fail(`${label} is not a stable ID`);
  return value;
}

const WORK_PACKET_FIELDS = new Set([
  'waveId', 'packetId', 'actorId', 'runId', 'goal', 'dependencies', 'taskIds',
  'allowedPaths', 'forbiddenPaths', 'requiredCapabilities', 'riskCeiling',
  'contextBudget', 'acceptanceCriteria', 'focusedChecks', 'knownFailures',
  'prohibitedApproaches', 'reportFormat', 'weight', 'isolationReason',
]);

const ASSIGNMENT_FIELDS = new Set([
  'assignmentId', 'packetId', 'taskIds', 'actorId', 'runId', 'role', 'state',
  'pathOwnership', 'generation',
]);

const ATTEMPT_REPORT_FIELDS = new Set([
  'status', 'actorId', 'runId', 'packetId', 'changedPaths', 'unchangedPaths',
  'approach', 'commandsExecuted', 'testCounts', 'evidence', 'failures',
  'limitations', 'prohibitedApproachesLearned', 'exactNextStep',
]);

const EVIDENCE_FIELDS = new Set([
  'kind', 'source', 'expected', 'actual', 'exitCode', 'authorizing', 'command',
]);

const VERIFICATION_FIELDS = new Set([
  'resultId', 'found', 'executed', 'passed', 'failed', 'skipped', 'outcome',
]);

const HANDOFF_FIELDS = new Set([
  'taskId', 'packetId', 'lastCompletedStep', 'actualState', 'changedPaths',
  'failedHypotheses', 'limitations', 'nextStep', 'evidenceIds',
]);

const RUN_STATE_FIELDS = new Set([
  'schemaVersion', 'contractId', 'contractVersion', 'runId', 'status',
  'createdAt', 'updatedAt', 'adapter', 'slots', 'waveId', 'assignments',
  'openAttempts', 'completedPacketIds', 'stopReason', 'userAcceptance',
  'memoryProfile', 'configDigest',
]);

function stringList(value, label, { paths = false } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) fail(`${label}[${index}] is invalid`);
    return paths ? rejectPrivatePaths(item, `${label}[${index}]`) : item.trim();
  });
}

export function validateWorkPacket(input) {
  assertSafePayload(input, 'WorkPacket');
  assertKnownFields(input, WORK_PACKET_FIELDS, 'WorkPacket');
  const packet = {
    waveId: requireId(input.waveId, 'waveId'),
    packetId: requireId(input.packetId, 'packetId'),
    actorId: input.actorId ? requireId(input.actorId, 'actorId') : null,
    runId: input.runId ? requireId(input.runId, 'runId') : null,
    goal: typeof input.goal === 'string' ? input.goal : '',
    dependencies: stringList(input.dependencies, 'dependencies'),
    taskIds: stringList(input.taskIds, 'taskIds'),
    allowedPaths: stringList(input.allowedPaths, 'allowedPaths', { paths: true }),
    forbiddenPaths: stringList(input.forbiddenPaths, 'forbiddenPaths', { paths: true }),
    requiredCapabilities: stringList(input.requiredCapabilities, 'requiredCapabilities'),
    riskCeiling: TASK_RISKS.includes(input.riskCeiling) ? input.riskCeiling : 'routine',
    contextBudget: Number.isFinite(input.contextBudget) ? input.contextBudget : 4,
    acceptanceCriteria: stringList(input.acceptanceCriteria, 'acceptanceCriteria'),
    // Each entry is an argv array for the current Node binary, or a JSON string of that array.
    focusedChecks: Array.isArray(input.focusedChecks) ? input.focusedChecks : [],
    knownFailures: stringList(input.knownFailures, 'knownFailures'),
    prohibitedApproaches: stringList(input.prohibitedApproaches, 'prohibitedApproaches'),
    reportFormat: input.reportFormat || 'continuity-agent-report-v1',
    weight: Number.isFinite(input.weight) ? input.weight : 1,
    isolationReason: input.isolationReason && PACKET_ISOLATION_REASONS.includes(input.isolationReason)
      ? input.isolationReason
      : null,
  };
  if (!packet.taskIds.length) fail('WorkPacket requires taskIds');
  for (const capability of packet.requiredCapabilities) {
    if (!CAPABILITY_PROFILES.includes(capability)) fail(`unknown capability ${capability}`);
  }
  return packet;
}

export function validateAssignment(input) {
  assertSafePayload(input, 'Assignment');
  assertKnownFields(input, ASSIGNMENT_FIELDS, 'Assignment');
  const state = input.state || 'held';
  if (!ASSIGNMENT_STATES.includes(state)) fail('Assignment.state is invalid');
  return {
    assignmentId: requireId(input.assignmentId, 'assignmentId'),
    packetId: requireId(input.packetId, 'packetId'),
    taskIds: stringList(input.taskIds, 'taskIds'),
    actorId: requireId(input.actorId, 'actorId'),
    runId: input.runId ? requireId(input.runId, 'runId') : null,
    role: input.role === 'verifier' ? 'verifier' : 'executor',
    state,
    pathOwnership: stringList(input.pathOwnership, 'pathOwnership', { paths: true }),
    generation: Number.isSafeInteger(input.generation) ? input.generation : 1,
  };
}

export function validateAttemptReport(input) {
  assertSafePayload(input, 'AttemptReport');
  assertKnownFields(input, ATTEMPT_REPORT_FIELDS, 'AttemptReport');
  if (!REPORT_STATUSES.includes(input.status)) fail('AttemptReport.status is invalid');
  const counts = input.testCounts && typeof input.testCounts === 'object' ? input.testCounts : {};
  return {
    status: input.status,
    actorId: requireId(input.actorId, 'actorId'),
    runId: requireId(input.runId, 'runId'),
    packetId: requireId(input.packetId, 'packetId'),
    changedPaths: stringList(input.changedPaths, 'changedPaths', { paths: true }),
    unchangedPaths: stringList(input.unchangedPaths, 'unchangedPaths', { paths: true }),
    approach: typeof input.approach === 'string' ? input.approach : '',
    commandsExecuted: Array.isArray(input.commandsExecuted) ? input.commandsExecuted : [],
    testCounts: {
      found: Number(counts.found ?? 0),
      executed: Number(counts.executed ?? 0),
      passed: Number(counts.passed ?? 0),
      failed: Number(counts.failed ?? 0),
      skipped: Number(counts.skipped ?? 0),
    },
    evidence: Array.isArray(input.evidence) ? input.evidence : [],
    failures: stringList(input.failures, 'failures'),
    limitations: stringList(input.limitations, 'limitations'),
    prohibitedApproachesLearned: stringList(input.prohibitedApproachesLearned, 'prohibitedApproachesLearned'),
    exactNextStep: typeof input.exactNextStep === 'string' ? input.exactNextStep : '',
  };
}

export function validateEvidenceRecord(input) {
  assertSafePayload(input, 'EvidenceRecord');
  assertKnownFields(input, EVIDENCE_FIELDS, 'EvidenceRecord');
  const kind = input.kind === 'test' ? 'test' : 'command';
  const exitCode = Number(input.exitCode);
  if (!Number.isInteger(exitCode)) fail('EvidenceRecord.exitCode must be an integer');
  return {
    kind,
    source: typeof input.source === 'string' ? input.source : (input.command || 'command'),
    expected: typeof input.expected === 'string' ? input.expected : 'command succeeds',
    actual: typeof input.actual === 'string' ? input.actual : `exit ${exitCode}`,
    exitCode,
    authorizing: exitCode === 0 && (kind === 'command' || kind === 'test'),
    command: typeof input.command === 'string' ? input.command : null,
  };
}

export function validateVerificationReport(input) {
  assertSafePayload(input, 'VerificationReport');
  assertKnownFields(input, VERIFICATION_FIELDS, 'VerificationReport');
  const found = Number(input.found);
  const executed = Number(input.executed);
  const passed = Number(input.passed);
  const failed = Number(input.failed);
  const skipped = Number(input.skipped ?? 0);
  if (![found, executed, passed, failed, skipped].every(Number.isFinite)) {
    fail('VerificationReport counts must be numbers');
  }
  return {
    resultId: requireId(input.resultId, 'resultId'),
    found,
    executed,
    passed,
    failed,
    skipped,
    outcome: found >= 1 && executed >= 1 && passed >= 1 && failed === 0 ? 'passed' : 'failed',
  };
}

export function validateContextHandoff(input) {
  assertSafePayload(input, 'ContextHandoff');
  assertKnownFields(input, HANDOFF_FIELDS, 'ContextHandoff');
  if (!input.nextStep) fail('ContextHandoff requires nextStep');
  if (!input.taskId) fail('ContextHandoff requires taskId');
  if (input.lastCompletedStep == null || input.lastCompletedStep === '') {
    fail('ContextHandoff requires lastCompletedStep');
  }
  if (input.actualState == null || input.actualState === '') {
    fail('ContextHandoff requires actualState');
  }
  return {
    taskId: requireId(input.taskId, 'taskId'),
    packetId: input.packetId ? requireId(input.packetId, 'packetId') : null,
    lastCompletedStep: typeof input.lastCompletedStep === 'string' ? input.lastCompletedStep : '',
    actualState: typeof input.actualState === 'string' ? input.actualState : '',
    changedPaths: stringList(input.changedPaths, 'changedPaths', { paths: true }),
    failedHypotheses: stringList(input.failedHypotheses, 'failedHypotheses'),
    evidenceIds: stringList(input.evidenceIds, 'evidenceIds'),
    limitations: stringList(input.limitations, 'limitations'),
    nextStep: input.nextStep,
  };
}

export function validateCoordinatorRunState(input) {
  assertSafePayload(input, 'CoordinatorRunState');
  assertKnownFields(input, RUN_STATE_FIELDS, 'CoordinatorRunState');
  if (input.contractId !== COORDINATION_CONTRACT_ID) fail('CoordinatorRunState contractId mismatch');
  if (input.contractVersion !== COORDINATION_CONTRACT_VERSION) fail('CoordinatorRunState contractVersion mismatch');
  if (!RUN_STATES.includes(input.status)) fail('CoordinatorRunState.status is invalid');
  return {
    schemaVersion: 1,
    contractId: COORDINATION_CONTRACT_ID,
    contractVersion: COORDINATION_CONTRACT_VERSION,
    runId: requireId(input.runId, 'runId'),
    status: input.status,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    adapter: input.adapter || 'local-process',
    slots: Number.isSafeInteger(input.slots) ? input.slots : 1,
    waveId: input.waveId ? requireId(input.waveId, 'waveId') : null,
    assignments: Array.isArray(input.assignments) ? input.assignments : [],
    openAttempts: Array.isArray(input.openAttempts) ? input.openAttempts : [],
    completedPacketIds: Array.isArray(input.completedPacketIds) ? input.completedPacketIds : [],
    stopReason: input.stopReason ?? null,
    userAcceptance: input.userAcceptance || 'pending',
    memoryProfile: input.memoryProfile || 'local-cli',
    configDigest: input.configDigest || null,
  };
}

export function ownershipOverlap(left = [], right = []) {
  const fold = (value) => String(value).toLowerCase();
  return left.some((a) => right.some((b) => {
    const leftClaim = fold(a);
    const rightClaim = fold(b);
    return leftClaim === rightClaim
      || leftClaim.startsWith(`${rightClaim}/`)
      || rightClaim.startsWith(`${leftClaim}/`);
  }));
}
