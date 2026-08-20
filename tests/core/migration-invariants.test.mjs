import assert from 'node:assert/strict';

import { MemoryError, ZERO_HASH, buildEnvelope, foldV2 } from '../../continuity/scripts/lib/core/domain-v2.mjs';

const workspaceAtRecord = { head: 'e'.repeat(40), branch: 'main', dirty: false, statusFingerprint: 'f'.repeat(64), fingerprintPartial: false, capturedAt: '2026-08-15T03:00:00.000Z' };
const actor = (kind, id) => ({ kind, id, role: kind });
const draft = (eventType, subject, payload, by) => ({ eventType, occurredAt: '2026-08-15T03:00:00.000Z', actor: by, subject, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal', payload });

export async function run() {
  const events = [];
  const envelope = (value) => buildEnvelope(value, { epochId: 'epoch-migration-fixture', sequence: events.length + 1, recordedAt: '2026-08-15T03:00:00.000Z', workspaceAtRecord, previousEventHash: events.at(-1)?.eventHash ?? ZERO_HASH });
  const add = (value) => { const event = envelope(value); foldV2([...events, event]); events.push(event); return event; };
  const migrationActor = actor('migration', 'actor-migration');
  add(draft('project.initialized', { type: 'project', id: 'project-migrated' }, { project: { projectId: 'project-migrated', name: 'Migrated fixture', identity: 'Synthetic migration fixture', implementationBoundaries: ['Synthetic only'], operatingRules: ['Preserve legacy meaning'] }, initialization: 'migration' }, migrationActor));
  const imported = add(draft('migration.v1_imported', { type: 'migration', id: 'migration-import' }, { archiveHistory: 'archive/HISTORY.v1.ndjson', historyBytes: 100, historySha256: '1'.repeat(64), eventCount: 2, finalEventHash: '2'.repeat(64), recordChunkCount: 2 }, migrationActor));
  const record = (legacyId) => ({ legacyId, kind: 'activeWork', summary: 'Legacy record retained without inference', sourceRefs: [] });
  assert.throws(() => foldV2([...events, envelope(draft('migration.v1_records_imported', { type: 'migration', id: 'migration-chunk-one' }, { importEventId: imported.eventId, chunkIndex: 1, records: [record('legacy-one')] }, migrationActor))]), MemoryError);
  add(draft('migration.v1_records_imported', { type: 'migration', id: 'migration-chunk-zero' }, { importEventId: imported.eventId, chunkIndex: 0, records: [record('legacy-one')] }, migrationActor));
  const goal = draft('goal.declared', { type: 'goal', id: 'goal-final' }, { goal: { goalId: 'goal-final', title: 'Continue explicitly', outcome: 'Use a user-backed goal after import', isFinal: true, authority: 'user', basis: 'user_stated', criterionIds: [] }, evidenceRef: 'evidence-user-goal' }, actor('coordinator', 'actor-coordinator'));
  assert.throws(() => foldV2([...events, envelope(goal)]), MemoryError);
  assert.throws(() => foldV2([...events, envelope(draft('migration.v1_records_imported', { type: 'migration', id: 'migration-chunk-bad' }, { importEventId: 'event-wrong-link', chunkIndex: 1, records: [record('legacy-two')] }, migrationActor))]), MemoryError);
  add(draft('migration.v1_records_imported', { type: 'migration', id: 'migration-chunk-one' }, { importEventId: imported.eventId, chunkIndex: 1, records: [record('legacy-two')] }, migrationActor));
  add(goal);
  assert.throws(() => foldV2([...events, envelope(draft('migration.v1_records_imported', { type: 'migration', id: 'migration-chunk-extra' }, { importEventId: imported.eventId, chunkIndex: 2, records: [record('legacy-extra')] }, migrationActor))]), MemoryError);
}
