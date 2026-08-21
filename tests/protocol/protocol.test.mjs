import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COORDINATION_CONTRACT_ID,
  COORDINATION_CONTRACT_VERSION,
  ProtocolError,
  assertSafePayload,
  createCliClient,
  ownershipOverlap,
  validateAttemptReport,
  validateWorkPacket,
} from '../../continuity/scripts/lib/protocol/index.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function walk(directory, relative = '') {
  const files = [];
  for (const name of readdirSync(directory, { withFileTypes: true })) {
    const portable = relative ? `${relative}/${name.name}` : name.name;
    const absolute = path.join(directory, name.name);
    if (name.isDirectory()) files.push(...walk(absolute, portable));
    else if (name.name.endsWith('.mjs')) files.push({ portable, absolute });
  }
  return files;
}

export async function run() {
  assert.equal(COORDINATION_CONTRACT_ID, 'project-memory.coordinator.v1');
  assert.equal(COORDINATION_CONTRACT_VERSION, 1);

  const packet = validateWorkPacket({
    waveId: 'wave-0001',
    packetId: 'packet-abcd1234ef567890',
    actorId: 'actor-exec-01',
    runId: 'run-exec-01',
    goal: 'Ship the core path',
    taskIds: ['task-core-01'],
    allowedPaths: ['src/core'],
    forbiddenPaths: [],
    requiredCapabilities: ['implementation'],
    riskCeiling: 'routine',
    acceptanceCriteria: ['command evidence exists'],
    focusedChecks: ['node -e process.exit(0)'],
    knownFailures: [],
    prohibitedApproaches: ['retry the failed rollback'],
    reportFormat: 'continuity-agent-report-v1',
  });
  assert.equal(packet.packetId, 'packet-abcd1234ef567890');

  assert.throws(() => validateWorkPacket({
    ...packet,
    apiKey: 'secret',
  }), ProtocolError);

  assert.throws(() => assertSafePayload({ token: 'nope' }), /token/);
  assert.throws(() => assertSafePayload({ note: 'sk_live_abcdefghijklmnopqrstuv' }), /secret/);
  assert.equal(ownershipOverlap(['src/core'], ['src/core/lib']), true);
  assert.equal(ownershipOverlap(['src/a'], ['src/b']), false);

  const report = validateAttemptReport({
    status: 'done',
    actorId: 'actor-exec-01',
    runId: 'run-exec-01',
    packetId: 'packet-abcd1234ef567890',
    changedPaths: [],
    unchangedPaths: ['src/core'],
    approach: 'local worker',
    commandsExecuted: ['node -e process.exit(0)'],
    testCounts: { found: 1, executed: 1, passed: 1, failed: 0, skipped: 0 },
    evidence: [],
    failures: [],
    limitations: [],
    prohibitedApproachesLearned: [],
    exactNextStep: 'Record evidence',
  });
  assert.equal(report.status, 'done');

  const client = createCliClient();
  assert.equal(typeof client.inspectReady, 'function');
  assert.equal(typeof client.registerAgent, 'function');

  const skillScripts = path.join(repoRoot, 'continuity', 'scripts', 'lib');
  const files = walk(skillScripts);
  const coreFiles = files.filter((file) => file.portable.startsWith('core/'));
  for (const file of coreFiles) {
    const source = readFileSync(file.absolute, 'utf8');
    assert.equal(/lib\/coordinator\//.test(source) || /from '\.\.\/coordinator/.test(source), false, file.portable);
  }
  const continuityAdapter = files.find((file) => file.portable === 'continuity/index.mjs');
  const continuitySource = readFileSync(continuityAdapter.absolute, 'utf8');
  assert.equal(continuitySource.includes('coordinator/adapters'), false);
}
