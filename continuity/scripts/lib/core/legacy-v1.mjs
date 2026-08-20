#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  gitAdminTopology, isStoreRepoPath, readOwnedFileBounded, storePaths as continuityStorePaths,
} from './store.mjs';

const MAX_SNAPSHOT_BYTES = 64 * 1024;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_BYTES = MAX_SNAPSHOT_BYTES * 2;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_STATUS_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACE_HASH_BYTES = 8 * 1024 * 1024;
const MAX_WORKSPACE_FILE_BYTES = 1024 * 1024;
const MAX_STRING = 2_000;
const MAX_ITEMS = 50;
const MAX_HISTORY_TAIL = 100;
const VERSION = '2.0.0';
const ZERO_HASH = '0'.repeat(64);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const templatePath = path.join(skillRoot, 'assets', 'snapshot-v1.template.json');

class MemoryError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function equalCanonical(left, right) {
  return canonical(left) === canonical(right);
}

function parseArgs(argv) {
  const args = [...argv];
  let command = null;
  let rootCandidate = process.cwd();
  let rootExplicit = false;
  let inputMode = null;
  let inputFile = null;
  let inputCount = 0;
  let tail = 10;
  let dryRun = false;
  const positionals = [];
  while (args.length) {
    const arg = args.shift();
    if (arg === '--root') {
      const rootArg = args.shift();
      if (!rootArg) throw new MemoryError('--root requires a path');
      rootCandidate = path.resolve(rootArg);
      rootExplicit = true;
    } else if (arg === '--stdin') {
      inputCount += 1;
      inputMode = 'stdin';
    } else if (arg === '--file') {
      inputCount += 1;
      inputMode = 'file';
      inputFile = args.shift();
    } else if (arg === '--tail') {
      tail = Number(args.shift());
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--version') {
      if (command || positionals.length || args.length) throw new MemoryError('invalid --version usage');
      command = '--version';
    } else if (arg.startsWith('-')) {
      throw new MemoryError('unknown argument');
    } else if (!command) {
      command = arg;
    } else {
      positionals.push(arg);
    }
  }
  return { command, rootCandidate, rootExplicit, inputMode, inputFile, inputCount, tail, dryRun, positionals };
}

function gitSpawn(root, args, options = {}) {
  return spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
    ...options,
  });
}

function gitText(root, args, fallback = '') {
  const result = gitSpawn(root, args);
  if (result.status !== 0 || result.error) return fallback;
  return (result.stdout ?? '').trim();
}

function resolveRepositoryRoot(candidate, explicit) {
  let candidateReal;
  try {
    candidateReal = realpathSync.native(candidate);
  } catch {
    throw new MemoryError('repository root is unavailable');
  }
  const result = gitSpawn(candidateReal, ['rev-parse', '--show-toplevel']);
  if (result.status !== 0 || result.error || !(result.stdout ?? '').trim()) {
    throw new MemoryError('current location is not inside a Git worktree');
  }
  let topReal;
  try {
    topReal = realpathSync.native((result.stdout ?? '').trim());
  } catch {
    throw new MemoryError('Git top-level is unavailable');
  }
  if (explicit && path.normalize(candidateReal) !== path.normalize(topReal)) {
    throw new MemoryError('--root must name the Git worktree top-level');
  }
  return topReal;
}

function safeGitTopology(root) {
  try {
    return gitAdminTopology(root);
  } catch {
    throw new MemoryError('Git administration or lock topology is unsafe', 3);
  }
}

function isLinkedWorktree(root) {
  return safeGitTopology(root).linkedWorktree;
}

function assertMutationAllowed(root) {
  const migrationMarker = continuityStorePaths(root).migrationMarker;
  assertStorePathSafe(root, migrationMarker);
  if (assertSingleLinkRegularFile(migrationMarker, 'MIGRATION.v1-to-v2.json')) {
    throw new MemoryError('continuity mutation is blocked by interrupted migration');
  }
  if (isLinkedWorktree(root)) {
    throw new MemoryError('mutating continuity is refused in linked worktrees');
  }
}

function resolveLockPath(root) {
  // Compatibility lock shared with pre-Continuity writers to prevent split-brain writes.
  const gitPath = gitText(root, ['rev-parse', '--git-path', 'project-memory.checkpoint.lock']);
  if (!gitPath) throw new MemoryError('unable to resolve the checkpoint lock path');
  return path.isAbsolute(gitPath) ? path.normalize(gitPath) : path.resolve(root, gitPath);
}

function pathsFor(root) {
  const store = continuityStorePaths(root).store;
  return {
    store,
    current: path.join(store, 'CURRENT.json'),
    history: path.join(store, 'HISTORY.ndjson'),
    lock: resolveLockPath(root),
  };
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MemoryError(`${label} must be an object`);
}

function assertExactKeys(value, allowed, required, label) {
  assertObject(value, label);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) throw new MemoryError(`${label} contains unknown fields`);
  if (required.some((key) => !keys.includes(key))) throw new MemoryError(`${label} is missing required fields`);
}

function assertString(value, label, { min = 1, max = MAX_STRING } = {}) {
  if (
    typeof value !== 'string'
    || value.length < min
    || value.length > max
    || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  ) throw new MemoryError(`${label} must be a bounded single-line string`);
}

function assertDate(value, label) {
  assertString(value, label, { max: 24 });
  if (!ISO_UTC.test(value) || new Date(value).toISOString() !== value) {
    throw new MemoryError(`${label} must be strict ISO-8601 UTC with milliseconds`);
  }
}

function assertArray(value, label, validateItem) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new MemoryError(`${label} must be a bounded array`);
  value.forEach((item, index) => validateItem(item, `${label}[${index}]`));
}

function normalizeRepoPath(value, label) {
  assertString(value, label, { max: 500 });
  const normalized = value.replaceAll('\\', '/');
  if (
    path.isAbsolute(value)
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split('/').some((part) => part === '..' || part === '')
    || normalized === '.env'
    || (normalized.startsWith('.env.') && normalized !== '.env.example')
  ) throw new MemoryError(`${label} must be a safe repository-relative path`);
  return normalized;
}

function canonicalizeSnapshotPaths(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
  const normalized = { ...snapshot };
  if (Array.isArray(snapshot.sourceRefs)) {
    normalized.sourceRefs = snapshot.sourceRefs.map((ref, index) => {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return ref;
      return { ...ref, path: normalizeRepoPath(ref.path, `sourceRefs[${index}].path`) };
    });
  }
  for (const field of ['activeWork', 'decisions', 'recentWork', 'validationEvidence']) {
    if (!Array.isArray(snapshot[field])) continue;
    normalized[field] = snapshot[field].map((item, itemIndex) => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !Array.isArray(item.sourceRefs)) return item;
      return {
        ...item,
        sourceRefs: item.sourceRefs.map((repoPath, pathIndex) => normalizeRepoPath(repoPath, `${field}[${itemIndex}].sourceRefs[${pathIndex}]`)),
      };
    });
  }
  return normalized;
}

function assertSourcePathArray(value, label, knownPaths) {
  assertArray(value, label, (item, itemLabel) => {
    const normalized = normalizeRepoPath(item, itemLabel);
    if (normalized !== item) throw new MemoryError(`${itemLabel} must use canonical separators`);
    if (!knownPaths.has(normalized)) throw new MemoryError(`${itemLabel} is not declared in sourceRefs`);
  });
}

