import { randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync,
  renameSync, rmSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import path from 'node:path';

import { captureAuthoritativeInput, canonicalV3, isBrandedV3 } from './input-v3.mjs';
import {
  MAX_EVENT_BYTES, MAX_JOURNAL_BYTES, MemoryError, SCHEMA_VERSION, ZERO_HASH,
  buildEnvelopeV3, foldV3,
} from './domain-v3.mjs';
import {
  assertMutationAllowed, assertOwnedFile, assertPathSafe, assertStoreSafe, detectStoreVersion,
  gitAdminTopology, openStore, readOwnedFileBounded, storePaths,
} from './store.mjs';
import { unavailableWorkspace } from './workspace-v3.mjs';

const MAX_PROJECTION_BYTES = 64 * 1024;

function fail(message, exitCode = 3) {
  throw new MemoryError(message, exitCode);
}

function testBarrier(point, details) {
  if (process.env.NODE_ENV !== 'test' || process.env.PROJECT_MEMORY_TEST_BARRIER_POINT !== point) return;
  const directory = process.env.PROJECT_MEMORY_TEST_BARRIER_DIR;
  if (!directory || !existsSync(directory)) fail('test race barrier is unavailable');
  const ready = path.join(directory, 'ready.json');
  const release = path.join(directory, 'release');
  try {
    writeFileSync(ready, `${JSON.stringify({ point, ...details })}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    fail('test race barrier is unavailable');
  }
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 15_000;
  while (!existsSync(release)) {
    if (Date.now() >= deadline) fail('test race barrier timed out');
    Atomics.wait(sleeper, 0, 0, 10);
  }
}

function nowIso(clock) {
  const value = typeof clock === 'function' ? clock() : new Date();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function defaultWorkspace(recordedAt) {
  return unavailableWorkspace(recordedAt);
}

function captureDraft(input) {
  if (typeof input === 'string' || (input && typeof input === 'object' && (Buffer.isBuffer(input) || input instanceof Uint8Array))) {
    return captureAuthoritativeInput(input);
  }
  fail('appendV3 accepts JSON text or bytes only', 2);
}

function eventLine(event) {
  const bytes = Buffer.from(`${canonicalV3(event)}\n`, 'utf8');
  if (bytes.length > MAX_EVENT_BYTES) fail('history event exceeds the size limit', 2);
  return bytes;
}

function projectionBytes(state) {
  const bytes = Buffer.from(`${canonicalV3(state)}\n`, 'utf8');
  if (bytes.length > MAX_PROJECTION_BYTES) fail('CURRENT projection exceeds the size limit');
  return bytes;
}

function lockFile(root) {
  return gitAdminTopology(root).lock;
}

function acquireLock(root) {
  const file = lockFile(root);
  if (existsSync(file)) {
    assertOwnedFile(file, 'continuity lock', { optional: false });
    fail('continuity is locked by another or interrupted writer');
  }
  let fd;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') fail('continuity is locked by another or interrupted writer');
    fail('unable to acquire continuity lock');
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), schemaVersion: SCHEMA_VERSION }));
    fsyncSync(fd);
  } catch {
    try { closeSync(fd); } catch { /* lock fd */ }
    try { unlinkSync(file); } catch { /* best-effort */ }
    fail('unable to initialize continuity lock');
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { unlinkSync(file); } finally { try { closeSync(fd); } catch { /* lock fd */ } }
  };
}

function writeOwned(file, bytes) {
  const fd = openSync(file, 'wx', 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function replaceProjection(root, state) {
  const files = assertStoreSafe(root);
  if (process.env.NODE_ENV === 'test' && process.env.PROJECT_MEMORY_TEST_FAIL_V3_CURRENT_REPLACE === '1') {
    fail('simulated v3 CURRENT projection failure');
  }
  const temporary = `${files.current}.tmp-${process.pid}-${randomUUID()}`;
  assertPathSafe(root, temporary);
  writeOwned(temporary, projectionBytes(state));
  testBarrier('journal-projection-before-rename', { temporary, current: files.current });
  renameSync(temporary, files.current);
}

export function readV3Journal(root, { allowEmpty = false } = {}) {
  const files = assertStoreSafe(root);
  if (!existsSync(files.history)) {
    if (allowEmpty) return { files, events: [], committedBytes: 0, trailingBytes: 0, state: null, projection: 'missing' };
    fail('history has no committed events');
  }
  const raw = readOwnedFileBounded(files.history, MAX_JOURNAL_BYTES, 'HISTORY.ndjson total');
  const text = raw.toString('utf8');
  const lastLf = text.lastIndexOf('\n');
  if (lastLf < 0) fail('journal has no committed event');
  const committed = text.slice(0, lastLf + 1);
  const trailingBytes = raw.length - Buffer.byteLength(committed, 'utf8');
  const lines = committed.split('\n').filter(Boolean);
  const events = lines.map((line, index) => {
    if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) fail(`history event ${index + 1} exceeds the size limit`);
    try {
      return JSON.parse(line);
    } catch {
      fail(`history event ${index + 1} is not valid JSON`);
    }
  });
  if (!events.length) {
    if (allowEmpty) return { files, events, committedBytes: 0, trailingBytes, state: null, projection: 'missing' };
    fail('history has no committed events');
  }
  if (events[0]?.schemaVersion !== SCHEMA_VERSION) fail('store is not a v3 journal', 5);
  const state = foldV3(events);
  let projection = 'missing';
  if (existsSync(files.current)) {
    try {
      const parsed = JSON.parse(readOwnedFileBounded(files.current, MAX_PROJECTION_BYTES, 'CURRENT.json').toString('utf8'));
      projection = canonicalV3(parsed) === canonicalV3(state) ? 'current' : 'stale';
    } catch {
      projection = 'invalid';
    }
  }
  return {
    files, events, committedBytes: Buffer.byteLength(committed, 'utf8'), trailingBytes, state, projection,
  };
}

export function replayV3(root) {
  return readV3Journal(root);
}

export function rebuildV3(root, { dryRun = false } = {}) {
  const store = readV3Journal(root);
  const bytes = projectionBytes(store.state);
  if (dryRun) {
    return {
      dryRun: true,
      equivalent: store.projection === 'current',
      sequence: store.events.at(-1).sequence,
      bytes: bytes.length,
    };
  }
  const release = acquireLock(root);
  try {
    assertMutationAllowed(root);
    replaceProjection(root, store.state);
    return { dryRun: false, sequence: store.events.at(-1).sequence, projection: 'current' };
  } finally {
    release();
  }
}

function persistEvents(root, events, { existing } = {}) {
  const files = storePaths(root);
  const historyBytes = Buffer.concat(events.map(eventLine));
  if (existing) {
    const fd = openSync(files.history, 'r+');
    try {
      if (existing.trailingBytes) {
        ftruncateSync(fd, existing.committedBytes);
        fsyncSync(fd);
      }
      const start = existing.committedBytes;
      if (start + historyBytes.length > MAX_JOURNAL_BYTES) fail('HISTORY.ndjson would exceed the total size limit');
      let offset = 0;
      while (offset < historyBytes.length) {
        offset += writeSync(fd, historyBytes, offset, historyBytes.length - offset, start + offset);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return;
  }
  writeOwned(files.history, historyBytes);
}

export function initializeV3(root, jsonTextOrBytes, options = {}) {
  if (options && (typeof options !== 'object' || Array.isArray(options))) fail('initializeV3 options are invalid', 2);
  const clock = typeof options.clock === 'function' ? options.clock : () => new Date();
  assertMutationAllowed(root);
  const input = captureDraft(jsonTextOrBytes);
  if (input.schemaVersion !== SCHEMA_VERSION) fail('v3 init requires schemaVersion 3', 2);
  if (!input.project || !input.finalGoal) fail('v3 init requires project and finalGoal', 2);
  const recordedAt = nowIso(clock);
  const workspaceAtRecord = workspaceForRecord(root, recordedAt, options.workspace);
  const epochId = `epoch-${randomUUID()}`;
  const actor = input.actor;
  const occurredAt = input.occurredAt;
  const projectDraft = {
    eventType: 'project.initialized',
    occurredAt,
    actor,
    subject: { type: 'project', id: input.project.projectId },
    supersedes: [],
    contradicts: [],
    evidenceRefs: [],
    sensitivity: 'internal',
    payload: { project: input.project, initialization: 'new' },
  };
  const goalDraft = {
    eventType: 'goal.declared',
    occurredAt,
    actor,
    subject: { type: 'goal', id: input.finalGoal.goalId },
    goalId: input.finalGoal.goalId,
    supersedes: [],
    contradicts: [],
    evidenceRefs: input.evidenceRef ? [input.evidenceRef] : [],
    sensitivity: 'internal',
    payload: { goal: input.finalGoal },
  };
  const first = buildEnvelopeV3(projectDraft, {
    epochId, sequence: 1, recordedAt, workspaceAtRecord, previousEventHash: ZERO_HASH,
  });
  const second = buildEnvelopeV3(goalDraft, {
    epochId, sequence: 2, recordedAt, workspaceAtRecord, previousEventHash: first.eventHash,
  });
  const events = [first, second];
  if (input.criterion) {
    const criterionDraft = {
      eventType: 'criterion.declared',
      occurredAt,
      actor,
      subject: { type: 'criterion', id: input.criterion.criterionId },
      supersedes: [],
      contradicts: [],
      evidenceRefs: [],
      sensitivity: 'internal',
      payload: { criterion: input.criterion },
    };
    events.push(buildEnvelopeV3(criterionDraft, {
      epochId, sequence: 3, recordedAt, workspaceAtRecord, previousEventHash: events.at(-1).eventHash,
    }));
  }
  const state = foldV3(events);
  const release = acquireLock(root);
  const files = storePaths(root);
  const storeParent = path.dirname(files.store);
  const temporary = path.join(storeParent, `${path.basename(files.store)}.tmp-${process.pid}-${randomUUID()}`);
  let installed = false;
  try {
    assertMutationAllowed(root);
    if (detectStoreVersion(root) !== 'uninitialized') fail('continuity is already initialized', 2);
    assertPathSafe(root, storeParent);
    assertPathSafe(root, temporary);
    mkdirSync(storeParent, { recursive: true });
    if (existsSync(files.store)) fail('continuity is already initialized', 2);
    mkdirSync(temporary, { recursive: false });
    writeOwned(path.join(temporary, 'HISTORY.ndjson'), Buffer.concat(events.map(eventLine)));
    writeOwned(path.join(temporary, 'CURRENT.json'), projectionBytes(state));
    renameSync(temporary, files.store);
    installed = true;
    return {
      version: 3,
      epochId,
      sequence: events.at(-1).sequence,
      eventId: events.at(-1).eventId,
      eventHash: events.at(-1).eventHash,
      projection: 'current',
    };
  } finally {
    if (!installed && existsSync(temporary)) {
      try { rmSync(temporary, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    release();
  }
}

function receiptFor(event) {
  const subjectId = event.subject?.id ?? null;
  return {
    version: 3,
    epochId: event.epochId,
    sequence: event.sequence,
    eventId: event.eventId,
    eventHash: event.eventHash,
    projection: 'current',
    eventType: event.eventType,
    subjectId,
    ...(event.eventType === 'result.recorded' ? { resultId: subjectId } : {}),
    ...(event.eventType === 'assignment.recorded' ? { assignmentId: subjectId } : {}),
  };
}

function restoreCommittedHistory(root, committedBytes) {
  const files = storePaths(root);
  const fd = openSync(files.history, 'r+');
  try {
    ftruncateSync(fd, committedBytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function resolveDraftInputs(draftsOrBuilder, store) {
  const draftInputs = typeof draftsOrBuilder === 'function' ? draftsOrBuilder(store) : draftsOrBuilder;
  if (!Array.isArray(draftInputs) || draftInputs.length < 1) fail('appendV3Batch requires a non-empty draft list', 2);
  return draftInputs;
}

function buildProspectiveBatch(store, draftInputs, { recordedAt, workspaceAtRecord }) {
  let events = store.events;
  let state = store.state;
  const built = [];
  for (const draftInput of draftInputs) {
    const draft = captureDraft(draftInput);
    if (!isBrandedV3(draft)) fail('appendV3 requires a branded snapshot', 2);
    const last = events.at(-1);
    const event = buildEnvelopeV3(draft, {
      epochId: last.epochId,
      sequence: last.sequence + 1,
      recordedAt,
      workspaceAtRecord,
      previousEventHash: last.eventHash,
      state,
    });
    events = [...events, event];
    state = foldV3(events);
    built.push(event);
  }
  return { built, state };
}

function workspaceForRecord(root, recordedAt, explicit) {
  return explicit ?? defaultWorkspace(recordedAt);
}

export function appendV3(root, jsonTextOrBytes, options = {}) {
  if (arguments.length < 2 || arguments.length > 3) fail('appendV3 arity is invalid', 2);
  if (options && (typeof options !== 'object' || Array.isArray(options))) fail('appendV3 options are invalid', 2);
  const [receipt] = appendV3Batch(root, [jsonTextOrBytes], options);
  return receipt;
}

export function appendV3Batch(root, draftsOrBuilder, options = {}) {
  if (arguments.length < 2 || arguments.length > 3) fail('appendV3Batch arity is invalid', 2);
  if (options && (typeof options !== 'object' || Array.isArray(options))) fail('appendV3Batch options are invalid', 2);
  assertMutationAllowed(root);
  if (typeof draftsOrBuilder !== 'function') {
    const preview = Array.isArray(draftsOrBuilder) ? draftsOrBuilder : [draftsOrBuilder];
    if (!preview.length) fail('appendV3Batch requires a non-empty draft list', 2);
    for (const draftInput of preview) {
      const draft = captureDraft(draftInput);
      if (!isBrandedV3(draft)) fail('appendV3 requires a branded snapshot', 2);
    }
  }
  assertMutationAllowed(root);
  openStore(root, { mode: 'write' });
  const release = acquireLock(root);
  try {
    testBarrier('journal-append-after-lock', { lock: lockFile(root) });
    assertMutationAllowed(root);
    const store = readV3Journal(root);
    const clock = typeof options.clock === 'function' ? options.clock : () => new Date();
    const recordedAt = nowIso(clock);
    const workspaceAtRecord = workspaceForRecord(root, recordedAt, options.workspace);
    const draftInputs = resolveDraftInputs(draftsOrBuilder, store);
    const { built, state } = buildProspectiveBatch(store, draftInputs, { recordedAt, workspaceAtRecord });
    try {
      persistEvents(root, built, { existing: store });
    } catch (error) {
      try {
        restoreCommittedHistory(root, store.committedBytes);
      } catch {
        fail('event persist interrupted; HISTORY pending repair');
      }
      throw error;
    }
    try {
      replaceProjection(root, state);
    } catch {
      fail(`event committed as sequence ${built.at(-1).sequence}; CURRENT projection pending repair`);
    }
    return built.map(receiptFor);
  } finally {
    release();
  }
}

export function validateV3Append(root, jsonTextOrBytes, options = {}) {
  const [receipt] = validateV3Batch(root, [jsonTextOrBytes], options);
  return { prospectiveSequence: receipt.sequence };
}

export function validateV3Batch(root, draftsOrBuilder, options = {}) {
  if (arguments.length < 2 || arguments.length > 3) fail('validateV3Batch arity is invalid', 2);
  if (options && (typeof options !== 'object' || Array.isArray(options))) fail('validateV3Batch options are invalid', 2);
  if (typeof draftsOrBuilder !== 'function') {
    const preview = Array.isArray(draftsOrBuilder) ? draftsOrBuilder : [draftsOrBuilder];
    if (!preview.length) fail('appendV3Batch requires a non-empty draft list', 2);
    for (const draftInput of preview) {
      const draft = captureDraft(draftInput);
      if (!isBrandedV3(draft)) fail('appendV3 requires a branded snapshot', 2);
    }
  }
  const store = readV3Journal(root);
  const clock = typeof options.clock === 'function' ? options.clock : () => new Date();
  const recordedAt = nowIso(clock);
  const workspaceAtRecord = workspaceForRecord(root, recordedAt, options.workspace);
  const draftInputs = resolveDraftInputs(draftsOrBuilder, store);
  const { built } = buildProspectiveBatch(store, draftInputs, { recordedAt, workspaceAtRecord });
  return built.map(receiptFor);
}
