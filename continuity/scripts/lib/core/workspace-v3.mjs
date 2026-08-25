import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readSync, readlinkSync } from 'node:fs';
import path from 'node:path';

import { isStoreRepoPath } from './store.mjs';

const MAX_STATUS_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACE_HASH_BYTES = 8 * 1024 * 1024;
const MAX_WORKSPACE_FILE_BYTES = 1024 * 1024;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function git(root, args, { maxBuffer = 2 * 1024 * 1024 } = {}) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
  });
  if (result.status !== 0 || result.error) return null;
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

export function unavailableWorkspace(recordedAt) {
  return {
    head: 'unavailable',
    branch: 'unknown',
    dirty: false,
    statusFingerprint: sha256(`unavailable:${recordedAt}`),
    fingerprintPartial: true,
    capturedAt: recordedAt,
  };
}

export function observeWorkspace(root, recordedAt) {
  const headRaw = git(root, ['rev-parse', 'HEAD']);
  const branchRaw = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (headRaw === null || branchRaw === null) return unavailableWorkspace(recordedAt);
  const head = headRaw.trim();
  const branch = branchRaw.trim() || 'detached';
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(head)) return unavailableWorkspace(recordedAt);
  const result = spawnSync('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: MAX_STATUS_BYTES,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
  });
  let partial = Boolean(result.error) || result.status !== 0;
  const fields = partial ? [] : (result.stdout ?? '').split('\0').filter(Boolean);
  const entries = [];
  let storeDirty = false;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4) { entries.push({ status: 'rename-source', repoPath: field.replaceAll('\\', '/') }); continue; }
    const status = field.slice(0, 2);
    const repoPath = field.slice(3).replaceAll('\\', '/');
    if (!isStoreRepoPath(root, repoPath)) {
      entries.push({ status, repoPath });
    } else {
      storeDirty = true;
    }
    if (/[RC]/.test(status) && index + 1 < fields.length) {
      index += 1;
      const source = fields[index].replaceAll('\\', '/');
      if (!isStoreRepoPath(root, source)) {
        entries.push({ status: 'rename-source', repoPath: source });
      } else {
        storeDirty = true;
      }
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
  return {
    head,
    branch,
    dirty: entries.length > 0 || partial || storeDirty,
    statusFingerprint: sha256(material.join('\0')),
    fingerprintPartial: partial,
    capturedAt: recordedAt,
  };
}

export function compareWorkspace(recorded, live) {
  if (!live || live.head === 'unavailable' || live.fingerprintPartial === true) return 'unknown';
  if (!recorded || recorded.head === 'unavailable' || recorded.fingerprintPartial === true
    || typeof recorded.statusFingerprint !== 'string' || typeof live.statusFingerprint !== 'string') {
    return 'unknown';
  }
  if (recorded.head !== live.head || recorded.statusFingerprint !== live.statusFingerprint) return 'stale';
  return 'fresh';
}

export function liveGitContext(root, recorded, extras = {}) {
  const now = extras.now ?? new Date().toISOString();
  const live = observeWorkspace(root, now);
  const axis = compareWorkspace(recorded, live);
  return {
    now: live.capturedAt,
    head: live.head,
    dirty: axis === 'unknown' ? null : axis === 'stale',
    expiredEvidenceIds: extras.expiredEvidenceIds ?? [],
    unreadableSources: extras.unreadableSources === true,
    workspace: axis,
  };
}
