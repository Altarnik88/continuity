import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { main } from '../../continuity/scripts/lib/core/cli.mjs';
import { validateDraft } from '../../continuity/scripts/lib/core/domain-v2.mjs';
import { appendV2, initializeV2 } from '../../continuity/scripts/lib/core/journal-v2.mjs';
import { openStore } from '../../continuity/scripts/lib/core/store.mjs';
import { makeRepository } from '../helpers/repository.mjs';

const observedAt = new Date(Date.now() - 120_000).toISOString();
const forgedFreshAt = new Date(Date.parse(observedAt) + 1_000).toISOString();
const actor = (kind = 'coordinator', id = `actor-${kind}`) => ({ kind, id, role: kind });
const draft = (eventType, subject, payload, by = actor()) => ({ eventType, occurredAt: observedAt, actor: by, subject, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal', payload });

export async function run() {
  const root = makeRepository('freshness-authority');
  try {
    const forgedClock = () => new Date(forgedFreshAt);
    initializeV2(root, {
      schemaVersion: 2,
      project: { projectId: 'project-freshness', name: 'Freshness', identity: 'Persistence authority seam', implementationBoundaries: ['Synthetic only'], operatingRules: ['Re-observe before completion'] },
      finalGoal: { goalId: 'goal-final', title: 'Authorize from live state', outcome: 'Forged evaluators do not authorize completion', isFinal: true, authority: 'user', basis: 'user_stated', criterionIds: ['criterion-core'] },
      actor: actor(), occurredAt: observedAt, evidenceRef: 'evidence-user-goal',
    }, { clock: forgedClock });
    const criterion = draft('criterion.declared', { type: 'criterion', id: 'criterion-core' }, { criterion: { criterionId: 'criterion-core', ownerType: 'goal', ownerId: 'goal-final', condition: 'Synthetic check is fresh', scope: 'core', requiredEvidenceKinds: ['test'], freshnessPolicy: { kind: 'max_age', maxAgeSeconds: 60 }, waivableByUser: false } });
    const beforeForgedOptions = openStore(root, { mode: 'read' }).events.length;
    assert.throws(() => appendV2(root, criterion, { clock: forgedClock }), /does not accept caller options/);
    assert.equal(openStore(root, { mode: 'read' }).events.length, beforeForgedOptions, 'rejected append options mutated the journal');
    const append = (value) => appendV2(root, value);
    append(criterion);
    append(draft('task.planned', { type: 'task', id: 'task-core' }, { task: { taskId: 'task-core', goalId: 'goal-final', title: 'Complete core', scope: 'core', pathOwnership: ['src/core'], owner: 'actor-subagent', dependencyIds: [], criterionIds: ['criterion-core'], userFacing: false, requiredForGoal: true } }));
    append(draft('attempt.started', { type: 'attempt', id: 'attempt-one' }, { attempt: { attemptId: 'attempt-one', taskId: 'task-core', ordinal: 1, owner: 'actor-subagent', approachId: 'approach-one', hypothesisId: 'hypothesis-one', approachSummary: 'Synthetic completion attempt' } }, actor('subagent')));
    append(draft('task.started', { type: 'task', id: 'task-core' }, { attemptId: 'attempt-one' }, actor('subagent')));
    const evidence = (evidenceId, subjectId) => draft('evidence.recorded', { type: subjectId.split('-')[0], id: subjectId }, { evidence: { evidenceId, kind: 'test', subjectId, scope: 'freshness authority seam', locator: `checks/${evidenceId}`, observedAt, verifier: { kind: 'tool', id: 'actor-tool' }, method: 'synthetic public journal seam', outcome: 'passed', policy: { kind: 'max_age', maxAgeSeconds: 60 }, sourceRefs: [], sensitivity: 'internal' } }, actor('tool'));
    append(evidence('evidence-deliverable', 'task-core'));
    append(draft('task.implemented', { type: 'task', id: 'task-core' }, { attemptId: 'attempt-one', deliverableEvidenceRefs: ['evidence-deliverable'] }, actor('subagent')));
    append(evidence('evidence-criterion', 'criterion-core'));
    append(draft('attempt.reported', { type: 'attempt', id: 'attempt-one' }, { attemptId: 'attempt-one', outcome: 'succeeded', endedAt: observedAt, summary: 'Synthetic checks passed at observation time', evidenceRefs: ['evidence-criterion'] }, actor('subagent')));

    const completion = draft('task.completed', { type: 'task', id: 'task-core' }, { attemptId: 'attempt-one', criterionEvidenceRefs: ['evidence-criterion'] });
    const forged = Object.freeze({ evaluateEvidence: () => 'fresh' });
    const before = openStore(root, { mode: 'read' });
    assert.doesNotThrow(() => validateDraft(completion, before.state, { liveContext: forged }), 'diagnostic seam should remain usable without granting write authority');
    const record = async (dryRun) => {
      let stdout = ''; let stderr = '';
      const argv = ['record', '--root', root, '--stdin', ...(dryRun ? ['--dry-run'] : [])];
      const status = await main(argv, {
        stdin: JSON.stringify(completion), clock: forgedClock,
        stdout: { write: (value) => { stdout += value; } },
        stderr: { write: (value) => { stderr += value; } },
      });
      return { status, stdout, stderr };
    };
    const dryRun = await record(true);
    assert.notEqual(dryRun.status, 0, dryRun.stdout);
    assert.match(dryRun.stderr, /live-fresh/);
    const persisted = await record(false);
    assert.notEqual(persisted.status, 0, persisted.stdout);
    assert.match(persisted.stderr, /live-fresh/);
    assert.equal(openStore(root, { mode: 'read' }).events.length, before.events.length, 'forged backdated clock mutated the journal');
  } finally { rmSync(root, { recursive: true, force: true }); }
}
