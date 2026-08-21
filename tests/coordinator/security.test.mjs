import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertSafePayload, rejectPrivatePaths } from '../../continuity/scripts/lib/protocol/index.mjs';
import { createLocalProcessAdapter } from '../../continuity/scripts/lib/coordinator/adapters/local-process.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function walkMjs(directory, relative = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const portable = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkMjs(absolute, portable));
    else if (entry.name.endsWith('.mjs')) files.push({ portable, source: readFileSync(absolute, 'utf8') });
  }
  return files;
}

export async function run() {
  assert.throws(() => rejectPrivatePaths('C:\\Users\\someone\\secret'), /repository-relative/);
  assert.throws(() => rejectPrivatePaths('/etc/passwd'), /repository-relative/);
  assert.throws(() => rejectPrivatePaths('../escape'), /repository-relative/);
  assert.equal(rejectPrivatePaths('src/lib'), 'src/lib');
  assert.throws(() => assertSafePayload({ environmentVariables: { TOKEN: 'x' } }), /environmentVariables/);

  const coordinatorFiles = walkMjs(path.join(repoRoot, 'continuity', 'scripts', 'lib', 'coordinator'));
  for (const file of coordinatorFiles) {
    assert.equal(file.source.includes('../core/journal-v3.mjs'), false, file.portable);
    assert.equal(file.source.includes('../core/store.mjs'), false, file.portable);
    assert.equal(file.source.includes('../core/recipes-v3.mjs'), false, file.portable);
    assert.equal(/HISTORY\.ndjson/.test(file.source) && file.portable.includes('engine'), false, file.portable);
  }

  const adapter = createLocalProcessAdapter();
  const health = adapter.healthCheck();
  assert.equal(health.ok, true);
  assert.equal(health.live, true);
  const rejected = adapter.launchAssignment({
    assignmentId: 'assignment-bad',
    actorId: 'actor-exec-01',
    runId: 'run-exec-01',
    root: repoRoot,
    packet: {
      packetId: 'packet-bad000000000001',
      waveId: 'wave-bad000000000001',
      taskIds: ['task-bad'],
    },
    command: ['cmd.exe', '/c', 'echo hi'],
  });
  assert.equal(rejected.report.status, 'failed');
  assert.match(rejected.report.failures.join(' '), /Node\.js binary|metacharacters|rejected/i);
}