function rejectSensitiveText(value) {
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bsk-[A-Za-z0-9_-]{16,}\b/,
    /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/i,
    /\bwhsec_[A-Za-z0-9]{12,}\b/i,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
    /\bAIza[0-9A-Za-z_-]{20,}\b/,
    /\bSK[0-9a-f]{32}\b/i,
    /\bSG\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/i,
    /\b(?:authorization|proxy-authorization)\s*[:=]\s*[^\s,;]+(?:\s+[^\s,;]+)?/i,
    /\b(?:cookie|set-cookie|session|session-id|sessionid)\s*[:=]\s*[^\s,;]+/i,
    /\b(?:password|passwd|secret|token|api[_-]?key|session[_-]?id|database_url|direct_url)\s*[:=]\s*[^\s,;{}\[\]]+/i,
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/i,
    /(?:^|["'])\s*[A-Z][A-Z0-9_]{2,}\s*=\s*[^\s<][^"']*/,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    /\+\d(?:[ ().-]*\d){9,14}/,
    /\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/,
    /\b(?:\d[ .()-]*){3}\d[ .()-]*\d{3}[ .()-]*\d{2}[ .()-]*\d{2}\b/,
    /\bdiff --git\b/i,
    /^@@\s+-\d/m,
    /\*\*\* (?:Begin|End) Patch/i,
    /^Index:\s+\S+/im,
  ];
  if (patterns.some((pattern) => pattern.test(value))) {
    throw new MemoryError('snapshot rejected: sensitive or disallowed material detected');
  }
}

function scanDisallowedShape(value, key = '') {
  const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const forbiddenKeys = new Set([
    'password', 'passwd', 'secret', 'token', 'accesstoken', 'refreshtoken', 'apikey',
    'cookie', 'setcookie', 'authorization', 'databaseurl', 'directurl', 'privatekey',
    'session', 'sessionid', 'stdout', 'stderr', 'commandoutput', 'logoutput', 'stacktrace',
    'rawdiff', 'patch', 'rawrows', 'rows', 'records', 'customeremail', 'customerphone',
    'customeraddress', 'email', 'phone', 'address', 'orderid', 'orderpayload',
  ]);
  if (forbiddenKeys.has(normalizedKey)) throw new MemoryError('snapshot rejected: sensitive or disallowed material detected');
  if (typeof value === 'string') {
    assertString(value, 'snapshot string');
    rejectSensitiveText(value);
  } else if (Array.isArray(value)) {
    if (value.length > MAX_ITEMS) throw new MemoryError('snapshot contains an oversized array');
    value.forEach((item) => scanDisallowedShape(item, key));
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([childKey, child]) => scanDisallowedShape(child, childKey));
  }
}

function validateSnapshot(snapshot) {
  const topKeys = [
    'schemaVersion', 'updatedAt', 'project', 'stableGoals', 'implementationBoundaries',
    'operatingRules', 'activeWork', 'decisions', 'recentWork', 'validationEvidence',
    'unresolvedItems', 'nextSteps', 'sourceRefs', 'workspace',
  ];
  assertExactKeys(snapshot, topKeys, topKeys, 'snapshot');
  if (snapshot.schemaVersion !== 1) throw new MemoryError('unsupported schemaVersion');
  assertDate(snapshot.updatedAt, 'updatedAt');
  assertExactKeys(snapshot.project, ['name', 'identity'], ['name', 'identity'], 'project');
  assertString(snapshot.project.name, 'project.name', { max: 120 });
  assertString(snapshot.project.identity, 'project.identity');

  for (const field of ['stableGoals', 'implementationBoundaries', 'operatingRules', 'unresolvedItems', 'nextSteps']) {
    assertArray(snapshot[field], field, (item, label) => assertString(item, label));
  }

  assertArray(snapshot.sourceRefs, 'sourceRefs', (item, label) => {
    assertExactKeys(item, ['path', 'purpose', 'contentSha256'], ['path', 'purpose', 'contentSha256'], label);
    if (normalizeRepoPath(item.path, `${label}.path`) !== item.path) throw new MemoryError(`${label}.path must use canonical separators`);
    assertString(item.purpose, `${label}.purpose`);
    if (!/^[a-f0-9]{64}$/.test(item.contentSha256)) throw new MemoryError(`${label}.contentSha256 must be sha256`);
  });
  const knownPaths = new Set(snapshot.sourceRefs.map((item) => item.path));
  if (knownPaths.size !== snapshot.sourceRefs.length) throw new MemoryError('sourceRefs paths must be unique');

  const validateSummaryItem = (item, label) => {
    assertExactKeys(item, ['summary', 'status', 'sourceRefs'], ['summary', 'status', 'sourceRefs'], label);
    assertString(item.summary, `${label}.summary`);
    assertString(item.status, `${label}.status`, { max: 160 });
    assertSourcePathArray(item.sourceRefs, `${label}.sourceRefs`, knownPaths);
  };
  assertArray(snapshot.activeWork, 'activeWork', validateSummaryItem);
  assertArray(snapshot.decisions, 'decisions', validateSummaryItem);
  assertArray(snapshot.recentWork, 'recentWork', (item, label) => {
    assertExactKeys(item, ['summary', 'status', 'checkedAt', 'sourceRefs'], ['summary', 'status', 'checkedAt', 'sourceRefs'], label);
    assertString(item.summary, `${label}.summary`);
    assertString(item.status, `${label}.status`, { max: 160 });
    assertDate(item.checkedAt, `${label}.checkedAt`);
    assertSourcePathArray(item.sourceRefs, `${label}.sourceRefs`, knownPaths);
  });
  assertArray(snapshot.validationEvidence, 'validationEvidence', (item, label) => {
    assertExactKeys(item, ['name', 'status', 'scope', 'checkedAt', 'sourceRefs'], ['name', 'status', 'scope', 'checkedAt', 'sourceRefs'], label);
    assertString(item.name, `${label}.name`, { max: 160 });
    assertString(item.status, `${label}.status`, { max: 160 });
    assertString(item.scope, `${label}.scope`);
    assertDate(item.checkedAt, `${label}.checkedAt`);
    assertSourcePathArray(item.sourceRefs, `${label}.sourceRefs`, knownPaths);
  });

  const workspaceAllowed = ['head', 'branch', 'dirty', 'statusFingerprint', 'capturedAt', 'fingerprintPartial'];
  const workspaceRequired = ['head', 'branch', 'dirty', 'statusFingerprint', 'capturedAt'];
  assertExactKeys(snapshot.workspace, workspaceAllowed, workspaceRequired, 'workspace');
  if (!(snapshot.workspace.head === 'unavailable' || /^[a-f0-9]{40,64}$/.test(snapshot.workspace.head))) {
    throw new MemoryError('workspace.head must be a Git SHA or unavailable');
  }
  assertString(snapshot.workspace.branch, 'workspace.branch', { max: 250 });
  if (typeof snapshot.workspace.dirty !== 'boolean') throw new MemoryError('workspace.dirty must be boolean');
  if (!/^[a-f0-9]{64}$/.test(snapshot.workspace.statusFingerprint)) throw new MemoryError('workspace.statusFingerprint must be sha256');
  if ('fingerprintPartial' in snapshot.workspace && typeof snapshot.workspace.fingerprintPartial !== 'boolean') {
    throw new MemoryError('workspace.fingerprintPartial must be boolean');
  }
  assertDate(snapshot.workspace.capturedAt, 'workspace.capturedAt');

  const projectionBytes = Buffer.byteLength(`${JSON.stringify(snapshot)}\n`);
  if (projectionBytes > MAX_SNAPSHOT_BYTES) throw new MemoryError('snapshot exceeds the size limit');
  scanDisallowedShape(snapshot);
}

