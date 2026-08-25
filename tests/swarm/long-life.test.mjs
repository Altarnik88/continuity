import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createEngine } from '../../continuity/scripts/lib/swarm/engine.mjs';
import { acquireEngineLock } from '../../continuity/scripts/lib/swarm/lock.mjs';
import { pathsOverlap } from '../../continuity/scripts/lib/swarm/contract.mjs';
import { planContinuations, planFromGoal } from '../../continuity/scripts/lib/swarm/planner.mjs';
import { insertTask } from '../../continuity/scripts/lib/swarm/store.mjs';
import { makeRepository, runCli } from '../helpers/repository.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dispatchJs = path.join(repoRoot, 'continuity', 'scripts', 'dispatch.mjs');
const engineJs = path.join(repoRoot, 'continuity', 'scripts', 'lib', 'swarm', 'engine.mjs');
const continuityCli = path.join(repoRoot, 'continuity', 'scripts', 'continuity.mjs');
const initTemplate = path.join(repoRoot, 'continuity', 'assets', 'init-v3.template.json');

const CASES = [
  ['live-leases-survive-second-createEngine', assertLiveLeasesSurviveSecondCreateEngine],
  ['dispatch-exhausted-no-eval', assertExhaustedDispatchHasNoEval],
  ['empty-write-not-auto-succeeded', assertEmptyWriteIsNotSucceeded],
  ['planner-is-not-pulse', assertPlannerIsNotPulse],
  ['case-fold-leases', assertCaseFoldLeases],
  ['waiting-accept-no-new-function', assertWaitingAcceptAddsNoFunction],
  ['http-accept-does-not-write-core', assertHttpAcceptDoesNotWriteCore],
  ['supervisor-host-packet', assertSupervisorHostPacket],
];

export async function run() {
  const failed = [];
  for (const [name, check] of CASES) {
    try {
      await check();
      console.log(`long-life swarm ${name}: PASS`);
    } catch (error) {
      failed.push(name);
      console.log(`long-life swarm ${name}: FAIL ${error.message}`);
    }
  }
  assert.equal(failed.length, 0, failed.join(','));
}

function isPulseNamed(task) {
  return /pulse/i.test(`${task?.id ?? ''} ${task?.taskId ?? ''} ${task?.title ?? ''}`);
}

function hasEvalToken(value) {
  return /eval-/.test(typeof value === 'string' ? value : JSON.stringify(value ?? {}));
}

