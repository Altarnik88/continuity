import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startControlSurface } from '../../continuity/scripts/control-surface.mjs';
import { MAX_JOURNAL_BYTES, MAX_PROJECTION_BYTES } from '../../continuity/scripts/lib/core/domain-v3.mjs';
import { sealHotJournal } from '../../continuity/scripts/lib/core/journal-v3.mjs';
import { createEngine } from '../../continuity/scripts/lib/swarm/engine.mjs';
import { acquireEngineLock } from '../../continuity/scripts/lib/swarm/lock.mjs';
import { buildRoster, pathsOverlap } from '../../continuity/scripts/lib/swarm/contract.mjs';
import { planFromGoal } from '../../continuity/scripts/lib/swarm/planner.mjs';
import { sanitizeMemoryRecord, swarmDataDirectory } from '../../continuity/scripts/lib/swarm/store.mjs';
import { makeRepository, runCli } from '../helpers/repository.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const continuityCli = path.join(repoRoot, 'continuity', 'scripts', 'continuity.mjs');
const dispatchJs = path.join(repoRoot, 'continuity', 'scripts', 'dispatch.mjs');
const initTemplate = path.join(repoRoot, 'continuity', 'assets', 'init-v3.template.json');
const engineSrc = readFileSync(path.join(repoRoot, 'continuity', 'scripts', 'lib', 'swarm', 'engine.mjs'), 'utf8');
const coordinatorSrc = readFileSync(path.join(repoRoot, 'continuity', 'scripts', 'lib', 'coordinator', 'engine.mjs'), 'utf8');
const dispatchSrc = readFileSync(path.join(repoRoot, 'continuity', 'scripts', 'dispatch.mjs'), 'utf8');
const skillSrc = readFileSync(path.join(repoRoot, 'continuity', 'SKILL.md'), 'utf8');
const archSrc = readFileSync(path.join(repoRoot, 'ARCHITECTURE.md'), 'utf8');

export async function run() {
  assertC1Canon();
  assertCloseableNext();
  assertC2EmptyDispatch();
  assertC3NoPulse();
  assertC4Lock();
  await assertC5HttpAccept();
  assertC6Sanitize();
  assertC7Handoff();
  assertC8Docs();
  assertC9Invariants();
  console.log('hours-canon C1-C9 current-state probe: PASS');
}

