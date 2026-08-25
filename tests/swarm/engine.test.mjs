import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startControlSurface } from '../../continuity/scripts/control-surface.mjs';
import {
  buildDispatchPacket,
  buildRoster,
  clampSwarmSize,
  isBlindKind,
  leaseConflict,
  pathsOverlap,
  selectDispatchWave,
} from '../../continuity/scripts/lib/swarm/contract.mjs';
import { createEngine, launchSwarm } from '../../continuity/scripts/lib/swarm/engine.mjs';
import { acquireEngineLock } from '../../continuity/scripts/lib/swarm/lock.mjs';
import { insertTask } from '../../continuity/scripts/lib/swarm/store.mjs';
import { makeRepository, runCli } from '../helpers/repository.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dispatchJs = path.join(repoRoot, 'continuity', 'scripts', 'dispatch.mjs');
const launchJs = path.join(repoRoot, 'continuity', 'scripts', 'launch.mjs');
const engineJs = path.join(repoRoot, 'continuity', 'scripts', 'lib', 'swarm', 'engine.mjs');
const continuityCli = path.join(repoRoot, 'continuity', 'scripts', 'continuity.mjs');
const initTemplate = path.join(repoRoot, 'continuity', 'assets', 'init-v3.template.json');
const LOCK_TTL_MS = 30 * 60 * 1000;

export async function run() {
  assertContractHelpers();
  const failed = [];
  const checks = [
    ['empty-dispatch-no-eval', assertEmptyDispatchHasNoEvalFallback],
    ['second-engine-preserves-live-leases', assertLiveEngineLockDoesNotDropForeignLeases],
    ['accept-is-not-user-accept', assertAcceptIsNotUserAccept],
    ['create-engine-no-pulse-without-journal-goal', assertCreateEngineDoesNotSeedPulseWithoutJournalGoal],
  ];
  for (const [name, check] of checks) {
    try {
      await check();
    } catch {
      failed.push(name);
    }
  }
  assert.equal(failed.length, 0, failed.join(','));
}

function assertContractHelpers() {
  assert.equal(clampSwarmSize(3), 5);
  assert.equal(clampSwarmSize(21), 20);
  assert.equal(buildRoster(8).length, 8);
  assert.ok(buildRoster(8).some((agent) => agent.role === 'verifier'));
  assert.ok(buildRoster(8).some((agent) => agent.role === 'analyst'));
  assert.ok(buildRoster(8).some((agent) => agent.role === 'security'));
  assert.ok(buildRoster(8).some((agent) => agent.role === 'reviewer'));
  assert.ok(!buildRoster(8).some((agent) => agent.role === 'manager'));
  assert.ok(buildRoster(10).some((agent) => agent.role === 'manager'));
  assert.equal(buildRoster(5).length, 5);
  assert.equal(buildRoster(20).length, 20);
  assert.ok(!buildRoster(20).some((agent) => agent.role === 'integrator'));
  assert.equal(pathsOverlap(['Forge/src.mjs'], ['forge/src.mjs']), true);
  assert.equal(pathsOverlap(['src-old'], ['src']), false);
  assert.equal(isBlindKind('test'), true);
  assert.equal(isBlindKind('security'), true);
  assert.equal(isBlindKind('review'), true);
  assert.equal(isBlindKind('write'), false);
  const packet = buildDispatchPacket({
    id: 'task-security',
    title: 'Audit control surface and lock recovery',
    kind: 'security',
    paths: ['src/lock.mjs'],
  });
  assert.equal(packet.blind, true);
  assert.match(packet.brief, /Do not read implementer notes/);
  assert.match(packet.brief, /HANDOFF\.md/);
  assert.ok(packet.forbiddenPaths.includes('forge/MEMORY.md'));
  assert.equal(pathsOverlap(['src'], ['src/store.mjs']), true);
  assert.equal(pathsOverlap(['src/cli.mjs'], ['src/http.mjs']), false);
  assert.equal(
    leaseConflict(
      [{ taskId: 'a', paths: ['src/store.mjs'] }],
      ['src/store.mjs'],
    ),
    true,
  );
  assert.equal(
    selectDispatchWave([
      { id: 'ready-a', priority: 1, paths: ['src/a.mjs'] },
      { id: 'ready-b', priority: 2, paths: ['src/a.mjs'] },
      { id: 'ready-c', priority: 3, paths: ['src/c.mjs'] },
    ]).map((task) => task.id).join(','),
    'ready-a,ready-c',
  );
}

