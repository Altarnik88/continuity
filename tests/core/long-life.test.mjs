import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEngine } from '../../continuity/scripts/lib/swarm/engine.mjs';
import { readV3Journal, sealHotJournal } from '../../continuity/scripts/lib/core/journal-v3.mjs';
import { parseRecordedEvent } from '../../continuity/scripts/lib/protocol/index.mjs';
import { makeRepository, runCli } from '../helpers/repository.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const continuityCli = path.join(repoRoot, 'continuity', 'scripts', 'continuity.mjs');
const initTemplate = path.join(repoRoot, 'continuity', 'assets', 'init-v3.template.json');

export async function run() {
  const repo = makeRepository('long-life-freshness');
  const failed = [];
  try {
    seedAuthorizingResult(repo);
    writeFileSync(path.join(repo, 'NOTE.md'), 'new commit after authorizing result\n');
    execFileSync('git', ['-C', repo, 'add', 'NOTE.md'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'post-result head change'], { stdio: 'ignore' });

    try {
      assertInspectFreshnessStale(repo);
      console.log('long-life core freshness-stale-after-commit: PASS');
    } catch (error) {
      failed.push('freshness-stale-after-commit');
      console.log(`long-life core freshness-stale-after-commit: FAIL ${error.message}`);
    }

    try {
      await assertMissionAcceptedIsNotUserAccept(repo);
      console.log('long-life core mission-accepted-not-user-accept: PASS');
    } catch (error) {
      failed.push('mission-accepted-not-user-accept');
      console.log(`long-life core mission-accepted-not-user-accept: FAIL ${error.message}`);
    }

    try {
      assertJournalSealKeepsGoal(repo);
      console.log('long-life core journal-seal-keeps-goal: PASS');
    } catch (error) {
      failed.push('journal-seal-keeps-goal');
      console.log(`long-life core journal-seal-keeps-goal: FAIL ${error.message}`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  assert.equal(failed.length, 0, failed.join(','));
}

function seedAuthorizingResult(repo) {
  const init = runCli(continuityCli, repo, ['init', '--schema', '3', '--file', initTemplate]);
  assert.equal(init.status, 0, init.stderr);
  const task = runCli(continuityCli, repo, [
    'record', 'task', '--title', 'Authorizing freshness check',
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
}

function assertInspectFreshnessStale(repo) {
  const inspect = runCli(continuityCli, repo, ['inspect']);
  assert.equal(inspect.status, 0, inspect.stderr);
  const inspectView = JSON.parse(runCli(continuityCli, repo, ['inspect', '--json']).stdout);
  const readyView = JSON.parse(runCli(continuityCli, repo, ['inspect', 'ready', '--json']).stdout);
  const freshnessValues = Object.values(readyView.freshness ?? {});
  const staleReported = (inspectView.stale ?? []).length > 0
    || freshnessValues.includes('stale')
    || /STALE (?!none\b)/.test(inspect.stdout);
  assert.ok(
    staleReported,
    'a new git commit after a succeeded authorizing result must make inspect freshness stale',
  );
}

async function assertMissionAcceptedIsNotUserAccept(repo) {
  const engine = createEngine({ root: repo, autoStart: false, paceMs: 0 });
  try {
    engine.start();
    const snap = engine.getSnapshot();
    assert.notEqual(snap.mission?.accepted, 'user');
    assert.notEqual(snap.mission?.accepted, 'accepted');
    const after = JSON.parse(runCli(continuityCli, repo, ['inspect', 'ready', '--json']).stdout);
    assert.equal(after.userAcceptance, 'pending');
    const history = readFileSync(path.join(repo, '.continuity', 'HISTORY.ndjson'), 'utf8');
    assert.equal(
      /"eventType":"feedback.recorded"/.test(history) && /"acceptance":"accepted"/.test(history),
      false,
      'swarm mission.accepted must not become user accept',
    );
  } finally {
    engine.stop();
  }
}

function assertJournalSealKeepsGoal(repo) {
  const before = JSON.parse(runCli(continuityCli, repo, ['inspect', 'ready', '--json']).stdout);
  assert.ok(before.goal?.goalId, 'journal goal must exist before seal');
  const anchor = sealHotJournal(repo);
  assert.ok(anchor.epochId);
  assert.ok(anchor.nextStep);
  const sealed = readdirSync(path.join(repo, '.continuity', 'epochs'))
    .filter((name) => name.endsWith('.ndjson'));
  assert.ok(sealed.length >= 1, 'sealed epoch file must exist');
  assert.equal(existsSync(path.join(repo, '.continuity', 'HISTORY.ndjson')), false);
  const task = runCli(continuityCli, repo, [
    'record', 'task', '--title', 'After sealed epoch',
    '--priority', 'core', '--size', 'S', '--class', 'function',
    '--as', 'coordinator', '--actor-id', 'actor-coord', '--run-id', 'run-after-seal',
  ]);
  assert.equal(task.status, 0, task.stderr);
  const store = readV3Journal(repo);
  assert.ok(store.sealedEpochs >= 1);
  assert.ok(store.state.finalGoalId || store.state.goals.length);
  const after = JSON.parse(runCli(continuityCli, repo, ['inspect', 'ready', '--json']).stdout);
  assert.equal(after.goal?.goalId, before.goal.goalId);
}
