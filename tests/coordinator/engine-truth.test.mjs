import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCommandFromFocusedChecks,
  createCoordinatorRuntime,
} from '../../continuity/scripts/lib/coordinator/index.mjs';
import { createLocalProcessAdapter } from '../../continuity/scripts/lib/coordinator/adapters/local-process.mjs';
import { saveRunState } from '../../continuity/scripts/lib/coordinator/run-state.mjs';
import {
  createCliClient,
  parseRecordedEvent,
} from '../../continuity/scripts/lib/protocol/index.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const continuityCli = path.join(repoRoot, 'continuity', 'scripts', 'continuity.mjs');
const initTemplate = path.join(repoRoot, 'continuity', 'assets', 'init-v3.template.json');

function git(root, args) {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

function makeRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'continuity-engine-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Coordinator Truth']);
  git(root, ['config', 'user.email', 'coord-truth@example.invalid']);
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

function journalEvents(root) {
  return readFileSync(path.join(root, '.continuity', 'HISTORY.ndjson'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function recordTask(root, title) {
  const result = runContinuity(root, [
    'record', 'task', '--title', title, '--priority', 'core', '--size', 'S',
    '--class', 'function', '--as', 'coordinator', '--actor-id', 'actor-coord', '--run-id', 'run-coord-01',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = parseRecordedEvent(result.stdout);
  assert.ok(parsed?.subjectId, result.stdout);
  return parsed.subjectId;
}

function wrapInspectWave(client, mutate) {
  const inspectWave = client.inspectWave.bind(client);
  client.inspectWave = (opts) => {
    const result = inspectWave(opts);
    mutate(result.document);
    return result;
  };
  return client;
}

function baseConfig(overrides = {}) {
  return {
    adapter: 'local-process',
    slots: 2,
    timeoutMs: 30_000,
    memoryCli: continuityCli,
    executorActorId: 'actor-exec-01',
    verifierActorId: 'actor-verify-01',
    executorRunId: 'run-exec-01',
    verifierRunId: 'run-verify-01',
    liveProofRequired: true,
    ...overrides,
  };
}

export async function run() {
  const empty = buildCommandFromFocusedChecks([]);
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /focusedChecks is empty/);
  const malformed = buildCommandFromFocusedChecks(['node -e process.exit(0)']);
  assert.equal(malformed.ok, false);
  const argv = buildCommandFromFocusedChecks([['-e', 'process.exit(0)']]);
  assert.equal(argv.ok, true);
  assert.equal(argv.command[0], process.execPath);
  assert.deepEqual(argv.command.slice(1), ['-e', 'process.exit(0)']);
  const encoded = buildCommandFromFocusedChecks(['["-e","process.exit(0)"]']);
  assert.equal(encoded.ok, true);
  assert.deepEqual(encoded.command.slice(1), ['-e', 'process.exit(0)']);

  const root = makeRepo();
  try {
    assert.equal(runContinuity(root, ['init', '--schema', '3', '--file', initTemplate]).status, 0);

    recordTask(root, 'Empty focused checks');
    const launchLog = [];
    const adapter = createLocalProcessAdapter({ timeoutMs: 30_000 });
    const originalLaunch = adapter.launchAssignment.bind(adapter);
    adapter.launchAssignment = (assignment) => {
      launchLog.push(assignment);
      return originalLaunch(assignment);
    };
    const emptyClient = wrapInspectWave(createCliClient({ continuityCli, timeoutMs: 30_000 }), (document) => {
      for (const item of document.wave?.wave || []) item.focusedChecks = [];
      for (const item of document.packets || []) item.focusedChecks = [];
    });
    const emptyRuntime = createCoordinatorRuntime({
      root,
      client: emptyClient,
      adapter,
      config: baseConfig({ slots: 1, executorRunId: 'run-exec-empty', verifierRunId: 'run-verify-empty' }),
    });
    const emptyRun = emptyRuntime.run({ runId: 'run-empty-checks' });
    const emptyEvents = journalEvents(root);
    assert.ok(emptyEvents.some((event) => event.eventType === 'failure.recorded'), 'empty focusedChecks must record failure');
    assert.equal(emptyEvents.some((event) => event.eventType === 'evidence.recorded'
      && event.payload?.evidence?.authorizing === true), false);
    assert.equal(emptyEvents.some((event) => event.eventType === 'result.recorded'), false);
    assert.equal(launchLog.length, 0, 'empty focusedChecks must not launch the adapter');
    assert.notEqual(emptyRun.state.status, 'completed');

    recordTask(root, 'Overlap packet one');
    recordTask(root, 'Overlap packet two');
    const overlapClient = wrapInspectWave(createCliClient({ continuityCli, timeoutMs: 30_000 }), (document) => {
      const seed = (document.wave?.wave || document.packets || [])[0];
      assert.ok(seed, 'expected a wave packet to clone');
      const left = {
        ...seed,
        packetId: 'packet-overlapaaaaaaa1',
        allowedPaths: ['src/shared'],
        focusedChecks: [['-e', 'process.exit(0)']],
      };
      const right = {
        ...seed,
        packetId: 'packet-overlapbbbbbbb2',
        allowedPaths: ['src/shared'],
        focusedChecks: [['-e', 'process.exit(0)']],
      };
      document.wave = { ...(document.wave && !Array.isArray(document.wave) ? document.wave : {}), wave: [left, right] };
    });
    const overlapRuntime = createCoordinatorRuntime({
      root,
      client: overlapClient,
      config: baseConfig({ executorRunId: 'run-exec-overlap', verifierRunId: 'run-verify-overlap' }),
    });
    const overlapRun = overlapRuntime.run({ runId: 'run-all-skipped' });
    assert.equal(overlapRun.state.status, 'blocked', overlapRun.state.stopReason);
    assert.equal(overlapRun.state.stopReason, 'nothing-could-be-launched');
    assert.equal(overlapRun.state.completedPacketIds.length, 0);

    const foreignIds = [];
    for (const [title, actorId, runId] of [
      ['Foreign result one', 'actor-manual-01', 'run-manual-01'],
      ['Foreign result two', 'actor-manual-02', 'run-manual-02'],
    ]) {
      const taskId = recordTask(root, title);
      assert.equal(runContinuity(root, [
        'record', 'start', '--task', taskId,
        '--approach', `manual ${title}`, '--as', 'subagent', '--actor-id', actorId, '--run-id', runId,
      ]).status, 0);
      assert.equal(runContinuity(root, [
        'record', 'evidence', '--task', taskId, '--expected', 'ok', '--actual', 'exit 0', '--kind', 'command',
        '--exit-code', '0', '--as', 'subagent', '--actor-id', actorId, '--run-id', runId,
      ]).status, 0);
      const recorded = runContinuity(root, [
        'record', 'result', '--expected', 'ok', '--actual', 'foreign result', '--execution', 'succeeded',
        '--as', 'subagent', '--actor-id', actorId, '--run-id', runId,
      ]);
      assert.equal(recorded.status, 0, recorded.stderr);
      foreignIds.push(parseRecordedEvent(recorded.stdout).resultId);
    }
    recordTask(root, 'Coordinator verify target');
    assert.equal(foreignIds.length, 2);
    const inspectBefore = JSON.parse(runContinuity(root, ['inspect', '--json']).stdout);
    assert.equal(inspectBefore.unverified[0].resultId, foreignIds[0]);

    const verifyIds = [];
    const writtenResultIds = [];
    const verifyClient = wrapInspectWave(createCliClient({ continuityCli, timeoutMs: 30_000 }), (document) => {
      for (const item of document.wave?.wave || []) item.focusedChecks = [['-e', 'process.exit(0)']];
      for (const item of document.packets || []) item.focusedChecks = [['-e', 'process.exit(0)']];
    });
    const recordResult = verifyClient.recordResult.bind(verifyClient);
    const recordVerify = verifyClient.recordVerify.bind(verifyClient);
    verifyClient.recordResult = (options) => {
      const recorded = recordResult(options);
      writtenResultIds.push(recorded.resultId);
      return recorded;
    };
    verifyClient.recordVerify = (options) => {
      verifyIds.push(options.resultId);
      return recordVerify(options);
    };
    const verifyRuntime = createCoordinatorRuntime({
      root,
      client: verifyClient,
      config: baseConfig({
        slots: 1,
        executorRunId: 'run-exec-verify',
        verifierRunId: 'run-verify-bind',
      }),
    });
    verifyRuntime.run({ runId: 'run-verify-binding' });
    assert.equal(writtenResultIds.length, 1, 'coordinator should write one result');
    assert.equal(verifyIds.length, 1, 'coordinator should verify one result');
    assert.equal(verifyIds[0], writtenResultIds[0]);
    assert.equal(foreignIds.includes(verifyIds[0]), false);
    const verifications = journalEvents(root).filter((event) => event.eventType === 'verification.recorded');
    assert.ok(verifications.length >= 1);
    assert.equal(verifications.at(-1).payload.report.resultId, writtenResultIds[0]);

    const resumeRoot = makeRepo();
    try {
      assert.equal(runContinuity(resumeRoot, ['init', '--schema', '3', '--file', initTemplate]).status, 0);
      recordTask(resumeRoot, 'Resume blocked');
      const resumeRuntime = createCoordinatorRuntime({
        root: resumeRoot,
        config: baseConfig({ slots: 1 }),
      });
      const planned = resumeRuntime.plan({ runId: 'run-open-attempt' });
      saveRunState(resumeRoot, {
        ...planned.state,
        status: 'running',
        openAttempts: [{ taskId: 'task-resume-blocked', actorId: 'actor-exec-01', runId: 'run-exec-01' }],
      });
      const resumed = resumeRuntime.resume({ runId: 'run-open-attempt' });
      assert.equal(resumed.state.status, 'blocked');
      assert.equal(resumed.state.stopReason, 'open-attempts-require-rollover');
      assert.match(resumed.rollover, /context-rollover/);
    } finally {
      rmSync(resumeRoot, { recursive: true, force: true });
    }

    const plannedDoctor = emptyRuntime.plan({ runId: 'run-plan-sequential' });
    assert.equal(plannedDoctor.execution, 'sequential');
    assert.equal(emptyRuntime.doctor().execution, 'sequential');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