function isContained(rootReal, targetReal) {
  const relative = path.relative(rootReal, targetReal);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertSingleLinkRegularFile(file, label) {
  if (!existsSync(file)) return null;
  let details;
  try {
    details = lstatSync(file, { bigint: true });
  } catch {
    throw new MemoryError(`${label} metadata is unreadable`);
  }
  if (!details.isFile() || details.nlink !== 1n) {
    throw new MemoryError(`${label} must be a regular file with exactly one hard link`);
  }
  return details;
}

function assertOpenFileOwned(file, fd, label) {
  let pathDetails;
  let openDetails;
  try {
    pathDetails = lstatSync(file, { bigint: true });
    openDetails = fstatSync(fd, { bigint: true });
  } catch {
    throw new MemoryError(`${label} ownership is unreadable`);
  }
  if (
    !pathDetails.isFile()
    || !openDetails.isFile()
    || pathDetails.nlink !== 1n
    || openDetails.nlink !== 1n
    || pathDetails.dev !== openDetails.dev
    || pathDetails.ino !== openDetails.ino
  ) throw new MemoryError(`${label} must be an owned regular file with exactly one hard link`);
  return openDetails;
}

function assertSameSingleLinkFile(file, expected, label) {
  const details = assertSingleLinkRegularFile(file, label);
  if (!details || details.dev !== expected.dev || details.ino !== expected.ino) {
    throw new MemoryError(`${label} ownership changed`);
  }
  return details;
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
      // Preserve a substituted path at one of the two names; never remove it speculatively.
    }
    throw new MemoryError(`${label} ownership changed`, 3);
  }
  try {
    if (directory) throw new MemoryError(`${label} directory cleanup is unsupported`, 3);
    unlinkSync(retired);
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError(`${label} cleanup failed`, 3);
  }
}

function assertStorePathSafe(root, target) {
  const lexicalRoot = path.resolve(root);
  const absolute = path.resolve(target);
  const rootReal = realpathSync.native(lexicalRoot);
  const lexicalHit = isContained(lexicalRoot, absolute);
  const canonicalHit = isContained(rootReal, absolute);
  if (!lexicalHit && !canonicalHit) throw new MemoryError('continuity store path escapes the repository');
  const walkRoot = lexicalHit ? lexicalRoot : rootReal;
  const relative = path.relative(walkRoot, absolute);
  let probe = walkRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    probe = path.join(probe, part);
    if (!existsSync(probe)) continue;
    let details;
    try {
      details = lstatSync(probe);
    } catch {
      throw new MemoryError('continuity store metadata is unreadable');
    }
    if (details.isSymbolicLink()) throw new MemoryError('continuity store must not use links or reparse points');
    let resolved;
    try {
      resolved = realpathSync.native(probe);
    } catch {
      throw new MemoryError('continuity store metadata is unreadable');
    }
    if (!isContained(rootReal, resolved)) throw new MemoryError('continuity store path escapes the repository');
  }
}

function assertStoreSafe(root, files = pathsFor(root)) {
  assertStorePathSafe(root, files.store);
  assertStorePathSafe(root, files.history);
  assertStorePathSafe(root, files.current);
  assertSingleLinkRegularFile(files.history, 'HISTORY.ndjson');
  assertSingleLinkRegularFile(files.current, 'CURRENT.json');
  return files;
}

function ensureStoreDirectory(root, files) {
  assertStoreSafe(root, files);
  try {
    mkdirSync(path.dirname(files.store), { recursive: true });
    assertStoreSafe(root, files);
    mkdirSync(files.store, { recursive: true });
    assertStoreSafe(root, files);
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError('unable to create the continuity store');
  }
}

function assertRealPathContained(root, repoPath) {
  const rootReal = realpathSync.native(root);
  const absolute = path.resolve(root, repoPath);
  let probe = absolute;
  while (!existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const probeReal = realpathSync.native(probe);
  if (!isContained(rootReal, probeReal)) throw new MemoryError('sourceRefs must not escape the repository through links');
  if (existsSync(absolute)) {
    const targetReal = realpathSync.native(absolute);
    if (!isContained(rootReal, targetReal)) throw new MemoryError('sourceRefs must not escape the repository through links');
  }
  return absolute;
}

function hashNormalizedTextFile(file, maxBytes = MAX_SOURCE_BYTES) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    throw new MemoryError('source reference is unreadable');
  }
  if (size > maxBytes) throw new MemoryError('source reference exceeds the hashing size limit');
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    throw new MemoryError('source reference is unreadable');
  }
  const digest = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const buffer = Buffer.alloc(32 * 1024);
  let pendingCarriageReturn = false;
  let total = 0;
  const feed = (text, final = false) => {
    if (pendingCarriageReturn) {
      text = `\r${text}`;
      pendingCarriageReturn = false;
    }
    if (!final && text.endsWith('\r')) {
      pendingCarriageReturn = true;
      text = text.slice(0, -1);
    }
    const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    if (normalized.includes('\0')) throw new MemoryError('source reference must be UTF-8 text');
    digest.update(normalized, 'utf8');
  };
  try {
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw new MemoryError('source reference exceeds the hashing size limit');
      feed(decoder.decode(buffer.subarray(0, count), { stream: true }));
    }
    feed(decoder.decode(), true);
    if (pendingCarriageReturn) digest.update('\n');
    return digest.digest('hex');
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError('source reference must be bounded UTF-8 text');
  } finally {
    closeSync(fd);
  }
}

function hashNormalizedUtf8Buffer(value) {
  if (value.length > MAX_SOURCE_BYTES) throw new MemoryError('source reference exceeds the hashing size limit');
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(value);
    if (decoded.includes('\0')) throw new MemoryError('source reference must be UTF-8 text');
    return sha256(decoded.replaceAll('\r\n', '\n').replaceAll('\r', '\n'));
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError('source reference must be bounded UTF-8 text');
  }
}

function requireCommittedHead(root) {
  const result = gitSpawn(root, ['rev-parse', '--verify', 'HEAD']);
  if (result.status !== 0 || result.error) throw new MemoryError('source refs require a committed HEAD');
}

