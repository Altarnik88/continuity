/** Test fixture only. Do not call from live engine seed. */
export function planPulse() {
  return [
    {
      id: 'task-scaffold',
      title: 'Scaffold the Pulse package',
      kind: 'write',
      priority: 10,
      paths: ['forge/package.json', 'forge/README.md'],
      deps: [],
      spec: { files: { 'forge/package.json': 'package.json', 'forge/README.md': 'README.md' } },
    },
    {
      id: 'task-analysis',
      title: 'Analyze Pulse goals and risks',
      kind: 'analyze',
      priority: 15,
      paths: ['forge/ANALYSIS.md'],
      deps: [],
      spec: { files: { 'forge/ANALYSIS.md': 'ANALYSIS.md' } },
    },
    {
      id: 'task-domain',
      title: 'Write Pulse domain rules',
      kind: 'write',
      priority: 20,
      paths: ['forge/src/domain.mjs'],
      deps: [],
      spec: { files: { 'forge/src/domain.mjs': 'src/domain.mjs' } },
    },
    {
      id: 'task-domain-test',
      title: 'Verify domain invariants',
      kind: 'test',
      priority: 30,
      paths: ['forge/test/domain.test.mjs'],
      deps: ['task-domain'],
      spec: {
        files: { 'forge/test/domain.test.mjs': 'test/domain.test.mjs' },
        run: ['--test', 'forge/test/domain.test.mjs'],
      },
    },
    {
      id: 'task-store',
      title: 'Write durable Pulse store',
      kind: 'write',
      priority: 40,
      paths: ['forge/src/store.mjs'],
      deps: ['task-domain'],
      spec: {
        files: { 'forge/src/store.mjs': 'src/store.mjs' },
        buggyFiles: { 'forge/src/store.mjs': 'src/store.buggy.mjs' },
        buggyUntilAttempt: 1,
      },
    },
    {
      id: 'task-store-test',
      title: 'Verify store persistence',
      kind: 'test',
      priority: 50,
      paths: ['forge/test/store.test.mjs'],
      deps: ['task-store'],
      spec: {
        files: { 'forge/test/store.test.mjs': 'test/store.test.mjs' },
        run: ['--test', 'forge/test/store.test.mjs'],
        repairTaskId: 'task-store',
      },
    },
    {
      id: 'task-service',
      title: 'Write Pulse application service',
      kind: 'write',
      priority: 40,
      paths: ['forge/src/service.mjs'],
      deps: ['task-store-test'],
      spec: { files: { 'forge/src/service.mjs': 'src/service.mjs' } },
    },
    {
      id: 'task-service-test',
      title: 'Verify service updates',
      kind: 'test',
      priority: 60,
      paths: ['forge/test/service.test.mjs'],
      deps: ['task-service', 'task-store-test'],
      spec: {
        files: { 'forge/test/service.test.mjs': 'test/service.test.mjs' },
        run: ['--test', 'forge/test/service.test.mjs'],
      },
    },
    {
      id: 'task-http',
      title: 'Expose Pulse HTTP API',
      kind: 'write',
      priority: 70,
      paths: ['forge/src/http.mjs'],
      deps: ['task-service'],
      spec: { files: { 'forge/src/http.mjs': 'src/http.mjs' } },
    },
    {
      id: 'task-cli',
      title: 'Expose Pulse CLI',
      kind: 'write',
      priority: 70,
      paths: ['forge/src/cli.mjs'],
      deps: ['task-service'],
      spec: { files: { 'forge/src/cli.mjs': 'src/cli.mjs' } },
    },
    {
      id: 'task-web',
      title: 'Publish Pulse status page',
      kind: 'write',
      priority: 80,
      paths: ['forge/web/index.html'],
      deps: ['task-http'],
      spec: { files: { 'forge/web/index.html': 'web/index.html' } },
    },
    {
      id: 'task-security',
      title: 'Audit Pulse CLI and HTTP for fail-closed input',
      kind: 'security',
      priority: 85,
      paths: ['forge/SECURITY.md', 'forge/src/http.mjs', 'forge/src/cli.mjs'],
      deps: ['task-http', 'task-cli'],
      spec: { files: { 'forge/SECURITY.md': 'SECURITY.md' } },
    },
    {
      id: 'task-review',
      title: 'Independent review of Pulse domain and persistence',
      kind: 'review',
      priority: 86,
      paths: ['forge/REVIEW.md', 'forge/src/domain.mjs', 'forge/src/store.mjs', 'forge/src/service.mjs'],
      deps: ['task-domain-test', 'task-store-test', 'task-service-test'],
      spec: { files: { 'forge/REVIEW.md': 'REVIEW.md' } },
    },
    {
      id: 'task-handoff',
      title: 'Write the session handoff',
      kind: 'handoff',
      priority: 90,
      paths: ['forge/HANDOFF.md'],
      deps: ['task-analysis', 'task-domain-test', 'task-store-test', 'task-service-test', 'task-cli', 'task-web', 'task-security', 'task-review'],
      spec: {},
    },
  ];
}