async function assertEmptyDispatchHasNoEvalFallback() {
  const emptyRoot = mkdtemp('dispatch-empty-');
  const emptyReport = runDispatch(emptyRoot);
  assertDispatchExhausted(emptyReport);

  const exhaustedRoot = mkdtemp('dispatch-exhausted-');
  const engine = createEngine({ root: exhaustedRoot, autoStart: false, paceMs: 0 });
  try {
    engine.start();
    const snap = engine.getSnapshot();
    assert.equal(snap.wave.length, 0);
    assert.ok((snap.tasks ?? []).every((task) => task.status !== 'ready'));
  } finally {
    engine.stop();
  }
  assertDispatchExhausted(runDispatch(exhaustedRoot));
}

async function assertLiveEngineLockDoesNotDropForeignLeases() {
  const heldRoot = mkdtemp('lock-held-');
  const first = acquireEngineLock(heldRoot);
  try {
    assert.throws(() => acquireEngineLock(heldRoot), /engine-already-live/);
  } finally {
    first.release();
  }

  const liveRoot = mkdtemp('lock-live-pid-');
  writeLock(liveRoot, { pid: process.pid, acquiredAt: new Date().toISOString() });
  assert.throws(() => acquireEngineLock(liveRoot), /engine-already-live/);

  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  try {
    const foreignRoot = mkdtemp('lock-foreign-pid-');
    writeLock(foreignRoot, { pid: sleeper.pid, acquiredAt: new Date().toISOString() });
    assert.throws(() => acquireEngineLock(foreignRoot), /engine-already-live/);
  } finally {
    sleeper.kill();
  }

  const opaqueRoot = mkdtemp('lock-opaque-');
  writeLock(opaqueRoot, { pid: 0, acquiredAt: new Date().toISOString() });
  assert.throws(() => acquireEngineLock(opaqueRoot), /engine-already-live/);

  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  const esrchRoot = mkdtemp('lock-esrch-');
  writeLock(esrchRoot, { pid: dead.pid, acquiredAt: new Date().toISOString() });
  const recoveredDead = acquireEngineLock(esrchRoot);
  recoveredDead.release();

  const ttlRoot = mkdtemp('lock-ttl-');
  writeLock(ttlRoot, {
    pid: 0,
    acquiredAt: new Date(Date.now() - LOCK_TTL_MS - 60_000).toISOString(),
  });
  const recoveredTtl = acquireEngineLock(ttlRoot);
  recoveredTtl.release();

  const leaseRoot = mkdtemp('lock-leases-');
  const engine = createEngine({ root: leaseRoot, autoStart: false, paceMs: 0 });
  const lock = acquireEngineLock(leaseRoot);
  try {
    insertHeldLease(engine, 'task-held', 'src/held.mjs');
    assert.equal(heldLeaseCount(engine), 1);

    const launched = spawnSync(process.execPath, [launchJs, '--paused', '--port', String(await freePort())], {
      cwd: leaseRoot,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.notEqual(launched.status, 0);
    assert.match(String(launched.stderr || launched.stdout), /engine-already-live/);
    assert.equal(heldLeaseCount(engine), 1, 'launch over a live lock must not drop leases');

    const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCreateEngineScript(leaseRoot)], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.equal(child.status, 0, 'second createEngine must not delete another process live leases');
    assert.equal(heldLeaseCount(engine), 1, 'parent leases must survive a second createEngine');
  } finally {
    try { engine.stop(); } catch { /* closed */ }
    lock.release();
  }
}

async function assertAcceptIsNotUserAccept() {
  const repo = makeRepository('swarm-accept');
  const init = runCli(continuityCli, repo, ['init', '--schema', '3', '--file', initTemplate]);
  assert.equal(init.status, 0, 'temp store init failed');
  const before = inspectReady(repo);
  assert.equal(before.userAcceptance, 'pending');

  const engine = createEngine({ root: repo, autoStart: false, paceMs: 0 });
  const port = await freePort();
  const surface = await startControlSurface(engine, { port });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/swarm/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'accept' }),
    });
    assert.notEqual(response.status, 200);
    const body = await response.json();
    assert.ok(body.error, 'accept action must not be treated as user accept');

    if (typeof engine.accept === 'function') {
      engine.accept();
    } else {
      assert.equal(typeof engine.accept, 'undefined');
    }

    const snap = engine.getSnapshot();
    assert.notEqual(snap.mission?.accepted, 'user');
    const after = inspectReady(repo);
    assert.equal(after.userAcceptance, 'pending');
    assert.ok(!journalHasUserAccept(repo), 'mission.accepted is not Continuity accept');
  } finally {
    await closeServer(surface.server);
    engine.stop();
  }
}

