export const STANDING_ORDER = [
  'Develop the product autonomously and for the long term.',
  'Do not wait for a new chat, a new prompt, or a human to restate the goal.',
  'Keep context: goals, failures, lessons, and playbooks must survive every session.',
  'Slice work into a task database. Run 5-20 sub-agents in parallel.',
  'Never let two agents own overlapping paths at the same time.',
  'Cover analysis, implementation, independent verification, security, and review when paths do not overlap.',
  'An attempt is not evidence. A report is not verification. Only the user may accept.',
].join(' ');

export function clampSwarmSize(value) {
  const size = Number(value);
  if (!Number.isInteger(size)) return 8;
  return Math.min(20, Math.max(5, size));
}

export function pathsOverlap(left = [], right = []) {
  for (const a of left) {
    for (const b of right) {
      if (a === b) return true;
      if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true;
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
  const sorted = [...tasks].sort((left, right) => {
    const priority = (left.priority ?? 100) - (right.priority ?? 100);
    if (priority !== 0) return priority;
    return String(left.id).localeCompare(String(right.id));
  });
  const wave = [];
  for (const task of sorted) {
    const paths = task.paths ?? [];
    if (wave.some((item) => pathsOverlap(item.paths ?? [], paths))) continue;
    wave.push(task);
  }
  return wave;
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
  if (swarmSize >= 12) {
    roster.push({ id: 'agent-integrator', role: 'integrator', name: 'Integrator' });
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

export function buildDispatchPacket(task) {
  const paths = (task.paths ?? []).join(', ');
  const blind = isBlindKind(task.kind);
  return {
    id: task.id,
    title: task.title,
    kind: task.kind,
    paths: task.paths ?? [],
    deps: task.deps ?? [],
    blind,
    brief: blind
      ? `${task.title}. Read only ${paths}. Do not read implementer notes, chat history, or other agents' reasoning. Use tests, the listed files, and available skills, MCP, and plugins.`
      : `${task.title}. Own only ${paths}. Use available skills, MCP, and plugins. Do not edit paths you do not own.`,
  };
}

export function nowIso(clock = () => new Date()) {
  const value = clock();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
