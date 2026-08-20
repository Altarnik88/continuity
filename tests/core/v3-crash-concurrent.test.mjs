import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MemoryError } from '../../continuity/scripts/lib/core/domain-v3.mjs';
import { appendV3, initializeV3, readV3Journal, rebuildV3 } from '../../continuity/scripts/lib/core/journal-v3.mjs';
import { recipeStart, recipeTask } from '../../continuity/scripts/lib/core/recipes-v3.mjs';
import { gitAdminTopology } from '../../continuity/scripts/lib/core/store.mjs';

const CLI = fileURLToPath(new URL('../../continuity/scripts/continuity.mjs', import.meta.url));
const clock = () => new Date('2026-08-18T00:00:00.000Z');

class CaseSkip extends Error {}

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function git(root, args) {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

function makeRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pm-v3-crash-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Crash Test']);
  git(root, ['config', 'user.email', 'crash@example.invalid']);
  writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

const INIT = {
  schemaVersion: 3,
  project: {
    projectId: 'project-demo',
    name: 'Demo',
    identity: 'v3 crash fixture',
    implementationBoundaries: ['Synthetic only'],
    operatingRules: ['No network'],
  },
  finalGoal: {
    goalId: 'goal-final',
    title: 'Remember honestly',
    outcome: 'Journal remains truth after projection failure',
    isFinal: true,
    authority: 'user',
    basis: 'user_stated',
    criterionIds: ['criterion-honest'],
  },
  criterion: {
    criterionId: 'criterion-honest',
    ownerType: 'goal',
    ownerId: 'goal-final',
    condition: 'Success has evidence',
    scope: 'fixture',
    requiredEvidenceKinds: ['command'],
    freshnessPolicy: { kind: 'source_digest' },
    waivableByUser: false,
  },
  actor: { kind: 'user', id: 'actor-user', role: 'user' },
  occurredAt: '2026-08-18T00:00:00.000Z',
};

function actor(kind = 'coordinator') {
  return { kind, id: `actor-${kind}`, role: kind, runId: `run-${kind}` };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function persistenceFingerprint(root) {
  const store = readV3Journal(root);
  const history = readFileSync(store.files.history);
  const current = existsSync(store.files.current) ? readFileSync(store.files.current) : Buffer.alloc(0);
  return {
    historySha256: sha256(history),
    currentSha256: sha256(current),
    records: store.events.length,
    lastSequence: store.events.at(-1).sequence,
    lastEventHash: store.events.at(-1).eventHash,
    projection: store.projection,
    lockExists: existsSync(gitAdminTopology(root).lock),
  };
}

function seedTask(root) {
  initializeV3(root, JSON.stringify(INIT), { clock });
  let store = readV3Journal(root);
  appendV3(root, recipeTask(store, { actor: actor(), title: 'Ship crash semantics' }, { clock }), { clock });
  return readV3Journal(root);
}

export const CASES = Object.freeze([
  {
    id: 'T01-R07-004-projection-failure-journal-is-truth',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      const previousFail = process.env.PROJECT_MEMORY_TEST_FAIL_V3_CURRENT_REPLACE;
      const previousEnv = process.env.NODE_ENV;
      try {
        const seeded = seedTask(root);
        const before = persistenceFingerprint(root);
        process.env.NODE_ENV = 'test';
        process.env.PROJECT_MEMORY_TEST_FAIL_V3_CURRENT_REPLACE = '1';
        assert.throws(() => appendV3(root, recipeStart(seeded, {
          actor: actor(), approach: 'crash after journal',
        }, { clock }), { clock }), (error) => (
          error instanceof MemoryError
          && /committed as sequence \d+; CURRENT projection pending repair/.test(error.message)
        ));
        const after = readV3Journal(root);
        assert.equal(after.events.length, before.records + 1);
        assert.equal(after.events.at(-1).eventType, 'attempt.started');
        assert.notEqual(after.projection, 'current');
        assert.notEqual(persistenceFingerprint(root).historySha256, before.historySha256);
        delete process.env.PROJECT_MEMORY_TEST_FAIL_V3_CURRENT_REPLACE;
        rebuildV3(root);
        const repaired = readV3Journal(root);
        assert.equal(repaired.projection, 'current');
        assert.equal(repaired.events.length, before.records + 1);
        assert.equal(repaired.events.at(-1).eventType, 'attempt.started');
      } finally {
        if (previousFail === undefined) delete process.env.PROJECT_MEMORY_TEST_FAIL_V3_CURRENT_REPLACE;
        else process.env.PROJECT_MEMORY_TEST_FAIL_V3_CURRENT_REPLACE = previousFail;
        if (previousEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousEnv;
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T01-R07-005-overlapping-writer-lock-no-effect',
    async run() {
      if (!hasGit()) throw new CaseSkip('git.exe is not available');
      const root = makeRepo();
      const barrier = mkdtempSync(path.join(os.tmpdir(), 'pm-v3-lock-'));
      const ready = path.join(barrier, 'ready.json');
      const release = path.join(barrier, 'release');
      const draftFile = path.join(root, 'overlap-draft.json');
      let child;
      try {
        const seeded = seedTask(root);
        const draft = recipeStart(seeded, { actor: actor(), approach: 'hold lock' }, { clock });
        writeFileSync(draftFile, draft);
        const journalUrl = new URL('../../continuity/scripts/lib/core/journal-v3.mjs', import.meta.url).href;
        child = spawn(process.execPath, ['--input-type=module', '-e', `
          const { appendV3 } = await import(${JSON.stringify(journalUrl)});
          const { readFileSync } = await import('node:fs');
          appendV3(process.argv[1], readFileSync(process.argv[2], 'utf8'));
        `, root, draftFile], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: {
            ...process.env,
            NODE_ENV: 'test',
            PROJECT_MEMORY_TEST_BARRIER_POINT: 'journal-append-after-lock',
            PROJECT_MEMORY_TEST_BARRIER_DIR: barrier,
          },
        });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const exited = new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code, signal) => resolve({ code, signal }));
        });
        const deadline = Date.now() + 15_000;
        while (!existsSync(ready)) {
          if (child.exitCode !== null) throw new Error(`overlap child exited before lock barrier: ${stderr}`);
          if (Date.now() >= deadline) throw new Error(`overlap child did not reach lock barrier: ${stderr}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const held = persistenceFingerprint(root);
        assert.equal(held.lockExists, true);
        const conflict = spawnSync(process.execPath, [CLI, '--root', root, 'record', 'start', '--approach', 'overlap'], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: ['C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\Git\\bin', process.env.PATH]
              .filter(Boolean)
              .join(path.delimiter),
            NO_COLOR: '1',
          },
        });
        assert.notEqual(conflict.status, 0, conflict.stdout);
        assert.equal(conflict.stdout, '');
        assert.match(conflict.stderr, /locked by another or interrupted writer/i);
        const afterConflict = persistenceFingerprint(root);
        assert.equal(afterConflict.historySha256, held.historySha256);
        assert.equal(afterConflict.currentSha256, held.currentSha256);
        assert.equal(afterConflict.records, held.records);
        assert.equal(afterConflict.lockExists, true);
        writeFileSync(release, 'release\n', { flag: 'wx' });
        const result = await exited;
        assert.equal(result.code, 0, stderr);
        const after = persistenceFingerprint(root);
        assert.equal(after.records, held.records + 1);
        assert.equal(after.lockExists, false);
        assert.equal(readV3Journal(root).events.at(-1).eventType, 'attempt.started');
      } finally {
        if (child && child.exitCode === null) child.kill();
        rmSync(barrier, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
]);

export async function run() {
  const totals = { found: CASES.length, executed: 0, passed: 0, failed: 0, skipped: 0 };
  for (const testCase of CASES) {
    try {
      await testCase.run();
      totals.executed += 1;
      totals.passed += 1;
      console.log(`PASS ${testCase.id}`);
    } catch (error) {
      if (error instanceof CaseSkip) {
        totals.skipped += 1;
        console.log(`SKIP ${testCase.id}: ${error.message}`);
      } else {
        totals.executed += 1;
        totals.failed += 1;
        console.error(`FAIL ${testCase.id}: ${error instanceof Error ? error.stack : error}`);
      }
    }
  }
  if (totals.found === 0 || totals.executed + totals.skipped !== totals.found) totals.failed += 1;
  console.log(`v3 crash concurrent: found=${totals.found} executed=${totals.executed} passed=${totals.passed} failed=${totals.failed} skipped=${totals.skipped}`);
  if (totals.failed > 0 || totals.executed === 0) {
    throw new Error(`v3 crash concurrent failed found=${totals.found} passed=${totals.passed} failed=${totals.failed} skipped=${totals.skipped}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}
