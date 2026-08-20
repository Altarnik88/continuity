import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync,
  linkSync, readSync, readlinkSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import path from 'node:path';

import {
  MAX_EVENT_BYTES, MAX_JOURNAL_BYTES, MemoryError, ZERO_HASH, buildEnvelope, canonicalV2,
  evidencePolicyFacts, foldV2, validateDraftForPersistence, validateDraftShape,
} from './domain-v2.mjs';
import {
  assertMutationAllowed, assertOwnedFile, assertPathSafe, assertStoreSafe, detectStoreVersion,
  gitAdminTopology, isStoreRepoPath, openStore, readOwnedFileBounded, readV2Journal, storePaths,
} from './store.mjs';

const MAX_PROJECTION_BYTES = 64 * 1024;
const MAX_STATUS_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACE_HASH_BYTES = 8 * 1024 * 1024;
const MAX_WORKSPACE_FILE_BYTES = 1024 * 1024;

function nowIso(clock) {
  const value = typeof clock === 'function' ? clock() : new Date();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function publicOptions(options, allowed, label) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new MemoryError(`${label} options are invalid`, 3);
  }
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(options);
    keys = Reflect.ownKeys(options);
  } catch {
    throw new MemoryError(`${label} options are invalid`, 3);
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== 'string' || !Object.hasOwn(allowed, key))) {
    throw new MemoryError(`${label} options are invalid`, 3);
  }
  const verified = Object.create(null);
  try {
    for (const [key, type] of Object.entries(allowed)) {
      if (!keys.includes(key)) continue;
      const value = options[key];
      if (value !== undefined && typeof value !== type) throw new MemoryError(`${label} options are invalid`, 3);
      verified[key] = value;
    }
  } catch {
    throw new MemoryError(`${label} options are invalid`, 3);
  }
  return verified;
}

