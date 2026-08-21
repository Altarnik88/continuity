import {
  CALIBRATION_STATES,
  CAPABILITY_PROFILES,
  COST_TIERS,
  SECRET_AGENT_FIELDS,
  SPEED_TIERS,
  TRUST_TIERS,
} from './contract.mjs';

const BACKLOG_TERMINAL_EXECUTIONS = new Set(['failed', 'superseded']);
const AUTHORIZING_TEST_KINDS = new Set(['command', 'test']);
const DRIVE_PATH = /^[A-Za-z]:/;
const AGENT_ID = /^[a-z][a-z0-9_]*-[a-z0-9][a-z0-9-]{1,72}$/;
const AGENT_FIELDS = new Set([
  'actorId', 'providerFamily', 'modelFamily', 'capabilityProfiles', 'costTier', 'speedTier',
  'contextCapacity', 'availableTools', 'worktreeSupport', 'trustTier', 'platformLimitations',
  'calibrationStatus', 'kind',
]);
const AGENT_KINDS = new Set(['coordinator', 'subagent', 'tool']);

function plainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function forbiddenAgentField(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_AGENT_FIELDS.includes(key)) return key;
    const found = forbiddenAgentField(nested, seen);
    if (found) return found;
  }
  return null;
}

function agentText(value, label, max = 80) {
  if (typeof value !== 'string' || !value.length || value.length > max
    || value !== value.trim() || value !== value.normalize('NFC')
    || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
    return { ok: false, reason: `${label} is invalid` };
  }
  return { ok: true, value };
}

function agentTextList(value, label, { allowed } = {}) {
  if (!Array.isArray(value) || value.length > 50) return { ok: false, reason: `${label} must be an array` };
  const normalized = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = agentText(value[index], `${label}[${index}]`);
    if (!item.ok) return item;
    if (allowed && !allowed.includes(item.value)) return { ok: false, reason: `unknown ${label}: ${item.value}` };
    normalized.push(item.value);
  }
  return { ok: true, value: [...new Set(normalized)].sort() };
}

export function normalizePersistedAgent(input) {
  if (!plainRecord(input)) return { ok: false, reason: 'agent must be an object' };
  const secretField = forbiddenAgentField(input);
  if (secretField) return { ok: false, reason: `agent must not store ${secretField}` };
  const unknown = Object.keys(input).find((key) => !AGENT_FIELDS.has(key));
  if (unknown) return { ok: false, reason: `agent contains unknown field ${unknown}` };
  if (typeof input.actorId !== 'string' || !AGENT_ID.test(input.actorId)) {
    return { ok: false, reason: 'agent.actorId is not a stable ID' };
  }
  const providerFamily = agentText(input.providerFamily ?? 'unspecified', 'agent.providerFamily');
  if (!providerFamily.ok) return providerFamily;
  const modelFamily = agentText(input.modelFamily ?? 'unspecified', 'agent.modelFamily');
  if (!modelFamily.ok) return modelFamily;
  const capabilityProfiles = agentTextList(input.capabilityProfiles ?? [], 'capabilityProfiles', {
    allowed: CAPABILITY_PROFILES,
  });
  if (!capabilityProfiles.ok) return capabilityProfiles;
  const availableTools = agentTextList(input.availableTools ?? [], 'availableTools');
  if (!availableTools.ok) return availableTools;
  const platformLimitations = agentTextList(input.platformLimitations ?? [], 'platformLimitations');
  if (!platformLimitations.ok) return platformLimitations;
  const costTier = input.costTier ?? 'standard';
  if (!COST_TIERS.includes(costTier)) return { ok: false, reason: 'agent.costTier is invalid' };
  const speedTier = input.speedTier ?? 'standard';
  if (!SPEED_TIERS.includes(speedTier)) return { ok: false, reason: 'agent.speedTier is invalid' };
  const trustTier = input.trustTier ?? 'unknown';
  if (!TRUST_TIERS.includes(trustTier)) return { ok: false, reason: 'agent.trustTier is invalid' };
  const calibrationStatus = input.calibrationStatus ?? 'untested';
  if (!CALIBRATION_STATES.includes(calibrationStatus)) {
    return { ok: false, reason: 'agent.calibrationStatus is invalid' };
  }
  if (trustTier === 'high' && calibrationStatus !== 'calibrated') {
    return { ok: false, reason: 'calibration must not grant a high trust tier' };
  }
  const contextCapacity = input.contextCapacity ?? null;
  if (contextCapacity !== null && (!Number.isSafeInteger(contextCapacity) || contextCapacity < 1)) {
    return { ok: false, reason: 'agent.contextCapacity is invalid' };
  }
  if (input.worktreeSupport !== undefined && typeof input.worktreeSupport !== 'boolean') {
    return { ok: false, reason: 'agent.worktreeSupport must be boolean' };
  }
  const kind = input.kind ?? 'subagent';
  if (!AGENT_KINDS.has(kind)) return { ok: false, reason: 'agent.kind is invalid' };
  return {
    ok: true,
    normalized: {
      actorId: input.actorId,
      providerFamily: providerFamily.value,
      modelFamily: modelFamily.value,
      capabilityProfiles: capabilityProfiles.value,
      costTier,
      speedTier,
      contextCapacity,
      availableTools: availableTools.value,
      worktreeSupport: input.worktreeSupport ?? false,
      trustTier,
      platformLimitations: platformLimitations.value,
      calibrationStatus,
      kind,
    },
  };
}

