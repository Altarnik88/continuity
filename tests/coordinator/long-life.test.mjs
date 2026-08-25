import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCoordinatorRuntime } from '../../continuity/scripts/lib/coordinator/index.mjs';
import { parseRecordedEvent } from '../../continuity/scripts/lib/protocol/index.mjs';
import { makeRepository, runCli } from '../helpers/repository.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const continuityCli = path.join(repoRoot, 'continuity', 'scripts', 'continuity.mjs');
const initTemplate = path.join(repoRoot, 'continuity', 'assets', 'init-v3.template.json');

const CASES = [
  ['coordinator-planner-is-not-pulse', assertCoordinatorPlannerIsNotPulse],
  ['coordinator-exhausted-no-eval', assertCoordinatorExhaustedHasNoEval],
  ['coordinator-freshness-stale-after-commit', assertCoordinatorFreshnessStaleAfterCommit],
  ['coordinator-freshness-not-user-accept', assertCoordinatorDoesNotAccept],
];

export async function run() {
  const failed = [];
  for (const [name, check] of CASES) {
    try {
      await check();
      console.log(`long-life coordinator ${name}: PASS`);
    } catch (error) {
      failed.push(name);
      console.log(`long-life coordinator ${name}: FAIL ${error.message}`);
    }
  }
  assert.equal(failed.length, 0, failed.join(','));
}

function pulseOrEval(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  return /pulse/i.test(text) || /eval-/.test(text);
}

function waveItems(document) {
  if (Array.isArray(document?.wave?.wave)) return document.wave.wave;
  if (Array.isArray(document?.wave)) return document.wave;
  if (Array.isArray(document?.packets)) return document.packets;
  return [];
}