function testBarrier(point, details) {
  if (process.env.NODE_ENV !== 'test' || process.env.PROJECT_MEMORY_TEST_BARRIER_POINT !== point) return;
  const directory = process.env.PROJECT_MEMORY_TEST_BARRIER_DIR;
  if (!directory || !existsSync(directory)) throw new MemoryError('test race barrier is unavailable', 3);
  const ready = path.join(directory, 'ready.json');
  const release = path.join(directory, 'release');
  try {
    writeFileSync(ready, `${JSON.stringify({ point, ...details })}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    throw new MemoryError('test race barrier is unavailable', 3);
  }
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 15_000;
  while (!existsSync(release)) {
    if (Date.now() >= deadline) throw new MemoryError('test race barrier timed out', 3);
    Atomics.wait(sleeper, 0, 0, 10);
  }
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function git(root, args, { maxBuffer = 2 * 1024 * 1024 } = {}) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer, env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } });
  if (result.status !== 0 || result.error) throw new MemoryError('unable to inspect Git repository state', 3);
  return result.stdout;
}

function workspaceTarget(root, repoPath, budget) {
  const absolute = path.resolve(root, repoPath);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return { material: 'unsafe', partial: true };
  if (!existsSync(absolute)) return { material: 'missing', partial: false };
  let details;
  try { details = lstatSync(absolute); } catch { return { material: 'unreadable', partial: true }; }
  if (details.isSymbolicLink()) {
    try { return { material: sha256(`symlink:${readlinkSync(absolute)}`), partial: false }; } catch { return { material: 'unreadable-link', partial: true }; }
  }
  if (!details.isFile()) return { material: sha256(`non-file:${details.mode}:${details.size}`), partial: true };
  const allowance = Math.max(0, Math.min(details.size, MAX_WORKSPACE_FILE_BYTES, budget.remaining));
  const digest = createHash('sha256');
  digest.update(`size:${details.size}:mode:${details.mode}:`);
  let fd; let read = 0;
  try {
    fd = openSync(absolute, 'r');
    const buffer = Buffer.alloc(32 * 1024);
    while (read < allowance) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, allowance - read), null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
      read += count;
    }
  } catch { return { material: 'unreadable', partial: true }; } finally { if (fd !== undefined) closeSync(fd); }
  budget.remaining -= read;
  const partial = read < details.size;
  digest.update(partial ? ':TRUNCATED' : ':COMPLETE');
  return { material: digest.digest('hex'), partial };
}

function workspace(root, recordedAt) {
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || 'detached';
  const result = spawnSync('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: MAX_STATUS_BYTES, env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } });
  let partial = Boolean(result.error) || result.status !== 0;
  const fields = partial ? [] : (result.stdout ?? '').split('\0').filter(Boolean);
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4) { entries.push({ status: 'rename-source', repoPath: field.replaceAll('\\', '/') }); continue; }
    const status = field.slice(0, 2);
    const repoPath = field.slice(3).replaceAll('\\', '/');
    if (!isStoreRepoPath(root, repoPath)) entries.push({ status, repoPath });
    if (/[RC]/.test(status) && index + 1 < fields.length) {
      index += 1;
      const source = fields[index].replaceAll('\\', '/');
      if (!isStoreRepoPath(root, source)) entries.push({ status: 'rename-source', repoPath: source });
    }
  }
  entries.sort((left, right) => `${left.status}\0${left.repoPath}`.localeCompare(`${right.status}\0${right.repoPath}`, 'en'));
  const budget = { remaining: MAX_WORKSPACE_HASH_BYTES };
  const material = [];
  for (const entry of entries) {
    const target = workspaceTarget(root, entry.repoPath, budget);
    partial ||= target.partial;
    material.push(`${entry.status}\0${entry.repoPath}\0${target.material}`);
  }
  if (partial) material.push('FINGERPRINT_PARTIAL');
  return { head, branch, dirty: entries.length > 0 || partial, statusFingerprint: sha256(material.join('\0')), fingerprintPartial: partial, capturedAt: recordedAt };
}

function sourceRefState(root, sourceRef) {
  const absolute = path.resolve(root, sourceRef.path);
  try {
    assertPathSafe(root, absolute);
    if (!existsSync(absolute)) return 'stale';
    const bytes = readOwnedFileBounded(absolute, MAX_WORKSPACE_FILE_BYTES, 'freshness source');
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const digest = sha256(decoded.replaceAll('\r\n', '\n').replaceAll('\r', '\n'));
    return digest === sourceRef.contentSha256 ? 'current' : 'stale';
  } catch { return 'unknown'; }
}

function combineFreshness(values) {
  if (values.includes('stale')) return 'stale';
  if (values.includes('unknown')) return 'unknown';
  if (values.includes('fresh')) return 'fresh';
  return 'not_applicable';
}

function policyFreshness(root, evidence, policy, now) {
  if (policy.kind === 'not_applicable') return 'not_applicable';
  if (policy.kind === 'immutable_until_superseded') return 'fresh';
  if (policy.kind === 'source_digest' && !evidencePolicyFacts({ ...evidence, policy }).sourceBound) return 'unknown';
  const sourceStates = evidence.sourceRefs.map((sourceRef) => sourceRefState(root, sourceRef));
  let result = sourceStates.includes('stale') ? 'stale' : sourceStates.includes('unknown') ? 'unknown' : 'fresh';
  if (policy.kind === 'max_age' && result === 'fresh') {
    const age = Date.parse(now) - Date.parse(evidence.observedAt);
    if (age < 0) result = 'unknown';
    else if (age > policy.maxAgeSeconds * 1_000) result = 'stale';
  }
  return result;
}

function observeCompletionFreshness(root, state, recordedAt, workspaceNow) {
  const evidenceIds = new Set(state.evidence.map((evidence) => evidence.evidenceId));
  return (evidence, criterion) => {
    if (!evidenceIds.has(evidence.evidenceId)) return 'unknown';
    const freshness = [policyFreshness(root, evidence, evidence.policy, recordedAt)];
    if (canonicalV2(criterion.freshnessPolicy) !== canonicalV2(evidence.policy)) freshness.push(policyFreshness(root, evidence, criterion.freshnessPolicy, recordedAt));
    if (evidence.workspaceAtObservation) {
      const observed = evidence.workspaceAtObservation;
      freshness.push(observed.fingerprintPartial || workspaceNow.fingerprintPartial ? 'unknown'
        : observed.head !== workspaceNow.head || observed.statusFingerprint !== workspaceNow.statusFingerprint ? 'stale' : 'fresh');
    }
    return combineFreshness(freshness);
  };
}

function lockPath(root) {
  return gitAdminTopology(root).lock;
}

function assertFdOwned(file, fd, label) {
  try {
    const byPath = lstatSync(file, { bigint: true }); const opened = fstatSync(fd, { bigint: true });
    if (!byPath.isFile() || !opened.isFile() || byPath.nlink !== 1n || opened.nlink !== 1n
      || byPath.dev !== opened.dev || byPath.ino !== opened.ino) {
      throw new MemoryError(`${label} ownership changed`, 3);
    }
    return opened;
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError(`${label} ownership changed`, 3);
  }
}

function retainedIdentity(retained) {
  return typeof retained === 'number' ? fstatSync(retained, { bigint: true }) : retained;
}

function pathOwnsRetained(file, retained, { directory = false, expectedLinks } = {}) {
  try {
    if (typeof expectedLinks !== 'bigint' || expectedLinks < 1n) return false;
    const byPath = lstatSync(file, { bigint: true });
    const identity = retainedIdentity(retained);
    const typeMatches = directory
      ? byPath.isDirectory() && identity.isDirectory()
      : byPath.isFile() && identity.isFile();
    return typeMatches && byPath.nlink === expectedLinks
      && byPath.dev === identity.dev && byPath.ino === identity.ino;
  } catch {
    return false;
  }
}

function assertRetainedPath(file, retained, label, options) {
  if (!pathOwnsRetained(file, retained, options)) throw new MemoryError(`${label} ownership changed`, 3);
  return retainedIdentity(retained);
}

// Recovery only: extra aliases must survive, so restoring the prior inode cannot use
// its observed link count as cleanup authority. Every destructive caller uses expectedLinks.
function assertRetainedIdentity(file, retained, label) {
  try {
    const byPath = lstatSync(file, { bigint: true });
    const identity = retainedIdentity(retained);
    if (!byPath.isFile() || !identity.isFile()
      || byPath.dev !== identity.dev || byPath.ino !== identity.ino) {
      throw new MemoryError(`${label} ownership changed`, 3);
    }
    return byPath;
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError(`${label} ownership changed`, 3);
  }
}

function retireOwnedPath(file, retained, label, { directory = false, barrierPoint, expectedLinks } = {}) {
  assertRetainedPath(file, retained, label, { directory, expectedLinks });
  if (barrierPoint) testBarrier(barrierPoint, { target: file });
  const retired = `${file}.retired-${process.pid}-${randomUUID()}`;
  try {
    renameSync(file, retired);
  } catch {
    throw new MemoryError(`${label} cleanup failed`, 3);
  }
  if (!pathOwnsRetained(retired, retained, { directory, expectedLinks })) {
    try {
      if (!existsSync(file)) renameSync(retired, file);
    } catch {
      // The replacement remains retained at one of the two paths; never remove it speculatively.
    }
    throw new MemoryError(`${label} ownership changed`, 3);
  }
  try {
    if (directory) rmSync(retired, { recursive: true, force: false });
    else unlinkSync(retired);
  } catch {
    throw new MemoryError(`${label} cleanup failed`, 3);
  }
}

function acquireLock(root) {
  const file = lockPath(root);
  if (existsSync(file)) { assertOwnedFile(file, 'continuity lock', { optional: false }); throw new MemoryError('continuity is locked by another or interrupted writer', 3); }
  let fd;
  let identity;
  try { fd = openSync(file, 'wx', 0o600); } catch (error) { if (error?.code === 'EEXIST') throw new MemoryError('continuity is locked by another or interrupted writer', 3); throw new MemoryError('unable to acquire continuity lock', 3); }
  try {
    identity = fstatSync(fd, { bigint: true });
    assertFdOwned(file, fd, 'continuity lock');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: nowIso() }));
    if (process.env.NODE_ENV === 'test' && process.env.PROJECT_MEMORY_TEST_FAIL_V2_LOCK_METADATA === '1') {
      throw new Error('simulated v2 lock metadata failure');
    }
    fsyncSync(fd);
  } catch {
    try {
      if (identity) retireOwnedPath(file, fd, 'continuity lock', {
        barrierPoint: 'journal-lock-failure-cleanup', expectedLinks: 1n,
      });
    } catch {}
    try { closeSync(fd); } catch {}
    throw new MemoryError('unable to initialize continuity lock', 3);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    let failure;
    try {
      retireOwnedPath(file, fd, 'continuity lock', {
        barrierPoint: 'journal-lock-release-cleanup', expectedLinks: 1n,
      });
    } catch (error) {
      failure = error instanceof MemoryError ? error : new MemoryError('unable to release continuity lock', 3);
    }
    try { closeSync(fd); } catch { failure ??= new MemoryError('unable to close continuity lock', 3); }
    if (failure) throw failure;
  };
}

function syncDirectory(directory) {
  let fd;
  try { fd = openSync(directory, 'r'); fsyncSync(fd); } catch { if (process.platform !== 'win32') throw new MemoryError('unable to sync continuity directory metadata', 3); } finally { if (fd !== undefined) closeSync(fd); }
}

function writeOwnedFile(file, bytes) {
  const fd = openSync(file, 'wx', 0o600);
  try { assertFdOwned(file, fd, path.basename(file)); let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset); fsyncSync(fd); assertFdOwned(file, fd, path.basename(file)); } finally { closeSync(fd); }
}

function projectionBytes(state) {
  const bytes = Buffer.from(`${canonicalV2(state)}\n`, 'utf8');
  if (bytes.length > MAX_PROJECTION_BYTES) throw new MemoryError('CURRENT projection exceeds the size limit', 3);
  return bytes;
}

function eventBytes(event) {
  const bytes = Buffer.from(`${canonicalV2(event)}\n`, 'utf8');
  if (bytes.length > MAX_EVENT_BYTES) throw new MemoryError('history event exceeds the size limit');
  return bytes;
}

function validateInitInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MemoryError('v2 init input must be an object');
  const allowed = ['schemaVersion', 'project', 'finalGoal', 'actor', 'occurredAt', 'evidenceRef'];
  if (Object.keys(input).some((key) => !allowed.includes(key)) || allowed.some((key) => !(key in input))) throw new MemoryError('v2 init input has missing or unknown fields');
  if (input.schemaVersion !== 2 || input.finalGoal?.isFinal !== true || input.finalGoal?.authority !== 'user' || input.finalGoal?.basis !== 'user_stated') throw new MemoryError('v2 init requires one explicit user-backed final goal');
  const projectDraft = { eventType: 'project.initialized', occurredAt: input.occurredAt, actor: input.actor, subject: { type: 'project', id: input.project?.projectId }, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal', payload: { project: input.project, initialization: 'new' } };
  const goalDraft = { eventType: 'goal.declared', occurredAt: input.occurredAt, actor: input.actor, subject: { type: 'goal', id: input.finalGoal?.goalId }, goalId: input.finalGoal?.goalId, supersedes: [], contradicts: [], evidenceRefs: [input.evidenceRef], sensitivity: 'internal', payload: { goal: input.finalGoal, evidenceRef: input.evidenceRef } };
  return { projectDraft, goalDraft };
}

export function initializeV2(root, input, options = {}) {
  if (arguments.length > 3) throw new MemoryError('initializeV2 options are invalid', 3);
  const verifiedOptions = publicOptions(options, { clock: 'function' }, 'initializeV2');
  const { clock = () => new Date() } = verifiedOptions;
  assertMutationAllowed(root);
  const { projectDraft, goalDraft } = validateInitInput(input);
  openStore(root, { mode: 'write' });
  const recordedAt = nowIso(clock); const epochId = `epoch-${randomUUID()}`; const workspaceAtRecord = workspace(root, recordedAt);
  const first = buildEnvelope(projectDraft, { epochId, sequence: 1, recordedAt, workspaceAtRecord, previousEventHash: ZERO_HASH });
  const second = buildEnvelope(goalDraft, { epochId, sequence: 2, recordedAt, workspaceAtRecord, previousEventHash: first.eventHash });
  const events = [first, second]; const state = foldV2(events); const historyBytes = Buffer.concat(events.map(eventBytes)); const currentBytes = projectionBytes(state);
  const release = acquireLock(root);
  const files = storePaths(root);
  const storeParent = path.dirname(files.store);
  const temporary = path.join(storeParent, `${path.basename(files.store)}.tmp-${process.pid}-${randomUUID()}`);
  let temporaryIdentity;
  let installed = false;
  try {
    assertMutationAllowed(root);
    if (detectStoreVersion(root) !== 'uninitialized' || existsSync(files.current)) throw new MemoryError('continuity is already initialized', 3);
    assertPathSafe(root, storeParent); assertPathSafe(root, temporary); mkdirSync(storeParent, { recursive: true });
    if (existsSync(files.store)) throw new MemoryError('continuity is already initialized', 3);
    assertMutationAllowed(root);
    mkdirSync(temporary, { recursive: false, mode: 0o700 });
    temporaryIdentity = lstatSync(temporary, { bigint: true });
    writeOwnedFile(path.join(temporary, 'HISTORY.ndjson'), historyBytes); writeOwnedFile(path.join(temporary, 'CURRENT.json'), currentBytes); syncDirectory(temporary);
    if (process.env.NODE_ENV === 'test' && process.env.PROJECT_MEMORY_TEST_FAIL_V2_INIT_TEMP === '1') {
      throw new MemoryError('simulated v2 initialization temporary failure', 3);
    }
    assertMutationAllowed(root);
    renameSync(temporary, files.store); installed = true; syncDirectory(storeParent);
    return { version: 2, epochId, sequence: 2, eventId: second.eventId, eventHash: second.eventHash, projection: 'current' };
  } finally {
    let cleanupFailure;
    if (!installed && temporaryIdentity) {
      try {
        retireOwnedPath(temporary, temporaryIdentity, 'continuity initialization temporary', {
          directory: true,
          barrierPoint: 'journal-init-temp-cleanup',
          expectedLinks: temporaryIdentity.nlink,
        });
      } catch (error) {
        cleanupFailure = error instanceof MemoryError ? error : new MemoryError('continuity initialization temporary cleanup failed', 3);
      }
    }
    try { release(); } catch (error) { cleanupFailure ??= error; }
    if (cleanupFailure) throw cleanupFailure;
  }
}

function atomicProjection(root, state) {
  const files = assertStoreSafe(root); const temporary = `${files.current}.tmp-${process.pid}-${randomUUID()}`; const bytes = projectionBytes(state);
  assertPathSafe(root, temporary);
  let fd;
  let temporaryIdentity;
  let previousFd;
  let previousIdentity;
  let backup;
  let installed = false;
  let renamed = false;
  let failure;
  try {
    try { fd = openSync(temporary, 'wx', 0o600); } catch { throw new MemoryError('unable to create projection temporary', 3); }
    temporaryIdentity = assertFdOwned(temporary, fd, 'projection temporary');
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) {
        throw new MemoryError('projection temporary returned an invalid write length', 3);
      }
      offset += count;
    }
    fsyncSync(fd);
    assertFdOwned(temporary, fd, 'projection temporary');
    if (process.env.NODE_ENV === 'test' && process.env.PROJECT_MEMORY_TEST_FAIL_V2_CURRENT_REPLACE === '1') {
      throw new MemoryError('simulated v2 CURRENT projection failure', 3);
    }
    assertStoreSafe(root);
    try {
      previousFd = openSync(files.current, 'r');
      previousIdentity = assertFdOwned(files.current, previousFd, 'CURRENT.json');
      backup = `${files.current}.rollback-${process.pid}-${randomUUID()}`;
      linkSync(files.current, backup);
      assertRetainedPath(files.current, previousFd, 'CURRENT.json', { expectedLinks: 2n });
      assertRetainedPath(backup, previousFd, 'CURRENT.json rollback link', { expectedLinks: 2n });
      closeSync(previousFd);
      previousFd = undefined;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      previousFd = undefined;
      previousIdentity = undefined;
      backup = undefined;
    }
    assertFdOwned(temporary, fd, 'projection temporary');
    testBarrier('journal-projection-before-rename', { temporary, current: files.current, rollback: backup });
    assertFdOwned(temporary, fd, 'projection temporary');
    if (backup) {
      assertRetainedPath(files.current, previousIdentity, 'CURRENT.json', { expectedLinks: 2n });
      assertRetainedPath(backup, previousIdentity, 'CURRENT.json rollback link', { expectedLinks: 2n });
    }
    renameSync(temporary, files.current);
    renamed = true;
    temporaryIdentity = assertFdOwned(files.current, fd, 'CURRENT.json');
    syncDirectory(files.store);
    closeSync(fd);
    fd = undefined;
    if (backup) {
      retireOwnedPath(backup, previousIdentity, 'CURRENT.json rollback link', {
        barrierPoint: 'journal-projection-rollback-cleanup', expectedLinks: 1n,
      });
      backup = undefined;
    }
    installed = true;
  } catch (error) {
    if (renamed && !installed) {
      try {
        let recovery;
        if (backup) {
          assertRetainedIdentity(backup, previousIdentity, 'CURRENT.json rollback link');
          recovery = `${backup}.restore-${process.pid}-${randomUUID()}`;
          assertPathSafe(root, recovery);
          linkSync(backup, recovery);
          assertRetainedIdentity(recovery, previousIdentity, 'CURRENT.json recovery link');
        }
        const installedRetained = fd ?? temporaryIdentity;
        if (installedRetained && pathOwnsRetained(files.current, installedRetained, { expectedLinks: 1n })) {
          if (existsSync(temporary)) throw new MemoryError('projection rollback path is occupied', 3);
          renameSync(files.current, temporary);
          assertRetainedPath(temporary, installedRetained, 'projection rollback temporary', { expectedLinks: 1n });
        } else if (existsSync(files.current)) {
          const quarantine = `${files.current}.quarantine-${process.pid}-${randomUUID()}`;
          assertPathSafe(root, quarantine);
          renameSync(files.current, quarantine);
        }
        renamed = false;
        if (recovery) {
          assertRetainedIdentity(recovery, previousIdentity, 'CURRENT.json recovery link');
          renameSync(recovery, files.current);
          assertRetainedIdentity(files.current, previousIdentity, 'CURRENT.json');
        } else if (existsSync(files.current)) {
          throw new MemoryError('CURRENT projection rollback failed', 3);
        }
        syncDirectory(files.store);
      } catch {
        error = new MemoryError('unable to preserve prior CURRENT projection', 3);
      }
    }
    failure = error instanceof MemoryError ? error : new MemoryError('unable to install CURRENT projection', 3);
  } finally {
    if (backup && previousIdentity) {
      const expectedLinks = renamed ? 1n : 2n;
      if (pathOwnsRetained(backup, previousIdentity, { expectedLinks })) {
        try { retireOwnedPath(backup, previousIdentity, 'CURRENT.json rollback link', { expectedLinks }); } catch { failure ??= new MemoryError('CURRENT projection rollback-link cleanup failed', 3); }
      }
    }
    const temporaryRetained = fd ?? temporaryIdentity;
    if (!installed && temporaryRetained && pathOwnsRetained(temporary, temporaryRetained, { expectedLinks: 1n })) {
      try {
        retireOwnedPath(temporary, temporaryRetained, 'projection temporary', {
          barrierPoint: 'journal-projection-temp-cleanup', expectedLinks: 1n,
        });
      } catch { failure ??= new MemoryError('owned projection temporary cleanup failed', 3); }
    }
    if (fd !== undefined) {
      try { closeSync(fd); } catch { failure ??= new MemoryError('projection temporary could not be closed safely', 3); }
    }
    if (previousFd !== undefined) try { closeSync(previousFd); } catch { failure ??= new MemoryError('prior CURRENT descriptor could not be closed safely', 3); }
  }
  if (failure) throw failure;
}

function truncateTail(root, files, bytes) {
  assertStoreSafe(root); const fd = openSync(files.history, 'r+');
  try { assertFdOwned(files.history, fd, 'HISTORY.ndjson'); ftruncateSync(fd, bytes); fsyncSync(fd); assertFdOwned(files.history, fd, 'HISTORY.ndjson'); } finally { closeSync(fd); }
}

function appendEvent(files, bytes, fd, committedLength) {
  const before = assertRetainedPath(files.history, fd, 'HISTORY.ndjson', { expectedLinks: 1n });
  if (before.size !== BigInt(committedLength)) throw new MemoryError('HISTORY.ndjson committed length changed', 3);
  if (committedLength + bytes.length > MAX_JOURNAL_BYTES) throw new MemoryError('HISTORY.ndjson would exceed the total size limit', 3);
  testBarrier('journal-append-before-write', { history: files.history, committedLength });
  const prewrite = assertRetainedPath(files.history, fd, 'HISTORY.ndjson', { expectedLinks: 1n });
  if (prewrite.size !== BigInt(committedLength)) throw new MemoryError('HISTORY.ndjson committed length changed', 3);
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, committedLength + offset);
      if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) {
        throw new MemoryError('HISTORY.ndjson returned an invalid write length', 3);
      }
      offset += count;
    }
    fsyncSync(fd);
    const after = assertRetainedPath(files.history, fd, 'HISTORY.ndjson', { expectedLinks: 1n });
    if (after.size !== BigInt(committedLength + bytes.length)) throw new MemoryError('HISTORY.ndjson committed length changed', 3);
  } catch (error) {
    if (offset > 0 && pathOwnsRetained(files.history, fd, { expectedLinks: 1n })) {
      try { ftruncateSync(fd, committedLength); fsyncSync(fd); } catch {}
    }
    throw error instanceof MemoryError ? error : new MemoryError('unable to append HISTORY.ndjson', 3);
  }
}

export function appendV2(root, draft) {
  if (arguments.length > 2) throw new MemoryError('appendV2 does not accept caller options', 3);
  assertMutationAllowed(root);
  const preflight = validateDraftShape(draft);
  assertMutationAllowed(root);
  openStore(root, { mode: 'write' });
  const release = acquireLock(root);
  let journalFd;
  try {
    testBarrier('journal-append-after-lock', { lock: lockPath(root) });
    assertMutationAllowed(root);
    const files = storePaths(root);
    try { journalFd = openSync(files.history, 'r+'); } catch { throw new MemoryError('HISTORY.ndjson is unavailable', 3); }
    const expected = assertFdOwned(files.history, journalFd, 'HISTORY.ndjson');
    const store = readV2Journal(root);
    const afterRead = assertRetainedPath(files.history, journalFd, 'HISTORY.ndjson', { expectedLinks: 1n });
    if (afterRead.dev !== expected.dev || afterRead.ino !== expected.ino
      || afterRead.size !== BigInt(store.committedBytes + store.trailingBytes)) {
      throw new MemoryError('HISTORY.ndjson identity or committed length changed', 3);
    }
    const recordedAt = nowIso(); const workspaceAtRecord = workspace(root, recordedAt);
    const valid = validateDraftForPersistence(preflight, store.state, observeCompletionFreshness(root, store.state, recordedAt, workspaceAtRecord)); const last = store.events.at(-1);
    const event = buildEnvelope(valid, { epochId: last.epochId, sequence: last.sequence + 1, recordedAt, workspaceAtRecord, previousEventHash: last.eventHash });
    if (store.events.some((known) => known.eventId === event.eventId)) throw new MemoryError('append would duplicate an eventId', 3);
    const state = foldV2([...store.events, event]);
    const bytes = eventBytes(event);
    projectionBytes(state);
    if (store.trailingBytes) {
      assertMutationAllowed(root);
      const beforeTruncate = assertRetainedPath(files.history, journalFd, 'HISTORY.ndjson', { expectedLinks: 1n });
      if (beforeTruncate.size !== BigInt(store.committedBytes + store.trailingBytes)) throw new MemoryError('HISTORY.ndjson committed length changed', 3);
      ftruncateSync(journalFd, store.committedBytes);
      fsyncSync(journalFd);
      const afterTruncate = assertRetainedPath(files.history, journalFd, 'HISTORY.ndjson', { expectedLinks: 1n });
      if (afterTruncate.size !== BigInt(store.committedBytes)) throw new MemoryError('HISTORY.ndjson tail truncation failed', 3);
    }
    assertMutationAllowed(root); appendEvent(files, bytes, journalFd, store.committedBytes);
    try { assertMutationAllowed(root); atomicProjection(root, state); } catch { throw new MemoryError(`event committed as sequence ${event.sequence}; CURRENT projection pending repair`, 3); }
    return { version: 2, epochId: event.epochId, sequence: event.sequence, eventId: event.eventId, eventHash: event.eventHash, projection: 'current' };
  } finally {
    let failure;
    if (journalFd !== undefined) try { closeSync(journalFd); } catch { failure = new MemoryError('HISTORY.ndjson descriptor could not be closed safely', 3); }
    try { release(); } catch (error) { failure ??= error; }
    if (failure) throw failure;
  }
}

export function validateV2Append(root, draft) {
  if (arguments.length > 2) throw new MemoryError('validateV2Append options are invalid', 3);
  const store = openStore(root, { mode: 'read' });
  if (store.version !== 2) throw new MemoryError('record requires a v2 store', 3);
  const recordedAt = nowIso(); const workspaceNow = workspace(root, recordedAt);
  validateDraftForPersistence(draft, store.state, observeCompletionFreshness(root, store.state, recordedAt, workspaceNow));
  return { prospectiveSequence: store.events.length + 1 };
}

export function rebuildProjection(root) {
  if (arguments.length > 1) throw new MemoryError('rebuildProjection does not accept caller options', 3);
  assertMutationAllowed(root);
  openStore(root, { mode: 'write' });
  const release = acquireLock(root);
  try {
    assertMutationAllowed(root);
    const store = readV2Journal(root);
    assertMutationAllowed(root);
    atomicProjection(root, store.state);
    return store.state;
  } finally { release(); }
}
