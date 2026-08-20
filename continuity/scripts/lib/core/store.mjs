import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { MAX_JOURNAL_BYTES, MemoryError, canonicalV2, foldV2 } from './domain-v2.mjs';

const MAX_PROJECTION_BYTES = 64 * 1024;
const MAX_GIT_POINTER_BYTES = 4 * 1024;
const ASSERT_OWNED_FILE_OPTION_KEYS = new Set(['optional']);
const READ_V2_JOURNAL_OPTION_KEYS = new Set(['allowEmpty', 'validateLegacyArchive']);
const OPEN_STORE_OPTION_KEYS = new Set(['mode']);
export const DEFAULT_STORE_DIR = '.continuity';
export const LEGACY_STORE_DIR = '.codex/project-memory';
export const STORE_DIR_ENV = 'CONTINUITY_STORE_DIR';

function inspectPublicOptions(options, allowedKeys, label) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new MemoryError(`${label} options are invalid`, 3);
  }
  let prototype;
  let keys;
  try {
    prototype = Reflect.getPrototypeOf(options);
    keys = Reflect.ownKeys(options);
  } catch {
    throw new MemoryError(`${label} options are invalid`, 3);
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))) {
    throw new MemoryError(`${label} options are invalid`, 3);
  }
  const descriptors = new Map();
  try {
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(options, key);
      if (!descriptor) throw new Error('missing option descriptor');
      descriptors.set(key, descriptor);
    }
  } catch {
    throw new MemoryError(`${label} options are invalid`, 3);
  }
  return descriptors;
}

function readPublicOption(options, descriptors, key, fallback, label) {
  const descriptor = descriptors.get(key);
  if (!descriptor) return fallback;
  try {
    const value = Object.hasOwn(descriptor, 'value') ? descriptor.value : descriptor.get?.call(options);
    return value === undefined ? fallback : value;
  } catch {
    throw new MemoryError(`${label} options are invalid`, 3);
  }
}

function configuredStoreDirectory() {
  const configured = process.env[STORE_DIR_ENV];
  if (configured === undefined) return DEFAULT_STORE_DIR;
  if (!configured || configured.length > 240 || /[\0\r\n]/.test(configured)
    || path.isAbsolute(configured) || path.win32.isAbsolute(configured)
    || path.win32.parse(configured).root) {
    throw new MemoryError(`${STORE_DIR_ENV} must be a bounded repository-relative directory`, 3);
  }
  const parts = configured.replaceAll('\\', '/').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new MemoryError(`${STORE_DIR_ENV} must not contain empty or traversal segments`, 3);
  }
  if (parts[0].toLowerCase() === '.git') {
    throw new MemoryError(`${STORE_DIR_ENV} must not target Git administration data`, 3);
  }
  return parts.join('/');
}

export function storeRelativePath(root) {
  const relative = configuredStoreDirectory();
  assertPathSafe(root, path.resolve(root, ...relative.split('/')));
  return relative;
}

export function isStoreRepoPath(root, repoPath) {
  const storePath = storeRelativePath(root);
  return repoPath === storePath || repoPath.startsWith(`${storePath}/`);
}

function pathsAt(store) {
  return {
    store,
    history: path.join(store, 'HISTORY.ndjson'),
    current: path.join(store, 'CURRENT.json'),
    migrationMarker: path.join(store, 'MIGRATION.v1-to-v2.json'),
    historyV1: path.join(store, 'HISTORY.v1.ndjson'),
    currentV1: path.join(store, 'CURRENT.v1.json'),
  };
}

export function storePaths(root) {
  const relative = storeRelativePath(root);
  return pathsAt(path.resolve(root, ...relative.split('/')));
}

export function legacyStorePaths(root) {
  const store = path.resolve(root, ...LEGACY_STORE_DIR.split('/'));
  assertPathSafe(root, store);
  return pathsAt(store);
}

