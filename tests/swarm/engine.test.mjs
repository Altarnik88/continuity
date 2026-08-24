import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildDispatchPacket, buildRoster, clampSwarmSize, isBlindKind, leaseConflict, pathsOverlap } from '../../continuity/scripts/lib/swarm/contract.mjs';
import { launchSwarm } from '../../continuity/scripts/lib/swarm/engine.mjs';

export async function run() {
  assert.equal(clampSwarmSize(3), 5);
  assert.equal(clampSwarmSize(21), 20);
  assert.equal(buildRoster(8).length, 8);
  assert.ok(buildRoster(8).some((agent) => agent.role === 'verifier'));
  assert.ok(buildRoster(8).some((agent) => agent.role === 'analyst'));
  assert.ok(buildRoster(8).some((agent) => agent.role === 'security'));
  assert.ok(buildRoster(8).some((agent) => agent.role === 'reviewer'));
  assert.ok(!buildRoster(8).some((agent) => agent.role === 'manager'));
  assert.ok(buildRoster(10).some((agent) => agent.role === 'manager'));
  assert.equal(isBlindKind('test'), true);
  assert.equal(isBlindKind('security'), true);
  assert.equal(isBlindKind('review'), true);
  assert.equal(isBlindKind('write'), false);
  const packet = buildDispatchPacket({
    id: 'task-security',
    title: 'Audit Pulse CLI and HTTP',
    kind: 'security',
    paths: ['forge/SECURITY.md'],
  });
  assert.equal(packet.blind, true);
  assert.match(packet.brief, /Do not read implementer notes/);
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
    assert.ok(done.files.includes('forge/ANALYSIS.md'), 'analysis was missing');
    assert.ok(done.files.includes('forge/SECURITY.md'), 'security note was missing');
    assert.ok(done.files.includes('forge/REVIEW.md'), 'independent review was missing');
    assert.ok(done.files.includes('forge/HANDOFF.md'), 'handoff was missing');
    assert.ok(done.files.includes('forge/MEMORY.md'), 'product memory was missing');
    assert.ok(done.files.includes('forge/src/metrics.mjs'), 'continuation metrics were missing');
    assert.equal(done.counts.failed, 0, `failed tasks: ${done.tasks.filter((task) => task.status === 'failed').map((task) => task.id).join(',')}`);
    assert.ok(done.counts.succeeded >= 18, `expected Pulse plus continuation wave to finish, got ${done.counts.succeeded}`);
    assert.ok(
      done.tasks.filter((task) => ['analyze', 'security', 'review'].includes(task.kind)).every((task) => task.status === 'succeeded'),
      'full-cycle roles did not finish',
    );
    assert.ok(
      done.tasks.filter((task) => task.kind === 'security' || task.kind === 'review').every((task) => task.verifier),
      'security/review must be marked by a verifier, not the writer',
    );
    assert.equal(done.agents.find((agent) => agent.role === 'conductor')?.status, 'watching');
    assert.ok(!done.tasks.some((task) => {
      const agent = done.agents.find((item) => item.id === task.assignee);
      return agent && (agent.role === 'conductor' || agent.role === 'manager');
    }), 'conductor/manager must not take product leases');
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

  const managedRoot = mkdtempSync(path.join(os.tmpdir(), 'continuity-manager-'));
  const managed = launchSwarm({ root: managedRoot, autoStart: true, swarmSize: 10, paceMs: 0 });
  try {
    const done = await managed.waitUntilIdle({ timeoutMs: 45_000 });
    assert.ok(done.agents.some((agent) => agent.role === 'manager'), 'size 10 must appoint a manager');
    assert.equal(done.agents.find((agent) => agent.role === 'manager')?.status, 'watching');
    assert.ok(done.counts.succeeded >= 18);
  } finally {
    managed.stop();
  }
}
