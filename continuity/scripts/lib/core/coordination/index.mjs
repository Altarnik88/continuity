import { MemoryError } from '../domain-v3.mjs';
import { buildTaskAccumulator, planSufficiency } from './accumulator.mjs';
import {
  COORDINATION_CONTRACT_ID,
  COORDINATION_CONTRACT_VERSION,
  COORDINATION_OPERATIONS,
} from './contract.mjs';
import { loadAgentRegistry } from './registry.mjs';
import {
  buildFirstState,
  buildWorkPackets,
  canParkInBacklog,
  contextAllowsNewPacket,
  readyTasks,
  repairPolicy,
  selectVerifier,
  selectWave,
} from './schedule.mjs';

export {
  COORDINATION_CONTRACT_ID,
  COORDINATION_CONTRACT_VERSION,
  COORDINATION_OPERATIONS,
} from './contract.mjs';
export { buildTaskAccumulator, planSufficiency } from './accumulator.mjs';
export { cheapestEligible, loadAgentRegistry, normalizeAgent } from './registry.mjs';
export {
  buildFirstState,
  buildWorkPackets,
  canParkInBacklog,
  contextAllowsNewPacket,
  readyTasks,
  repairPolicy,
  selectVerifier,
  selectWave,
  validateAssignment,
  validatePacketRecord,
} from './schedule.mjs';

const READY_BOUND = 20;
const READY_BOUND_WIDE = 40;

function fail(message, exitCode = 2) {
  throw new MemoryError(message, exitCode);
}

function take(items, limit) {
  return (items ?? []).slice(0, limit);
}

function takeLast(items, limit) {
  const list = items ?? [];
  return list.slice(Math.max(0, list.length - limit));
}

function slimReadyTask(task) {
  if (!task) return task;
  return {
    id: task.id,
    title: task.title,
    class: task.class,
    priority: task.priority,
    size: task.size,
    status: task.status,
    goalId: task.goalId,
    criterionIds: take(task.criterionIds, 8),
    requiredCapabilities: take(task.requiredCapabilities, 8),
    ownershipScope: take(task.ownershipScope, 8),
    recommendedNextAction: task.recommendedNextAction,
    freshness: task.freshness,
    assignmentId: task.assignmentId,
    verification: task.verification,
    acceptance: task.acceptance,
    risk: task.risk,
    weight: task.weight,
  };
}

function slimAssignment(item) {
  return {
    assignmentId: item.assignmentId,
    packetId: item.packetId,
    taskIds: take(item.taskIds, 8),
    actorId: item.actorId,
    state: item.state,
    generation: item.generation,
  };
}

function slimWaveItem(item) {
  return {
    packetId: item.packetId,
    taskIds: take(item.taskIds, 8),
    weight: item.weight,
    prerequisites: take(item.prerequisites, 8),
    allowedPaths: take(item.allowedPaths, 16),
    forbiddenPaths: take(item.forbiddenPaths, 8),
    requiredCapabilities: take(item.requiredCapabilities, 8),
    riskCeiling: item.riskCeiling,
    contextBudget: item.contextBudget,
    focusedChecks: take(item.focusedChecks, 4),
    completionContract: take(item.completionContract, 4),
    isolated: item.isolated,
    isolationReason: item.isolationReason,
    slot: item.slot,
    actorId: item.actorId,
  };
}

function boundAssignments(items, limit) {
  const list = items ?? [];
  const held = list.filter((item) => item.state === 'held').map(slimAssignment);
  if (held.length >= limit) return held.slice(0, limit);
  const rest = takeLast(list.filter((item) => item.state !== 'held'), limit - held.length).map(slimAssignment);
  return [...held, ...rest];
}