function verifiedSourceHash(root, repoPath) {
  const normalized = normalizeRepoPath(repoPath, 'source path');
  requireCommittedHead(root);
  const absolute = assertRealPathContained(root, normalized);
  if (!existsSync(absolute)) throw new MemoryError('source reference is missing');
  let details;
  try {
    details = lstatSync(absolute);
  } catch {
    throw new MemoryError('source reference is unreadable');
  }
  if (details.isSymbolicLink() || !details.isFile()) throw new MemoryError('source reference must be a regular repository file');

  const tracked = gitSpawn(root, ['ls-files', '--error-unmatch', '--', normalized], { stdio: 'ignore' });
  const ignored = gitSpawn(root, ['check-ignore', '--no-index', '-q', '--', normalized], { stdio: 'ignore' });
  const dirty = gitSpawn(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', normalized]);
  if (tracked.status !== 0 || ignored.status === 0 || dirty.status !== 0 || dirty.error || dirty.stdout) {
    throw new MemoryError('source reference must be tracked, committed, non-ignored, and clean');
  }

  const head = gitSpawn(root, ['show', `HEAD:${normalized}`], {
    encoding: null,
    maxBuffer: MAX_SOURCE_BYTES + 1,
  });
  if (head.error?.code === 'ENOBUFS' || Buffer.byteLength(head.stdout ?? Buffer.alloc(0)) > MAX_SOURCE_BYTES) {
    throw new MemoryError('source reference exceeds the hashing size limit');
  }
  if (head.status !== 0 || head.error) throw new MemoryError('source reference must exist as bounded text in HEAD');
  const workingHash = hashNormalizedTextFile(absolute);
  const headHash = hashNormalizedUtf8Buffer(head.stdout ?? Buffer.alloc(0));
  if (workingHash !== headHash) throw new MemoryError('source reference does not match committed HEAD content');
  return { path: normalized, contentSha256: workingHash };
}

function validateLatestSourceRefs(root, snapshot, { requireCurrentHashes = false } = {}) {
  for (const ref of snapshot.sourceRefs) {
    assertRealPathContained(root, ref.path);
    if (requireCurrentHashes) {
      const verified = verifiedSourceHash(root, ref.path);
      if (verified.contentSha256 !== ref.contentSha256) {
        throw new MemoryError('checkpoint source reference hash does not match current source');
      }
    }
  }
}

function hashWorkspaceTarget(root, repoPath, budget) {
  const absolute = path.resolve(root, repoPath);
  if (!existsSync(absolute)) return { material: 'missing', partial: false };
  let details;
  try {
    details = lstatSync(absolute);
  } catch {
    return { material: 'unreadable', partial: true };
  }
  if (details.isSymbolicLink()) {
    return { material: `symlink:${readlinkSync(absolute)}`, partial: false };
  }
  if (!details.isFile()) return { material: `non-file:${details.mode}:${details.size}`, partial: true };
  const allowance = Math.max(0, Math.min(details.size, MAX_WORKSPACE_FILE_BYTES, budget.remaining));
  const digest = createHash('sha256');
  digest.update(`size:${details.size}:mode:${details.mode}:`);
  const fd = openSync(absolute, 'r');
  const buffer = Buffer.alloc(32 * 1024);
  let read = 0;
  try {
    while (read < allowance) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, allowance - read), null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
      read += count;
    }
  } finally {
    closeSync(fd);
  }
  budget.remaining -= read;
  const partial = read < details.size;
  digest.update(partial ? ':TRUNCATED' : ':COMPLETE');
  return { material: digest.digest('hex'), partial };
}

function getWorkspace(root, { capturedAt = new Date().toISOString(), git } = {}) {
  const invokeGit = git
    ? (args, options = {}) => git(root, [...args], { ...options })
    : (args, options = {}) => gitSpawn(root, args, options);
  const gitValue = (args, fallback = '') => {
    const result = invokeGit(args);
    if (result?.status !== 0 || result?.error) return fallback;
    return (result?.stdout ?? '').trim();
  };
  const result = invokeGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    maxBuffer: MAX_STATUS_BYTES,
  });
  let partial = Boolean(result.error) || result.status !== 0;
  const raw = partial ? '' : (result.stdout ?? '');
  const fields = raw.split('\0').filter(Boolean);
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4) {
      entries.push({ status: 'rename-source', repoPath: field.replaceAll('\\', '/') });
      continue;
    }
    const status = field.slice(0, 2);
    const repoPath = field.slice(3).replaceAll('\\', '/');
    if (!isStoreRepoPath(root, repoPath)) entries.push({ status, repoPath });
    if (/[RC]/.test(status) && index + 1 < fields.length) {
      index += 1;
      const source = fields[index].replaceAll('\\', '/');
      if (!isStoreRepoPath(root, source)) entries.push({ status: 'rename-source', repoPath: source });
    }
  }
  entries.sort((left, right) => `${left.status}\0${left.repoPath}`.localeCompare(`${right.status}\0${right.repoPath}`));
  const budget = { remaining: MAX_WORKSPACE_HASH_BYTES };
  const material = [];
  for (const entry of entries) {
    const target = hashWorkspaceTarget(root, entry.repoPath, budget);
    partial ||= target.partial;
    material.push(`${entry.status}\0${entry.repoPath}\0${target.material}`);
  }
  if (partial) material.push('FINGERPRINT_PARTIAL');
  return {
    head: gitValue(['rev-parse', 'HEAD'], 'unavailable'),
    branch: gitValue(['branch', '--show-current'], 'unavailable') || 'detached',
    dirty: entries.length > 0 || partial,
    statusFingerprint: sha256(material.join('\0')),
    fingerprintPartial: partial,
    capturedAt,
  };
}

function readBufferBounded(file, maxBytes, label) {
  if (!file) throw new MemoryError('--file requires a path');
  return readOwnedFileBounded(file, maxBytes, label);
}

function readBoundedFile(file, maxBytes, label) {
  return readBufferBounded(file, maxBytes, label).toString('utf8');
}

function readBoundedStdin() {
  const chunks = [];
  let total = 0;
  const buffer = Buffer.alloc(8 * 1024);
  while (true) {
    const count = readSync(0, buffer, 0, buffer.length, null);
    if (count === 0) break;
    total += count;
    if (total > MAX_SNAPSHOT_BYTES) throw new MemoryError('snapshot input exceeds the size limit');
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseSnapshotInput(raw) {
  if (Buffer.byteLength(raw) > MAX_SNAPSHOT_BYTES) throw new MemoryError('snapshot input exceeds the size limit');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new MemoryError('snapshot input is not valid JSON'); }
  scanDisallowedShape(parsed);
  return canonicalizeSnapshotPaths(parsed);
}

function readJsonBounded(file, label) {
  const raw = readBoundedFile(file, MAX_SNAPSHOT_BYTES, label);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new MemoryError(`${label} is not valid JSON`); }
  validateSnapshot(parsed);
  return parsed;
}

function readHistory(file) {
  const raw = readBufferBounded(file, MAX_HISTORY_BYTES, 'HISTORY.ndjson total');
  const lastNewline = raw.lastIndexOf(0x0a);
  const committedBytes = lastNewline < 0 ? 0 : lastNewline + 1;
  const trailingBytes = raw.length - committedBytes;
  const committed = raw.subarray(0, committedBytes).toString('utf8');
  const lines = committed.split(/\r?\n/).filter(Boolean);
  const events = lines.map((line, index) => {
    if (Buffer.byteLength(line) > MAX_EVENT_BYTES) throw new MemoryError(`history event ${index + 1} exceeds the size limit`);
    let event;
    try { event = JSON.parse(line); } catch { throw new MemoryError(`history event ${index + 1} is not valid JSON`); }
    return event;
  });
  return { events, committedBytes, trailingBytes };
}

function validateEvent(event, index, previousHash) {
  const keys = ['sequence', 'timestamp', 'previousHash', 'snapshotHash', 'eventHash', 'snapshot'];
  assertExactKeys(event, keys, keys, `history event ${index + 1}`);
  if (event.sequence !== index + 1) throw new MemoryError(`history sequence mismatch at event ${index + 1}`);
  assertDate(event.timestamp, `history event ${index + 1}.timestamp`);
  for (const field of ['previousHash', 'snapshotHash', 'eventHash']) {
    if (!/^[a-f0-9]{64}$/.test(event[field])) throw new MemoryError(`history event ${index + 1}.${field} must be sha256`);
  }
  if (event.previousHash !== previousHash) throw new MemoryError(`history chain mismatch at event ${index + 1}`);
  validateSnapshot(event.snapshot);
  if (event.snapshotHash !== sha256(canonical(event.snapshot))) throw new MemoryError(`history snapshot hash mismatch at event ${index + 1}`);
  const material = {
    sequence: event.sequence,
    timestamp: event.timestamp,
    previousHash: event.previousHash,
    snapshotHash: event.snapshotHash,
    snapshot: event.snapshot,
  };
  if (event.eventHash !== sha256(canonical(material))) throw new MemoryError(`history event hash mismatch at event ${index + 1}`);
}

