import { ADAPTER_METHODS, COORDINATION_OPERATIONS } from './compatibility.mjs';
import { ProtocolError } from './secrets.mjs';

function fail(message) {
  throw new ProtocolError(message, 2);
}

function assertMethods(target, names, label) {
  if (target === null || typeof target !== 'object') fail(`${label} is missing`);
  for (const name of names) {
    if (typeof target[name] !== 'function') fail(`${label}.${name}() is required`);
  }
  return target;
}

export function assertMemoryPort(port) {
  return assertMethods(port, ['doctor', 'validate', 'record', 'recordFile'], 'MemoryPort');
}

export function assertContinuityReadPort(port) {
  return assertMethods(port, [
    'inspect', 'inspectReady', 'inspectWave', 'handoff', 'history',
  ], 'ContinuityReadPort');
}

export function assertCoordinatorWritePort(port) {
  return assertMethods(port, [
    'recordTask', 'recordPacket', 'recordAssign', 'recordStart', 'recordReport',
    'recordEvidence', 'recordResult', 'recordFail', 'recordVerify', 'recordContext',
    'recordRelease', 'registerAgent',
  ], 'CoordinatorWritePort');
}

export function assertAgentRuntimeAdapter(adapter) {
  return assertMethods(adapter, ADAPTER_METHODS, 'AgentRuntimeAdapter');
}

export function protocolOperations() {
  return [...COORDINATION_OPERATIONS];
}
