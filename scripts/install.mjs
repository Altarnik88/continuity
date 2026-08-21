#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inventoryFromWorktree } from './package-inventory.mjs';
import { PROFILE_NAMES, filesForProfile } from './release-profiles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  process.stderr.write(`install: ${message}\n`);
  process.exit(2);
}

function parse(argv) {
  const options = {
    profile: 'full',
    dest: null,
    dryRun: false,
    replaceCode: false,
  };
  const args = [...argv];
  while (args.length) {
    const value = args.shift();
    if (value === '--profile') options.profile = args.shift();
    else if (value === '--dest') options.dest = args.shift();
    else if (value === '--dry-run') options.dryRun = true;
    else if (value === '--replace-code') options.replaceCode = true;
    else fail(`unknown argument ${value}`);
  }
  if (!PROFILE_NAMES.includes(options.profile)) fail('profile must be full, memory, or coordinator');
  if (!options.dest) fail('--dest is required');
  return options;
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function planInstall(repoRoot, { profile, dest }) {
  const inventory = inventoryFromWorktree(repoRoot);
  const files = filesForProfile(inventory.all, profile);
  const resolvedDest = path.resolve(dest);
  return { profile, dest: resolvedDest, files };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = parse(process.argv.slice(2));
  const plan = planInstall(root, options);
  process.stdout.write(`destination=${plan.dest}\nprofile=${plan.profile}\nfiles=${plan.files.length}\n`);
  if (existsSync(plan.dest)) {
    const store = path.join(plan.dest, '.continuity');
    if (existsSync(store)) {
      process.stdout.write('project-data=.continuity preserved\n');
    }
    if (!options.replaceCode) {
      fail(`destination exists; pass --replace-code to replace code files without deleting project data (${plan.dest})`);
    }
  }
  if (options.dryRun) {
    process.stdout.write('dry-run=ok\nrollback=delete the destination directory if this copy has not been used\n');
    process.exit(0);
  }
  const staging = `${plan.dest}.install-tmp`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    for (const file of plan.files) {
      const from = path.join(root, ...file.split('/'));
      const to = path.join(staging, ...file.split('/'));
      mkdirSync(path.dirname(to), { recursive: true });
      cpSync(from, to);
      if (sha256File(from) !== sha256File(to)) fail(`hash mismatch after copy (${file})`);
    }
    if (existsSync(plan.dest) && options.replaceCode) {
      const preserved = existsSync(path.join(plan.dest, '.continuity'));
      const data = preserved ? path.join(staging, '.continuity-preserve') : null;
      if (preserved) cpSync(path.join(plan.dest, '.continuity'), data, { recursive: true });
      rmSync(plan.dest, { recursive: true, force: true });
      cpSync(staging, plan.dest, { recursive: true });
      if (data) {
        cpSync(data, path.join(plan.dest, '.continuity'), { recursive: true });
      }
    } else {
      mkdirSync(path.dirname(plan.dest), { recursive: true });
      cpSync(staging, plan.dest, { recursive: true });
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  process.stdout.write('install=ok\nrollback=remove the destination code copy; do not delete <repo>/.continuity unless you intend to destroy project data\n');
}
