import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeRepository(label) {
  const root = mkdtempSync(path.join(os.tmpdir(), `project-memory-v2-${label}-`));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Continuity Fixture']);
  writeFileSync(path.join(root, 'README.md'), '# Synthetic fixture\n');
  execFileSync('git', ['-C', root, 'add', 'README.md']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
  return root;
}

export function runCli(helper, root, args, input) {
  return spawnSync(process.execPath, [helper, '--root', root, ...args], {
    encoding: 'utf8', input, env: { ...process.env, NO_COLOR: '1' }, maxBuffer: 1024 * 1024,
  });
}
