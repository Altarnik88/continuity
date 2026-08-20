import { evaluateFreshness } from '../domain-v3.mjs';
import { criterionHasFreshAuthorizingResult, taskOwnershipClaims } from './persist-policy.mjs';
import {
  PRIORITY_RANK,
  SIZE_WEIGHTS,
  TASK_CLASSES,
  TASK_COMPLEXITIES,
  TASK_PRIORITIES,
  TASK_RISKS,
  TASK_SIZES,
} from './contract.mjs';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function unique(values) {
  return [...new Set(values)];
}

export function normalizeTaskClass(value) {
  return TASK_CLASSES.includes(value) ? value : 'unclassified';
}

export function normalizePriority(value) {
  return TASK_PRIORITIES.includes(value) ? value : 'core';
}

export function normalizeSize(value) {
  return TASK_SIZES.includes(value) ? value : 'M';
}

export function normalizeComplexity(value) {
  return TASK_COMPLEXITIES.includes(value) ? value : 'unknown';
}

export function normalizeRisk(value) {
  return TASK_RISKS.includes(value) ? value : 'routine';
}

export function sizeWeight(size) {
  return SIZE_WEIGHTS[normalizeSize(size)];
}

export function isRequiredCriterion(criterion) {
  return criterion?.waivableByUser === false;
}

function evidenceForTask(state, task) {
  return state.evidence.filter((item) => item.taskId === task.taskId
    || task.attemptIds.includes(item.attemptId)
    || (item.criterionIds ?? []).some((id) => task.criterionIds.includes(id)));
}

function freshnessForTask(state, live, task) {
  const linked = evidenceForTask(state, task);
  if (!linked.length) return 'unknown';
  const values = linked.map((item) => evaluateFreshness(live ?? {}, item).aggregate);
  if (values.includes('stale')) return 'stale';
  if (values.includes('unknown')) return 'unknown';
  if (values.includes('fresh')) return 'fresh';
  return 'not_applicable';
}

function recommendedNextAction(task, {
  blockedBy, cycle, assigned, xlUnsplit, needsVerification, needsReplan, needsDifferentApproach,
}) {
  if (cycle) return 'break-dependency-cycle';
  if (task.priority === 'backlog') return 'leave-in-backlog';
  if (xlUnsplit) return 'split-xl-task';
  const status = task.status || task.execution;
  if (status === 'blocked' || blockedBy.length) return 'resolve-blocker';
  if (needsDifferentApproach) return 'change-approach';
  if (needsReplan) return 'replan';
  if (status === 'failed') return 'repair-or-replan';
  if (status === 'partial') return 'continue-or-handoff';
  if (status === 'in_progress' && assigned) return 'continue-current-attempt';
  if (needsVerification) return 'request-independent-verification';
  if (status === 'succeeded') return 'await-user-acceptance';
  if (status === 'planned' || status === 'unknown') return 'assign-work-packet';
  return 'inspect-task';
}

function failedApproaches(state, task) {
  return unique(state.failures
    .filter((item) => item.subject?.id === task.taskId || item.attemptId && task.attemptIds.includes(item.attemptId))
    .map((item) => item.approachId)
    .filter(Boolean));
}

function forbiddenApproaches(state, task) {
  return unique(state.decisions
    .filter((item) => (item.taskId === task.taskId || (item.relatedEntityIds ?? []).includes(task.taskId))
      && /do not|forbidden|rejected approach|never retry/i.test(`${item.choice} ${item.rationale}`))
    .map((item) => item.choice));
}

export function criterionCoverage(state, live = {}) {
  return state.criteria.map((criterion) => {
    const required = isRequiredCriterion(criterion);
    const linked = state.tasks.filter((task) => task.criterionIds.includes(criterion.criterionId));
    const active = linked.filter((task) => task.priority !== 'backlog'
      && !['failed', 'superseded'].includes(task.execution));
    const satisfied = required
      ? criterionHasFreshAuthorizingResult(state, criterion, live)
      : state.results.some((result) => (
        result.criterionIds.includes(criterion.criterionId)
        && result.execution === 'succeeded'
        && result.verification === 'passed'
      ));
    return {
      criterionId: criterion.criterionId,
      required,
      satisfied,
      taskIds: linked.map((task) => task.taskId),
      activeTaskIds: active.map((task) => task.taskId),
    };
  });
}

