import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ProtocolError, assertKnownFields, assertSafePayload } from '../protocol/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLED_CONFIG = path.resolve(HERE, '../../../assets/coordinator.config.json');

const CONFIG_FIELDS = new Set([
  'adapter', 'slots', 'timeoutMs', 'memoryCli', 'executorActorId', 'verifierActorId',
  'executorRunId', 'verifierRunId', 'contextUsedRatio', 'liveProofRequired',
]);

export function loadCoordinatorConfig(file) {
  const raw = JSON.parse(readFileSync(file || BUNDLED_CONFIG, 'utf8'));
  assertSafePayload(raw, 'coordinator config');
  assertKnownFields(raw, CONFIG_FIELDS, 'coordinator config');
  const adapter = raw.adapter || 'local-process';
  const slots = Number(raw.slots ?? 1);
  if (!Number.isSafeInteger(slots) || slots < 1 || slots > 8) {
    throw new ProtocolError('coordinator config.slots must be 1..8', 2);
  }
  const timeoutMs = Number(raw.timeoutMs ?? 30_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    throw new ProtocolError('coordinator config.timeoutMs must be 1000..120000', 2);
  }
  return {
    adapter,
    slots,
    timeoutMs,
    memoryCli: raw.memoryCli ?? null,
    executorActorId: raw.executorActorId || 'actor-exec-01',
    verifierActorId: raw.verifierActorId || 'actor-verify-01',
    executorRunId: raw.executorRunId || 'run-exec-01',
    verifierRunId: raw.verifierRunId || 'run-verify-01',
    contextUsedRatio: raw.contextUsedRatio ?? null,
    liveProofRequired: raw.liveProofRequired !== false,
  };
}