// Backward compatibility is deliberately explicit: normal runtime paths never
// inspect or initialize `.codex/project-memory`. Callers may use this metadata-
// only probe to offer an operator-controlled migration without reading records.
export function discoverLegacyStore(root) {
  const files = legacyStorePaths(root);
  const container = path.dirname(files.store);
  for (const [target, label] of [[container, 'legacy .codex directory'], [files.store, 'legacy project-memory store']]) {
    assertPathSafe(root, target);
    const details = lstatIfPresent(target, label);
    if (!details) return Object.freeze({ status: 'absent', store: files.store, history: false, current: false });
    if (!details.isDirectory()) throw new MemoryError(`${label} is invalid`, 3);
  }
  const history = Boolean(assertOwnedFile(files.history, 'legacy HISTORY.ndjson'));
  const current = Boolean(assertOwnedFile(files.current, 'legacy CURRENT.json'));
  return Object.freeze({ status: history || current ? 'present' : 'empty', store: files.store, history, current });
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function lstatIfPresent(target, label = 'continuity path') {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new MemoryError(`${label} is unavailable`, 3);
  }
}

export function assertPathSafe(root, target) {
  const lexicalRoot = path.resolve(root);
  const absolute = path.resolve(target);
  const rootReal = realpathSync.native(lexicalRoot);
  const lexicalHit = contained(lexicalRoot, absolute);
  const canonicalHit = contained(rootReal, absolute);
  if (!lexicalHit && !canonicalHit) throw new MemoryError('continuity path escapes the repository', 3);
  const walkRoot = lexicalHit ? lexicalRoot : rootReal;
  let probe = walkRoot;
  for (const part of path.relative(walkRoot, absolute).split(path.sep).filter(Boolean)) {
    probe = path.join(probe, part);
    const details = lstatIfPresent(probe);
    if (!details) continue;
    if (details.isSymbolicLink()) throw new MemoryError('continuity path must not use links or reparse points', 3);
    const resolved = realpathSync.native(probe);
    if (!contained(rootReal, resolved)) throw new MemoryError('continuity path escapes the repository', 3);
  }
}

export function assertOwnedFile(file, label, options = {}) {
  if (arguments.length > 3) throw new MemoryError('assertOwnedFile options are invalid', 3);
  const descriptors = inspectPublicOptions(options, ASSERT_OWNED_FILE_OPTION_KEYS, 'assertOwnedFile');
  const optional = readPublicOption(options, descriptors, 'optional', true, 'assertOwnedFile');
  if (typeof optional !== 'boolean') throw new MemoryError('assertOwnedFile options are invalid', 3);
  const details = lstatIfPresent(file, label);
  if (!details) {
    if (optional) return null;
    throw new MemoryError(`${label} is missing`, 3);
  }
  if (!details.isFile() || details.nlink !== 1) throw new MemoryError(`${label} must be a regular file with exactly one hard link`, 3);
  return details;
}

export function assertStoreSafe(root) {
  const files = storePaths(root);
  const lexicalRoot = path.resolve(root);
  let component = lexicalRoot;
  for (const part of path.relative(lexicalRoot, files.store).split(path.sep).filter(Boolean)) {
    component = path.join(component, part);
    assertPathSafe(root, component);
    const details = lstatIfPresent(component, 'continuity store path component');
    if (details && !details.isDirectory()) throw new MemoryError('continuity directory component is invalid', 3);
  }
  for (const target of [
    files.history, files.current,
    files.migrationMarker, files.historyV1, files.currentV1,
  ]) assertPathSafe(root, target);
  assertOwnedFile(files.history, 'HISTORY.ndjson');
  assertOwnedFile(files.current, 'CURRENT.json');
  assertOwnedFile(files.migrationMarker, 'MIGRATION.v1-to-v2.json');
  assertOwnedFile(files.historyV1, 'HISTORY.v1.ndjson');
  assertOwnedFile(files.currentV1, 'CURRENT.v1.json');
  return files;
}

export function assertMutationAllowed(root) {
  const files = assertStoreSafe(root);
  if (lstatIfPresent(files.migrationMarker, 'MIGRATION.v1-to-v2.json')) {
    throw new MemoryError('continuity mutation is blocked by interrupted migration', 3);
  }
}

