import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MemoryError, validateDraftShape } from '../../continuity/scripts/lib/core/domain-v2.mjs';
import { makeRepository, runCli } from '../helpers/repository.mjs';

const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../continuity/scripts/continuity.mjs');
const initInput = { schemaVersion: 2, project: { projectId: 'project-secure', name: 'Secure fixture', identity: 'Synthetic security fixture', implementationBoundaries: ['Synthetic only'], operatingRules: ['Fail closed'] }, finalGoal: { goalId: 'goal-final', title: 'Remain bounded', outcome: 'Reject unsafe state', isFinal: true, authority: 'user', basis: 'user_stated', criterionIds: [] }, actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' }, occurredAt: '2026-08-15T00:00:00.000Z', evidenceRef: 'evidence-user-goal' };
const evidenceDraft = (id) => ({ eventType: 'evidence.recorded', occurredAt: '2026-08-15T00:00:00.000Z', actor: { kind: 'tool', id: 'actor-test-tool', role: 'tool' }, subject: { type: 'goal', id: 'goal-final' }, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal', payload: { evidence: { evidenceId: id, kind: 'test', subjectId: 'goal-final', scope: 'security fixture', locator: `checks/${id}`, observedAt: '2026-08-15T00:00:00.000Z', verifier: { kind: 'tool', id: 'actor-test-tool' }, method: 'public CLI', outcome: 'passed', policy: { kind: 'max_age', maxAgeSeconds: 3600 }, sourceRefs: [], sensitivity: 'internal' } } });

export async function run() {
  const sensitiveNeedles = [
    '-----BEGIN PRIVATE KEY-----', `ghp_${'A'.repeat(24)}`, `AKIA${'A'.repeat(16)}`, `sk-${'A'.repeat(20)}`,
    `rk_live_${'A'.repeat(12)}`, `whsec_${'A'.repeat(16)}`, `xoxb-${'A'.repeat(16)}`, `AIza${'A'.repeat(24)}`,
    `SK${'a'.repeat(32)}`, `SG.${'A'.repeat(16)}.${'B'.repeat(16)}`, `eyJ${'A'.repeat(12)}.${'B'.repeat(12)}.${'C'.repeat(12)}`,
    `Bearer ${'A'.repeat(24)}`, 'Proxy-Authorization: Basic synthetic', 'set-cookie=session-value', 'database_url=synthetic-value',
    'postgres://synthetic:credential@example.invalid/db', 'SYNTHETIC_KEY=synthetic-value', 'person@example.invalid', '+1 (555) 123-4567',
    '555-123-4567', '8 999 123 45 67', 'diff --git a/a b/a', '@@ -1 +1 @@', '*** Begin Patch', 'Index: synthetic.txt',
  ];
  for (const needle of sensitiveNeedles) {
    const candidate = { ...evidenceDraft('evidence-sensitive'), payload: { evidence: { ...evidenceDraft('evidence-sensitive').payload.evidence, method: needle } } };
    assert.throws(() => validateDraftShape(candidate), (error) => error instanceof MemoryError && !error.message.includes(needle));
  }
  for (const key of ['password', 'passwd', 'secret', 'token', 'access_token', 'refreshToken', 'apiKey', 'cookie', 'set-cookie', 'authorization', 'database_url', 'directUrl', 'privateKey', 'session', 'session-id', 'stdout', 'stderr', 'commandOutput', 'logOutput', 'stacktrace', 'rawDiff', 'patch', 'rawRows', 'rows', 'records', 'customerEmail', 'customerPhone', 'customerAddress', 'email', 'phone', 'address', 'orderId', 'orderPayload']) {
    const candidate = { ...evidenceDraft('evidence-sensitive-key'), payload: { evidence: { [key]: 'synthetic-value' } } };
    assert.throws(() => validateDraftShape(candidate), (error) => error instanceof MemoryError && /sensitive or disallowed/.test(error.message));
  }

  const roots = [];
  try {
    const root = makeRepository('security'); roots.push(root);
    const initPath = path.join(root, 'init.json');
    writeFileSync(initPath, JSON.stringify({ ...initInput, finalGoal: { ...initInput.finalGoal, authority: 'coordinator' } }));
    let result = runCli(helper, root, ['init', '--schema', '2', '--file', initPath]);
    assert.equal(result.status, 2);
    assert.equal(existsSync(path.join(root, '.continuity')), false);
    writeFileSync(initPath, JSON.stringify(initInput));
    result = runCli(helper, root, ['init', '--schema', '2', '--file', initPath]);
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
    assert.match(result.stdout, /journal-tail=partial/);
    assert.match(readFileSync(history, 'utf8'), /\{partial:$/);
    const draftPath = path.join(root, 'event.json');
    writeFileSync(draftPath, JSON.stringify(evidenceDraft('evidence-after-tail')));
    result = runCli(helper, root, ['record', '--file', draftPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(readFileSync(history, 'utf8'), /\{partial:/);

    const rejected = evidenceDraft('evidence-rejected');
    const needle = `Bearer ${'A'.repeat(24)}`;
    rejected.payload.evidence.method = needle;
    rejected.unexpected = 'must fail closed';
    writeFileSync(draftPath, JSON.stringify(rejected));
    result = runCli(helper, root, ['record', '--file', draftPath]);
    assert.equal(result.status, 2);
    assert.equal(`${result.stdout}${result.stderr}`.includes(needle), false);

    const outsideLink = path.join(root, 'history-hardlink.ndjson');
    linkSync(history, outsideLink);
    writeFileSync(draftPath, JSON.stringify(evidenceDraft('evidence-hardlink')));
    result = runCli(helper, root, ['record', '--file', draftPath]);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /exactly one hard link/);

    const linked = path.join(root, 'linked-worktree');
    execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', linked, 'HEAD']);
    const linkedInput = path.join(linked, 'init.json'); writeFileSync(linkedInput, JSON.stringify(initInput));
    result = runCli(helper, linked, ['init', '--schema', '2', '--file', linkedInput]);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /refused in linked worktrees/);
    execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', linked]);

    const linkedStoreRoot = makeRepository('linked-store'); roots.push(linkedStoreRoot);
    const outsideStore = mkdtempSync(path.join(os.tmpdir(), 'project-memory-v2-outside-')); roots.push(outsideStore);
    symlinkSync(outsideStore, path.join(linkedStoreRoot, '.continuity'), process.platform === 'win32' ? 'junction' : 'dir');
    const linkedInit = path.join(linkedStoreRoot, 'init.json'); writeFileSync(linkedInit, JSON.stringify(initInput));
    result = runCli(helper, linkedStoreRoot, ['init', '--schema', '2', '--file', linkedInit]);
    assert.equal(result.status, 3);
    assert.equal(existsSync(path.join(outsideStore, 'HISTORY.ndjson')), false);
  } finally {
    for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
  }
}
