#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildReleaseArtifacts } from './package-release.mjs';
import { filesForProfile } from './release-profiles.mjs';
import { inventoryFromWorktree } from './package-inventory.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const dest = mkdtempSync(path.join(os.tmpdir(), 'continuity-release-'));
try {
  const { artifacts, manifest, sums } = buildReleaseArtifacts(repoRoot, dest);
  assert.equal(artifacts.length, 3);
  assert.equal(manifest.contractId, 'project-memory.coordinator.v1');
  const names = artifacts.map((item) => item.name).sort();
  assert.deepEqual(names, [
    'continuity-coordinator-1.0.0.zip',
    'continuity-full-1.0.0.zip',
    'continuity-memory-1.0.0.zip',
  ]);
  const memory = artifacts.find((item) => item.profile === 'memory');
  const coordinator = artifacts.find((item) => item.profile === 'coordinator');
  const full = artifacts.find((item) => item.profile === 'full');
  assert.equal(memory.files.some((file) => file.includes('/coordinator/')), false);
  assert.equal(coordinator.files.some((file) => file.includes('/lib/core/')), false);
  assert.ok(full.files.includes('continuity/scripts/continuity.mjs'));
  assert.ok(full.files.includes('continuity/scripts/coordinator.mjs'));
  const writtenSums = readFileSync(path.join(dest, 'SHA256SUMS'), 'utf8').trim();
  assert.equal(writtenSums, sums);
  const inventory = inventoryFromWorktree(repoRoot);
  assert.deepEqual(filesForProfile(inventory.all, 'memory'), memory.files);

  const install = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'install.mjs'),
    '--profile', 'memory',
    '--dest', path.join(dest, 'install-memory'),
    '--dry-run',
  ], { encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /dry-run=ok/);
  assert.match(install.stdout, /destination=/);

  for (const profile of ['memory', 'coordinator', 'full']) {
    const smokeName = profile === 'full' ? 'full.mjs' : `${profile}.mjs`;
    const smoke = spawnSync(process.execPath, [
      path.join(repoRoot, 'continuity', 'scripts', 'smokes', smokeName),
    ], { encoding: 'utf8' });
    assert.equal(smoke.status, 0, `${profile} smoke failed: ${smoke.stderr}`);
  }
  console.log(`release tests: PASS (artifacts=3 memory=${memory.files.length} coordinator=${coordinator.files.length} full=${full.files.length})`);
} finally {
  rmSync(dest, { recursive: true, force: true });
}