function projectionState(currentPath, authoritativeSnapshot) {
  if (!existsSync(currentPath)) return { state: 'missing' };
  try {
    const projection = readJsonBounded(currentPath, 'CURRENT.json');
    return { state: equalCanonical(projection, authoritativeSnapshot) ? 'current' : 'stale' };
  } catch {
    return { state: 'invalid' };
  }
}

function loadJournal(root, { allowEmpty = false } = {}) {
  const files = assertStoreSafe(root, pathsFor(root));
  if (!existsSync(files.history)) {
    if (allowEmpty) return { files, current: null, events: [], committedBytes: 0, trailingBytes: 0, projection: { state: existsSync(files.current) ? 'orphaned' : 'missing' } };
    throw new MemoryError('authoritative HISTORY.ndjson is missing');
  }
  const history = readHistory(files.history);
  if (!history.events.length) {
    if (allowEmpty) return { files, current: null, ...history, projection: { state: existsSync(files.current) ? 'orphaned' : 'missing' } };
    throw new MemoryError('history has no committed events');
  }
  let previousHash = ZERO_HASH;
  history.events.forEach((event, index) => {
    validateEvent(event, index, previousHash);
    previousHash = event.eventHash;
  });
  const current = history.events.at(-1).snapshot;
  validateLatestSourceRefs(root, current);
  return { files, current, ...history, projection: projectionState(files.current, current) };
}

function acquireLock(root, lockPath) {
  const expected = safeGitTopology(root).lock;
  if (path.relative(expected, lockPath) !== '' || path.relative(lockPath, expected) !== '') {
    throw new MemoryError('checkpoint lock path does not match safe Git topology');
  }
  if (existsSync(lockPath)) {
    assertSingleLinkRegularFile(lockPath, 'checkpoint lock');
    throw new MemoryError('checkpoint locked by another or interrupted writer');
  }
  let fd;
  let identity;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      assertSingleLinkRegularFile(lockPath, 'checkpoint lock');
      throw new MemoryError('checkpoint locked by another or interrupted writer');
    }
    throw new MemoryError('unable to acquire the checkpoint lock');
  }
  try {
    identity = fstatSync(fd, { bigint: true });
    const metadata = JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() });
    assertOpenFileOwned(lockPath, fd, 'checkpoint lock');
    writeFileSync(fd, metadata);
    if (process.env.NODE_ENV === 'test' && process.env.PROJECT_MEMORY_TEST_FAIL_LOCK_METADATA === '1') {
      throw new Error('simulated lock metadata failure');
    }
    fsyncSync(fd);
  } catch {
    try {
      if (identity) retireOwnedPath(lockPath, fd, 'checkpoint lock', {
        barrierPoint: 'legacy-lock-failure-cleanup', expectedLinks: 1n,
      });
    } catch {}
    try { closeSync(fd); } catch {}
    throw new MemoryError('unable to initialize the checkpoint lock', 3);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    let releaseError;
    try {
      retireOwnedPath(lockPath, fd, 'checkpoint lock', {
        barrierPoint: 'legacy-lock-release-cleanup', expectedLinks: 1n,
      });
    } catch (error) {
      releaseError = error instanceof MemoryError ? error : new MemoryError('unable to remove the checkpoint lock', 3);
    }
    try { closeSync(fd); } catch { releaseError ??= new MemoryError('unable to close the checkpoint lock', 3); }
    if (releaseError) throw releaseError;
  };
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = openSync(directory, 'r');
    fsyncSync(fd);
  } catch (error) {
    if (process.platform !== 'win32') throw new MemoryError('unable to sync continuity directory metadata');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function atomicWriteProjection(root, files, value) {
  assertStoreSafe(root, files);
  const file = files.current;
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  let fd;
  let temporaryIdentity;
  let previousFd;
  let previousIdentity;
  let backup;
  let installed = false;
  let renamed = false;
  let failure;
  try {
    assertStorePathSafe(root, temporary);
    if (existsSync(temporary)) {
      assertSingleLinkRegularFile(temporary, 'projection temporary file');
      throw new MemoryError('projection temporary file already exists');
    }
    try {
      fd = openSync(temporary, 'wx', 0o600);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        assertSingleLinkRegularFile(temporary, 'projection temporary file');
        throw new MemoryError('projection temporary file already exists');
      }
      throw new MemoryError('unable to create the projection temporary file');
    }
    temporaryIdentity = assertOpenFileOwned(temporary, fd, 'projection temporary file');
    const serialized = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(serialized) > MAX_SNAPSHOT_BYTES) throw new MemoryError('CURRENT projection exceeds the size limit');
    assertOpenFileOwned(temporary, fd, 'projection temporary file');
    writeFileSync(fd, serialized, 'utf8');
    fsyncSync(fd);
    assertOpenFileOwned(temporary, fd, 'projection temporary file');
    if (process.env.NODE_ENV === 'test' && process.env.PROJECT_MEMORY_TEST_FAIL_CURRENT_REPLACE === '1') {
      throw new MemoryError('simulated locked CURRENT projection', 3);
    }
    assertStoreSafe(root, files);
    try {
      previousFd = openSync(file, 'r');
      previousIdentity = assertOpenFileOwned(file, previousFd, 'CURRENT.json');
      backup = `${file}.rollback-${process.pid}-${randomUUID()}`;
      linkSync(file, backup);
      assertRetainedPath(file, previousFd, 'CURRENT.json', { expectedLinks: 2n });
      assertRetainedPath(backup, previousFd, 'CURRENT.json rollback link', { expectedLinks: 2n });
      closeSync(previousFd);
      previousFd = undefined;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      previousFd = undefined;
      previousIdentity = undefined;
      backup = undefined;
    }
    assertOpenFileOwned(temporary, fd, 'projection temporary file');
    testBarrier('legacy-projection-before-rename', { temporary, current: file, rollback: backup });
    assertOpenFileOwned(temporary, fd, 'projection temporary file');
    if (backup) {
      assertRetainedPath(file, previousIdentity, 'CURRENT.json', { expectedLinks: 2n });
      assertRetainedPath(backup, previousIdentity, 'CURRENT.json rollback link', { expectedLinks: 2n });
    }
    renameSync(temporary, file);
    renamed = true;
    temporaryIdentity = assertOpenFileOwned(file, fd, 'CURRENT.json');
    fsyncDirectory(files.store);
    closeSync(fd);
    fd = undefined;
    if (backup) {
      retireOwnedPath(backup, previousIdentity, 'CURRENT.json rollback link', {
        barrierPoint: 'legacy-projection-rollback-cleanup', expectedLinks: 1n,
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
          assertStorePathSafe(root, recovery);
          linkSync(backup, recovery);
          assertRetainedIdentity(recovery, previousIdentity, 'CURRENT.json recovery link');
        }
        const installedRetained = fd ?? temporaryIdentity;
        if (installedRetained && pathOwnsRetained(file, installedRetained, { expectedLinks: 1n })) {
          if (existsSync(temporary)) throw new MemoryError('projection rollback path is occupied', 3);
          renameSync(file, temporary);
          assertRetainedPath(temporary, installedRetained, 'projection rollback temporary', { expectedLinks: 1n });
        } else if (existsSync(file)) {
          const quarantine = `${file}.quarantine-${process.pid}-${randomUUID()}`;
          assertStorePathSafe(root, quarantine);
          renameSync(file, quarantine);
        }
        renamed = false;
        if (recovery) {
          assertRetainedIdentity(recovery, previousIdentity, 'CURRENT.json recovery link');
          renameSync(recovery, file);
          assertRetainedIdentity(file, previousIdentity, 'CURRENT.json');
        } else if (existsSync(file)) {
          throw new MemoryError('CURRENT projection rollback failed', 3);
        }
        fsyncDirectory(files.store);
      } catch {
        error = new MemoryError('unable to preserve prior CURRENT projection', 3);
      }
    }
    failure = error instanceof MemoryError && error.exitCode === 3
      ? error
      : new MemoryError('unable to install CURRENT projection', 3);
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
        retireOwnedPath(temporary, temporaryRetained, 'projection temporary file', {
          barrierPoint: 'legacy-projection-temp-cleanup', expectedLinks: 1n,
        });
      } catch { failure ??= new MemoryError('projection temporary cleanup failed', 3); }
    }
    if (fd !== undefined) try { closeSync(fd); } catch { failure ??= new MemoryError('projection temporary could not be closed safely', 3); }
    if (previousFd !== undefined) try { closeSync(previousFd); } catch { failure ??= new MemoryError('prior CURRENT descriptor could not be closed safely', 3); }
  }
  if (failure) throw failure;
}