function assertOwnedPathDetails(pathDetails, label) {
  if (!pathDetails.isFile() || pathDetails.isSymbolicLink() || pathDetails.nlink !== 1n) {
    throw new MemoryError(`${label} must be a regular file with exactly one hard link`, 3);
  }
}

function lstatOwnedFileBeforeOpen(file, label) {
  let pathDetails;
  try {
    pathDetails = lstatSync(file, { bigint: true });
  } catch {
    throw new MemoryError(`${label} is unavailable`, 3);
  }
  assertOwnedPathDetails(pathDetails, label);
  return pathDetails;
}

function assertDescriptorIdentity(pathDetails, descriptorDetails, label) {
  if (!pathDetails.isFile() || pathDetails.isSymbolicLink() || !descriptorDetails.isFile()
    || pathDetails.nlink !== 1n || descriptorDetails.nlink !== 1n
    || pathDetails.dev !== descriptorDetails.dev || pathDetails.ino !== descriptorDetails.ino) {
    throw new MemoryError(`${label} ownership changed`, 3);
  }
  if (pathDetails.size !== descriptorDetails.size) {
    throw new MemoryError(`${label} changed while being read`, 3);
  }
}

export function readOwnedFileBounded(file, max, label) {
  if (arguments.length > 3) throw new MemoryError('bounded read arguments are invalid', 3);
  if (!Number.isSafeInteger(max) || max < 0) throw new MemoryError('file size limit is invalid', 3);
  const pathBefore = lstatOwnedFileBeforeOpen(file, label);
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new MemoryError(`${label} is unavailable`, 3);
  }
  let value;
  let failure;
  try {
    const openedBefore = fstatSync(fd, { bigint: true });
    assertDescriptorIdentity(pathBefore, openedBefore, label);
    const pathOpened = lstatSync(file, { bigint: true });
    assertDescriptorIdentity(pathOpened, openedBefore, label);
    if (openedBefore.size > BigInt(max)) throw new MemoryError(`${label} exceeds the size limit`, 3);

    const bytes = Buffer.alloc(max + 1);
    let total = 0;
    while (total < bytes.length) {
      const count = readSync(fd, bytes, total, bytes.length - total, null);
      if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length - total) {
        throw new MemoryError(`${label} returned an invalid read length`, 3);
      }
      if (count === 0) break;
      total += count;
    }

    let openedAfter;
    let pathAfter;
    try {
      openedAfter = fstatSync(fd, { bigint: true });
      pathAfter = lstatSync(file, { bigint: true });
      assertDescriptorIdentity(pathAfter, openedAfter, label);
    } catch {
      throw new MemoryError(`${label} changed while being read`, 3);
    }
    if (openedBefore.dev !== openedAfter.dev || openedBefore.ino !== openedAfter.ino
      || pathBefore.dev !== pathAfter.dev || pathBefore.ino !== pathAfter.ino
      || openedBefore.size !== openedAfter.size || BigInt(total) !== openedAfter.size) {
      throw new MemoryError(`${label} changed while being read`, 3);
    }
    if (total > max) throw new MemoryError(`${label} exceeds the size limit`, 3);
    value = Buffer.from(bytes.subarray(0, total));
  } catch (error) {
    failure = error instanceof MemoryError ? error : new MemoryError(`${label} is unreadable`, 3);
  }
  try {
    closeSync(fd);
  } catch {
    failure ??= new MemoryError(`${label} could not be closed safely`, 3);
  }
  if (failure) throw failure;
  return value;
}

function freezeDeep(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) freezeDeep(nested);
  return value;
}

function immutableCopy(value) {
  return freezeDeep(structuredClone(value));
}

function validateArchiveSynchronously(validator, details) {
  try {
    const result = validator(details);
    const then = result !== null && (typeof result === 'object' || typeof result === 'function')
      ? result.then
      : undefined;
    if (typeof then === 'function') {
      if (typeof result.catch === 'function') result.catch(() => undefined);
      throw new Error('asynchronous validator result');
    }
    if (result !== true) throw new Error('archive validator did not authorize replay');
  } catch {
    throw new MemoryError('legacy archive validation failed', 3);
  }
}