function asList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function uniqueIds(values) {
  return [...new Set(values.filter(Boolean))];
}

function isPulseNamed(task) {
  return /pulse/i.test(`${task?.id ?? ''}${task?.taskId ?? ''}${task?.title ?? ''}`);
}

function taskPaths(task) {
  return [...asList(task?.paths), ...asList(task?.ownershipScope), ...asList(task?.pathOwnership)].join(' ');
}

function isPulseProductTask(task) {
  const id = String(task?.id ?? task?.taskId ?? '');
  const title = String(task?.title ?? '');
  if (/task-scaffold/i.test(id) || /scaffold the pulse/i.test(title)) return true;
  return /pulse/i.test(`${id} ${title}`) && /(^|[ /])forge(\/|$)/.test(taskPaths(task));
}

function isPulseFollowOn(task) {
  if (isPulseNamed(task) || isPulseProductTask(task)) return true;
  const id = String(task?.id ?? task?.taskId ?? '');
  const title = String(task?.title ?? '');
  const paths = taskPaths(task);
  return /task-metrics(-test)?$/i.test(id)
    || /\brisk metrics\b/i.test(title)
    || /(^|[ /])forge\/(?:src|test)\/metrics(?:\.|$)/.test(paths);
}

function readGoal(input) {
  if (!input || typeof input !== 'object') return null;
  const fromList = asList(input.goals);
  const listed = input.finalGoalId
    ? fromList.find((item) => (item?.goalId ?? item?.id) === input.finalGoalId)
    : fromList.find((item) => item?.isFinal) ?? fromList[0];
  const goal = input.goal ?? input.finalGoal ?? listed ?? null;
  if (!goal || typeof goal !== 'object') return null;
  const goalId = goal.goalId ?? goal.id;
  if (!goalId || goalId === 'none') return null;
  return { ...goal, goalId };
}

function readCriteria(input, goal) {
  if (!input || typeof input !== 'object') return [];
  const listed = [...asList(input.criteria), ...asList(input.criterion)]
    .map((item) => (typeof item === 'string' ? { criterionId: item } : item))
    .filter((item) => item && (item.criterionId ?? item.id))
    .map((item) => ({ ...item, criterionId: item.criterionId ?? item.id }));
  if (listed.length) return uniqueByCriterion(listed);
  return uniqueIds(asList(goal?.criterionIds)).map((criterionId) => ({ criterionId }));
}

function uniqueByCriterion(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (seen.has(item.criterionId)) continue;
    seen.add(item.criterionId);
    out.push(item);
  }
  return out;
}

function readJournalTasks(input) {
  if (!input || typeof input !== 'object') return [];
  const accumulator = input.taskAccumulator;
  const seen = new Set();
  const out = [];
  for (const task of [
    ...asList(accumulator?.tasks),
    ...asList(input.tasks),
    ...asList(input.availableTasks),
    ...asList(input.activeTasks),
  ]) {
    if (!task || typeof task !== 'object') continue;
    const id = task.id ?? task.taskId;
    if (!id || seen.has(id) || isPulseProductTask(task)) continue;
    seen.add(id);
    out.push(task);
  }
  return out;
}

function ownershipScopeOf(task, criterion) {
  const claims = uniqueIds([
    ...asList(task?.ownershipScope),
    ...asList(task?.pathOwnership),
    ...asList(task?.paths),
  ]);
  if (claims.length) return claims;
  const scope = criterion?.scope;
  if (typeof scope === 'string' && scope.trim()) return [scope.trim()];
  return ['continuity'];
}

function focusedVerificationOf(task, criterion) {
  const fromTask = asList(task?.focusedVerification).filter((item) => typeof item === 'string' && item);
  if (fromTask.length) return fromTask;
  const verification = criterion?.verification;
  if (typeof verification === 'string' && verification.trim() && verification !== 'unverified') {
    return [verification.trim()];
  }
  return [];
}

