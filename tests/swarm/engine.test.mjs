import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
    assert.equal(done.counts.failed, 0, `failed tasks: ${done.tasks.filter((task) => task.status === 'failed').map((task) => task.id).join(',')}`);
    assert.ok(done.counts.succeeded >= 11, `expected the Pulse wave to finish, got ${done.counts.succeeded}`);
    assert.ok(done.memory.some((item) => item.kind === 'failure'), 'the buggy store should have produced a remembered failure');
    assert.ok(done.memory.some((item) => item.kind === 'playbook'), 'passing verification should record a playbook');
    assert.equal(done.mission.accepted, 'pending');
    swarm.accept();
    assert.equal(swarm.getSnapshot().mission.accepted, 'accepted');
  } finally {
    swarm.stop();
  }
}