function combineFreshness(values) {
  if (values.includes('stale')) return 'stale';
  if (values.includes('unknown')) return 'unknown';
  if (values.includes('fresh')) return 'fresh';
  return 'not_applicable';
}

export function persistedEvidenceFreshness(live = {}, evidence = {}) {
  const axes = {
    commit: live.head && evidence.commit && live.head !== 'unavailable' && evidence.commit !== 'unavailable'
      ? (live.head === evidence.commit ? 'fresh' : 'stale')
      : (live.head === 'unavailable' || evidence.commit === 'unavailable' ? 'unknown' : 'not_applicable'),
    worktree: live.dirty === true ? 'stale' : live.dirty === false ? 'fresh' : 'unknown',
    evidence: evidence.outcome === 'passed'
      ? (live.expiredEvidenceIds?.includes(evidence.evidenceId) ? 'stale' : 'fresh')
      : 'unknown',
    source: evidence.sourceRefs?.length
      ? (live.unreadableSources ? 'unknown' : 'fresh')
      : 'not_applicable',
  };
  if (live.head && evidence.commit && live.head !== evidence.commit && live.head !== 'unavailable') {
    axes.commit = 'stale';
  }
  return { ...axes, aggregate: combineFreshness(Object.values(axes)) };
}

function resultHasFreshAuthorizingChecks(state, criterion, result, live) {
  if (result.execution !== 'succeeded' || result.verification !== 'passed') return false;
  if (!(result.criterionIds ?? []).includes(criterion.criterionId)) return false;
  const evidence = (result.evidenceIds ?? [])
    .map((evidenceId) => state.evidence.find((item) => item.evidenceId === evidenceId))
    .filter((item) => item
      && item.authorizing === true
      && item.outcome === 'passed'
      && AUTHORIZING_TEST_KINDS.has(item.kind)
      && (item.criterionIds ?? []).includes(criterion.criterionId)
      && persistedEvidenceFreshness(live, item).aggregate === 'fresh');
  const required = (criterion.requiredEvidenceKinds ?? [])
    .filter((kind) => AUTHORIZING_TEST_KINDS.has(kind));
  return required.length
    ? required.every((kind) => evidence.some((item) => item.kind === kind))
    : evidence.length > 0;
}

export function criterionHasFreshAuthorizingResult(state, criterion, live = {}) {
  return (state.results ?? []).some((result) => (
    resultHasFreshAuthorizingChecks(state, criterion, result, live)
  ));
}

export function requiredCriterionBacklogViolations(state, live = {}) {
  const violations = [];
  for (const criterion of state.criteria ?? []) {
    if (criterion.waivableByUser !== false) continue;
    const linked = (state.tasks ?? []).filter((task) => (
      (task.criterionIds ?? []).includes(criterion.criterionId)
    ));
    if (!linked.some((task) => task.priority === 'backlog')) continue;
    const active = linked.some((task) => task.priority !== 'backlog'
      && !BACKLOG_TERMINAL_EXECUTIONS.has(task.execution));
    const satisfied = criterionHasFreshAuthorizingResult(state, criterion, live);
    if (!active && !satisfied) violations.push(criterion.criterionId);
  }
  return violations;
}

