import { createHash } from 'node:crypto';

import { MemoryError } from '../domain-v3.mjs';
import {
  buildTaskAccumulator,
  compareTasks,
  criterionCoverage,
  dependencyGraph,
  isCoreProductTask,
  isRequiredCriterion,
  normalizeTaskClass,
  planSufficiency,
  sizeWeight,
} from './accumulator.mjs';
import {
  BUILD_FIRST_FORBIDDEN_CLASSES,
  CONTEXT_ASSIGN_THRESHOLD,
  COORDINATION_CONTRACT_ID,
  COORDINATION_CONTRACT_VERSION,
  DEFAULT_CONTEXT_BUDGET,
  MAX_BATCH_SMALL,
  MIN_BATCH_SMALL,
  NO_PROGRESS_REPLAN_LIMIT,
  REPAIR_HYPOTHESIS_LIMIT,
} from './contract.mjs';
import { agentSatisfies, cheapestEligible, independentVerifier } from './registry.mjs';
import {
  ownershipClaimsOverlap,
  persistedPacketIsolationReason,
  persistedPacketPolicy,
  persistedTasksMayBatch,
} from './persist-policy.mjs';

function fail(message) {
  throw new MemoryError(message, 2);
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function overlaps(left = [], right = []) {
  return ownershipClaimsOverlap(left, right);
}

export function buildFirstState(state) {
  const plan = planSufficiency(state);
  const coreSucceeded = state.results.some((result) => {
    const task = state.tasks.find((item) => item.taskId === result.taskId);
    const authorizingCheck = (result.evidenceIds ?? [])
      .map((evidenceId) => state.evidence.find((item) => item.evidenceId === evidenceId))
      .some((evidence) => evidence
        && evidence.taskId === result.taskId
        && evidence.authorizing === true
        && evidence.outcome === 'passed'
        && ['command', 'test'].includes(evidence.kind)
        && (evidence.criterionIds ?? []).some((criterionId) => (
          (result.criterionIds ?? task?.criterionIds ?? []).includes(criterionId)
        )));
    return task && isCoreProductTask(task)
      && result.execution === 'succeeded'
      && authorizingCheck;
  });
  const e2e = {
    initialized: Boolean(state.project),
    goal: Boolean(state.finalGoalId),
    criterion: state.criteria.length > 0,
    task: state.tasks.length > 0,
    attempt: state.attempts.length > 0,
    evidence: state.evidence.some((item) => item.authorizing === true),
    result: state.results.some((item) => item.execution === 'succeeded'),
    replayable: true,
    handoffable: state.tasks.length > 0,
  };
  const pathReady = Object.values(e2e).every(Boolean);
  return {
    passed: coreSucceeded || (pathReady && coreSucceeded),
    coreSucceeded,
    pathReady,
    e2e,
    plan,
  };
}

export function isBuildFirstAllowed(task, state, gate = buildFirstState(state)) {
  const recordClass = normalizeTaskClass(task.class);
  if (gate.passed) return { allowed: true, reason: 'build-first-passed' };
  if (task.priority === 'blocker' || recordClass === 'blocker') return { allowed: true, reason: 'confirmed-blocker' };
  if (['function', 'connector', 'handoff'].includes(recordClass)) return { allowed: true, reason: 'core-product-path' };
  if (BUILD_FIRST_FORBIDDEN_CLASSES.includes(recordClass)) {
    const linkable = recordClass === 'wrapper' || recordClass === 'infrastructure';
    const enables = task.enablesTaskIds ?? [];
    const enablesCore = linkable && enables.some((taskId) => {
      const target = state.tasks.find((item) => item.taskId === taskId);
      return target && isCoreProductTask(target) && !['succeeded', 'superseded'].includes(target.execution);
    });
    if (!enablesCore) {
      return { allowed: false, reason: 'wrapper-without-required-core-link' };
    }
    return { allowed: true, reason: 'required-infrastructure-for-core' };
  }
  return { allowed: false, reason: 'unclassified-task-class' };
}

export function readyTasks(state, live = {}, { agents = [], includeBacklog = false } = {}) {
  const accumulator = buildTaskAccumulator(state, live);
  const gate = buildFirstState(state);
  const graph = dependencyGraph(state.tasks);
  const held = (state.assignments ?? []).filter((item) => item.state === 'held');
  const owned = new Set(held.flatMap((item) => item.pathOwnership ?? item.ownershipScope ?? []));
  const ready = [];
  const excluded = [];
  for (const task of accumulator.tasks) {
    const blockedBy = graph.blockedBy.get(task.id) ?? [];
    const assignment = held.find((item) => item.taskIds.includes(task.id));
    const gateCheck = isBuildFirstAllowed({ ...task, class: task.class, enablesTaskIds: task.enablesTaskIds }, state, gate);
    let reason = null;
    if (task.priority === 'backlog' && !includeBacklog) reason = 'backlog-excluded';
    else if (graph.cyclic.has(task.id)) reason = 'dependency-cycle';
    else if (blockedBy.length) reason = 'unfinished-dependencies';
    else if (task.status === 'blocked') reason = 'confirmed-blocker';
    else if (task.status === 'succeeded' && task.verification === 'unverified') reason = 'needs-verification';
    else if (['succeeded', 'superseded'].includes(task.status)) reason = 'already-complete';
    else if (assignment) reason = 'already-assigned';
    else if (!gateCheck.allowed) reason = gateCheck.reason;
    else if (task.size === 'XL') reason = 'xl-must-split';
    else if (held.some((item) => overlaps(item.pathOwnership ?? [], task.ownershipScope))) reason = 'ownership-conflict';
    else if (agents.length && !cheapestEligible(agents, task.requiredCapabilities, { risk: task.risk })) {
      reason = task.risk === 'critical' ? 'insufficient-or-unknown-capability' : 'no-eligible-agent';
    }
    if (reason) excluded.push({ taskId: task.id, reason });
    else ready.push(task);
  }
  ready.sort(compareTasks);
  return {
    contractId: COORDINATION_CONTRACT_ID,
    contractVersion: COORDINATION_CONTRACT_VERSION,
    gate,
    ready,
    excluded,
    ownedPaths: [...owned].sort(),
    deterministicOrder: ready.map((item) => item.id),
  };
}

function isolationReason(task) {
  return persistedPacketIsolationReason(task);
}

function canBatch(left, right) {
  return persistedTasksMayBatch(left, right);
}

export function packetIdFor(taskIds) {
  return `packet-${sha(taskIds.slice().sort().join('|')).slice(0, 16)}`;
}

export function buildWorkPackets(tasks, { contextBudget = DEFAULT_CONTEXT_BUDGET } = {}) {
  const remaining = [...tasks].sort(compareTasks);
  const packets = [];
  while (remaining.length) {
    const seed = remaining.shift();
    const isolated = isolationReason(seed);
    const members = [seed];
    if (!isolated && ['XS', 'S'].includes(seed.size)) {
      for (let index = 0; index < remaining.length && members.length < MAX_BATCH_SMALL;) {
        const candidate = remaining[index];
        const nextWeight = members.reduce((sum, item) => sum + (item.weight ?? 0), 0) + (candidate.weight ?? 0);
        if (canBatch(seed, candidate) && members.every((item) => canBatch(item, candidate))
          && nextWeight <= contextBudget) {
          members.push(candidate);
          remaining.splice(index, 1);
        } else index += 1;
      }
      if (members.length === 1 && remaining.some((item) => canBatch(seed, item))) {
        /* keep singleton when a second compatible task does not fit the budget */
      } else if (members.length > 1 && members.length < MIN_BATCH_SMALL) {
        packets.push(makePacket(members, isolated));
        continue;
      }
    }
    packets.push(makePacket(members, isolated));
  }
  return packets;
}

function makePacket(tasks, isolated) {
  const taskIds = tasks.map((item) => item.id).sort();
  const capabilities = uniqueSorted(tasks.flatMap((item) => item.requiredCapabilities));
  const ownership = uniqueSorted(tasks.flatMap((item) => item.ownershipScope));
  const riskCeiling = tasks.some((item) => item.risk === 'critical')
    ? 'critical'
    : tasks.some((item) => item.risk === 'significant') ? 'significant' : 'routine';
  const weight = tasks.reduce((sum, item) => sum + (item.weight ?? 0), 0);
  return {
    packetId: packetIdFor(taskIds),
    taskIds,
    weight,
    prerequisites: uniqueSorted(tasks.flatMap((item) => item.dependencies)),
    allowedPaths: ownership,
    forbiddenPaths: [],
    requiredCapabilities: capabilities,
    riskCeiling,
    contextBudget: Math.max(weight, DEFAULT_CONTEXT_BUDGET),
    focusedChecks: uniqueSorted(tasks.flatMap((item) => item.focusedVerification)),
    completionContract: uniqueSorted(tasks.flatMap((item) => item.acceptanceCriteria.length
      ? item.acceptanceCriteria
      : [`task ${item.id} meets its criteria`])),
    handoffContract: {
      requireContextHandoffOnPartial: true,
      newActorRequiresNewAttempt: true,
    },
    isolated: Boolean(isolated),
    isolationReason: isolated,
    moduleId: tasks[0].moduleId,
  };
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

export function contextAllowsNewPacket({ usedRatio, exact, packetsAssigned = 0, lastPacket } = {}) {
  if (exact === true && typeof usedRatio === 'number') {
    return usedRatio < CONTEXT_ASSIGN_THRESHOLD;
  }
  if (!lastPacket) return packetsAssigned === 0;
  if (lastPacket.isolationReason === 'complex' || lastPacket.riskCeiling !== 'routine') return packetsAssigned < 1;
  if (lastPacket.weight >= 4) return packetsAssigned < 1;
  return packetsAssigned < 1;
}

export function selectWave(packets, {
  slots = 1,
  resourceLimit = Number.POSITIVE_INFINITY,
  agents = [],
} = {}) {
  const available = Math.max(0, Number.isSafeInteger(slots) ? slots : 0);
  const chosen = [];
  const claimedPaths = [];
  const slotLoad = Array.from({ length: available }, () => ({ weight: 0, packets: [] }));
  const sorted = [...packets].sort((left, right) => {
    if (left.weight !== right.weight) return right.weight - left.weight;
    return left.packetId.localeCompare(right.packetId);
  });
  for (const packet of sorted) {
    if (chosen.length >= available) break;
    if (packet.isolationReason === 'xl-must-split') continue;
    if (overlaps(claimedPaths, packet.allowedPaths)) continue;
    const agent = cheapestEligible(agents, packet.requiredCapabilities, { risk: packet.riskCeiling });
    if (agents.length && !agent) continue;
    const total = chosen.reduce((sum, item) => sum + item.weight, 0);
    if (Number.isFinite(resourceLimit) && total + packet.weight > resourceLimit) continue;
    const slot = slotLoad
      .map((item, index) => ({ ...item, index }))
      .sort((left, right) => left.weight - right.weight || left.index - right.index)[0];
    if (!slot) break;
    const assignment = {
      ...packet,
      slot: slot.index,
      actorId: agent?.actorId ?? null,
      agent: agent ? { actorId: agent.actorId, modelFamily: agent.modelFamily, costTier: agent.costTier } : null,
    };
    chosen.push(assignment);
    slot.weight += packet.weight;
    slot.packets.push(packet.packetId);
    claimedPaths.push(...packet.allowedPaths);
  }
  return {
    contractId: COORDINATION_CONTRACT_ID,
    contractVersion: COORDINATION_CONTRACT_VERSION,
    wave: chosen,
    unusedSlots: Math.max(0, available - chosen.length),
    totalWeight: chosen.reduce((sum, item) => sum + item.weight, 0),
    idleReason: chosen.length === 0 && available > 0 ? 'no-independent-ready-work' : null,
  };
}

export function repairPolicy(state, taskId) {
  const attempts = state.attempts.filter((item) => item.taskId === taskId);
  const failures = state.failures.filter((item) => item.subject?.id === taskId);
  const byHypothesis = new Map();
  for (const failure of failures) {
    const key = failure.hypothesisId || failure.approachId || 'unknown';
    byHypothesis.set(key, (byHypothesis.get(key) ?? 0) + 1);
  }
  const exhausted = [...byHypothesis.entries()].filter(([, count]) => count >= REPAIR_HYPOTHESIS_LIMIT);
  const noProgress = attempts.length >= NO_PROGRESS_REPLAN_LIMIT
    && !state.results.some((item) => item.taskId === taskId && item.execution === 'succeeded');
  return {
    hypothesisFailures: Object.fromEntries(byHypothesis),
    changeApproach: exhausted.length > 0,
    replan: noProgress,
    limits: { hypothesis: REPAIR_HYPOTHESIS_LIMIT, noProgress: NO_PROGRESS_REPLAN_LIMIT },
  };
}

export function canParkInBacklog(state, taskId, live = {}) {
  const task = state.tasks.find((item) => item.taskId === taskId);
  if (!task) fail('task is unknown');
  const coverage = criterionCoverage(state, live);
  for (const criterionId of task.criterionIds) {
    const criterion = state.criteria.find((item) => item.criterionId === criterionId);
    const row = coverage.find((item) => item.criterionId === criterionId);
    if (isRequiredCriterion(criterion) && row && !row.satisfied) {
      const remaining = row.activeTaskIds.filter((id) => id !== taskId);
      if (remaining.length === 0) {
        return { allowed: false, reason: 'required-criterion-cannot-hide-in-backlog' };
      }
    }
  }
  return { allowed: true, reason: 'optional-or-covered' };
}

export function validatePacketRecord(packet, tasks) {
  if (!packet?.taskIds?.length) fail('work packet requires taskIds');
  if (packet.taskIds.length > MAX_BATCH_SMALL) fail('work packet exceeds the small-task batch limit');
  const members = packet.taskIds.map((taskId) => {
    const task = tasks.find((item) => item.id === taskId || item.taskId === taskId);
    if (!task) fail(`packet task ${taskId} is unknown`);
    return task.id ? task : { ...task, id: task.taskId, weight: sizeWeight(task.size) };
  });
  const policy = persistedPacketPolicy(packet, members);
  if (!policy.ok) fail(policy.reason);
  return true;
}

export function validateAssignment({ packet, actor, agents = [], held = [] }) {
  if (!actor?.id) fail('assignment requires an actor');
  if (actor.kind === 'user') fail('user actors are not assigned implementation packets');
  if (packet.isolationReason === 'xl-must-split') fail('XL tasks cannot be assigned before they are split');
  if (held.some((item) => item.state === 'held' && (
    item.taskIds.some((taskId) => packet.taskIds.includes(taskId))
    || overlaps(item.pathOwnership ?? [], packet.allowedPaths)
  ))) fail('duplicate or conflicting assignment');
  if (agents.length) {
    const agent = agents.find((item) => item.actorId === actor.id);
    if (!agent) fail('invalid actor');
    if (!agentSatisfies(agent, packet.requiredCapabilities, { risk: packet.riskCeiling })) {
      fail(packet.riskCeiling === 'critical'
        ? 'critical task cannot use an unknown or insufficient capability'
        : 'insufficient capability');
    }
  }
  return true;
}

export function selectVerifier({ agents, executor, requiredCapabilities = [], risk = 'routine' }) {
  const verifier = independentVerifier(agents, executor, requiredCapabilities, { risk });
  if (!verifier) fail('independent verifier is unavailable');
  if (verifier.actorId === executor?.id || verifier.actorId === executor?.actorId) {
    fail('a subagent cannot independently verify its own work');
  }
  return verifier;
}

export function emptyTestSetOutcome(counts) {
  const found = Number(counts?.found ?? 0);
  const executed = Number(counts?.executed ?? 0);
  if (found === 0 || executed === 0) {
    return { passed: false, reason: 'empty-test-set-is-not-success' };
  }
  return { passed: counts.failed === 0, reason: null };
}