function assertC1Canon() {
  assert.match(engineSrc, /createCliClient/);
  assert.equal(/appendV3|HISTORY\.ndjson/.test(engineSrc), false, 'swarm engine must not write HISTORY files');
  const root = mkdtempSync(path.join(os.tmpdir(), 'hours-c1-'));
  const engine = createEngine({ root, autoStart: false, paceMs: 0 });
  try {
    const snap = engine.getSnapshot();
    assert.equal(snap.mission?.title, '');
    assert.notEqual(snap.mission?.accepted, 'accepted');
    assert.equal(snap.mission?.acceptedSource, 'sqlite-pending');
  } finally {
    engine.stop();
    rmSync(root, { recursive: true, force: true });
  }

  const repo = makeRepository('hours-c1-restore');
  try {
    assert.equal(runCli(continuityCli, repo, ['init', '--schema', '3', '--file', initTemplate]).status, 0);
    const first = createEngine({ root: repo, autoStart: false, paceMs: 0 });
    let seeded;
    try {
      seeded = (first.getSnapshot().tasks ?? []).map((task) => task.id).sort();
      assert.ok(seeded.length > 0, 'journal goal must seed the sqlite projection');
    } finally {
      first.stop();
    }
    rmSync(path.join(swarmDataDirectory(repo), 'swarm.sqlite'), { force: true });
    const restored = createEngine({ root: repo, autoStart: false, paceMs: 0 });
    try {
      const ids = (restored.getSnapshot().tasks ?? []).map((task) => task.id).sort();
      assert.deepEqual(ids, seeded, 'wiped sqlite must replan from inspect / HISTORY');
      assert.equal(existsSync(path.join(repo, '.continuity', 'HISTORY.ndjson')), true);
    } finally {
      restored.stop();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function assertCloseableNext() {
  const repo = makeRepository('hours-next');
  try {
    assert.equal(runCli(continuityCli, repo, ['init', '--schema', '3', '--file', initTemplate]).status, 0);
    const task = runCli(continuityCli, repo, [
      'record', 'task', '--title', 'Closeable next action', '--priority', 'core',
      '--class', 'function', '--as', 'coordinator', '--actor-id', 'actor-coord', '--run-id', 'run-coord-next',
    ]);
    assert.equal(task.status, 0, task.stderr);
    assert.equal(runCli(continuityCli, repo, [
      'record', 'start', '--approach', 'Record a failure that later needs a close',
      '--as', 'subagent', '--actor-id', 'actor-exec-next', '--run-id', 'run-exec-next',
    ]).status, 0);
    const fail = runCli(continuityCli, repo, [
      'record', 'fail', '--why', 'Second process deleted live leases',
      '--impact', 'Hours-long swarm cannot resume',
      '--next', 'Change recoverOrphans so a second process does not delete live leases',
      '--as', 'subagent', '--actor-id', 'actor-exec-next', '--run-id', 'run-exec-next',
    ]);
    assert.equal(fail.status, 0, fail.stderr);
    const inspectAfterFail = runCli(continuityCli, repo, ['inspect']);
    assert.equal(inspectAfterFail.status, 0, inspectAfterFail.stderr);
    const nextMatch = inspectAfterFail.stdout.match(/NEXT (next-[a-z0-9-]+):Change recoverOrphans/);
    assert.ok(nextMatch, inspectAfterFail.stdout);
    const unknown = runCli(continuityCli, repo, [
      'record', 'next', '--subject', 'next-does-not-exist-xx', '--execution', 'succeeded',
      '--as', 'coordinator', '--actor-id', 'actor-coord', '--run-id', 'run-coord-next',
    ]);
    assert.notEqual(unknown.status, 0, 'unknown next subject must fail closed');
    const closed = runCli(continuityCli, repo, [
      'record', 'next', '--subject', nextMatch[1], '--execution', 'succeeded',
      '--why', 'Live lock pid keeps recoverOrphans from deleting leases',
      '--as', 'coordinator', '--actor-id', 'actor-coord', '--run-id', 'run-coord-next',
    ]);
    assert.equal(closed.status, 0, closed.stderr);
    const inspectAfterClose = runCli(continuityCli, repo, ['inspect']);
    assert.equal(inspectAfterClose.status, 0, inspectAfterClose.stderr);
    assert.match(inspectAfterClose.stdout, /NEXT none/);
    assert.match(inspectAfterClose.stdout, /FAILURES failure-/);
    const anchor = sealHotJournal(repo);
    assert.equal(/recoverOrphans/.test(anchor.nextStep), false, 'sealed epoch must not resume a closed next action');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function assertC2EmptyDispatch() {
  assert.equal(/fallbackWave|eval-/.test(dispatchSrc), false);
  const empty = spawnSync(process.execPath, [dispatchJs, '--port', '1'], {
    cwd: mkdtempSync(path.join(os.tmpdir(), 'hours-c2-')),
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(empty.status, 0, empty.stderr);
  const report = JSON.parse(empty.stdout);
  assert.deepEqual(report.wave, []);
  assert.equal(report.fallback, false);
}

function assertC3NoPulse() {
  assert.deepEqual(planFromGoal(null), []);
  const root = mkdtempSync(path.join(os.tmpdir(), 'hours-c3-'));
  const engine = createEngine({ root, autoStart: false, paceMs: 0 });
  try {
    const tasks = engine.getSnapshot().tasks ?? [];
    assert.equal(tasks.some((task) => /pulse|task-scaffold/i.test(`${task.id} ${task.title}`)), false);
    assert.equal(existsSync(path.join(root, 'forge')), false);
  } finally {
    engine.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

function assertC4Lock() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hours-c4-'));
  const first = acquireEngineLock(root);
  try {
    assert.throws(() => acquireEngineLock(root), /engine-already-live/);
  } finally {
    first.release();
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(pathsOverlap(['Forge/a.mjs'], ['forge/a.mjs']), true);
  assert.equal(dispatchSrc.includes('createEngine'), false);
  assert.equal(dispatchSrc.includes('recoverOrphans'), false);
}

async function assertC5HttpAccept() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hours-c5-'));
  const engine = createEngine({ root, autoStart: false, paceMs: 0 });
  const surface = await startControlSurface(engine, { port: 0 });
  try {
    const port = surface.server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/swarm/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'accept' }),
    });
    assert.notEqual(response.status, 200);
    assert.equal(typeof engine.accept, 'undefined');
  } finally {
    await new Promise((resolve) => surface.server.close(resolve));
    engine.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

function assertC6Sanitize() {
  const clean = sanitizeMemoryRecord({
    kind: 'failure',
    title: 'tap',
    body: 'TAP version 13\nnot ok 1 /tmp/secret/path\nPATH=/bin\nHOME=/home/x\nUSER=x',
  });
  assert.equal(/TAP version|not ok|\/tmp\/secret/.test(clean.body), false);
  assert.ok(clean.sha256);
  assert.match(engineSrc, /sanitizedSpawnEnv/);
}

function assertC7Handoff() {
  const writeFn = engineSrc.slice(engineSrc.indexOf('async function writeHandoff'));
  const finishAt = writeFn.indexOf('finish({ id: \'task-handoff\'');
  const jsonAt = writeFn.indexOf('HANDOFF.json');
  assert.ok(finishAt >= 0 && jsonAt > finishAt, 'writeHandoff must finish before writing HANDOFF');
  assert.match(engineSrc, /evidenceIds/);
  assert.match(engineSrc, /failedHypotheses/);
  assert.match(engineSrc, /lastCompletedStep/);
}

function assertC8Docs() {
  assert.match(skillSrc, /Node does not spawn host Task/);
  assert.match(skillSrc, /do not invent missing requirements or slice a product/);
  assert.match(archSrc, /execution projection/);
  assert.match(archSrc, /untrusted view/);
  assert.equal(/5-20 LLM/.test(skillSrc) && /launch\.mjs/.test(skillSrc) && /5-20 LLM[^\n]*launch/.test(skillSrc), false);
}

function assertC9Invariants() {
  assert.ok(!buildRoster(20).some((agent) => agent.role === 'integrator'));
  assert.equal(MAX_JOURNAL_BYTES, 8 * 1024 * 1024);
  assert.equal(MAX_PROJECTION_BYTES, 256 * 1024);
  assert.match(coordinatorSrc, /authorizing evidence requires an observed --run command/);
  assert.match(engineSrc, /authorizing evidence requires an observed --run command/);
  assert.equal(engineSrc.includes("actual: evidence?.actual || 'exit 0'"), false);
  assert.equal(/task\.spec\.run \?\? \['--test'\]/.test(engineSrc), false);
  const repo = makeRepository('hours-c9');
  try {
    assert.equal(runCli(continuityCli, repo, ['init', '--schema', '3', '--file', initTemplate]).status, 0);
    const accept = runCli(continuityCli, repo, ['record', 'accept', '--as', 'coordinator', '--result', 'result-none']);
    assert.notEqual(accept.status, 0);
    const ready = JSON.parse(runCli(continuityCli, repo, ['inspect', 'ready', '--json']).stdout);
    assert.equal(ready.userAcceptance, 'pending');
    const engine = createEngine({ root: repo, autoStart: false, paceMs: 0 });
    try {
      assert.equal(engine.getSnapshot().mission?.title, ready.goal?.goalId);
      assert.notEqual(engine.getSnapshot().mission?.accepted, 'accepted');
    } finally {
      engine.stop();
    }

    const task = runCli(continuityCli, repo, [
      'record', 'task', '--title', 'C9 claimed versus observed', '--priority', 'core',
      '--class', 'function', '--as', 'coordinator', '--actor-id', 'actor-coord', '--run-id', 'run-coord-c9',
    ]);
    assert.equal(task.status, 0, task.stderr);
    const start = runCli(continuityCli, repo, [
      'record', 'start', '--approach', 'Observe a Node check',
      '--as', 'subagent', '--actor-id', 'actor-exec-c9', '--run-id', 'run-exec-c9',
    ]);
    assert.equal(start.status, 0, start.stderr);
    const claimed = runCli(continuityCli, repo, [
      'record', 'evidence', '--expected', 'claimed stay labeled', '--actual', 'exit 0',
      '--kind', 'command', '--exit-code', '0',
      '--as', 'subagent', '--actor-id', 'actor-exec-c9', '--run-id', 'run-exec-c9',
    ]);
    assert.equal(claimed.status, 0, claimed.stderr);
    const observedCommand = runCli(continuityCli, repo, [
      'record', 'evidence', '--run', '-e process.exit(0)', '--expected', 'observed command exits 0',
      '--kind', 'command', '--as', 'subagent', '--actor-id', 'actor-exec-c9', '--run-id', 'run-exec-c9',
    ]);
    assert.equal(observedCommand.status, 0, observedCommand.stderr);
    const observedTest = runCli(continuityCli, repo, [
      'record', 'evidence', '--run', '-e process.exit(0)', '--expected', 'observed test exits 0',
      '--kind', 'test', '--as', 'subagent', '--actor-id', 'actor-exec-c9', '--run-id', 'run-exec-c9',
    ]);
    assert.equal(observedTest.status, 0, observedTest.stderr);
    const inspect = runCli(continuityCli, repo, ['inspect']);
    assert.match(inspect.stdout, /observed/);
    assert.match(inspect.stdout, /claimed/);
    const commandId = JSON.parse(observedCommand.stdout.trim().split('\n').at(-1)).evidenceId
      || JSON.parse(observedCommand.stdout.trim().split('\n').at(-1)).subjectId;
    const testId = JSON.parse(observedTest.stdout.trim().split('\n').at(-1)).evidenceId
      || JSON.parse(observedTest.stdout.trim().split('\n').at(-1)).subjectId;
    const result = runCli(continuityCli, repo, [
      'record', 'result', '--expected', 'observed checks exit 0', '--actual', 'authorizing observed evidence',
      '--execution', 'succeeded', '--evidence', `${commandId},${testId}`,
      '--as', 'subagent', '--actor-id', 'actor-exec-c9', '--run-id', 'run-exec-c9',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const resultId = JSON.parse(result.stdout.trim().split('\n').at(-1)).resultId
      || JSON.parse(result.stdout.trim().split('\n').at(-1)).subjectId;
    const selfVerify = runCli(continuityCli, repo, [
      'record', 'verify', '--result', resultId, '--found', '1', '--executed', '1', '--passed', '1',
      '--failed', '0', '--exit-code', '0',
      '--as', 'subagent', '--actor-id', 'actor-exec-c9', '--run-id', 'run-exec-c9',
    ]);
    assert.notEqual(selfVerify.status, 0, 'same actor and run must not self-verify');
    const agentDraft = path.join(repo, 'verifier.json');
    writeFileSync(agentDraft, `${JSON.stringify({
      eventType: 'agent.registered',
      occurredAt: new Date().toISOString(),
      actor: { kind: 'coordinator', id: 'actor-coord', role: 'coordinator', runId: 'run-coord-c9' },
      subject: { type: 'agent', id: 'actor-verify-c9' },
      supersedes: [],
      contradicts: [],
      evidenceRefs: [],
      sensitivity: 'internal',
      payload: {
        agent: {
          actorId: 'actor-verify-c9',
          providerFamily: 'host',
          modelFamily: 'large',
          capabilityProfiles: ['implementation', 'integration'],
          costTier: 'standard',
          speedTier: 'standard',
          trustTier: 'standard',
          calibrationStatus: 'calibrated',
          kind: 'subagent',
        },
      },
    })}\n`);
    const registered = runCli(continuityCli, repo, [
      'record', '--file', agentDraft, '--as', 'coordinator', '--actor-id', 'actor-coord', '--run-id', 'run-coord-c9',
    ]);
    assert.equal(registered.status, 0, registered.stderr);
    const independent = runCli(continuityCli, repo, [
      'record', 'verify', '--result', resultId, '--found', '1', '--executed', '1', '--passed', '1',
      '--failed', '0', '--exit-code', '0',
      '--as', 'subagent', '--actor-id', 'actor-verify-c9', '--run-id', 'run-verify-c9',
    ]);
    assert.equal(independent.status, 0, independent.stderr);
    const attempt = runCli(continuityCli, repo, [
      'record', 'report', '--execution', 'partial', '--actual', 'attempt is not evidence',
      '--as', 'subagent', '--actor-id', 'actor-exec-c9', '--run-id', 'run-exec-c9',
    ]);
    assert.equal(attempt.status, 0, attempt.stderr);
    const readyAfter = JSON.parse(runCli(continuityCli, repo, ['inspect', 'ready', '--json']).stdout);
    assert.equal(readyAfter.userAcceptance, 'pending');
    assert.ok(
      (readyAfter.criteria ?? []).every((item) => item.verification === 'passed'),
      'fresh independently verified command+test evidence must mark required criteria passed',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