async function assertCreateEngineDoesNotSeedPulseWithoutJournalGoal() {
  const root = mkdtemp('no-pulse-');
  const engine = createEngine({ root, autoStart: false, paceMs: 0 });
  try {
    assertNoPulseScaffold(engine.getSnapshot(), root);
  } finally {
    engine.stop();
  }

  const launched = launchSwarm({ root, autoStart: false, swarmSize: 8, paceMs: 0 });
  try {
    launched.start();
    const snap = launched.getSnapshot();
    assertNoPulseScaffold(snap, root);
    assert.ok((snap.counts?.succeeded ?? 0) < 18);
  } finally {
    launched.stop();
  }
}

function assertNoPulseScaffold(snap, root) {
  const tasks = snap.tasks ?? [];
  assert.ok(
    !tasks.some((task) => /pulse|task-scaffold|scaffold/i.test(`${task.id} ${task.title}`)),
    'createEngine must not insert Pulse or task-scaffold without a journal goal',
  );
  assert.equal(existsSync(path.join(root, 'forge')), false);
  assert.ok(!(snap.files ?? []).some((file) => String(file).startsWith('forge/')));
}

function assertDispatchExhausted(report) {
  assert.deepEqual(report.wave, []);
  assert.equal(report.fallback, false);
  assert.ok(!JSON.stringify(report).includes('eval-'));
  assert.ok(!(report.wave ?? []).some((item) => /^eval-/.test(String(item.id ?? item.taskId ?? ''))));
}

function runDispatch(cwd) {
  const result = spawnSync(process.execPath, [dispatchJs, '--port', '1'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(result.status, 0, 'dispatch must exit 0');
  return JSON.parse(result.stdout);
}

function insertHeldLease(engine, taskId, filePath) {
  insertTask(engine.db, {
    id: taskId,
    title: 'Held path lease',
    kind: 'write',
    priority: 1,
    paths: [filePath],
    deps: [],
    spec: {},
  }, () => new Date());
  engine.db.prepare("UPDATE tasks SET status = 'running', assignee = ? WHERE id = ?").run('agent-exec-1', taskId);
  engine.db.prepare('INSERT INTO leases (path, agent_id, task_id, created_at) VALUES (?, ?, ?, ?)').run(
    filePath,
    'agent-exec-1',
    taskId,
    new Date().toISOString(),
  );
}

function heldLeaseCount(engine) {
  return (engine.getSnapshot().leases ?? []).filter((lease) => (
    lease.task_id === 'task-held' && lease.path === 'src/held.mjs'
  )).length;
}

function childCreateEngineScript(root) {
  return `
    import { createEngine } from ${JSON.stringify(pathToFileURL(engineJs).href)};
    let wiped = false;
    try {
      const engine = createEngine({ root: ${JSON.stringify(root)}, autoStart: false, paceMs: 0 });
      try {
        const leases = engine.getSnapshot().leases ?? [];
        wiped = !leases.some((lease) => lease.task_id === 'task-held' && lease.path === 'src/held.mjs');
      } finally {
        engine.stop();
      }
    } catch {
      wiped = false;
    }
    process.exit(wiped ? 2 : 0);
  `;
}

function writeLock(root, record) {
  const file = path.join(root, 'data', 'engine.lock');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record)}\n`);
}

function inspectReady(root) {
  const result = spawnSync(process.execPath, [continuityCli, 'inspect', 'ready', '--json', '--root', root], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(result.status, 0, 'inspect ready failed');
  return JSON.parse(result.stdout);
}

function journalHasUserAccept(root) {
  const history = readFileSync(path.join(root, '.continuity', 'HISTORY.ndjson'), 'utf8');
  return /"type":"acceptance\.recorded"|record accept/.test(history);
}

function mkdtemp(label) {
  return mkdtempSync(path.join(os.tmpdir(), label));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