async function assertLiveLeasesSurviveSecondCreateEngine() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'long-life-leases-'));
  const first = createEngine({ root, autoStart: false, paceMs: 0 });
  const lock = acquireEngineLock(root);
  try {
    insertHeldLease(first, 'task-held', 'src/held.mjs');
    assert.equal(heldLeaseCount(first), 1, 'fixture lease must exist before the second engine');

    const second = createEngine({ root, autoStart: false, paceMs: 0 });
    try {
      assert.equal(heldLeaseCount(first), 1, 'same-process second createEngine must not drop live leases');
      assert.ok(
        (second.getSnapshot().leases ?? []).some((lease) => (
          lease.task_id === 'task-held' && lease.path === 'src/held.mjs'
        )),
        'second createEngine snapshot must still list the live lease',
      );
    } finally {
      try { second.stop(); } catch { /* closed */ }
    }

    const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCreateEngineScript(root)], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.equal(child.status, 0, `second-process createEngine must not drop live leases: ${child.stderr || child.stdout}`);
    assert.equal(heldLeaseCount(first), 1, 'parent live leases must survive a second-process createEngine');
  } finally {
    try { first.stop(); } catch { /* closed */ }
    try { lock.release(); } catch { /* released */ }
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertExhaustedDispatchHasNoEval() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'long-life-dispatch-'));
  const engine = createEngine({ root, autoStart: false, paceMs: 0 });
  try {
    engine.start();
    const snap = engine.getSnapshot();
    assert.ok((snap.tasks ?? []).every((task) => task.status !== 'ready'), 'exhausted engine must have no ready work');
  } finally {
    engine.stop();
  }

  const result = spawnSync(process.execPath, [dispatchJs, '--port', '1'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(result.status, 0, `dispatch.mjs must exit 0 after work is exhausted: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.wave, []);
  assert.equal(report.fallback, false);
  assert.equal(hasEvalToken(report), false, 'exhausted dispatch must not print eval-*');
  rmSync(root, { recursive: true, force: true });
}

async function assertEmptyWriteIsNotSucceeded() {
  const emptyRoot = mkdtempSync(path.join(os.tmpdir(), 'long-life-empty-write-'));
  const engine = createEngine({ root: emptyRoot, autoStart: false, paceMs: 0 });
  try {
    insertTask(engine.db, {
      id: 'task-empty-write',
      title: 'Empty spec.files write',
      kind: 'write',
      priority: 1,
      paths: ['src/empty.mjs'],
      deps: [],
      spec: { files: {} },
    }, () => new Date());
    engine.start();
    const task = await waitForTask(engine, 'task-empty-write');
    assert.ok(task, 'empty spec.files write task must exist');
    assert.notEqual(
      task.status,
      'succeeded',
      'empty spec.files write must not be succeeded after start/tick; Host Task did not run',
    );
  } finally {
    try { engine.stop(); } catch { /* closed */ }
    rmSync(emptyRoot, { recursive: true, force: true });
  }

  const repo = makeRepository('long-life-journal-write');
  try {
    const init = runCli(continuityCli, repo, ['init', '--schema', '3', '--file', initTemplate]);
    assert.equal(init.status, 0, init.stderr);
    const journalEngine = createEngine({ root: repo, autoStart: false, paceMs: 0 });
    try {
      journalEngine.start();
      await sleep(400);
      const writes = (journalEngine.getSnapshot().tasks ?? []).filter((task) => task.kind === 'write');
      assert.ok(writes.length >= 1, 'journal goal must plan at least one write task');
      for (const task of writes) {
        const files = task.spec?.files ?? {};
        const emptyCraft = !files || Object.keys(files).length === 0;
        if (emptyCraft) {
          assert.notEqual(
            task.status,
            'succeeded',
            `journal-planned ${task.id} with empty spec.files must not be succeeded after start/tick; Host Task did not run`,
          );
        }
      }
      assert.ok(
        writes.every((task) => task.status !== 'succeeded'),
        'journal-planned write must not be succeeded after engine start/tick; Host Task did not run',
      );
    } finally {
      try { journalEngine.stop(); } catch { /* closed */ }
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

async function assertPlannerIsNotPulse() {
  assert.deepEqual(planFromGoal(null), []);
  assert.deepEqual(planFromGoal(undefined), []);

  const dummyGoal = {
    goal: { goalId: 'goal-dummy', title: 'Dummy journal goal', isFinal: true, criterionIds: ['criterion-dummy'] },
    goals: [{ goalId: 'goal-dummy', title: 'Dummy journal goal', isFinal: true }],
    criteria: [{ criterionId: 'criterion-dummy', condition: 'truth' }],
  };
  const fromDummy = planFromGoal(dummyGoal);
  assert.ok(!fromDummy.some(isPulseNamed), 'planFromGoal must not enqueue Pulse-named tasks for a dummy journal goal');

  const withoutGoal = planContinuations({
    tasks: [{ id: 'task-handoff', title: 'Write the session handoff', status: 'succeeded' }],
  });
  assert.ok(!withoutGoal.some(isPulseNamed), 'planContinuations must not enqueue Pulse-named tasks');

  const withDummyGoal = planContinuations({
    ...dummyGoal,
    tasks: [{ id: 'task-handoff', title: 'Write the session handoff', status: 'succeeded' }],
  });
  assert.ok(
    !withDummyGoal.some(isPulseNamed),
    'planContinuations must not enqueue Pulse-named tasks when a dummy journal goal is present',
  );
  assert.equal(hasEvalToken(withDummyGoal), false);
}

async function assertCaseFoldLeases() {
  assert.equal(pathsOverlap(['Forge/src.mjs'], ['forge/src.mjs']), true);
  const root = mkdtempSync(path.join(os.tmpdir(), 'long-life-casefold-'));
  const engine = createEngine({ root, autoStart: false, paceMs: 0 });
  try {
    insertHeldLease(engine, 'task-held', 'Forge/src.mjs');
    insertTask(engine.db, {
      id: 'task-fold-other',
      title: 'Overlapping folded path',
      kind: 'write',
      priority: 1,
      paths: ['forge/src.mjs'],
      deps: [],
      spec: { files: { 'forge/src.mjs': 'src/domain.mjs' } },
    }, () => new Date());
    engine.db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run('task-fold-other');
    engine.start();
    await sleep(200);
    const other = engine.getSnapshot().tasks.find((task) => task.id === 'task-fold-other');
    assert.notEqual(other?.status, 'running', 'case-folded lease must block the second owner');
    assert.notEqual(other?.status, 'succeeded');
  } finally {
    try { engine.stop(); } catch { /* closed */ }
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertWaitingAcceptAddsNoFunction() {
  const next = planContinuations({
    mission: { status: 'waiting_accept' },
    tasks: [{ id: 'task-handoff', title: 'Write the session handoff', status: 'succeeded', kind: 'handoff' }],
  });
  assert.equal(next.some((task) => task.kind === 'write' || task.class === 'function'), false);
  const result = spawnSync(process.execPath, [dispatchJs, '--port', '1'], {
    cwd: mkdtempSync(path.join(os.tmpdir(), 'long-life-waiting-dispatch-')),
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.wave, []);
  assert.equal(report.fallback, false);
}

async function assertHttpAcceptDoesNotWriteCore() {
  const repo = makeRepository('long-life-http-accept');
  try {
    assert.equal(runCli(continuityCli, repo, ['init', '--schema', '3', '--file', initTemplate]).status, 0);
    const engine = createEngine({ root: repo, autoStart: false, paceMs: 0 });
    try {
      const before = readFileSync(path.join(repo, '.continuity', 'HISTORY.ndjson'), 'utf8');
      if (typeof engine.accept === 'function') engine.accept();
      const after = readFileSync(path.join(repo, '.continuity', 'HISTORY.ndjson'), 'utf8');
      assert.equal(after, before, 'engine.accept must not write Core accept');
      const ready = JSON.parse(runCli(continuityCli, repo, ['inspect', 'ready', '--json']).stdout);
      assert.equal(ready.userAcceptance, 'pending');
    } finally {
      engine.stop();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

async function assertSupervisorHostPacket() {
  const repo = makeRepository('long-life-supervisor');
  const supervisorJs = path.join(repoRoot, 'continuity', 'scripts', 'supervisor.mjs');
  try {
    assert.equal(runCli(continuityCli, repo, ['init', '--schema', '3', '--file', initTemplate]).status, 0);
    const result = spawnSync(process.execPath, [supervisorJs, '--once'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    const packetPath = path.join(repo, 'data', 'host-packet.json');
    assert.equal(existsSync(packetPath), true);
    const packet = JSON.parse(readFileSync(packetPath, 'utf8'));
    assert.equal(packet.accept, false);
    assert.equal(packet.hostAbsent, true);
    assert.ok(Array.isArray(packet.wave));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
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

async function waitForTask(engine, taskId, timeoutMs = 1500) {
  const started = Date.now();
  let task;
  while (Date.now() - started < timeoutMs) {
    task = (engine.getSnapshot().tasks ?? []).find((item) => item.id === taskId);
    if (task && task.status !== 'queued' && task.status !== 'ready') return task;
    await sleep(50);
  }
  return task;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
