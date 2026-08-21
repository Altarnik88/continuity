#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function run(script) {
  const result = spawnSync(process.execPath, [path.join(skillRoot, 'scripts', 'smokes', script)], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
  process.stdout.write(result.stdout);
}

run('memory.mjs');
run('coordinator.mjs');
const protocol = await import(pathToFileURL(path.join(skillRoot, 'scripts', 'lib', 'protocol', 'compatibility.mjs')).href);
if (protocol.COORDINATION_CONTRACT_ID !== 'project-memory.coordinator.v1') {
  process.stderr.write('full-smoke: protocol compatibility id changed\n');
  process.exit(1);
}
process.stdout.write('full-smoke: PASS\n');