export function readV2Journal(root, options = {}) {
  if (arguments.length > 2) throw new MemoryError('readV2Journal options are invalid', 3);
  const descriptors = inspectPublicOptions(
    options,
    READ_V2_JOURNAL_OPTION_KEYS,
    'readV2Journal',
  );
  const allowEmpty = readPublicOption(options, descriptors, 'allowEmpty', false, 'readV2Journal');
  const validateLegacyArchive = readPublicOption(
    options,
    descriptors,
    'validateLegacyArchive',
    undefined,
    'readV2Journal',
  );
  if (typeof allowEmpty !== 'boolean') throw new MemoryError('readV2Journal options are invalid', 3);
  if (validateLegacyArchive !== undefined && typeof validateLegacyArchive !== 'function') {
    throw new MemoryError('legacy archive validator must be a function', 3);
  }
  const files = assertStoreSafe(root);
  const historyDetails = assertOwnedFile(files.history, 'HISTORY.ndjson');
  const currentDetails = assertOwnedFile(files.current, 'CURRENT.json');
  if (!historyDetails) {
    if (allowEmpty) return { files, events: [], committedBytes: 0, trailingBytes: 0, state: null, projection: currentDetails ? 'orphaned' : 'missing' };
    throw new MemoryError('authoritative HISTORY.ndjson is missing', 3);
  }
  const raw = readOwnedFileBounded(files.history, MAX_JOURNAL_BYTES, 'HISTORY.ndjson total');
  const lastLf = raw.lastIndexOf(0x0a);
  const committedBytes = lastLf < 0 ? 0 : lastLf + 1;
  const trailingBytes = raw.length - committedBytes;
  const lines = raw.subarray(0, committedBytes).toString('utf8').split('\n').filter(Boolean);
  const events = lines.map((line, index) => {
    if (Buffer.byteLength(line, 'utf8') > 64 * 1024) throw new MemoryError(`history event ${index + 1} exceeds the size limit`, 3);
    try { return JSON.parse(line); } catch { throw new MemoryError(`history event ${index + 1} is not valid JSON`, 3); }
  });
  if (!events.length) {
    if (allowEmpty) return { files, events, committedBytes, trailingBytes, state: null, projection: currentDetails ? 'orphaned' : 'missing' };
    throw new MemoryError('history has no committed events', 3);
  }
  if (events[0]?.schemaVersion !== 2) throw new MemoryError('store is not a v2 journal', 3);
  const state = foldV2(events);
  let projection = 'missing';
  if (currentDetails) {
    const rawProjection = readOwnedFileBounded(files.current, MAX_PROJECTION_BYTES, 'CURRENT.json');
    try {
      const parsed = JSON.parse(rawProjection.toString('utf8'));
      projection = canonicalV2(parsed) === canonicalV2(state) ? 'current' : 'stale';
    } catch {
      projection = 'invalid';
    }
  }
  const receiptEvent = events.find((event) => event.eventType === 'migration.v1_imported');
  if (receiptEvent && validateLegacyArchive) {
    // Archive paths are immutable metadata, not open capabilities. The migration
    // validator must reopen and revalidate each path immediately before use.
    validateArchiveSynchronously(validateLegacyArchive, immutableCopy({ root, files, receiptEvent, state }));
  }
  return { files, events, committedBytes, trailingBytes, state, projection };
}

export function detectStoreVersion(root) {
  const files = assertStoreSafe(root);
  if (lstatIfPresent(files.migrationMarker, 'MIGRATION.v1-to-v2.json')) return 'interrupted-migration';
  if (!lstatIfPresent(files.history, 'HISTORY.ndjson')) return 'uninitialized';
  const raw = readOwnedFileBounded(files.history, MAX_JOURNAL_BYTES, 'HISTORY.ndjson total');
  const lf = raw.indexOf(0x0a);
  if (lf < 0) throw new MemoryError('journal has no committed event', 3);
  let first;
  try { first = JSON.parse(raw.subarray(0, lf).toString('utf8')); } catch { throw new MemoryError('first journal event is not valid JSON', 3); }
  if (first?.schemaVersion === 3) return 3;
  if (first?.schemaVersion === 2) return 2;
  if (first?.snapshot?.schemaVersion === 1) return 1;
  throw new MemoryError('unknown continuity journal version', 3);
}