function truncatePartialTail(root, files, committedBytes) {
  assertStoreSafe(root, files);
  const fd = openSync(files.history, 'r+');
  try {
    assertOpenFileOwned(files.history, fd, 'HISTORY.ndjson');
    ftruncateSync(fd, committedBytes);
    fsyncSync(fd);
    assertOpenFileOwned(files.history, fd, 'HISTORY.ndjson');
  } finally {
    closeSync(fd);
  }
}

function appendCommittedEvent(files, event, fd, committedLength, wasMissing) {
  const file = files.history;
  const bytes = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
  if (bytes.length > MAX_EVENT_BYTES) throw new MemoryError('history event exceeds the size limit');
  const before = assertRetainedPath(file, fd, 'HISTORY.ndjson', { expectedLinks: 1n });
  if (before.size !== BigInt(committedLength)) throw new MemoryError('HISTORY.ndjson committed length changed', 3);
  if (committedLength + bytes.length > MAX_HISTORY_BYTES) throw new MemoryError('HISTORY.ndjson would exceed the total size limit', 3);
  testBarrier('legacy-append-before-write', { history: file, committedLength });
  const prewrite = assertRetainedPath(file, fd, 'HISTORY.ndjson', { expectedLinks: 1n });
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
    const after = assertRetainedPath(file, fd, 'HISTORY.ndjson', { expectedLinks: 1n });
    if (after.size !== BigInt(committedLength + bytes.length)) throw new MemoryError('HISTORY.ndjson committed length changed', 3);
  } catch (error) {
    if (offset > 0 && pathOwnsRetained(file, fd, { expectedLinks: 1n })) {
      try { ftruncateSync(fd, committedLength); fsyncSync(fd); } catch {}
    }
    throw error instanceof MemoryError ? error : new MemoryError('unable to append HISTORY.ndjson', 3);
  }
  if (wasMissing) fsyncDirectory(files.store);
}

function prepareSnapshot(root, parsed) {
  const snapshot = {
    ...parsed,
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    workspace: getWorkspace(root),
  };
  validateSnapshot(snapshot);
  validateLatestSourceRefs(root, snapshot, { requireCurrentHashes: true });
  return snapshot;
}

function recordSnapshot(root, snapshot, { refuseInitialized = false } = {}) {
  assertMutationAllowed(root);
  const files = pathsFor(root);
  assertStoreSafe(root, files);
  const release = acquireLock(root, files.lock);
  let journalFd;
  let createdJournal = false;
  let committedJournal = false;
  try {
    if (process.env.NODE_ENV === 'test' && process.env.PROJECT_MEMORY_TEST_FAIL_LEGACY_AFTER_LOCK === '1') {
      throw new MemoryError('simulated legacy post-lock failure', 3);
    }
    assertMutationAllowed(root);
    ensureStoreDirectory(root, files);
    if (refuseInitialized && (existsSync(files.history) || existsSync(files.current))) {
      throw new MemoryError('continuity is already initialized');
    }
    const historyExisted = existsSync(files.history);
    if (historyExisted) {
      try { journalFd = openSync(files.history, 'r+'); } catch { throw new MemoryError('authoritative HISTORY.ndjson is unavailable', 3); }
      assertOpenFileOwned(files.history, journalFd, 'HISTORY.ndjson');
    }
    const existing = loadJournal(root, { allowEmpty: true });
    if (historyExisted) {
      const afterRead = assertRetainedPath(files.history, journalFd, 'HISTORY.ndjson', { expectedLinks: 1n });
      if (afterRead.size !== BigInt(existing.committedBytes + existing.trailingBytes)) {
        throw new MemoryError('HISTORY.ndjson identity or committed length changed', 3);
      }
    } else {
      if (existsSync(files.history)) throw new MemoryError('HISTORY.ndjson appeared during checkpoint preparation', 3);
      try { journalFd = openSync(files.history, 'wx+', 0o600); } catch { throw new MemoryError('unable to create HISTORY.ndjson', 3); }
      createdJournal = true;
      assertOpenFileOwned(files.history, journalFd, 'HISTORY.ndjson');
    }
    if (existing.trailingBytes > 0) {
      const beforeTruncate = assertRetainedPath(files.history, journalFd, 'HISTORY.ndjson', { expectedLinks: 1n });
      if (beforeTruncate.size !== BigInt(existing.committedBytes + existing.trailingBytes)) {
        throw new MemoryError('HISTORY.ndjson committed length changed', 3);
      }
      ftruncateSync(journalFd, existing.committedBytes);
      fsyncSync(journalFd);
      const afterTruncate = assertRetainedPath(files.history, journalFd, 'HISTORY.ndjson', { expectedLinks: 1n });
      if (afterTruncate.size !== BigInt(existing.committedBytes)) throw new MemoryError('HISTORY.ndjson tail truncation failed', 3);
    }
    if (existing.current && existing.projection.state !== 'current') atomicWriteProjection(root, files, existing.current);
    const previousHash = existing.events.at(-1)?.eventHash ?? ZERO_HASH;
    const material = {
      sequence: existing.events.length + 1,
      timestamp: snapshot.updatedAt,
      previousHash,
      snapshotHash: sha256(canonical(snapshot)),
      snapshot,
    };
    const event = { ...material, eventHash: sha256(canonical(material)) };
    appendCommittedEvent(files, event, journalFd, existing.committedBytes, createdJournal);
    committedJournal = true;
    try {
      atomicWriteProjection(root, files, snapshot);
    } catch {
      throw new MemoryError(`checkpoint committed as sequence ${event.sequence}; CURRENT projection pending repair`, 3);
    }
    const verified = loadJournal(root);
    console.log(`checkpoint recorded: sequence=${event.sequence} event=${event.eventHash.slice(0, 12)} projection=${verified.projection.state}`);
  } finally {
    let failure;
    if (createdJournal && !committedJournal && journalFd !== undefined
      && pathOwnsRetained(files.history, journalFd, { expectedLinks: 1n })) {
      try {
        retireOwnedPath(files.history, journalFd, 'HISTORY.ndjson', { expectedLinks: 1n });
      } catch { failure = new MemoryError('uncommitted HISTORY.ndjson cleanup failed', 3); }
    }
    if (journalFd !== undefined) try { closeSync(journalFd); } catch { failure ??= new MemoryError('HISTORY.ndjson descriptor could not be closed safely', 3); }
    try { release(); } catch (error) { failure ??= error; }
    if (failure) throw failure;
  }
}