function boundFreshness(map, preferIds, limit) {
  const source = map && typeof map === 'object' ? map : {};
  const entries = [];
  const seen = new Set();
  for (const id of preferIds) {
    if (entries.length >= limit) break;
    if (typeof id === 'string' && Object.hasOwn(source, id) && !seen.has(id)) {
      entries.push([id, source[id]]);
      seen.add(id);
    }
  }
  for (const [id, value] of Object.entries(source)) {
    if (entries.length >= limit) break;
    if (!seen.has(id)) {
      entries.push([id, value]);
      seen.add(id);
    }
  }
  return Object.fromEntries(entries);
}

function boundWave(wave) {
  if (!wave || typeof wave !== 'object') return wave;
  return {
    contractId: wave.contractId,
    contractVersion: wave.contractVersion,
    wave: (wave.wave ?? []).map(slimWaveItem),
    unusedSlots: wave.unusedSlots,
    totalWeight: wave.totalWeight,
    idleReason: wave.idleReason,
  };
}

export function boundCoordinatorView(view) {
  if (!view || typeof view !== 'object') return view;
  if (view.view === 'wave') {
    return {
      contractId: view.contractId,
      contractVersion: view.contractVersion,
      view: 'wave',
      plan: view.plan,
      buildFirst: view.buildFirst,
      wave: boundWave(view.wave),
      excludedTasks: take(view.excludedTasks, READY_BOUND_WIDE),
      interview: view.interview,
    };
  }
  const availableTasks = take(view.availableTasks, READY_BOUND).map(slimReadyTask);
  const excludedTasks = take(view.excludedTasks, READY_BOUND_WIDE);
  const preferFreshness = [
    ...availableTasks.map((item) => item.id),
    ...excludedTasks.map((item) => item.taskId),
  ];
  return {
    contractId: view.contractId,
    contractVersion: view.contractVersion,
    operations: view.operations,
    view: view.view || 'ready',
    interview: view.interview,
    plan: view.plan,
    buildFirst: view.buildFirst,
    goal: view.goal,
    criteria: take(view.criteria, READY_BOUND).map((item) => ({
      criterionId: item.criterionId,
      required: item.required,
      verification: item.verification,
    })),
    availableTasks,
    excludedTasks,
    previousAttempts: takeLast(view.previousAttempts, READY_BOUND),
    failedApproaches: takeLast(view.failedApproaches, READY_BOUND),
    freshness: boundFreshness(view.freshness, preferFreshness, READY_BOUND_WIDE),
    requiredCapabilities: take(view.requiredCapabilities, READY_BOUND),
    nextActions: take(view.nextActions, READY_BOUND),
    wave: boundWave(view.wave),
    assignments: boundAssignments(view.assignments, READY_BOUND),
    agents: take(view.agents, READY_BOUND).map((item) => ({
      actorId: item.actorId,
      providerFamily: item.providerFamily,
      modelFamily: item.modelFamily,
      capabilityProfiles: take(item.capabilityProfiles, 8),
      costTier: item.costTier,
      trustTier: item.trustTier,
      calibrationStatus: item.calibrationStatus,
    })),
    userAcceptance: view.userAcceptance,
    graphifyRequired: view.graphifyRequired === true,
    daemon: false,
  };
}

