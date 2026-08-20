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

function fail(message, exitCode = 2) {
  throw new MemoryError(message, exitCode);
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
  if (options.view === 'wave') {
    return {
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
  }
  if (options.view === 'handoff') {
    return {
      ...snapshot,
      view: 'handoff',
    };
  }
  return { ...snapshot, view: 'ready' };
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
