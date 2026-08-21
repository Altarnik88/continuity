import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCoordinatorRuntime } from '../../continuity/scripts/lib/coordinator/index.mjs';
import { createFakeAdapter } from '../../continuity/scripts/lib/coordinator/adapters/fake.mjs';
import { ProtocolError, createCliClient } from '../../continuity/scripts/lib/protocol/index.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const continuityCli = path.join(repoRoot, 'continuity', 'scripts', 'continuity.mjs');
const coordinatorCli = path.join(repoRoot, 'continuity', 'scripts', 'coordinator.mjs');
const initTemplate = path.join(repoRoot, 'continuity', 'assets', 'init-v3.template.json');

function git(root, args) {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

function makeRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'continuity-coord-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Coordinator Test']);
  git(root, ['config', 'user.email', 'coord@example.invalid']);
  writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

function runContinuity(root, args) {
  return spawnSync(process.execPath, [continuityCli, ...args, '--root', root], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

function runCoordinator(args, root) {
  return spawnSync(process.execPath, [coordinatorCli, ...args, '--root', root], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

function clientWithFocusedChecks(argv = ['-e', 'process.exit(0)']) {
  const client = createCliClient({ continuityCli, timeoutMs: 30_000 });
  const inspectWave = client.inspectWave.bind(client);
  client.inspectWave = (opts) => {
    const result = inspectWave(opts);
    const document = result.document;
    if (document && typeof document === 'object') {
      for (const item of document.wave?.wave || []) item.focusedChecks = [argv];
      for (const item of document.packets || []) item.focusedChecks = [argv];
    }
    return result;
  };
  return client;
}

export async function run() {
  const productVersion = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
  assert.equal(productVersion, '3.0.0');
  const version = spawnSync(process.execPath, [coordinatorCli, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), `continuity-coordinator ${productVersion}`);
  assert.equal(version.stdout.includes('schema'), false);
  const help = spawnSync(process.execPath, [coordinatorCli, '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /never starts a daemon/);

  const root = makeRepo();
  try {
    let result = runContinuity(root, ['init', '--schema', '3', '--file', initTemplate]);
    assert.equal(result.status, 0, result.stderr);
    result = runContinuity(root, [
      'record', 'task', '--title', 'Ship core function', '--priority', 'core', '--size', 'S',
      '--class', 'function', '--as', 'coordinator', '--actor-id', 'actor-coord', '--run-id', 'run-coord-01',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const ready = runContinuity(root, ['inspect', 'ready', '--json']);
    assert.equal(ready.status, 0, ready.stderr);
    const readyView = JSON.parse(ready.stdout);
    assert.equal(readyView.plan?.sufficient, true, JSON.stringify(readyView.plan));
    assert.ok((readyView.availableTasks ?? []).length >= 1, 'expected a ready task');

    const doctor = runCoordinator(['doctor'], root);
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.match(doctor.stdout, /adapter=local-process/);
    assert.match(doctor.stdout, /live-proof=true/);
    assert.match(doctor.stdout, /execution=sequential/);
    assert.match(doctor.stdout, /daemon=false/);

    const planned = runCoordinator(['plan'], root);
    assert.equal(planned.status, 0, planned.stderr);
    assert.match(planned.stdout, /execution=sequential/);

    const runtime = createCoordinatorRuntime({
      root,
      client: clientWithFocusedChecks(),
      config: {
        adapter: 'local-process',
        slots: 1,
        timeoutMs: 30_000,
        memoryCli: continuityCli,
        executorActorId: 'actor-exec-01',
        verifierActorId: 'actor-verify-01',
        executorRunId: 'run-exec-01',
        verifierRunId: 'run-verify-01',
        liveProofRequired: true,
      },
    });
    const executed = runtime.run({ runId: 'run-live-01' });
    assert.equal(executed.state.userAcceptance, 'pending');
    assert.equal(executed.execution, 'sequential');
    assert.ok(['completed', 'partial', 'blocked', 'running'].includes(executed.state.status), executed.state.status);

    const history = readFileSync(path.join(root, '.continuity', 'HISTORY.ndjson'), 'utf8')
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const types = history.map((event) => event.eventType);
    assert.ok(types.includes('agent.registered'), 'executor/verifier must be persisted');
    assert.ok(types.includes('work_package.recorded'), types.join(','));
    assert.ok(types.includes('assignment.recorded'), types.join(','));
    assert.ok(types.includes('attempt.started'), types.join(','));
    assert.ok(types.includes('evidence.recorded'), types.join(','));
    assert.ok(types.includes('result.recorded'), types.join(','));
    assert.ok(types.includes('verification.recorded'), types.join(','));
    assert.equal(types.includes('feedback.recorded'), false, 'coordinator must not accept for the user');
    const journal = readFileSync(path.join(root, '.continuity', 'HISTORY.ndjson'), 'utf8');
    assert.equal(/sk_live_|apiKey|Bearer /.test(journal), false);

    const inspect = JSON.parse(runContinuity(root, ['inspect', '--json']).stdout);
    const accepted = (inspect.rejections ?? []).concat(inspect.confirmed ?? []);
    assert.equal((inspect.confirmed ?? []).every((item) => item.acceptance !== 'accepted'), true);
    void accepted;

    const resumed = runtime.resume({ runId: 'run-live-01' });
    assert.ok(resumed.state);
    assert.notEqual(resumed.state.status, 'cancelled');
    const cancelled = runtime.cancel({ runId: 'run-live-01' });
    assert.equal(cancelled.state.status, 'cancelled');

    const fakeRuntime = createCoordinatorRuntime({
      root,
      adapter: createFakeAdapter(),
      config: {
        adapter: 'fake',
        slots: 1,
        timeoutMs: 5000,
        memoryCli: continuityCli,
        executorActorId: 'actor-exec-01',
        verifierActorId: 'actor-verify-01',
        executorRunId: 'run-exec-02',
        verifierRunId: 'run-verify-02',
        liveProofRequired: false,
      },
    });
    const fakeDoctor = fakeRuntime.doctor();
    assert.equal(fakeDoctor.adapter.class, 'test-only');
    const fakeRun = fakeRuntime.run({ runId: 'run-fake-allowed' });
    assert.ok(fakeRun.state);

    const blockedFake = createCoordinatorRuntime({
      root,
      adapter: createFakeAdapter(),
      config: {
        adapter: 'fake',
        slots: 1,
        timeoutMs: 5000,
        memoryCli: continuityCli,
        executorActorId: 'actor-exec-01',
        verifierActorId: 'actor-verify-01',
        executorRunId: 'run-exec-03',
        verifierRunId: 'run-verify-03',
        liveProofRequired: true,
      },
    });
    assert.throws(
      () => blockedFake.doctor(),
      (error) => error instanceof ProtocolError && error.exitCode === 4
        && /live proof of autonomous execution/.test(error.message),
    );
    assert.throws(
      () => blockedFake.run({ runId: 'run-fake-blocked' }),
      (error) => error instanceof ProtocolError && error.exitCode === 4
        && /live proof of autonomous execution/.test(error.message),
    );

    const defaultBlocked = createCoordinatorRuntime({
      root,
      adapter: createFakeAdapter(),
      config: {
        adapter: 'fake',
        slots: 1,
        timeoutMs: 5000,
        memoryCli: continuityCli,
        executorActorId: 'actor-exec-01',
        verifierActorId: 'actor-verify-01',
        executorRunId: 'run-exec-04',
        verifierRunId: 'run-verify-04',
      },
    });
    assert.throws(() => defaultBlocked.doctor(), ProtocolError);
    assert.throws(() => defaultBlocked.run({ runId: 'run-fake-default' }), ProtocolError);

    const cliFake = runCoordinator(['doctor', '--adapter', 'fake'], root);
    assert.equal(cliFake.status, 4, cliFake.stderr);
    assert.match(cliFake.stderr, /live proof of autonomous execution/);
    const cliFakeRun = runCoordinator(['run', '--adapter', 'fake'], root);
    assert.equal(cliFakeRun.status, 4, cliFakeRun.stderr);
    assert.match(cliFakeRun.stderr, /live proof of autonomous execution/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