function checkpoint(root, raw, { dryRun = false } = {}) {
  const parsed = parseSnapshotInput(raw);
  const existing = loadJournal(root, { allowEmpty: true });
  const snapshot = prepareSnapshot(root, parsed);
  if (dryRun) {
    console.log(`checkpoint dry-run: ok prospective-sequence=${existing.events.length + 1}`);
    return;
  }
  recordSnapshot(root, snapshot);
}

function initialSnapshot(root) {
  return prepareSnapshot(root, {
    project: { name: 'Project', identity: 'Bounded project continuity snapshot' },
    stableGoals: [],
    implementationBoundaries: [],
    operatingRules: [],
    activeWork: [],
    decisions: [],
    recentWork: [],
    validationEvidence: [],
    unresolvedItems: [],
    nextSteps: [],
    sourceRefs: [],
  });
}

function initialize(root) {
  const files = assertStoreSafe(root, pathsFor(root));
  if (existsSync(files.history) || existsSync(files.current)) throw new MemoryError('continuity is already initialized');
  recordSnapshot(root, initialSnapshot(root), { refuseInitialized: true });
}

function printList(title, values, render = (value) => value) {
  console.log(`\n${title}`);
  if (!values.length) console.log('- none');
  else values.forEach((value) => console.log(`- ${render(value)}`));
}

function inspect(root) {
  const store = loadJournal(root);
  const current = store.current;
  const live = getWorkspace(root);
  console.log(`${current.project.name}: ${current.project.identity}`);
  console.log(`memory updated: ${current.updatedAt}`);
  console.log(`journal: authoritative; CURRENT projection=${store.projection.state}${store.trailingBytes ? '; partial tail ignored until checkpoint recovery' : ''}`);
  printList('Stable goals', current.stableGoals);
  printList('Implementation boundaries', current.implementationBoundaries);
  printList('Operating rules', current.operatingRules);
  printList('Active work', current.activeWork, (item) => `[${item.status}] ${item.summary}`);
  printList('Decisions', current.decisions, (item) => `[${item.status}] ${item.summary}`);
  printList('Recent work', current.recentWork, (item) => `[dated/unverified until rerun: ${item.checkedAt}; ${item.status}] ${item.summary}`);
  printList('Validation evidence', current.validationEvidence, (item) => `[dated/unverified until rerun: ${item.checkedAt}; ${item.status}] ${item.name} — ${item.scope}`);
  printList('Unresolved', current.unresolvedItems);
  printList('Next steps', current.nextSteps);

  const headDrift = live.head !== current.workspace.head;
  const statusDrift = live.statusFingerprint !== current.workspace.statusFingerprint;
  const fingerprintPartial = Boolean(current.workspace.fingerprintPartial || live.fingerprintPartial);
  const statusDriftLabel = fingerprintPartial ? 'UNKNOWN' : (statusDrift ? 'YES' : 'no');
  console.log('\nWorkspace drift');
  console.log(`- HEAD: recorded=${current.workspace.head.slice(0, 12)} current=${live.head.slice(0, 12)} drift=${headDrift ? 'YES' : 'no'}`);
  console.log(`- status: recorded=${current.workspace.dirty ? 'dirty' : 'clean'} current=${live.dirty ? 'dirty' : 'clean'} drift=${statusDriftLabel} fingerprint=${fingerprintPartial ? 'partial' : 'full'}`);

  console.log('\nSource refs');
  current.sourceRefs.forEach((ref) => {
    const absolute = assertRealPathContained(root, ref.path);
    let state = 'CURRENT';
    if (!existsSync(absolute)) state = 'MISSING';
    else {
      try {
        if (hashNormalizedTextFile(absolute) !== ref.contentSha256) state = 'STALE';
      } catch {
        state = 'UNREADABLE';
      }
    }
    console.log(`- ${state}: ${ref.path} — ${ref.purpose}`);
  });
}

function showHistory(root, tail) {
  if (!Number.isInteger(tail) || tail < 1 || tail > MAX_HISTORY_TAIL) {
    throw new MemoryError(`--tail must be an integer from 1 to ${MAX_HISTORY_TAIL}`);
  }
  const store = loadJournal(root);
  store.events.slice(-tail).forEach((event) => {
    console.log(`#${event.sequence} ${event.timestamp} ${event.eventHash.slice(0, 12)} active=${event.snapshot.activeWork.length} unresolved=${event.snapshot.unresolvedItems.length}`);
  });
  if (store.trailingBytes) console.log(`journal tail: ${store.trailingBytes} uncommitted byte(s), ignored until checkpoint recovery`);
}

function legacyInspectRecords(current) {
  const records = [];
  const add = (kind, summary, { legacyStatus, checkedAt } = {}) => {
    const ordinal = records.length + 1;
    const legacyId = `legacy-${kind.toLowerCase()}-${ordinal}-${sha256(canonical({ kind, summary, legacyStatus, checkedAt, ordinal })).slice(0, 12)}`;
    records.push({ legacyId, kind, summary, ...(legacyStatus ? { legacyStatus } : {}), ...(checkedAt ? { checkedAt } : {}), freshness: 'unknown' });
  };
  current.stableGoals.forEach((summary) => add('stableGoal', summary));
  current.activeWork.forEach((item) => add('activeWork', item.summary, { legacyStatus: item.status }));
  current.decisions.forEach((item) => add('decision', item.summary, { legacyStatus: item.status }));
  current.recentWork.forEach((item) => add('recentWork', item.summary, { legacyStatus: item.status, checkedAt: item.checkedAt }));
  current.validationEvidence.forEach((item) => add('validationEvidence', item.name, { legacyStatus: item.status, checkedAt: item.checkedAt }));
  current.unresolvedItems.forEach((summary) => add('unresolvedItem', summary));
  current.nextSteps.forEach((summary) => add('nextStep', summary));
  return { records: records.slice(0, MAX_ITEMS), truncated: records.length > MAX_ITEMS };
}

function legacySourceDrift(root, sourceRefs) {
  return sourceRefs.map((ref) => {
    let state = 'unknown';
    try {
      const absolute = assertRealPathContained(root, ref.path);
      state = !existsSync(absolute) ? 'stale' : hashNormalizedTextFile(absolute) === ref.contentSha256 ? 'current' : 'stale';
    } catch { state = 'unknown'; }
    return { path: ref.path, purpose: ref.purpose, state };
  });
}

export function readLegacyInspectInput(root) {
  if (arguments.length > 1) throw new MemoryError('readLegacyInspectInput options are invalid', 3);
  const store = loadJournal(root);
  const current = store.current;
  const { records, truncated } = legacyInspectRecords(current);
  const allBoundaries = [...new Set([...current.implementationBoundaries, ...current.operatingRules])];
  const boundaries = allBoundaries.slice(0, MAX_ITEMS);
  const warnings = [{
    warningId: 'warning-legacy-v1-untyped', severity: 'blocking', code: 'legacy_v1_untyped',
    message: 'Legacy v1 memory has no typed final goal, task, criterion, acceptance, freshness, or handoff authority',
  }];
  if (truncated) warnings.push({
    warningId: 'warning-legacy-v1-record-limit', severity: 'blocking', code: 'legacy_v1_record_limit',
    message: 'Legacy records exceed the bounded inspect view; explicit migration is required for complete typed continuity',
  });
  if (allBoundaries.length > MAX_ITEMS) warnings.push({
    warningId: 'warning-legacy-v1-boundary-limit', severity: 'blocking', code: 'legacy_v1_boundary_limit',
    message: 'Legacy boundaries exceed the bounded inspect view; explicit migration is required before handoff',
  });
  if (store.projection.state !== 'current') warnings.push({
    warningId: 'warning-legacy-v1-projection', severity: 'blocking', code: 'legacy_v1_projection',
    message: 'Legacy CURRENT projection is not current; the validated journal remains authoritative',
  });
  return {
    store: {
      schemaVersion: 1,
      sequence: store.events.at(-1).sequence,
      eventHash: store.events.at(-1).eventHash,
      journalState: 'valid',
      projectionState: store.projection.state,
      partialTail: store.trailingBytes > 0,
    },
    project: { name: current.project.name, identity: current.project.identity },
    boundaries,
    legacy: records,
    recordedWorkspace: structuredClone(current.workspace),
    sourceRefs: structuredClone(current.sourceRefs),
    warnings,
  };
}

