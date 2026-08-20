import { MemoryError } from '../domain-v3.mjs';
import {
  COORDINATION_CONTRACT_ID,
  COORDINATION_CONTRACT_VERSION,
  COST_RANK,
  TRUST_RANK,
} from './contract.mjs';
import { normalizePersistedAgent, persistedAgentSatisfies } from './persist-policy.mjs';

function fail(message) {
  throw new MemoryError(message, 2);
}

export function normalizeAgent(input) {
  const policy = normalizePersistedAgent(input);
  if (!policy.ok) fail(policy.reason);
  return policy.normalized;
}

export function loadAgentRegistry(input = []) {
  const records = Array.isArray(input) ? input : input.agents ?? [];
  const agents = records.map((item) => normalizeAgent(item));
  const seen = new Set();
  for (const agent of agents) {
    if (seen.has(agent.actorId)) fail(`duplicate agent ${agent.actorId}`);
    seen.add(agent.actorId);
  }
  return {
    contractId: COORDINATION_CONTRACT_ID,
    contractVersion: COORDINATION_CONTRACT_VERSION,
    agents: agents.sort((left, right) => left.actorId.localeCompare(right.actorId)),
  };
}

export function capabilitiesKnown(agent) {
  return agent.calibrationStatus === 'calibrated' || agent.capabilityProfiles.length > 0;
}

export function agentSatisfies(agent, requiredCapabilities = [], { risk = 'routine' } = {}) {
  return persistedAgentSatisfies(agent, requiredCapabilities, { risk });
}

export function cheapestEligible(agents, requiredCapabilities = [], options = {}) {
  const eligible = agents
    .filter((agent) => agentSatisfies(agent, requiredCapabilities, options))
    .sort((left, right) => {
      const cost = COST_RANK[left.costTier] - COST_RANK[right.costTier];
      if (cost !== 0) return cost;
      const trust = TRUST_RANK[right.trustTier] - TRUST_RANK[left.trustTier];
      if (trust !== 0) return trust;
      return left.actorId.localeCompare(right.actorId);
    });
  return eligible[0] ?? null;
}

export function independentVerifier(agents, executor, requiredCapabilities = [], options = {}) {
  const others = agents.filter((agent) => agent.actorId !== executor?.actorId && agent.actorId !== executor?.id);
  const preferredFamily = others.filter((agent) => (
    !executor?.modelFamily || agent.modelFamily !== executor.modelFamily
  ));
  return cheapestEligible(preferredFamily, requiredCapabilities, options)
    ?? cheapestEligible(others, requiredCapabilities, options);
}