export function buildTaskRecord(state, live, task, extras = {}) {
  const size = normalizeSize(task.size);
  const ownership = taskOwnershipClaims(task);
  const assignment = (state.assignments ?? []).find((item) => (
    item.state === 'held' && item.taskIds.includes(task.taskId)
  ));
  const latestResult = [...(state.results ?? [])].reverse().find((item) => item.taskId === task.taskId);
  const needsVerification = latestResult?.execution === 'succeeded' && latestResult.verification === 'unverified';
  const hypothesisCounts = new Map();
  for (const failure of (state.failures ?? []).filter((item) => item.subject?.id === task.taskId)) {
    const key = failure.hypothesisId || failure.approachId || 'unknown';
    hypothesisCounts.set(key, (hypothesisCounts.get(key) ?? 0) + 1);
  }
  const needsDifferentApproach = [...hypothesisCounts.values()].some((count) => count >= 2);
  const needsReplan = (task.attemptIds?.length ?? 0) >= 3
    && !(state.results ?? []).some((item) => item.taskId === task.taskId && item.execution === 'succeeded');
  const record = {
    id: task.taskId,
    title: task.title,
    goalId: task.goalId,
    criterionIds: [...task.criterionIds],
    sourceContext: task.sourceContext || task.scope,
    priority: normalizePriority(task.priority),
    size,
    weight: sizeWeight(size),
    complexity: normalizeComplexity(task.complexity),
    risk: normalizeRisk(task.risk),
    requiredCapabilities: [...(task.requiredCapabilities ?? task.capabilities ?? [])],
    dependencies: [...(task.dependencyIds ?? [])],
    ownershipScope: [...(ownership.claims ?? [])],
    acceptanceCriteria: [...(task.acceptanceCriteria ?? [])],
    focusedVerification: [...(task.focusedVerification ?? [])],
    status: task.execution,
    actor: assignment?.actorId ?? task.owner ?? null,
    evidenceLinks: evidenceForTask(state, task).map((item) => item.evidenceId),
    attemptLinks: [...(task.attemptIds ?? [])],
    createdAt: task.createdAt ?? state.projectedAt,
    freshness: freshnessForTask(state, live, task),
    class: normalizeTaskClass(task.class),
    moduleId: task.moduleId || (task.pathOwnership?.[0] ?? task.scope),
    enablesTaskIds: [...(task.enablesTaskIds ?? [])],
    assignmentId: assignment?.assignmentId ?? null,
    failedApproaches: failedApproaches(state, task),
    forbiddenApproaches: forbiddenApproaches(state, task),
    userFacing: task.userFacing === true,
    verification: task.verification ?? latestResult?.verification ?? 'unverified',
    acceptance: latestResult?.acceptance ?? task.acceptance ?? 'pending',
  };
  record.recommendedNextAction = recommendedNextAction(record, {
    blockedBy: extras.blockedBy ?? [],
    cycle: extras.cycle === true,
    assigned: Boolean(assignment),
    xlUnsplit: size === 'XL',
    needsVerification,
    needsReplan: extras.needsReplan === true || needsReplan,
    needsDifferentApproach: extras.needsDifferentApproach === true || needsDifferentApproach,
  });
  return record;
}

export function buildTaskAccumulator(state, live = {}) {
  const graph = dependencyGraph(state.tasks);
  const coverage = criterionCoverage(state, live);
  const tasks = [...state.tasks]
    .map((task) => buildTaskRecord(state, live, task, {
      blockedBy: graph.blockedBy.get(task.taskId) ?? [],
      cycle: graph.cyclic.has(task.taskId),
    }))
    .sort((left, right) => compareTasks(left, right));
  return {
    tasks,
    coverage,
    cycles: graph.cycles,
    counts: {
      total: tasks.length,
      blocker: tasks.filter((item) => item.priority === 'blocker').length,
      core: tasks.filter((item) => item.priority === 'core').length,
      verification: tasks.filter((item) => item.priority === 'verification').length,
      backlog: tasks.filter((item) => item.priority === 'backlog').length,
    },
  };
}

export function compareTasks(left, right) {
  const priority = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
  if (priority !== 0) return priority;
  if (left.status === 'blocked' && right.status !== 'blocked') return -1;
  if (right.status === 'blocked' && left.status !== 'blocked') return 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function dependencyGraph(tasks) {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const blockedBy = new Map();
  const cycles = [];
  const cyclic = new Set();
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function walk(taskId) {
    if (visited.has(taskId) || !byId.has(taskId)) return;
    if (visiting.has(taskId)) {
      const start = stack.indexOf(taskId);
      const cycle = start >= 0 ? stack.slice(start).concat(taskId) : [taskId];
      cycles.push(cycle);
      for (const id of cycle) cyclic.add(id);
      return;
    }
    visiting.add(taskId);
    stack.push(taskId);
    for (const dependencyId of byId.get(taskId).dependencyIds ?? []) walk(dependencyId);
    stack.pop();
    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const task of tasks) {
    walk(task.taskId);
    const unfinished = (task.dependencyIds ?? []).filter((dependencyId) => {
      const dependency = byId.get(dependencyId);
      return !dependency || !['succeeded', 'superseded'].includes(dependency.execution);
    });
    blockedBy.set(task.taskId, unfinished);
  }

  return {
    blockedBy,
    cyclic,
    cycles: cycles
      .map((cycle) => unique(cycle).sort())
      .sort((left, right) => left.join('\0').localeCompare(right.join('\0'))),
  };
}

export function planSufficiency(state) {
  const missing = [];
  if (!state.project) missing.push('project');
  if (!state.finalGoalId || !state.goals.some((item) => item.goalId === state.finalGoalId)) missing.push('goal');
  if (!state.criteria.length) missing.push('criteria');
  if (!state.tasks.length) missing.push('taskAccumulator');
  return {
    sufficient: missing.length === 0,
    missing,
    interview: { offered: false, reason: 'Continuity does not interview; supply Project, Goal, Criteria, and TaskAccumulator.' },
  };
}

export function isCoreProductTask(task) {
  return ['function', 'connector'].includes(normalizeTaskClass(task.class ?? task.taskClass))
    && normalizePriority(task.priority) === 'core';
}

export { clone };
