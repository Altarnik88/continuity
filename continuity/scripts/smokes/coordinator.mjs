#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(skillRoot, 'scripts', 'coordinator.mjs');

function fail(message) {
  process.stderr.write(`coordinator-smoke: ${message}\n`);
  process.exit(1);
}

const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
if (version.status !== 0 || !version.stdout.includes('continuity-coordinator 3.0.0')) {
  fail(`--version failed: ${version.stderr}`);
}
const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
if (help.status !== 0 || !help.stdout.includes('usage: coordinator.mjs')) {
  fail(`--help failed: ${help.stderr}`);
}
if (/daemon|watcher|login task/i.test(help.stdout) && !help.stdout.includes('never starts a daemon')) {
  fail('help must deny daemon startup');
}
process.stdout.write('coordinator-smoke: PASS\n');
