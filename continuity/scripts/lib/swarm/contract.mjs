export const STANDING_ORDER = [
  'Develop the product autonomously and for the long term.',
  'Do not wait for a new chat, a new prompt, or a human to restate the goal.',
  'Keep context: goals, failures, lessons, and playbooks must survive every session.',
  'Slice work into a task database. Run 5-20 sub-agents in parallel.',
  'Never let two agents own overlapping paths at the same time.',
  'Cover analysis, implementation, independent verification, security, and review when paths do not overlap.',
  'An attempt is not evidence. A report is not verification. Only the user may accept.',
].join(' ');

export const FORBIDDEN_VIEW_PATHS = Object.freeze([
  'forge/HANDOFF.md',
  'forge/HANDOFF.json',
  'forge/MEMORY.md',
  'data/memory.ndjson',
]);

export const REPAIR_HYPOTHESIS_LIMIT = 2;
export const NO_PROGRESS_REPLAN_LIMIT = 3;

export function clampSwarmSize(value) {
  const size = Number(value);
  if (!Number.isInteger(size)) return 8;
  return Math.min(20, Math.max(5, size));
}

function foldPath(value) {
  return String(value ?? '').replaceAll('\\', '/').toLowerCase();
}

export function pathsOverlap(left = [], right = []) {
  for (const a of left) {
    for (const b of right) {
      const foldedLeft = foldPath(a);
      const foldedRight = foldPath(b);
      if (!foldedLeft || !foldedRight) continue;
      if (foldedLeft === foldedRight) return true;
      if (foldedLeft.startsWith(`${foldedRight}/`) || foldedRight.startsWith(`${foldedLeft}/`)) return true;
    }
  }
  return false;
}

export function leaseConflict(held, candidatePaths, exceptTaskId) {
  return held.some((lease) => {
    if (exceptTaskId && lease.taskId === exceptTaskId) return false;
    return pathsOverlap(lease.paths, candidatePaths);
  });
}

export function selectDispatchWave(tasks = []) {
  return selectDispatchWaveReport(tasks).wave;
}

export function selectDispatchWaveReport(tasks = [], held = []) {
  const sorted = [...tasks].sort((left, right) => {
    const priority = (left.priority ?? 100) - (right.priority ?? 100);
    if (priority !== 0) return priority;
    return String(left.id).localeCompare(String(right.id));
  });
  const wave = [];
  const rejected = [];
  for (const task of sorted) {
    const paths = task.paths ?? [];
    if (leaseConflict(held, paths, task.id)) {
      rejected.push({ id: task.id, reason: 'lease-conflict' });
      continue;
    }
    if (wave.some((item) => pathsOverlap(item.paths ?? [], paths))) {
      rejected.push({ id: task.id, reason: 'path-overlap' });
      continue;
    }
    wave.push(task);
  }
  return { wave, rejected };
}

const EXECUTOR_NAMES = [
  'Mason', 'Weaver', 'Cartographer', 'Smith', 'Scribe', 'Surveyor',
  'Keeper', 'Wright', 'Quarry', 'Harbor', 'Nexus', 'Relay',
  'Forge', 'Anchor', 'Helix', 'Prism',
];

export function buildRoster(size) {
  const swarmSize = clampSwarmSize(size);
  const roster = [
    { id: 'agent-conductor', role: 'conductor', name: 'Conductor' },
    { id: 'agent-archivist', role: 'archivist', name: 'Archivist' },
    { id: 'agent-sentinel', role: 'verifier', name: 'Sentinel' },
  ];
  if (swarmSize >= 6) {
    roster.push({ id: 'agent-analyst', role: 'analyst', name: 'Analyst' });
  }
  if (swarmSize >= 7) {
    roster.push({ id: 'agent-warden', role: 'security', name: 'Warden' });
  }
  if (swarmSize >= 8) {
    roster.push({ id: 'agent-reviewer', role: 'reviewer', name: 'Reviewer' });
  }
  if (swarmSize >= 9) {
    roster.push({ id: 'agent-auditor', role: 'verifier', name: 'Auditor' });
  }
  if (swarmSize >= 10) {
    roster.push({ id: 'agent-manager', role: 'manager', name: 'Manager' });
  }
  let index = 0;
  while (roster.length < swarmSize) {
    const name = EXECUTOR_NAMES[index % EXECUTOR_NAMES.length];
    const suffix = index >= EXECUTOR_NAMES.length ? `-${index}` : '';
    roster.push({
      id: `agent-${name.toLowerCase()}${suffix}`,
      role: 'executor',
      name: `${name}${suffix}`,
    });
    index += 1;
  }
  return roster;
}

export function isBlindKind(kind) {
  return kind === 'test' || kind === 'security' || kind === 'review';
}

export function isViewPath(value) {
  const folded = foldPath(value);
  return FORBIDDEN_VIEW_PATHS.some((item) => folded === item || folded.endsWith(`/${item}`));
}

export function allowedBlindPaths(paths = []) {
  return paths.filter((item) => !isViewPath(item));
}

export function buildDispatchPacket(task) {
  const rawPaths = task.paths ?? [];
  const forbidden = [...new Set([
    ...FORBIDDEN_VIEW_PATHS,
    ...(task.forbiddenPaths ?? []),
  ])];
  const paths = isBlindKind(task.kind) ? allowedBlindPaths(rawPaths) : rawPaths;
  const pathText = paths.join(', ');
  const blind = isBlindKind(task.kind);
  return {
    id: task.id,
    title: task.title,
    kind: task.kind,
    paths,
    allowedPaths: paths,
    forbiddenPaths: forbidden,
    deps: task.deps ?? [],
    blind,
    brief: blind
      ? `${task.title}. Read only ${pathText || 'the leased source paths'}. Do not read implementer notes, chat history, other agents' reasoning, forge/HANDOFF.md, forge/MEMORY.md, or data/memory.ndjson. Use tests, the listed files, and available skills, MCP, and plugins.`
      : `${task.title}. Own only ${pathText}. Use available skills, MCP, and plugins. Do not edit paths you do not own.`,
  };
}

export function nowIso(clock = () => new Date()) {
  const value = clock();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function swarmRepairDecision({ attempts = 0, failureCount = 0 } = {}) {
  if (Number(attempts) >= NO_PROGRESS_REPLAN_LIMIT) {
    return { poison: true, reason: 'no-progress', replan: true };
  }
  if (Number(failureCount) >= REPAIR_HYPOTHESIS_LIMIT) {
    return { poison: true, reason: 'hypothesis-exhausted', changeApproach: true };
  }
  return { poison: false, reason: null, replan: false, changeApproach: false };
}
