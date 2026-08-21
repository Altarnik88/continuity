import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEGACY_SCHEMA_UNSUPPORTED } from '../../continuity/scripts/lib/core/errors.mjs';
import { makeRepository, runCli } from '../helpers/repository.mjs';

const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../continuity/scripts/continuity.mjs');
const v3Template = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../continuity/assets/init-v3.template.json');

function writeJournal(root, firstEvent) {
  const store = path.join(root, '.continuity');
  mkdirSync(store, { recursive: true });
  writeFileSync(path.join(store, 'HISTORY.ndjson'), `${JSON.stringify(firstEvent)}\n`);
  writeFileSync(path.join(store, 'CURRENT.json'), '{}\n');
}

export async function run() {
  const roots = [];
  try {
    const v1Root = makeRepository('legacy-v1-store');
    roots.push(v1Root);
    writeJournal(v1Root, { snapshot: { schemaVersion: 1 } });
    let result = runCli(helper, v1Root, ['inspect']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(LEGACY_SCHEMA_UNSUPPORTED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(result.stdout, /schemaVersion|legacy-v1|Decisions/);

    const v2Root = makeRepository('legacy-v2-store');
    roots.push(v2Root);
    writeJournal(v2Root, { schemaVersion: 2, eventType: 'project.initialized' });
    result = runCli(helper, v2Root, ['inspect']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /legacy-v1v2-final/);
    assert.doesNotMatch(result.stdout, /schemaVersion":2/);

    const invocationRoot = makeRepository('legacy-invocation');
    roots.push(invocationRoot);
    for (const args of [
      ['init', '--schema', '2', '--file', v3Template],
      ['init', '--schema', '1', '--file', v3Template],
      ['checkpoint'],
      ['migrate', '--to', '2'],
      ['event', 'template', 'task.started'],
    ]) {
      result = runCli(helper, invocationRoot, args);
      assert.notEqual(result.status, 0, args.join(' '));
      assert.match(result.stderr, /legacy-v1v2-final/, args.join(' '));
    }

    const v3Root = makeRepository('v3-doctor');
    roots.push(v3Root);
    result = runCli(helper, v3Root, ['init', '--schema', '3', '--file', v3Template]);
    assert.equal(result.status, 0, result.stderr);
    result = runCli(helper, v3Root, ['doctor']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /store=v3/);
    assert.match(result.stdout, /journal=valid/);
  } finally {
    for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
  }
}
