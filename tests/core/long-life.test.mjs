import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEngine } from '../../continuity/scripts/lib/swarm/engine.mjs';
import { parseRecordedEvent } from '../../continuity/scripts/lib/protocol/index.mjs';
import { makeRepository, runCli } from '../helpers/repository.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const continuityCli = path.join(repoRoot, 'continuity', 'scripts', 'continuity.mjs');
const initTemplate = path.join(repoRoot, 'continuity', 'assets', 'init-v3.template.json');

export async function run() {
  const repo = makeRepository('long-life-freshness');
  try {
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

    const start = runCli(continuityCli, repo, [
      'record', 'start', '--task', taskId, '--approach', 'Record authorizing evidence',
      '--as', 'subagent', '--actor-id', 'actor-exec-01', '--run-id', 'run-exec-01',
    ]);
    assert.equal(start.status, 0, start.stderr);

    const evidence = runCli(continuityCli, repo, [
      'record', 'evidence', '--task', taskId, '--run', '-e process.exit(0)',
      '--expected', 'check passes', '--kind', 'command',
      '--as', 'subagent', '--actor-id', 'actor-exec-01', '--run-id', 'run-exec-01',
    ]);
    assert.equal(evidence.status, 0, evidence.stderr);
    assert.ok(parseRecordedEvent(evidence.stdout)?.subjectId, evidence.stdout);

    const recorded = runCli(continuityCli, repo, [
      'record', 'result', '--expected', 'check passes', '--actual', 'exit 0',
      '--execution', 'succeeded',
      '--as', 'subagent', '--actor-id', 'actor-exec-01', '--run-id', 'run-exec-01',
    ]);
    assert.equal(recorded.status, 0, recorded.stderr);
    const resultId = parseRecordedEvent(recorded.stdout)?.resultId
      || parseRecordedEvent(recorded.stdout)?.subjectId;
    assert.ok(resultId, recorded.stdout);

    writeFileSync(path.join(repo, 'NOTE.md'), 'new commit after authorizing result\n');
    execFileSync('git', ['-C', repo, 'add', 'NOTE.md'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'post-result head change'], { stdio: 'ignore' });

    const inspect = runCli(continuityCli, repo, ['inspect']);
    assert.equal(inspect.status, 0, inspect.stderr);
    const inspectJson = runCli(continuityCli, repo, ['inspect', '--json']);
    assert.equal(inspectJson.status, 0, inspectJson.stderr);
    const inspectView = JSON.parse(inspectJson.stdout);
    const ready = runCli(continuityCli, repo, ['inspect', 'ready', '--json']);
    assert.equal(ready.status, 0, ready.stderr);
    const readyView = JSON.parse(ready.stdout);

    const freshnessValues = Object.values(readyView.freshness ?? {});
    const staleReported = (inspectView.stale ?? []).length > 0
      || freshnessValues.includes('stale')
      || /STALE (?!none\b)/.test(inspect.stdout);
    assert.ok(
      staleReported,
      'a new git commit after a succeeded authorizing result must make inspect freshness stale',
    );

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
    console.log('long-life core freshness-stale-not-user-accept: PASS');
  } catch (error) {
    console.log(`long-life core freshness-stale-not-user-accept: FAIL ${error.message}`);
    throw error;
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}
