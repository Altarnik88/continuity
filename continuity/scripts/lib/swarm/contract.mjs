export const STANDING_ORDER = [
  'Develop the product autonomously and for the long term.',
  'Do not wait for a new chat, a new prompt, or a human to restate the goal.',
  'Keep context: goals, failures, lessons, and playbooks must survive every session.',
  'Slice work into a task database. Run 5-20 sub-agents in parallel.',
  'Never let two agents own overlapping paths at the same time.',
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
  if (swarmSize >= 7) {
    roster.push({ id: 'agent-auditor', role: 'verifier', name: 'Auditor' });
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

export function nowIso(clock = () => new Date()) {
  const value = clock();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
