export {
  COORDINATION_CONTRACT_ID,
  COORDINATION_CONTRACT_VERSION,
  PROTOCOL_PACKAGE,
  PROTOCOL_PACKAGE_VERSION,
  COORDINATOR_RUNTIME_VERSION,
  CONTINUITY_CLI_VERSION,
  readProductVersion,
  COMPATIBILITY_MATRIX,
  COORDINATION_OPERATIONS,
  ADAPTER_METHODS,
  SECRET_AGENT_FIELDS,
  CONTEXT_ASSIGN_THRESHOLD,
  CONTEXT_RESERVE,
  CAPABILITY_PROFILES,
  TASK_CLASSES,
  TASK_PRIORITIES,
  TASK_SIZES,
  TASK_RISKS,
  RUN_STATES,
  REPORT_STATUSES,
} from './compatibility.mjs';
export {
  ProtocolError,
  assertSafePayload,
  assertKnownFields,
  rejectSecretText,
  rejectPrivatePaths,
  MAX_PROTOCOL_BYTES,
} from './secrets.mjs';
export {
  validateWorkPacket,
  validateAssignment,
  validateAttemptReport,
  validateEvidenceRecord,
  validateVerificationReport,
  validateContextHandoff,
  validateCoordinatorRunState,
  ownershipOverlap,
} from './validate.mjs';
export {
  assertMemoryPort,
  assertContinuityReadPort,
  assertCoordinatorWritePort,
  assertAgentRuntimeAdapter,
  protocolOperations,
} from './ports.mjs';
export { classifyAdapter, adapterHealthDocument } from './adapter.mjs';
export { createCliClient, BUNDLED_CONTINUITY_CLI, sanitizedSpawnEnv, parseRecordedEvent } from './client.mjs';
