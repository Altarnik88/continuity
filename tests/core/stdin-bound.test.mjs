import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryError } from '../../continuity/scripts/lib/core/domain-v2.mjs';
import { MAX_INPUT_BYTES, readStdinBounded } from '../../continuity/scripts/lib/core/cli.mjs';

export async function run() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'project-memory-stdin-bound-'));
  let fd;
  try {
    const input = path.join(root, 'oversized.json');
    writeFileSync(input, Buffer.alloc(MAX_INPUT_BYTES + 1, 0x41));
    fd = openSync(input, 'r');
    assert.throws(() => readStdinBounded(fd), (error) => error instanceof MemoryError && /size limit/.test(error.message));
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
}