export function canonicalOwnershipClaims(values) {
  if (values === undefined) return { ok: true, claims: [] };
  if (!Array.isArray(values)) return { ok: false, reason: 'ownership must be an array' };
  const claims = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value.length || value.length > 200
      || value !== value.trim() || value !== value.normalize('NFC')
      || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
      || value.startsWith('~') || value.startsWith('/') || value.startsWith('\\')
      || DRIVE_PATH.test(value) || value.includes(':') || value.includes('\\')) {
      return { ok: false, reason: 'ownership must be canonical repository-relative paths or modules' };
    }
    const segments = value.split('/');
    if (segments.some((segment) => !segment.length || segment === '.' || segment === '..')) {
      return { ok: false, reason: 'ownership must be canonical repository-relative paths or modules' };
    }
    claims.push(segments.join('/'));
  }
  return { ok: true, claims: [...new Set(claims)].sort() };
}

export function taskOwnershipClaims(task = {}) {
  const explicit = [
    ...(Array.isArray(task.ownershipScope) ? task.ownershipScope : []),
    ...(Array.isArray(task.pathOwnership) ? task.pathOwnership : []),
  ];
  const selected = explicit.length ? explicit : task.moduleId ? [task.moduleId] : [];
  return canonicalOwnershipClaims(selected);
}

export function assignmentOwnershipClaims(assignment = {}, tasks = []) {
  const explicit = canonicalOwnershipClaims(assignment.pathOwnership);
  if (!explicit.ok) return explicit;
  const claims = [...explicit.claims];
  for (const task of tasks) {
    const resolved = taskOwnershipClaims(task);
    if (!resolved.ok) return resolved;
    claims.push(...resolved.claims);
  }
  return canonicalOwnershipClaims(claims);
}

function claimOverlaps(left, right) {
  const foldedLeft = left.toLowerCase();
  const foldedRight = right.toLowerCase();
  return foldedLeft === foldedRight
    || foldedLeft.startsWith(`${foldedRight}/`)
    || foldedRight.startsWith(`${foldedLeft}/`);
}

export function ownershipClaimsOverlap(left = [], right = []) {
  const normalizedLeft = canonicalOwnershipClaims(left);
  const normalizedRight = canonicalOwnershipClaims(right);
  if (!normalizedLeft.ok || !normalizedRight.ok) return true;
  return normalizedLeft.claims.some((leftClaim) => (
    normalizedRight.claims.some((rightClaim) => claimOverlaps(leftClaim, rightClaim))
  ));
}

function taskCapabilities(task = {}) {
  return [...new Set(task.requiredCapabilities ?? task.capabilities ?? [])].sort();
}

