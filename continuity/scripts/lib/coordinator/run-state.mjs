import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  COORDINATION_CONTRACT_ID,
  COORDINATION_CONTRACT_VERSION,
  ProtocolError,
  validateCoordinatorRunState,
} from '../protocol/index.mjs';

export const RUN_STORE_DIR = ['.continuity', 'coordinator', 'runs'];

function failClosed(message = 'coordinator run is missing or invalid', exitCode = 2) {
  throw new ProtocolError(message, exitCode);
}

function runsDir(root) {
  return path.join(root, ...RUN_STORE_DIR);
}

function runPath(root, runId) {
  return path.join(runsDir(root), `${runId}.json`);
}

function parseRunDocument(text) {
  if (typeof text !== 'string' || !text.trim()) failClosed();
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    failClosed();
  }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length === 0) {
    failClosed();
  }
  try {
    return validateCoordinatorRunState(raw);
  } catch (error) {
    if (error instanceof ProtocolError) failClosed();
    throw error;
  }
}

export function createRunState({
  runId,
  adapter = 'local-process',
  slots = 1,
  clock = () => new Date(),
} = {}) {
  const now = (clock() instanceof Date ? clock() : new Date(clock())).toISOString();
  return validateCoordinatorRunState({
    schemaVersion: 1,
    contractId: COORDINATION_CONTRACT_ID,
    contractVersion: COORDINATION_CONTRACT_VERSION,
    runId,
    status: 'planning',
    createdAt: now,
    updatedAt: now,
    adapter,
    slots,
    waveId: null,
    assignments: [],
    openAttempts: [],
    completedPacketIds: [],
    stopReason: null,
    userAcceptance: 'pending',
    memoryProfile: 'local-cli',
    configDigest: null,
  });
}

export function saveRunState(root, state, { clock = () => new Date() } = {}) {
  const next = validateCoordinatorRunState({
    ...state,
    updatedAt: (clock() instanceof Date ? clock() : new Date(clock())).toISOString(),
  });
  mkdirSync(runsDir(root), { recursive: true });
  writeFileSync(runPath(root, next.runId), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function loadRunState(root, runId) {
  if (typeof runId !== 'string' || !runId) failClosed();
  let text;
  try {
    text = readFileSync(runPath(root, runId), 'utf8');
  } catch {
    failClosed();
  }
  return parseRunDocument(text);
}

export function listRunIds(root) {
  try {
    return readdirSync(runsDir(root))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

export function latestRunId(root) {
  const ids = listRunIds(root);
  return ids.at(-1) ?? null;
}