function samePath(left, right) {
  return path.relative(left, right) === '' && path.relative(right, left) === '';
}

function gitMetadata(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024,
  });
  if (result.status !== 0 || result.error) throw new MemoryError('unable to inspect Git worktree metadata', 3);
  const value = result.stdout.trim();
  if (!value) throw new MemoryError('Git worktree metadata is empty', 3);
  return value;
}

function existingGitDirectory(root, value, label) {
  const absolute = path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value);
  let details;
  try {
    details = lstatSync(absolute);
  } catch {
    throw new MemoryError(`${label} is unavailable`, 3);
  }
  if (!details.isDirectory() || details.isSymbolicLink()) throw new MemoryError(`${label} is unsafe`, 3);
  try {
    return realpathSync.native(absolute);
  } catch {
    throw new MemoryError(`${label} is unavailable`, 3);
  }
}

function existingGitFile(root, value, label) {
  const absolute = path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value);
  let details;
  try {
    details = lstatSync(absolute);
  } catch {
    throw new MemoryError(`${label} is unavailable`, 3);
  }
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
    throw new MemoryError(`${label} is unsafe`, 3);
  }
  try {
    return realpathSync.native(absolute);
  } catch {
    throw new MemoryError(`${label} is unavailable`, 3);
  }
}

function readGitPointer(file, label, { gitdirPrefix = false } = {}) {
  const raw = readOwnedFileBounded(file, MAX_GIT_POINTER_BYTES, label);
  const value = raw.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(raw)) throw new MemoryError(`${label} is unsafe`, 3);
  const pattern = gitdirPrefix ? /^gitdir: ([^\r\n]+)\r?\n?$/ : /^([^\r\n]+)\r?\n?$/;
  const match = pattern.exec(value);
  if (!match || match[1] !== match[1].trim()) throw new MemoryError(`${label} is unsafe`, 3);
  return match[1];
}

function assertContainedGitDirectories(root, target, label) {
  if (!contained(root, target)) throw new MemoryError(`${label} escapes the Git administration directory`, 3);
  let probe = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    probe = path.join(probe, part);
    let details;
    try {
      details = lstatSync(probe);
    } catch {
      throw new MemoryError(`${label} is unavailable`, 3);
    }
    if (!details.isDirectory() || details.isSymbolicLink()) throw new MemoryError(`${label} is unsafe`, 3);
    let resolved;
    try {
      resolved = realpathSync.native(probe);
    } catch {
      throw new MemoryError(`${label} is unavailable`, 3);
    }
    if (!contained(root, resolved)) throw new MemoryError(`${label} escapes the Git administration directory`, 3);
  }
}

