import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { swarmDataDirectory } from './store.mjs';

const LOCK_NAME = 'engine.lock';
const LOCK_TTL_MS = 30 * 60 * 1000;

export function acquireEngineLock(root) {
  const directory = swarmDataDirectory(root);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, LOCK_NAME);
  reclaimStaleLock(file);
  const fd = writeExclusiveLock(file);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try { unlinkSync(file); } finally {
        try { closeSync(fd); } catch { /* lock fd */ }
      }
    },
  };
}

function reclaimStaleLock(file) {
  if (!existsSync(file)) return;
  const record = readLockRecord(file);
  if (isLivePid(record?.pid)) {
    throw new Error('engine-already-live');
  }
  if (isDeadPid(record?.pid) || isExpired(record, file)) {
    try { unlinkSync(file); } catch { /* steal stale lock */ }
    return;
  }
  throw new Error('engine-already-live');
}

function writeExclusiveLock(file) {
  let fd;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('engine-already-live');
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }));
    fsyncSync(fd);
    return fd;
  } catch (error) {
    try { closeSync(fd); } catch { /* lock fd */ }
    try { unlinkSync(file); } catch { /* best-effort */ }
    throw error;
  }
}

function readLockRecord(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function isLivePid(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function isDeadPid(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

function isExpired(record, file) {
  const stamp = record?.acquiredAt ?? record?.ts;
  const parsed = typeof stamp === 'number' ? stamp : Date.parse(stamp);
  if (Number.isFinite(parsed)) return Date.now() - parsed > LOCK_TTL_MS;
  try {
    return Date.now() - statSync(file).mtimeMs > LOCK_TTL_MS;
  } catch {
    return false;
  }
}
