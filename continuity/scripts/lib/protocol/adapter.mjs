import { CAPABILITY_PROFILES } from './compatibility.mjs';
import { assertAgentRuntimeAdapter } from './ports.mjs';
import { ProtocolError, assertSafePayload } from './secrets.mjs';

export { assertAgentRuntimeAdapter };

const LIVE_ADAPTERS = new Set(['local-process']);
const TEST_ADAPTERS = new Set(['fake']);

export function classifyAdapter(name) {
  if (LIVE_ADAPTERS.has(name)) return 'live';
  if (TEST_ADAPTERS.has(name)) return 'test-only';
  throw new ProtocolError(`unknown runtime adapter ${name}`, 2);
}

export function assertCapabilityProfile(name) {
  if (!CAPABILITY_PROFILES.includes(name)) {
    throw new ProtocolError(`unknown capability profile ${name}`, 2);
  }
  return name;
}

export function adapterHealthDocument(adapter, extra = {}) {
  assertAgentRuntimeAdapter(adapter);
  const health = adapter.healthCheck();
  assertSafePayload(health, 'adapter.healthCheck');
  return {
    adapter: extra.name || 'unknown',
    class: extra.class || classifyAdapter(extra.name || 'fake'),
    healthy: health?.ok === true,
    details: health,
  };
}
