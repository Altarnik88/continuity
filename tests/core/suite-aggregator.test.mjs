import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SUITE_NAMES, SuiteSelectionError, suiteFiles } from '../helpers/suite-aggregator.mjs';

export async function run() {
  assert.deepEqual(SUITE_NAMES, ['core', 'migration', 'continuity', 'graphify', 'protocol', 'coordinator']);
  const root = mkdtempSync(path.join(os.tmpdir(), 'project-memory-suite-contract-'));
  try {
    mkdirSync(path.join(root, 'migration'));
    assert.throws(() => suiteFiles(root, 'migration'), (error) => error instanceof SuiteSelectionError && error.reason === 'empty');
    assert.throws(() => suiteFiles(root, 'unknown'), (error) => error instanceof SuiteSelectionError && error.reason === 'unknown');
    mkdirSync(path.join(root, 'core', 'nested'), { recursive: true });
    writeFileSync(path.join(root, 'core', 'nested', 'public.test.mjs'), 'export async function run() {}\n');
    assert.deepEqual(suiteFiles(root, 'core'), [path.join(root, 'core', 'nested', 'public.test.mjs')]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
