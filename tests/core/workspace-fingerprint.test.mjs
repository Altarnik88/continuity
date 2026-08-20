import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { appendV2, initializeV2 } from '../../continuity/scripts/lib/core/journal-v2.mjs';
import { openStore } from '../../continuity/scripts/lib/core/store.mjs';
import { makeRepository } from '../helpers/repository.mjs';

const occurredAt = '2026-08-15T04:00:00.000Z';
const evidenceDraft = (evidenceId) => ({
  eventType: 'evidence.recorded', occurredAt,
  actor: { kind: 'tool', id: 'actor-test-tool', role: 'tool' }, subject: { type: 'goal', id: 'goal-final' }, goalId: 'goal-final',
  supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal',
  payload: { evidence: { evidenceId, kind: 'test', subjectId: 'goal-final', scope: 'workspace fingerprint seam', locator: `checks/${evidenceId}`, observedAt: occurredAt, verifier: { kind: 'tool', id: 'actor-test-tool' }, method: 'public journal seam', outcome: 'passed', policy: { kind: 'max_age', maxAgeSeconds: 60 }, sourceRefs: [], sensitivity: 'internal' } },
});

export async function run() {
  const root = makeRepository('workspace-fingerprint');
  try {
    const clock = () => new Date(occurredAt);
    initializeV2(root, {
      schemaVersion: 2,
      project: { projectId: 'project-workspace', name: 'Workspace', identity: 'Fingerprint fixture', implementationBoundaries: ['Synthetic only'], operatingRules: ['Detect dirty content'] },
      finalGoal: { goalId: 'goal-final', title: 'Fingerprint content', outcome: 'Dirty content changes are visible', isFinal: true, authority: 'user', basis: 'user_stated', criterionIds: [] },
      actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' }, occurredAt, evidenceRef: 'evidence-user-goal',
    }, { clock });
    const dirty = path.join(root, 'dirty.txt');
    writeFileSync(dirty, 'base\n');
    execFileSync('git', ['-C', root, 'add', 'dirty.txt']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'dirty fixture']);
    writeFileSync(dirty, 'one!\n');
    appendV2(root, evidenceDraft('evidence-workspace-one'));
    writeFileSync(dirty, 'two!\n');
    appendV2(root, evidenceDraft('evidence-workspace-two'));
    const observations = openStore(root, { mode: 'read' }).events.slice(-2).map((event) => event.workspaceAtRecord);
    assert.equal(observations.every((item) => item.fingerprintPartial === false), true);
    assert.notEqual(observations[0].statusFingerprint, observations[1].statusFingerprint);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
