import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRepository, runCli } from '../helpers/repository.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helper = path.join(root, 'continuity', 'scripts', 'continuity.mjs');
const runner = path.join(root, 'scripts', 'test-continuity.mjs');

export async function run() {
  let result = spawnSync(process.execPath, [helper, 'event', 'template', 'task.started'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const template = JSON.parse(result.stdout);
  for (const field of ['recordedAt', 'occurredAt', 'previousEventHash', 'eventHash']) assert.equal(field in template, false);

  const root = makeRepository('cli-contract');
  try {
    const draftPath = path.join(root, 'draft.json');
    writeFileSync(draftPath, JSON.stringify({ eventType: 'task.started', occurredAt: '2026-08-15T00:00:00.000Z', actor: { kind: 'subagent', id: 'actor-subagent', role: 'subagent' }, subject: { type: 'task', id: 'task-example' }, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal', payload: { attemptId: 'attempt-example' } }));
    result = spawnSync(process.execPath, [helper, 'event', 'lint', '--file', draftPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);

    const initPath = path.join(root, 'init.json');
    writeFileSync(initPath, JSON.stringify({ schemaVersion: 2, project: { projectId: 'project-cli', name: 'CLI fixture', identity: 'Synthetic CLI fixture', implementationBoundaries: ['Synthetic only'], operatingRules: ['No network'] }, finalGoal: { goalId: 'goal-final', title: 'Freeze CLI', outcome: 'Expose stable routing', isFinal: true, authority: 'user', basis: 'user_stated', criterionIds: [] }, actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' }, occurredAt: '2026-08-15T00:00:00.000Z', evidenceRef: 'evidence-user-goal' }));
    result = runCli(helper, root, ['init', '--schema', '2', '--file', initPath]);
    assert.equal(result.status, 0, result.stderr);
    result = runCli(helper, root, ['history', '--json', '--tail', '1']);
    assert.equal(result.status, 0, result.stderr);
    const historyDocument = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(historyDocument), ['schemaVersion', 'events']);
    assert.equal(result.stdout, `${JSON.stringify(historyDocument)}\n`);
    for (const args of [['validate', '--json'], ['record', '--json', '--file', draftPath], ['event', 'template', 'task.started', '--tail', '1'], ['history', '--schema', '2'], ['--version', '--json']]) {
      result = runCli(helper, root, args);
      assert.equal(result.status, 2, args.join(' '));
      assert.equal(result.stdout, '');
    }
    result = runCli(helper, root, ['checkpoint']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /event-based/);
    assert.equal(runCli(helper, root, ['inspect']).status, 3);
    assert.equal(runCli(helper, root, ['migrate', '--to', '2']).status, 3);
    const unknownGraphify = runCli(helper, root, ['graphify', 'observe']);
    assert.equal(unknownGraphify.status, 2);
    assert.equal(unknownGraphify.stdout, '');
    assert.match(unknownGraphify.stderr, /usage: continuity\.mjs/);
  } finally { rmSync(root, { recursive: true, force: true }); }

  result = spawnSync(process.execPath, [runner, '--suite', 'unknown'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
}
