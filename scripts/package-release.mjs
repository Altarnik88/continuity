#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inventoryFromWorktree } from './package-inventory.mjs';
import { PROFILE_NAMES, RELEASE_VERSION, filesForProfile } from './release-profiles.mjs';
import { buildStoredZip, fileEntry, sha256 } from './zip-store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function gitSha() {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'uncommitted';
  }
}

export function buildReleaseArtifacts(repoRoot = root, dest) {
  const inventory = inventoryFromWorktree(repoRoot);
  const sourceCommit = gitSha();
  const builtAt = '1970-01-01T00:00:00.000Z';
  const artifacts = [];
  for (const profile of PROFILE_NAMES) {
    const files = filesForProfile(inventory.all, profile).sort();
    if (!files.length) throw new Error(`profile ${profile} selected no files`);
    if (profile === 'memory' && files.some((file) => file.includes('/coordinator/'))) {
      throw new Error('memory artifact must not include Coordinator runtime');
    }
    if (profile === 'coordinator' && files.some((file) => file.includes('/lib/core/'))) {
      throw new Error('coordinator artifact must not include Core journal implementation');
    }
    const entries = files.map((file) => fileEntry(repoRoot, file));
    const zip = buildStoredZip(entries);
    const name = `continuity-${profile}-${RELEASE_VERSION}.zip`;
    artifacts.push({
      profile,
      name,
      files,
      bytes: zip.length,
      sha256: sha256(zip),
      zip,
    });
  }
  const manifest = {
    version: RELEASE_VERSION,
    sourceCommit,
    builtAt,
    contractId: 'project-memory.coordinator.v1',
    supportedNode: ['22', '24'],
    supportedPlatforms: ['win32', 'linux', 'darwin'],
    artifacts: artifacts.map((item) => ({
      profile: item.profile,
      name: item.name,
      sha256: item.sha256,
      bytes: item.bytes,
      files: item.files,
    })),
  };
  const sums = artifacts.map((item) => `${item.sha256}  ${item.name}`).join('\n');
  if (dest) {
    mkdirSync(dest, { recursive: true });
    for (const artifact of artifacts) {
      writeFileSync(path.join(dest, artifact.name), artifact.zip);
    }
    writeFileSync(path.join(dest, 'SHA256SUMS'), `${sums}\n`);
    writeFileSync(path.join(dest, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { artifacts, manifest, sums };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dest = path.resolve(process.argv[2] || path.join(root, 'dist'));
  const { artifacts } = buildReleaseArtifacts(root, dest);
  for (const artifact of artifacts) {
    console.log(`${artifact.name} ${artifact.sha256} ${artifact.files.length} files`);
  }
  console.log(`release artifacts: ${dest}`);
}