const TYPED_GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function renderableLegacyWorkspace(workspace) {
  const rendered = structuredClone(workspace);
  const unrepresentable = rendered.head !== 'unavailable' && !TYPED_GIT_OBJECT_ID.test(rendered.head);
  if (unrepresentable) rendered.head = 'unavailable';
  return { rendered, unrepresentable };
}

export function renderLegacyInspectV1(root, options = {}) {
  if (arguments.length > 2) throw new MemoryError('renderLegacyInspectV1 options are invalid', 3);
  const verifiedOptions = publicOptions(options, { clock: 'function', git: 'function' }, 'renderLegacyInspectV1');
  const { clock = () => new Date(), git } = verifiedOptions;
  const input = readLegacyInspectInput(root);
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new MemoryError('legacy inspect clock is invalid');
  const generatedAt = now.toISOString();
  const live = getWorkspace(root, { capturedAt: generatedAt, git });
  const recordedWorkspace = renderableLegacyWorkspace(input.recordedWorkspace);
  const currentWorkspace = renderableLegacyWorkspace(live);
  const warnings = structuredClone(input.warnings);
  if (recordedWorkspace.unrepresentable || currentWorkspace.unrepresentable) {
    const warning = {
      warningId: 'warning-legacy-v1-projection', severity: 'blocking', code: 'legacy_v1_projection',
      message: 'A legacy projection fact was unrepresentable; the validated journal remains authoritative',
    };
    const existing = warnings.findIndex((item) => item.code === warning.code);
    if (existing === -1) warnings.push(warning);
    else warnings[existing] = warning;
  }
  return {
    inspectVersion: 1,
    view: 'legacy-v1',
    generatedAt,
    store: input.store,
    project: input.project,
    boundaries: input.boundaries,
    legacy: input.legacy,
    workspaceDrift: {
      recorded: recordedWorkspace.rendered,
      current: currentWorkspace.rendered,
      headDrift: input.recordedWorkspace.head !== live.head,
      statusDrift: input.recordedWorkspace.statusFingerprint !== live.statusFingerprint,
      fingerprintState: input.recordedWorkspace.fingerprintPartial || live.fingerprintPartial ? 'partial' : 'full',
    },
    sourceDrift: legacySourceDrift(root, input.sourceRefs),
    warnings,
  };
}

function printSnapshotTemplate() {
  const raw = readBoundedFile(templatePath, MAX_SNAPSHOT_BYTES, 'snapshot template');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new MemoryError('bundled snapshot template is invalid'); }
  validateSnapshot(parsed);
  process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
}

function printSourceHash(root, repoPath) {
  if (!repoPath) throw new MemoryError('source hash requires one repository-relative path');
  const result = verifiedSourceHash(root, repoPath);
  console.log(JSON.stringify(result));
}

function lintSnapshot(root, inputFile) {
  const raw = readBoundedFile(inputFile, MAX_SNAPSHOT_BYTES, 'snapshot input');
  prepareSnapshot(root, parseSnapshotInput(raw));
  console.log('snapshot lint: ok');
}

function doctor(root) {
  const linked = isLinkedWorktree(root);
  const files = assertStoreSafe(root, pathsFor(root));
  assertSingleLinkRegularFile(files.lock, 'checkpoint lock');
  const workspace = getWorkspace(root);
  console.log(`repository=ok worktree=${linked ? 'linked' : 'primary'} mutation=${linked ? 'refused' : 'allowed'}`);
  if (!existsSync(files.history)) {
    console.log(`journal=uninitialized projection=${existsSync(files.current) ? 'orphaned' : 'missing'}`);
  } else {
    const store = loadJournal(root);
    console.log(`journal=valid events=${store.events.length} tail=${store.trailingBytes ? 'partial' : 'clean'} projection=${store.projection.state}`);
  }
  console.log(`workspace-fingerprint=${workspace.fingerprintPartial ? 'partial' : 'full'}`);
  console.log(`lock=${existsSync(files.lock) ? 'present-manual-review-required' : 'clear'}`);
}

function requirePlainCommand(args) {
  if (args.positionals.length || args.inputCount || args.dryRun || args.tail !== 10) throw new MemoryError('invalid command arguments');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === '--version') {
    requirePlainCommand(args);
    console.log(`continuity ${VERSION}`);
    return;
  }
  if (args.command === 'snapshot' && args.positionals.length === 1 && args.positionals[0] === 'template') {
    if (args.inputCount || args.dryRun || args.tail !== 10 || args.rootExplicit) throw new MemoryError('invalid snapshot template arguments');
    printSnapshotTemplate();
    return;
  }

  const root = resolveRepositoryRoot(args.rootCandidate, args.rootExplicit);
  if (args.command === 'inspect') {
    requirePlainCommand(args);
    inspect(root);
  }
  else if (args.command === 'validate') {
    requirePlainCommand(args);
    const store = loadJournal(root);
    console.log(`continuity valid: ${store.events.length} event(s), latest=${store.events.at(-1).eventHash.slice(0, 12)}, projection=${store.projection.state}, journal-tail=${store.trailingBytes ? 'partial' : 'clean'}`);
  } else if (args.command === 'history') {
    if (args.positionals.length || args.inputCount || args.dryRun) throw new MemoryError('invalid history arguments');
    showHistory(root, args.tail);
  } else if (args.command === 'checkpoint') {
    if (args.positionals.length || !args.inputMode || args.inputCount !== 1 || args.tail !== 10) {
      throw new MemoryError('checkpoint requires exactly one of --stdin or --file');
    }
    assertMutationAllowed(root);
    const raw = args.inputMode === 'file'
      ? readBoundedFile(args.inputFile, MAX_SNAPSHOT_BYTES, 'snapshot input')
      : readBoundedStdin();
    checkpoint(root, raw, { dryRun: args.dryRun });
  } else if (args.command === 'init') {
    requirePlainCommand(args);
    assertMutationAllowed(root);
    initialize(root);
  } else if (args.command === 'source' && args.positionals.length === 2 && args.positionals[0] === 'hash') {
    if (args.inputCount || args.dryRun || args.tail !== 10) throw new MemoryError('invalid source hash arguments');
    printSourceHash(root, args.positionals[1]);
  } else if (args.command === 'lint') {
    if (args.positionals.length || args.inputMode !== 'file' || args.inputCount !== 1 || args.dryRun || args.tail !== 10) {
      throw new MemoryError('lint requires exactly one --file');
    }
    lintSnapshot(root, args.inputFile);
  } else if (args.command === 'doctor') {
    requirePlainCommand(args);
    doctor(root);
  } else {
    throw new MemoryError('usage: continuity.mjs <init|inspect|validate|history|checkpoint|doctor|lint|source hash|snapshot template>');
  }
}

export function runV1() {
  try {
    main();
  } catch (error) {
    const message = error instanceof MemoryError ? error.message : 'unexpected helper failure';
    console.error(`continuity: ERROR: ${message}`);
    process.exitCode = error instanceof MemoryError ? error.exitCode : 1;
  }
}
