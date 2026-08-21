import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRepository, runCli } from '../helpers/repository.mjs';

const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../continuity/scripts/continuity.mjs');
const v3Template = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../continuity/assets/init-v3.template.json');

export async function run() {
  const roots = [];
  try {
    const root = makeRepository('security'); roots.push(root);
    let result = runCli(helper, root, ['init', '--schema', '3', '--file', v3Template]);
    assert.equal(result.status, 0, result.stderr);
    result = runCli(helper, root, ['record', 'task', '--title', 'Secure work', '--priority', 'core', '--class', 'function']);
    assert.equal(result.status, 0, result.stderr);

    const store = path.join(root, '.continuity');
    const current = path.join(store, 'CURRENT.json');
    writeFileSync(current, '{corrupt\n');
    result = runCli(helper, root, ['validate']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /projection=invalid/);
    assert.equal(readFileSync(current, 'utf8'), '{corrupt\n');

    const history = path.join(store, 'HISTORY.ndjson');
    writeFileSync(history, '{partial:', { flag: 'a' });
    result = runCli(helper, root, ['validate']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(history, 'utf8'), /\{partial:$/);
    result = runCli(helper, root, ['record', 'evidence', '--expected', 'pass', '--actual', 'pass', '--kind', 'command', '--exit-code', '0']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(readFileSync(history, 'utf8'), /\{partial:/);

    const outsideLink = path.join(root, 'history-hardlink.ndjson');
    linkSync(history, outsideLink);
    result = runCli(helper, root, ['record', 'evidence', '--expected', 'pass', '--actual', 'pass', '--kind', 'command', '--exit-code', '0']);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /exactly one hard link/);

    const linked = path.join(root, 'linked-worktree');
    execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', linked, 'HEAD']);
    result = runCli(helper, linked, ['init', '--schema', '3', '--file', v3Template]);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /refused in linked worktrees/);
    execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', linked]);

    const linkedStoreRoot = makeRepository('linked-store'); roots.push(linkedStoreRoot);
    const outsideStore = mkdtempSync(path.join(os.tmpdir(), 'project-memory-v3-outside-')); roots.push(outsideStore);
    symlinkSync(outsideStore, path.join(linkedStoreRoot, '.continuity'), process.platform === 'win32' ? 'junction' : 'dir');
    result = runCli(helper, linkedStoreRoot, ['init', '--schema', '3', '--file', v3Template]);
    assert.equal(result.status, 3);
    assert.equal(existsSync(path.join(outsideStore, 'HISTORY.ndjson')), false);
  } finally {
    for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
  }
}
