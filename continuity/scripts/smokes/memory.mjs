#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(skillRoot, 'scripts', 'continuity.mjs');

function fail(message) {
  process.stderr.write(`memory-smoke: ${message}\n`);
  process.exit(1);
}

const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
if (version.status !== 0 || !version.stdout.includes('continuity 2.0.0')) {
  fail(`--version failed: ${version.stderr}`);
}

const root = mkdtempSync(path.join(os.tmpdir(), 'continuity-memory-smoke-'));
try {
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Smoke']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'smoke@example.invalid']);
  writeFileSync(path.join(root, 'README.md'), '# smoke\n');
  execFileSync('git', ['-C', root, 'add', 'README.md']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'smoke']);
  const doctor = spawnSync(process.execPath, [cli, 'doctor', '--root', root], { encoding: 'utf8' });
  if (doctor.status !== 0 || !doctor.stdout.includes('journal=uninitialized')) {
    fail(`doctor failed: ${doctor.stderr || doctor.stdout}`);
  }
  const coordinator = path.join(skillRoot, 'scripts', 'coordinator.mjs');
  const coord = spawnSync(process.execPath, [coordinator, '--version'], { encoding: 'utf8' });
  if (coord.status === 0) {
    process.stdout.write('memory-smoke: coordinator CLI present but unused\n');
  }
  process.stdout.write('memory-smoke: PASS\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}