function kindFromClass(value) {
  if (value === 'tests' || value === 'test') return 'test';
  if (value === 'security' || value === 'review' || value === 'handoff' || value === 'analyze') return value;
  return 'write';
}

function priorityNumber(value) {
  if (Number.isFinite(value)) return value;
  if (value === 'blocker') return 1;
  if (value === 'verification') return 20;
  if (value === 'backlog') return 90;
  return 10;
}

function projectJournalTask(task, goal, criteria) {
  const id = task.id ?? task.taskId;
  const criterionIds = uniqueIds(asList(task.criterionIds).length
    ? asList(task.criterionIds)
    : criteria.map((item) => item.criterionId));
  const criterion = criteria.find((item) => criterionIds.includes(item.criterionId)) ?? criteria[0];
  const ownershipScope = ownershipScopeOf(task, criterion);
  return {
    id,
    taskId: id,
    title: task.title ?? id,
    kind: task.kind ?? kindFromClass(task.class),
    priority: priorityNumber(task.priority),
    paths: asList(task.paths).length ? asList(task.paths) : ownershipScope,
    deps: asList(task.deps).length ? asList(task.deps) : asList(task.dependencyIds),
    spec: task.spec && typeof task.spec === 'object' ? task.spec : {},
    goalId: task.goalId ?? goal.goalId,
    criterionIds,
    ownershipScope,
    focusedVerification: focusedVerificationOf(task, criterion),
  };
}

function cutCriterionTask(goal, criterion, index) {
  const criterionId = criterion.criterionId;
  const id = `task-${criterionId}`;
  const ownershipScope = ownershipScopeOf(null, criterion);
  return {
    id,
    taskId: id,
    title: `Cover ${criterionId}`,
    kind: 'write',
    priority: 10 + index,
    paths: ownershipScope,
    deps: [],
    spec: {},
    goalId: goal.goalId,
    criterionIds: [criterionId],
    ownershipScope,
    focusedVerification: focusedVerificationOf(null, criterion),
  };
}

export function planFromGoal(inspectOrInit) {
  const goal = readGoal(inspectOrInit);
  const criteria = readCriteria(inspectOrInit, goal);
  if (!goal || !criteria.length) return [];
  const existing = readJournalTasks(inspectOrInit)
    .filter((task) => !task.goalId || task.goalId === goal.goalId)
    .map((task) => projectJournalTask(task, goal, criteria));
  if (existing.length) return existing;
  return criteria.map((criterion, index) => cutCriterionTask(goal, criterion, index));
}

export function planContinuations(state) {
  const existing = new Set((state.tasks ?? []).map((task) => task.id));
  const succeeded = new Set((state.tasks ?? []).filter((task) => task.status === 'succeeded').map((task) => task.id));
  if (!succeeded.has('task-handoff')) return [];
  const next = [
    {
      id: 'task-memory-digest',
      title: 'Write product memory from swarm lessons',
      kind: 'digest',
      priority: 100,
      paths: ['forge/MEMORY.md'],
      deps: ['task-handoff'],
      spec: {},
    },
    {
      id: 'task-changelog',
      title: 'Record what the swarm learned in the changelog',
      kind: 'write',
      priority: 110,
      paths: ['forge/CHANGELOG.md'],
      deps: ['task-handoff'],
      spec: { files: { 'forge/CHANGELOG.md': 'CHANGELOG.md' } },
    },
    {
      id: 'task-metrics',
      title: 'Add Pulse risk metrics',
      kind: 'write',
      priority: 120,
      paths: ['forge/src/metrics.mjs'],
      deps: ['task-handoff'],
      spec: { files: { 'forge/src/metrics.mjs': 'src/metrics.mjs' } },
    },
    {
      id: 'task-metrics-test',
      title: 'Verify Pulse risk metrics',
      kind: 'test',
      priority: 130,
      paths: ['forge/test/metrics.test.mjs'],
      deps: ['task-metrics'],
      spec: {
        files: { 'forge/test/metrics.test.mjs': 'test/metrics.test.mjs' },
        run: ['--test', 'forge/test/metrics.test.mjs'],
      },
    },
  ];
  return next.filter((task) => !existing.has(task.id) && !isPulseFollowOn(task));
}
