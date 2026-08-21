import { ProtocolError, classifyAdapter } from '../../protocol/index.mjs';
import { createFakeAdapter } from './fake.mjs';
import { createLocalProcessAdapter } from './local-process.mjs';

export function createAdapter(name, options = {}) {
  if (name === 'local-process') return createLocalProcessAdapter(options);
  if (name === 'fake') return createFakeAdapter(options);
  throw new ProtocolError(`unknown runtime adapter ${name}`, 2);
}

export function requireLiveAdapter(name) {
  if (classifyAdapter(name) !== 'live') {
    throw new ProtocolError(`adapter ${name} is not live proof of autonomous execution`, 4);
  }
  return createAdapter(name);
}