export function coordinatorSnapshot(store, live = {}, options = {}) {
  const state = store.state;
  const plan = planSufficiency(state);
  const gate = buildFirstState(state);
  const registry = loadAgentRegistry(options.agents ?? []);
  const accumulator = buildTaskAccumulator(state, live);
  const ready = readyTasks(state, live, { agents: registry.agents, includeBacklog: false });
  const packets = buildWorkPackets(ready.ready, { contextBudget: options.contextBudget });
  const wave = selectWave(packets, {
    slots: options.slots ?? 1,
    resourceLimit: options.resourceLimit,
    agents: registry.agents,
  });
  const goal = state.goals.find((item) => item.goalId === state.finalGoalId) ?? null;
  return {
    contractId: COORDINATION_CONTRACT_ID,
    contractVersion: COORDINATION_CONTRACT_VERSION,
    operations: COORDINATION_OPERATIONS,
    interview: plan.interview,
    plan,
    buildFirst: gate,
    goal: goal && {
      goalId: goal.goalId,
      title: goal.title,
      outcome: goal.outcome,
      acceptance: goal.acceptance,
    },
    criteria: state.criteria.map((item) => ({
      criterionId: item.criterionId,
      condition: item.condition,
      required: item.waivableByUser === false,
      verification: item.verification,
    })),
    taskAccumulator: accumulator,
    availableTasks: ready.ready,
    excludedTasks: ready.excluded,
    dependencies: accumulator.cycles,
    previousAttempts: state.attempts.map((item) => ({
      attemptId: item.attemptId,
      taskId: item.taskId,
      owner: item.owner,
      approachId: item.approachId,
      execution: item.execution,
    })),
    failedApproaches: accumulator.tasks.flatMap((item) => item.failedApproaches.map((approachId) => ({
      taskId: item.id, approachId,
    }))),
    blockers: accumulator.tasks.filter((item) => item.status === 'blocked'),
    ownership: ready.ownedPaths,
    freshness: Object.fromEntries(accumulator.tasks.map((item) => [item.id, item.freshness])),
    requiredCapabilities: [...new Set(ready.ready.flatMap((item) => item.requiredCapabilities))].sort(),
    nextActions: accumulator.tasks.map((item) => ({
      taskId: item.id,
      action: item.recommendedNextAction,
    })),
    packets,
    wave,
    assignments: state.assignments ?? [],
    agents: registry.agents.map((item) => ({
      actorId: item.actorId,
      providerFamily: item.providerFamily,
      modelFamily: item.modelFamily,
      capabilityProfiles: item.capabilityProfiles,
      costTier: item.costTier,
      trustTier: item.trustTier,
      calibrationStatus: item.calibrationStatus,
    })),
    userAcceptance: state.results.length === 0 || state.results.every((item) => item.acceptance === 'pending')
      ? 'pending'
      : state.results.every((item) => item.acceptance === 'accepted')
        ? 'accepted'
        : state.results.some((item) => item.acceptance === 'accepted') ? 'mixed' : 'rejected',
    graphifyRequired: false,
    daemon: false,
  };
}

export function buildCoordinatorView(store, live, options = {}) {
  const snapshot = coordinatorSnapshot(store, live, options);
  let view;
  if (options.view === 'wave') {
    view = {
      contractId: snapshot.contractId,
      contractVersion: snapshot.contractVersion,
      view: 'wave',
      plan: snapshot.plan,
      buildFirst: snapshot.buildFirst,
      wave: snapshot.wave,
      packets: snapshot.packets,
      excludedTasks: snapshot.excludedTasks,
      interview: snapshot.interview,
    };
  } else if (options.view === 'handoff') {
    view = {
      ...snapshot,
      view: 'handoff',
    };
  } else {
    view = { ...snapshot, view: 'ready' };
  }
  return options.bound ? boundCoordinatorView(view) : view;
}

export function assertReadOnlyView(view) {
  if (!view?.contractId) fail('coordination view is missing');
  return view;
}

export function contextHandoffRecord({
  taskId, packetId, lastCompletedStep, actualState, changedPaths = [],
  evidenceIds = [], approaches = [], errors = [], failedHypotheses = [],
  limitations = [], nextStep,
}) {
  if (!taskId || !nextStep) fail('context handoff requires taskId and nextStep');
  for (const pathValue of changedPaths) {
    if (!pathValue || pathValue.startsWith('/') || pathValue.includes(':') || pathValue.includes('..')) {
      fail('context handoff must not store private absolute paths');
    }
  }
  return {
    taskId,
    packetId: packetId ?? null,
    lastCompletedStep,
    actualState,
    changedPaths,
    evidenceIds,
    approaches,
    errors,
    failedHypotheses,
    limitations,
    nextStep,
  };
}

export function attemptDoesNotTransfer(previousAttempt, nextActorId) {
  return previousAttempt?.owner !== nextActorId;
}
