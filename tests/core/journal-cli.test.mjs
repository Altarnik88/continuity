import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { MemoryError } from '../../continuity/scripts/lib/core/domain-v2.mjs';
import { main } from '../../continuity/scripts/lib/core/cli.mjs';
import { rebuildProjection } from '../../continuity/scripts/lib/core/journal-v2.mjs';
import { detectStoreVersion, openStore } from '../../continuity/scripts/lib/core/store.mjs';
import { makeRepository, runCli } from '../helpers/repository.mjs';

const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../continuity/scripts/continuity.mjs');

export async function run() {
  const root = makeRepository('journal');
  try {
    const initPath = path.join(root, 'init.json');
    writeFileSync(initPath, JSON.stringify({
      schemaVersion: 2,
      project: { projectId: 'project-fixture', name: 'Fixture', identity: 'Synthetic v2 fixture', implementationBoundaries: ['Synthetic files only'], operatingRules: ['No network'] },
      finalGoal: { goalId: 'goal-final', title: 'Finish fixture', outcome: 'Exercise the public v2 core', isFinal: true, authority: 'user', basis: 'user_stated', criterionIds: [] },
      actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
      occurredAt: '2026-08-15T00:00:00.000Z', evidenceRef: 'evidence-user-goal',
    }));
    const injectedInitAt = '2026-08-15T00:00:01.000Z';
    let initStdout = ''; let initStderr = '';
    const initStatus = await main(['init', '--root', root, '--schema', '2', '--file', initPath], {
      clock: () => new Date(injectedInitAt),
      stdout: { write: (value) => { initStdout += value; } },
      stderr: { write: (value) => { initStderr += value; } },
    });
    assert.equal(initStatus, 0, initStderr);
    assert.match(initStdout, /^continuity v2 initialized:/);
    assert.equal(detectStoreVersion(root), 2);
    const initialized = openStore(root, { mode: 'read' });
    assert.equal(initialized.events.length, 2);
    assert.deepEqual(initialized.events.map((event) => event.recordedAt), [injectedInitAt, injectedInitAt]);

    const draftPath = path.join(root, 'event.json');
    writeFileSync(draftPath, JSON.stringify({
      eventType: 'evidence.recorded', occurredAt: '2026-08-15T00:00:00.000Z',
      actor: { kind: 'tool', id: 'actor-test-tool', role: 'test runner' }, subject: { type: 'goal', id: 'goal-final' },
      goalId: 'goal-final', supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal',
      payload: { evidence: { evidenceId: 'evidence-core-check', kind: 'test', subjectId: 'goal-final', scope: 'v2 core', locator: 'checks/core', observedAt: '2026-08-15T00:00:00.000Z', verifier: { kind: 'tool', id: 'actor-test-tool', version: '1' }, method: 'public CLI', outcome: 'passed', policy: { kind: 'max_age', maxAgeSeconds: 3600 }, sourceRefs: [], sensitivity: 'internal' } },
    }));
    let result = runCli(helper, root, ['record', '--file', draftPath]);
    assert.equal(result.status, 0, result.stderr);
    result = runCli(helper, root, ['validate']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^continuity v2 valid: 3 event\(s\), projection=current, journal-tail=clean\r?\n$/);

    const store = path.join(root, '.continuity');
    const history = readFileSync(path.join(store, 'HISTORY.ndjson'));
    assert.equal(history.at(-1), 0x0a);
    assert.equal(history.toString('utf8').trimEnd().split('\n').length, 3);
    const expectedProjection = readFileSync(path.join(store, 'CURRENT.json'));
    const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../continuity');
    const contractSchema = JSON.parse(readFileSync(path.join(skillRoot, 'references', 'v2-contract.schema.json'), 'utf8'));
    const projectionSchema = JSON.parse(readFileSync(path.join(skillRoot, 'references', 'projection-v2.schema.json'), 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    ajv.addSchema(contractSchema);
    const validateEnvelopeSchema = ajv.getSchema('urn:continuity:schema:v2-contract#/$defs/EventEnvelope');
    for (const line of history.toString('utf8').trimEnd().split('\n')) {
      assert.equal(validateEnvelopeSchema(JSON.parse(line)), true, JSON.stringify(validateEnvelopeSchema.errors));
    }
    const validateProjection = ajv.compile(projectionSchema);
    assert.equal(validateProjection(JSON.parse(expectedProjection)), true, JSON.stringify(validateProjection.errors));
    unlinkSync(path.join(store, 'CURRENT.json'));
    const lockName = execFileSync('git', ['-C', root, 'rev-parse', '--git-path', 'project-memory.checkpoint.lock'], { encoding: 'utf8' }).trim();
    const lock = path.isAbsolute(lockName) ? lockName : path.resolve(root, lockName);
    writeFileSync(lock, '{"fixture":true}\n');
    assert.throws(() => rebuildProjection(root), MemoryError);
    assert.equal(existsSync(path.join(store, 'CURRENT.json')), false);
    unlinkSync(lock);
    rebuildProjection(root);
    assert.deepEqual(readFileSync(path.join(store, 'CURRENT.json')), expectedProjection);

    execFileSync('git', ['-C', root, 'add', '.continuity']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'store fixture']);
    const linked = path.join(root, 'linked-worktree');
    execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', linked, 'HEAD']);
    assert.throws(() => rebuildProjection(linked), MemoryError);
    execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', linked]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
