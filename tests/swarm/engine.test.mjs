import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildRoster, clampSwarmSize, leaseConflict, pathsOverlap } from '../../continuity/scripts/lib/swarm/contract.mjs';
import { launchSwarm } from '../../continuity/scripts/lib/swarm/engine.mjs';

export async function run() {
  assert.equal(clampSwarmSize(3), 5);
  assert.equal(clampSwarmSize(21), 20);
  assert.equal(buildRoster(8).length, 8);
  assert.ok(buildRoster(8).some((agent) => agent.role === 'verifier'));
  assert.equal(pathsOverlap(['forge/src'], ['forge/src/store.mjs']), true);
  assert.equal(pathsOverlap(['forge/src/cli.mjs'], ['forge/src/http.mjs']), false);
  assert.equal(
    leaseConflict(
      [{ taskId: 'a', paths: ['forge/src/store.mjs'] }],
      ['forge/src/store.mjs'],
    ),
    true,
  );

  const root = mkdtempSync(path.join(os.tmpdir(), 'continuity-swarm-'));
  const swarm = launchSwarm({ root, autoStart: true, swarmSize: 8, paceMs: 0 });
  try {
    const done = await swarm.waitUntilIdle({ timeoutMs: 45_000 });
    assert.ok(done.files.includes('forge/src/domain.mjs'), 'domain was not written');
    assert.ok(done.files.includes('forge/HANDOFF.md'), 'handoff was missing');
    assert.ok(done.files.includes('forge/MEMORY.md'), 'product memory was missing');
    assert.ok(done.files.includes('forge/src/metrics.mjs'), 'continuation metrics were missing');
    assert.equal(done.counts.failed, 0, `failed tasks: ${done.tasks.filter((task) => task.status === 'failed').map((task) => task.id).join(',')}`);
    assert.ok(done.counts.succeeded >= 15, `expected Pulse plus continuation wave to finish, got ${done.counts.succeeded}`);
    assert.ok(done.maxInflight >= 2, `expected parallel agents, maxInflight=${done.maxInflight}`);
    assert.ok(done.memory.some((item) => item.kind === 'failure'), 'the buggy store should have produced a remembered failure');
    assert.ok(done.memory.some((item) => item.kind === 'playbook'), 'passing verification should record a playbook');
    assert.equal(done.mission.accepted, 'pending');
    assert.equal(done.mission.status, 'waiting_accept');
    assert.ok(existsSync(path.join(root, 'data', 'memory.ndjson')), 'append-only memory log was missing');
    assert.ok(
      readFileSync(path.join(root, 'data', 'memory.ndjson'), 'utf8').trim().split('\n').length >= 4,
      'memory log did not keep lessons across the wave',
    );
    swarm.accept();
    assert.equal(swarm.getSnapshot().mission.accepted, 'accepted');
  } finally {
    swarm.stop();
  }

  const resumed = launchSwarm({ root, autoStart: false, swarmSize: 8, paceMs: 0 });
  try {
    const snap = resumed.getSnapshot();
    assert.ok(snap.memory.length >= 4, 'memory did not survive relaunch');
    assert.ok(snap.files.includes('forge/MEMORY.md'), 'product files did not survive relaunch');
    assert.equal(snap.mission.accepted, 'accepted');
    assert.ok(existsSync(path.join(root, 'data', 'swarm.sqlite')), 'sqlite task database did not survive relaunch');
    assert.ok(existsSync(path.join(root, 'data', 'memory.ndjson')), 'memory log did not survive relaunch');
  } finally {
    resumed.stop();
  }

  assert.equal(buildRoster(5).length, 5);
  assert.equal(buildRoster(20).length, 20);
}
