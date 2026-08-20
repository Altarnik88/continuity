// Compatibility identifier retained so existing coordinator event consumers
// keep one stable protocol boundary; it does not imply a runtime dependency.
export const COORDINATION_CONTRACT_ID = 'project-memory.coordinator.v1';
export const COORDINATION_CONTRACT_VERSION = 1;

export const TASK_PRIORITIES = Object.freeze(['blocker', 'core', 'verification', 'backlog']);
export const TASK_SIZES = Object.freeze(['XS', 'S', 'M', 'L', 'XL']);
export const SIZE_WEIGHTS = Object.freeze({ XS: 1, S: 2, M: 4, L: 8, XL: null });
export const TASK_COMPLEXITIES = Object.freeze(['low', 'medium', 'high', 'unknown']);
export const TASK_RISKS = Object.freeze(['routine', 'significant', 'critical']);
export const CAPABILITY_PROFILES = Object.freeze([
  'mechanical', 'implementation', 'integration', 'deep_reasoning', 'security_critical', 'visual',
]);
export const TASK_CLASSES = Object.freeze([
  'unclassified',
  'function', 'connector', 'blocker', 'handoff',
  'infrastructure', 'wrapper', 'documentation', 'tests',
  'refactor', 'report', 'plugin', 'adapter', 'optimization',
  'architecture', 'migration', 'security', 'cosmetic',
]);
export const COST_TIERS = Object.freeze(['lowest', 'low', 'standard', 'high', 'highest']);
export const SPEED_TIERS = Object.freeze(['fastest', 'fast', 'standard', 'slow']);
export const TRUST_TIERS = Object.freeze(['unknown', 'low', 'standard', 'high']);
export const CALIBRATION_STATES = Object.freeze(['untested', 'limited', 'calibrated', 'failed']);
export const ASSIGNMENT_STATES = Object.freeze(['held', 'released', 'handed_off', 'superseded']);
export const PACKET_ISOLATION_REASONS = Object.freeze([
  'complex', 'significant-risk', 'critical-risk', 'large', 'xl-must-split',
  'security', 'migration', 'architecture',
]);

export const PRIORITY_RANK = Object.freeze({ blocker: 0, core: 1, verification: 2, backlog: 3 });
export const COST_RANK = Object.freeze({ lowest: 0, low: 1, standard: 2, high: 3, highest: 4 });
export const TRUST_RANK = Object.freeze({ unknown: 0, low: 1, standard: 2, high: 3 });

export const CONTEXT_ASSIGN_THRESHOLD = 0.65;
export const CONTEXT_RESERVE = 0.30;
export const MIN_BATCH_SMALL = 2;
export const MAX_BATCH_SMALL = 4;
export const DEFAULT_CONTEXT_BUDGET = 4;
export const REPAIR_HYPOTHESIS_LIMIT = 2;
export const NO_PROGRESS_REPLAN_LIMIT = 3;

export const BUILD_FIRST_ALLOWED_CLASSES = Object.freeze(['function', 'connector', 'blocker', 'handoff']);
export const BUILD_FIRST_FORBIDDEN_CLASSES = Object.freeze([
  'documentation', 'tests', 'plugin', 'adapter', 'refactor', 'report',
  'optimization', 'wrapper', 'infrastructure', 'cosmetic',
]);

export const SECRET_AGENT_FIELDS = Object.freeze([
  'apiKey', 'apiKeys', 'token', 'tokens', 'password', 'secret', 'secrets',
  'credential', 'credentials', 'billing', 'billingDetails', 'env', 'environment',
  'environmentVariables', 'authorization',
]);

export const COORDINATION_OPERATIONS = Object.freeze([
  'ready',
  'packets',
  'eligible',
  'assign',
  'start',
  'report',
  'context',
  'release',
  'request-verification',
  'verify',
  'wave',
  'handoff',
]);