function assertLinkedWorktreeTopology(root, gitDirectory, commonDirectory) {
  const dotGit = path.join(root, '.git');
  assertPathSafe(root, dotGit);
  const declaredGitDirectory = existingGitDirectory(
    root,
    readGitPointer(dotGit, 'linked-worktree .git pointer', { gitdirPrefix: true }),
    'linked-worktree Git administration directory',
  );
  if (!samePath(declaredGitDirectory, gitDirectory)) {
    throw new MemoryError('linked-worktree Git administration pointer is inconsistent', 3);
  }

  const worktreesDirectory = existingGitDirectory(
    commonDirectory,
    path.join(commonDirectory, 'worktrees'),
    'Git worktrees administration directory',
  );
  if (samePath(worktreesDirectory, gitDirectory) || !contained(worktreesDirectory, gitDirectory)) {
    throw new MemoryError('linked-worktree Git administration directory is unsafe', 3);
  }
  assertContainedGitDirectories(commonDirectory, gitDirectory, 'linked-worktree Git administration directory');

  const declaredCommonDirectory = existingGitDirectory(
    gitDirectory,
    readGitPointer(path.join(gitDirectory, 'commondir'), 'linked-worktree common-directory pointer'),
    'linked-worktree common directory',
  );
  if (!samePath(declaredCommonDirectory, commonDirectory)) {
    throw new MemoryError('linked-worktree common-directory pointer is inconsistent', 3);
  }

  const declaredDotGit = existingGitFile(
    gitDirectory,
    readGitPointer(path.join(gitDirectory, 'gitdir'), 'linked-worktree back pointer'),
    'linked-worktree back-pointer target',
  );
  const dotGitReal = existingGitFile(root, dotGit, 'linked-worktree .git pointer');
  if (!samePath(declaredDotGit, dotGitReal)) {
    throw new MemoryError('linked-worktree back pointer is inconsistent', 3);
  }
}

export function gitAdminTopology(root) {
  let rootReal;
  try {
    rootReal = realpathSync.native(root);
  } catch {
    throw new MemoryError('repository root is unavailable', 3);
  }
  const topLevel = existingGitDirectory(root, gitMetadata(root, ['rev-parse', '--show-toplevel']), 'Git worktree root');
  if (!samePath(rootReal, topLevel)) throw new MemoryError('repository root does not match the Git worktree root', 3);

  const gitDirectory = existingGitDirectory(root, gitMetadata(root, ['rev-parse', '--absolute-git-dir']), 'Git administration directory');
  const commonDirectory = existingGitDirectory(root, gitMetadata(root, ['rev-parse', '--git-common-dir']), 'Git common directory');
  const linkedWorktree = !samePath(gitDirectory, commonDirectory);
  if (linkedWorktree) {
    assertLinkedWorktreeTopology(rootReal, gitDirectory, commonDirectory);
  } else if (!contained(rootReal, gitDirectory) || !contained(rootReal, commonDirectory)) {
    throw new MemoryError('Git administration directory escapes the repository', 3);
  }

  // Retain the historical lock filename so old and new wrappers cannot write
  // concurrently. This is a storage compatibility identifier, not a dependency.
  const reportedLock = gitMetadata(root, ['rev-parse', '--git-path', 'project-memory.checkpoint.lock']);
  const lockAbsolute = path.isAbsolute(reportedLock) ? path.normalize(reportedLock) : path.resolve(root, reportedLock);
  const lockParent = existingGitDirectory(root, path.dirname(lockAbsolute), 'Git lock directory');
  const lock = path.join(lockParent, path.basename(lockAbsolute));
  if (!contained(commonDirectory, lock) || (linkedWorktree ? !contained(gitDirectory, lock) : !contained(rootReal, lock))) {
    throw new MemoryError('continuity lock escapes the Git administration directory', 3);
  }
  if (linkedWorktree) {
    assertContainedGitDirectories(gitDirectory, lockParent, 'Git lock directory');
    assertOwnedFile(lock, 'continuity lock');
  } else {
    assertPathSafe(root, lock);
  }
  return Object.freeze({
    root: rootReal, gitDirectory, commonDirectory, lock,
    linkedWorktree,
  });
}

export function openStore(root, options = {}) {
  if (arguments.length > 2) throw new MemoryError('openStore options are invalid', 3);
  const descriptors = inspectPublicOptions(options, OPEN_STORE_OPTION_KEYS, 'openStore');
  const mode = readPublicOption(options, descriptors, 'mode', 'read', 'openStore');
  if (!['read', 'write'].includes(mode)) throw new MemoryError('store mode must be read or write', 3);
  const version = detectStoreVersion(root);
  if (mode === 'write' && gitAdminTopology(root).linkedWorktree) throw new MemoryError('mutating continuity is refused in linked worktrees', 3);
  if (version === 2) return { version, root, ...readV2Journal(root) };
  return { version, root, files: assertStoreSafe(root) };
}