function focusedVerificationValues(task = {}) {
  return [...new Set((task.focusedVerification ?? []).filter(Boolean))].sort();
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function persistedPacketIsolationReason(task = {}) {
  if (task.size === 'XL') return 'xl-must-split';
  if (task.complexity === 'high') return 'complex';
  if (task.risk === 'critical') return 'critical-risk';
  if (task.risk === 'significant') return 'significant-risk';
  if (task.size === 'L') return 'large';
  if (taskCapabilities(task).includes('security_critical') || task.class === 'security') return 'security';
  if (task.class === 'migration') return 'migration';
  if (task.class === 'architecture') return 'architecture';
  return null;
}

export function persistedTasksMayBatch(left = {}, right = {}) {
  if (persistedPacketIsolationReason(left) || persistedPacketIsolationReason(right)) return false;
  if (!['XS', 'S'].includes(left.size) || !['XS', 'S'].includes(right.size)) return false;
  if (!left.moduleId || left.moduleId !== right.moduleId) return false;
  if (!sameValues(taskCapabilities(left), taskCapabilities(right))) return false;
  const leftOwnership = taskOwnershipClaims(left);
  const rightOwnership = taskOwnershipClaims(right);
  if (!leftOwnership.ok || !rightOwnership.ok
    || ownershipClaimsOverlap(leftOwnership.claims, rightOwnership.claims)) return false;
  if (['architecture', 'migration', 'security'].includes(left.class)
    || ['architecture', 'migration', 'security'].includes(right.class)) return false;
  if ((left.class === 'cosmetic') !== (right.class === 'cosmetic')) return false;
  if (!sameValues(focusedVerificationValues(left), focusedVerificationValues(right))) return false;
  return true;
}

export function persistedPacketPolicy(packet = {}, tasks = []) {
  if (!Array.isArray(packet.taskIds) || packet.taskIds.length < 1 || packet.taskIds.length > 4) {
    return { ok: false, reason: 'work packet requires 1-4 task ids' };
  }
  if (tasks.length !== packet.taskIds.length) return { ok: false, reason: 'work packet tasks are incomplete' };
  if (tasks.some((task) => task.size === 'XL')) {
    return { ok: false, reason: 'XL tasks cannot be assigned before they are split' };
  }
  if (tasks.length > 1) {
    for (let left = 0; left < tasks.length; left += 1) {
      for (let right = left + 1; right < tasks.length; right += 1) {
        if (!persistedTasksMayBatch(tasks[left], tasks[right])) {
          return { ok: false, reason: 'work packet batching or isolation rules were violated' };
        }
      }
    }
  }
  const ownership = assignmentOwnershipClaims({ pathOwnership: packet.allowedPaths }, tasks);
  if (!ownership.ok) return ownership;
  const requiredCapabilities = [...new Set(tasks.flatMap(taskCapabilities))].sort();
  const riskCeiling = tasks.some((task) => task.risk === 'critical')
    ? 'critical'
    : tasks.some((task) => task.risk === 'significant') ? 'significant' : 'routine';
  const isolationReason = tasks.length === 1 ? persistedPacketIsolationReason(tasks[0]) : null;
  return {
    ok: true,
    normalized: {
      allowedPaths: ownership.claims,
      requiredCapabilities,
      riskCeiling,
      isolationReason,
      isolated: Boolean(isolationReason),
      moduleId: tasks.every((task) => task.moduleId === tasks[0]?.moduleId)
        ? (tasks[0]?.moduleId ?? null)
        : null,
    },
  };
}

export function persistedAgentSatisfies(agent, requiredCapabilities = [], { risk = 'routine' } = {}) {
  if (!agent || agent.kind === 'user') return false;
  const profiles = Array.isArray(agent.capabilityProfiles) ? agent.capabilityProfiles : [];
  const capabilitiesKnown = agent.calibrationStatus === 'calibrated' || profiles.length > 0;
  if (risk === 'critical'
    && (!['low', 'standard', 'high'].includes(agent.trustTier) || !capabilitiesKnown)) return false;
  if (requiredCapabilities.includes('security_critical') && !profiles.includes('security_critical')) return false;
  return requiredCapabilities.every((capability) => profiles.includes(capability));
}

function sameIds(left = [], right = []) {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((value, index) => value === sortedRight[index]);
}

export function persistedAssignmentPolicy({
  assignment = {}, packet, tasks = [], agents = [], held = [],
} = {}) {
  if (!packet || packet.packetId !== assignment.packetId) {
    return { ok: false, reason: 'assignment packet is not registered' };
  }
  if (!sameIds(assignment.taskIds, packet.taskIds)) {
    return { ok: false, reason: 'assignment task ids do not match the registered packet' };
  }
  const packetPolicy = persistedPacketPolicy(packet, tasks);
  if (!packetPolicy.ok) return packetPolicy;
  const agent = agents.find((item) => item.actorId === assignment.actorId);
  if (!agent) return { ok: false, reason: 'assignment actor is invalid or unregistered' };
  if (!persistedAgentSatisfies(agent, packetPolicy.normalized.requiredCapabilities, {
    risk: packetPolicy.normalized.riskCeiling,
  })) {
    return {
      ok: false,
      reason: packetPolicy.normalized.riskCeiling === 'critical'
        ? 'critical task cannot use an unknown or insufficient capability'
        : 'assignment actor has insufficient capability',
    };
  }
  const ownership = assignmentOwnershipClaims(assignment, tasks);
  if (!ownership.ok) return ownership;
  if (held.some((item) => item.state === 'held' && (
    (item.taskIds ?? []).some((taskId) => assignment.taskIds.includes(taskId))
    || ownershipClaimsOverlap(item.pathOwnership ?? [], ownership.claims)
  ))) {
    return { ok: false, reason: 'duplicate or conflicting assignment ownership' };
  }
  return {
    ok: true,
    normalized: {
      pathOwnership: ownership.claims,
      requiredCapabilities: packetPolicy.normalized.requiredCapabilities,
      riskCeiling: packetPolicy.normalized.riskCeiling,
    },
  };
}