async function assertCoordinatorPlannerIsNotPulse() {
  const repo = makeRepository('coord-long-life-planner');
  try {
    assert.equal(runCli(continuityCli, repo, ['init', '--schema', '3', '--file', initTemplate]).status, 0);
    const ready = JSON.parse(runCli(continuityCli, repo, ['inspect', 'ready', '--json']).stdout);
    const wave = JSON.parse(runCli(continuityCli, repo, ['inspect', 'wave', '--json']).stdout);
    assert.ok(ready.goal?.goalId, 'dummy journal goal must be present');
    assert.equal(pulseOrEval(ready.availableTasks ?? []), false, 'ready set must not invent Pulse or eval-* tasks');
    assert.equal(pulseOrEval(waveItems(wave)), false, 'inspect wave must not enqueue Pulse-named or eval-* packets');

    const runtime = createCoordinatorRuntime({
      root: repo,
      config: {
        adapter: 'local-process',
        slots: 1,
        timeoutMs: 15_000,
        memoryCli: continuityCli,
        executorActorId: 'actor-exec-01',
        verifierActorId: 'actor-verify-01',
        executorRunId: 'run-exec-plan',
        verifierRunId: 'run-verify-plan',
        liveProofRequired: true,
      },
    });
    const planned = runtime.plan({ runId: 'run-coord-no-pulse' });
    assert.equal(pulseOrEval(waveItems(planned.wave)), false, 'coordinator plan must not enqueue Pulse or eval-*');
    assert.notEqual(planned.state?.userAcceptance, 'accepted');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

async function assertCoordinatorExhaustedHasNoEval() {
  const repo = makeRepository('coord-long-life-exhausted');
  try {
    assert.equal(runCli(continuityCli, repo, ['init', '--schema', '3', '--file', initTemplate]).status, 0);
    const taskId = recordAuthorizingResult(repo);
    assert.ok(taskId);
    const wave = JSON.parse(runCli(continuityCli, repo, ['inspect', 'wave', '--json']).stdout);
    assert.deepEqual(waveItems(wave), []);
    assert.equal(pulseOrEval(wave), false, 'exhausted coordinator wave must not print eval-*');

    const runtime = createCoordinatorRuntime({
      root: repo,
      config: {
        adapter: 'local-process',
        slots: 1,
        timeoutMs: 15_000,
        memoryCli: continuityCli,
        executorActorId: 'actor-exec-02',
        verifierActorId: 'actor-verify-02',
        executorRunId: 'run-exec-done',
        verifierRunId: 'run-verify-done',
        liveProofRequired: true,
      },
    });
    const planned = runtime.plan({ runId: 'run-coord-exhausted' });
    assert.deepEqual(waveItems(planned.wave), []);
    assert.equal(pulseOrEval(planned.wave), false);
    assert.equal(planned.ready?.userAcceptance ?? 'pending', 'pending');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

async function assertCoordinatorFreshnessStaleAfterCommit() {
  const repo = makeRepository('coord-long-life-stale');
  try {
    assert.equal(runCli(continuityCli, repo, ['init', '--schema', '3', '--file', initTemplate]).status, 0);
    recordAuthorizingResult(repo);
    writeFileSync(path.join(repo, 'AFTER.md'), 'commit after authorizing result\n');
    execFileSync('git', ['-C', repo, 'add', 'AFTER.md'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'stale the authorizing result'], { stdio: 'ignore' });
    const inspect = runCli(continuityCli, repo, ['inspect']);
    assert.equal(inspect.status, 0, inspect.stderr);
    const inspectView = JSON.parse(runCli(continuityCli, repo, ['inspect', '--json']).stdout);
    const readyView = JSON.parse(runCli(continuityCli, repo, ['inspect', 'ready', '--json']).stdout);
    const freshnessValues = Object.values(readyView.freshness ?? {});
    const staleReported = (inspectView.stale ?? []).length > 0
      || freshnessValues.includes('stale')
      || /STALE (?!none\b)/.test(inspect.stdout);
    assert.ok(staleReported, 'coordinator inspect freshness must be stale after a new commit');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

async function assertCoordinatorDoesNotAccept() {
  const repo = makeRepository('coord-long-life-accept');
  try {
    assert.equal(runCli(continuityCli, repo, ['init', '--schema', '3', '--file', initTemplate]).status, 0);
    recordAuthorizingResult(repo);
    writeFileSync(path.join(repo, 'AFTER.md'), 'commit after authorizing result\n');
    execFileSync('git', ['-C', repo, 'add', 'AFTER.md'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'stale the authorizing result'], { stdio: 'ignore' });
    const readyView = JSON.parse(runCli(continuityCli, repo, ['inspect', 'ready', '--json']).stdout);
    assert.equal(readyView.userAcceptance, 'pending');
    const runtime = createCoordinatorRuntime({
      root: repo,
      config: {
        adapter: 'local-process',
        slots: 1,
        timeoutMs: 15_000,
        memoryCli: continuityCli,
        executorActorId: 'actor-exec-03',
        verifierActorId: 'actor-verify-03',
        executorRunId: 'run-exec-fresh',
        verifierRunId: 'run-verify-fresh',
        liveProofRequired: true,
      },
    });
    const planned = runtime.plan({ runId: 'run-coord-fresh' });
    assert.equal(planned.ready?.userAcceptance ?? 'pending', 'pending');
    assert.notEqual(planned.state?.userAcceptance, 'accepted');
    const history = readFileSync(path.join(repo, '.continuity', 'HISTORY.ndjson'), 'utf8');
    assert.equal(
      /"eventType":"feedback.recorded"/.test(history) && /"acceptance":"accepted"/.test(history),
      false,
      'coordinator must not turn mission.accepted into user accept',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function recordAuthorizingResult(repo) {
  const task = runCli(continuityCli, repo, [
    'record', 'task', '--title', 'Coordinator long-life authorizing result',
    '--priority', 'core', '--size', 'S', '--class', 'function',
    '--as', 'coordinator', '--actor-id', 'actor-coord', '--run-id', 'run-coord-01',
  ]);
  assert.equal(task.status, 0, task.stderr);
  const taskId = parseRecordedEvent(task.stdout)?.subjectId;
  assert.ok(taskId, task.stdout);
  assert.equal(runCli(continuityCli, repo, [
    'record', 'start', '--task', taskId, '--approach', 'Record authorizing evidence',
    '--as', 'subagent', '--actor-id', 'actor-exec-01', '--run-id', 'run-exec-01',
  ]).status, 0);
  const evidence = runCli(continuityCli, repo, [
    'record', 'evidence', '--task', taskId, '--run', '-e process.exit(0)',
    '--expected', 'check passes', '--kind', 'command',
    '--as', 'subagent', '--actor-id', 'actor-exec-01', '--run-id', 'run-exec-01',
  ]);
  assert.equal(evidence.status, 0, evidence.stderr);
  const recorded = runCli(continuityCli, repo, [
    'record', 'result', '--expected', 'check passes', '--actual', 'exit 0',
    '--execution', 'succeeded',
    '--as', 'subagent', '--actor-id', 'actor-exec-01', '--run-id', 'run-exec-01',
  ]);
  assert.equal(recorded.status, 0, recorded.stderr);
  return taskId;
}
