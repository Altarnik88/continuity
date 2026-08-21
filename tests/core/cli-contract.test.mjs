import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRepository, runCli } from '../helpers/repository.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helper = path.join(root, 'continuity', 'scripts', 'continuity.mjs');
const runner = path.join(root, 'scripts', 'test-continuity.mjs');
const v3Template = path.join(root, 'continuity', 'assets', 'init-v3.template.json');

export async function run() {
  let result = spawnSync(process.execPath, [helper, 'event', 'template', 'task.started'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /legacy-v1v2-final/);

  const repo = makeRepository('cli-contract');
  try {
    result = runCli(helper, repo, ['init', '--schema', '3', '--file', v3Template]);
    assert.equal(result.status, 0, result.stderr);
    result = runCli(helper, repo, ['history', '--json', '--tail', '1']);
    assert.equal(result.status, 0, result.stderr);
    const historyDocument = JSON.parse(result.stdout);
    assert.equal(historyDocument.schemaVersion, 3);
    assert.equal(historyDocument.store.schemaVersion, 3);
    for (const args of [['record', '--json'], ['history', '--schema', '2'], ['--version', '--json']]) {
      result = runCli(helper, repo, args);
      assert.notEqual(result.status, 0, args.join(' '));
      assert.equal(result.stdout, '');
    }
    result = runCli(helper, repo, ['checkpoint']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /legacy-v1v2-final/);
    result = runCli(helper, repo, ['inspect']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(runCli(helper, repo, ['migrate', '--to', '2']).status, 2);
    const unknownGraphify = runCli(helper, repo, ['graphify', 'observe']);
    assert.notEqual(unknownGraphify.status, 0);
    assert.equal(unknownGraphify.stdout, '');
    assert.match(unknownGraphify.stderr, /legacy-v1v2-final/);
  } finally { rmSync(repo, { recursive: true, force: true }); }

  result = spawnSync(process.execPath, [runner, '--suite', 'unknown'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
}
