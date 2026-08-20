import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import {
  EVENT_TYPES, MemoryError, REDUCER_HANDLERS, TEMPLATE_REGISTRY, TRANSITION_TABLE, ZERO_HASH,
  buildEnvelope, canonicalV2, foldV2, validateDraft, validateInspectSemantics,
} from '../../continuity/scripts/lib/core/domain-v2.mjs';
import { main as mainV2 } from '../../continuity/scripts/lib/core/cli.mjs';
import { appendV2, initializeV2, rebuildProjection } from '../../continuity/scripts/lib/core/journal-v2.mjs';
import { readLegacyInspectInput, renderLegacyInspectV1 } from '../../continuity/scripts/lib/core/legacy-v1.mjs';
import { readOwnedFileBounded, readV2Journal, storePaths } from '../../continuity/scripts/lib/core/store.mjs';
import { makeRepository, runCli } from '../helpers/repository.mjs';
import { EXPECTED_EVENT_TYPES } from '../helpers/v2-contract-fixture.mjs';
import { run as runAllEventPaths } from './all-event-paths.test.mjs';

const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../continuity/scripts/continuity.mjs');
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../continuity');
const occurredAt = '2026-08-16T00:00:00.000Z';

function initInput(suffix) {
  return {
    schemaVersion: 2,
    project: {
      projectId: `project-truth-${suffix}`,
      name: 'Truth closure fixture',
      identity: 'Synthetic repository only',
      implementationBoundaries: ['No runtime store access'],
      operatingRules: ['Failures must have no effect'],
    },
    finalGoal: {
      goalId: `goal-truth-${suffix}`,
      title: 'Close the truth boundary',
      outcome: 'All paired invariants pass',
      isFinal: true,
      authority: 'user',
      basis: 'user_stated',
      criterionIds: [],
    },
    actor: { kind: 'user', id: 'actor-user', role: 'user' },
    occurredAt,
    evidenceRef: `evidence-user-${suffix}`,
  };
}

function taskDraft(suffix, project) {
  return {
    eventType: 'task.planned',
    occurredAt,
    actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
    subject: { type: 'task', id: `task-truth-${suffix}` },
    goalId: project.finalGoal.goalId,
    taskId: `task-truth-${suffix}`,
    supersedes: [],
    contradicts: [],
    evidenceRefs: [],
    sensitivity: 'internal',
    payload: {
      task: {
        taskId: `task-truth-${suffix}`,
        goalId: project.finalGoal.goalId,
        title: 'Exercise the mutation barrier',
        scope: 'Synthetic truth-closure fixture',
        pathOwnership: ['src/truth-closure'],
        owner: 'actor-subagent',
        dependencyIds: [],
        criterionIds: [],
        userFacing: false,
        requiredForGoal: false,
      },
    },
  };
}

function treeDigest(directory, { excludeGit = false } = {}) {
  const digest = createHash('sha256');
  const visit = (current, relative = '') => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (excludeGit && childRelative === '.git') continue;
      const child = path.join(current, entry.name);
      const kind = entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f';
      digest.update(`${kind}\0${childRelative}\0`);
      if (entry.isDirectory()) visit(child, childRelative);
      else if (entry.isSymbolicLink()) digest.update(readlinkSync(child));
      else {
        digest.update(String(statSync(child).size));
        digest.update('\0');
        digest.update(readFileSync(child));
      }
    }
  };
  visit(directory);
  return digest.digest('hex');
}

function projectDigest(root) {
  return treeDigest(root, { excludeGit: true });
}

function mutationLockPath(root) {
  const value = execFileSync('git', ['-C', root, 'rev-parse', '--git-path', 'project-memory.checkpoint.lock'], {
    encoding: 'utf8',
  }).trim();
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value);
}

function mutationBarrierSnapshot(root, files) {
  return {
    marker: readFileSync(files.migrationMarker),
    history: readFileSync(files.history),
    current: readFileSync(files.current),
    tree: treeDigest(files.store),
    lockPresent: existsSync(mutationLockPath(root)),
  };
}

function assertMutationBarrierUnchanged(root, files, before, label) {
  assert.deepEqual(readFileSync(files.migrationMarker), before.marker, `${label} changed the migration marker`);
  assert.deepEqual(readFileSync(files.history), before.history, `${label} changed HISTORY.ndjson`);
  assert.deepEqual(readFileSync(files.current), before.current, `${label} changed CURRENT.json`);
  assert.equal(treeDigest(files.store), before.tree, `${label} changed the store tree`);
  assert.equal(before.lockPresent, false, `${label} fixture began with lock residue`);
  assert.equal(existsSync(mutationLockPath(root)), false, `${label} left lock residue`);
}

function waitForChildLine(child, expected, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => finish(new Error(`child did not emit ${expected}`)), timeoutMs);
    const finish = (error) => {
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error); else resolve();
    };
    const onData = (chunk) => {
      output += chunk.toString('utf8');
      if (output.split(/\r?\n/).includes(expected)) finish();
    };
    const onError = (error) => finish(error);
    const onExit = (code) => finish(new Error(`child exited ${code} before ${expected}`));
    child.stdout?.on('data', onData);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

function waitForChildExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('child did not exit')), timeoutMs);
    const finish = (error, code) => {
      clearTimeout(timeout);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error); else resolve(code);
    };
    const onError = (error) => finish(error);
    const onExit = (code) => finish(undefined, code);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

function waitForBarrierReady(child, ready, stderr, timeoutMs = 10000) {
  if (existsSync(ready)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let interval;
    let timeout;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timeout);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error); else resolve();
    };
    const check = () => {
      if (existsSync(ready)) finish();
      else if (child.exitCode !== null) finish(new Error(`child exited ${child.exitCode} before synchronized barrier: ${stderr()}`));
    };
    const onError = (error) => finish(error);
    const onExit = (code) => finish(new Error(`child exited ${code} before synchronized barrier: ${stderr()}`));
    child.on('error', onError);
    child.on('exit', onExit);
    check();
    if (!settled) {
      interval = setInterval(check, 5);
      timeout = setTimeout(() => finish(new Error(`child did not reach synchronized barrier: ${stderr()}`)), timeoutMs);
    }
  });
}

function canonicalLegacy(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalLegacy).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalLegacy(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function writeDraft(root, name, draft) {
  const file = path.join(root, name);
  writeFileSync(file, `${JSON.stringify(draft)}\n`);
  return file;
}

function validMigrationMarker(phase) {
  return {
    markerVersion: 1,
    migrationId: 'migration-truth-marker',
    phase,
    startedAt: occurredAt,
    updatedAt: occurredAt,
    source: {
      historyPath: 'HISTORY.ndjson', historyBytes: 0, historySha256: 'a'.repeat(64),
      eventCount: 0, finalEventHash: 'b'.repeat(64),
    },
    targets: {
      archiveHistory: 'HISTORY.v1.ndjson', archiveCurrent: 'CURRENT.v1.json',
      v2History: 'HISTORY.ndjson', v2Current: 'CURRENT.json',
    },
    temps: {
      v2History: 'MIGRATION.v1-to-v2.history.tmp',
      v2Current: 'MIGRATION.v1-to-v2.current.tmp',
    },
    v2EpochId: 'epoch-truth-marker',
  };
}

function compileInspect() {
  const contract = JSON.parse(readFileSync(path.join(skillRoot, 'references', 'v2-contract.schema.json'), 'utf8'));
  const inspect = JSON.parse(readFileSync(path.join(skillRoot, 'references', 'inspect-v1.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(contract);
  return ajv.compile(inspect);
}

function compileSchemaDefinition(schemaName, definitionName) {
  const contract = JSON.parse(readFileSync(path.join(skillRoot, 'references', 'v2-contract.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(contract);
  if (schemaName === 'v2-contract.schema.json') return ajv.getSchema(`${contract.$id}#/$defs/${definitionName}`);
  const schema = JSON.parse(readFileSync(path.join(skillRoot, 'references', schemaName), 'utf8'));
  ajv.addSchema(schema);
  return ajv.getSchema(`${schema.$id}#/$defs/${definitionName}`);
}

function compileSchemaDocument(schemaName) {
  const contract = JSON.parse(readFileSync(path.join(skillRoot, 'references', 'v2-contract.schema.json'), 'utf8'));
  const schema = JSON.parse(readFileSync(path.join(skillRoot, 'references', schemaName), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(contract);
  return ajv.compile(schema);
}

function workspaceObservation(head = '1'.repeat(40), dirty = false) {
  return {
    head, branch: 'main', dirty, statusFingerprint: '2'.repeat(64),
    fingerprintPartial: false, capturedAt: occurredAt,
  };
}

function coordinatorInspect() {
  const recorded = workspaceObservation();
  return {
    inspectVersion: 1,
    view: 'coordinator',
    generatedAt: occurredAt,
    store: {
      schemaVersion: 2, epochId: 'epoch-truth-inspect', sequence: 2,
      eventHash: '3'.repeat(64), journalState: 'valid', projectionState: 'current', partialTail: false,
    },
    project: {
      projectId: 'project-truth-inspect', name: 'Truth inspect', identity: 'Synthetic inspect fixture',
      finalGoal: {
        goalId: 'goal-truth-inspect', title: 'Close the inspect truth boundary',
        outcome: 'Emit only semantically closed views', lifecycle: 'active', acceptance: 'pending',
        verification: 'not_run', freshness: 'unknown', criterionIds: [], failureIds: [], warningIds: [],
      },
    },
    criteria: [],
    boundaries: [],
    attention: {
      goalFailures: [], blocked: [], failed: [], verificationFailed: [],
      rejected: [], contested: [], stale: [],
    },
    tasks: [],
    nextActions: [],
    handoffs: [],
    feedback: [],
    evidenceSummary: [],
    workspaceDrift: {
      recorded, current: structuredClone(recorded), headDrift: false, statusDrift: false,
      fingerprintState: 'full',
    },
    sourceDrift: [],
    graphifyReceipts: [],
    legacy: [],
    warnings: [],
  };
}

function goalFailureSummary() {
  return {
    failureId: 'failure-truth-goal',
    subject: { type: 'goal', id: 'goal-truth-inspect' },
    terminal: 'blocked',
    responsibleBoundary: 'Synthetic dependency',
    observedSymptom: 'The synthetic goal is blocked',
    impact: 'The acceptance fixture cannot complete',
    unchanged: ['No production state changed'],
    rootCause: { state: 'unknown', summary: 'The upstream cause is not confirmed' },
    nextAction: 'Verify the synthetic dependency',
    evidenceRefs: ['evidence-truth-failure'],
  };
}

function taskAttentionSummary(category, index = 0) {
  const states = {
    blocked: { execution: 'blocked', verification: 'not_run', acceptance: 'not_requested' },
    failed: { execution: 'failed', verification: 'not_run', acceptance: 'not_requested' },
    verificationFailed: { execution: 'implemented', verification: 'failed', acceptance: 'pending' },
    rejected: { execution: 'completed', verification: 'passed', acceptance: 'rejected' },
  };
  return {
    taskId: `task-${category.toLowerCase()}-${index}`, title: `Attention ${category} ${index}`,
    owner: 'actor-subagent', ...states[category], freshness: 'unknown', failureIds: [],
  };
}

function attentionItem(category, index = 0) {
  if (category === 'goalFailures') {
    const value = goalFailureSummary();
    value.failureId = `failure-attention-${index}`;
    return value;
  }
  if (['blocked', 'failed', 'verificationFailed', 'rejected'].includes(category)) {
    return taskAttentionSummary(category, index);
  }
  if (category === 'contested') {
    return {
      contradictionId: `contradiction-attention-${index}`, claimKey: 'a'.repeat(64),
      claimIds: [`claim-attention-a-${index}`, `claim-attention-b-${index}`], state: 'contested',
    };
  }
  return {
    evidenceId: `evidence-attention-${index}`, kind: 'test', subjectId: `task-stale-${index}`,
    outcome: 'observed', observedAt: occurredAt, freshness: 'stale', scope: `Stale evidence ${index}`,
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function handoffInspect() {
  const view = coordinatorInspect();
  view.view = 'handoff';
  view.project.finalGoal = {
    goalId: 'goal-truth-inspect', title: 'Close the handoff truth boundary',
    outcome: 'Only linked bounded assignment context is emitted', lifecycle: 'active',
    acceptance: 'pending', verification: 'not_run', freshness: 'unknown', criterionIds: ['criterion-handoff'],
    failureIds: [], warningIds: [],
  };
  view.criteria = [{
    criterionId: 'criterion-handoff', condition: 'The handoff stays linked', scope: 'Synthetic handoff',
    lifecycle: 'active', verification: 'not_run', freshness: 'unknown', evidenceRefs: ['evidence-handoff'],
  }];
  view.tasks = [{
    taskId: 'task-handoff', title: 'Exercise the handoff view', scope: 'Synthetic handoff',
    owner: 'actor-subagent', requiredForGoal: false, execution: 'planned', verification: 'not_run',
    acceptance: 'not_requested', freshness: 'unknown', dependencyIds: [],
    criterionIds: ['criterion-handoff'], warningIds: [],
  }];
  view.handoffs = [{
    handoffId: 'handoff-detail', taskId: 'task-handoff', assignmentId: 'assignment-handoff',
    parentRunId: 'run-parent', owner: 'actor-subagent', scope: 'Synthetic handoff',
    pathOwnership: ['src/handoff'], criterionIds: ['criterion-handoff'],
    deliverables: ['Return a bounded report'], prohibitedActions: ['Do not mutate unrelated files'],
    state: 'assigned', warningIds: [],
  }];
  view.selectedEvidence = [{
    evidenceId: 'evidence-handoff', kind: 'test', subjectId: 'task-handoff', outcome: 'observed',
    observedAt: occurredAt, freshness: 'unknown', scope: 'Synthetic handoff evidence',
    locator: 'checks/handoff-linkage',
  }];
  view.evidenceSummary = [{
    evidenceId: 'evidence-handoff', kind: 'test', subjectId: 'task-handoff', outcome: 'observed',
    observedAt: occurredAt, freshness: 'unknown', scope: 'Synthetic handoff evidence',
  }];
  return view;
}

function foldFixtureEvents() {
  const events = [];
  const workspaceAtRecord = workspaceObservation();
  const add = (draft) => {
    const event = buildEnvelope(draft, {
      epochId: 'epoch-truth-feedback', sequence: events.length + 1, recordedAt: occurredAt,
      workspaceAtRecord, previousEventHash: events.at(-1)?.eventHash ?? ZERO_HASH,
    });
    foldV2([...events, event]);
    events.push(event);
  };
  const actor = { kind: 'user', id: 'actor-user', role: 'user' };
  add({
    eventType: 'project.initialized', occurredAt, actor,
    subject: { type: 'project', id: 'project-truth-feedback' },
    supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal',
    payload: {
      project: {
        projectId: 'project-truth-feedback', name: 'Feedback truth', identity: 'Synthetic feedback fixture',
        implementationBoundaries: [], operatingRules: [],
      },
      initialization: 'new',
    },
  });
  add({
    eventType: 'goal.declared', occurredAt, actor,
    subject: { type: 'goal', id: 'goal-truth-feedback' }, goalId: 'goal-truth-feedback',
    supersedes: [], contradicts: [], evidenceRefs: ['evidence-user-goal'], sensitivity: 'internal',
    payload: {
      goal: {
        goalId: 'goal-truth-feedback', title: 'Close feedback truth', outcome: 'Feedback remains coupled',
        isFinal: true, authority: 'user', basis: 'user_stated', criterionIds: [],
      },
      evidenceRef: 'evidence-user-goal',
    },
  });
  add({
    eventType: 'evidence.recorded', occurredAt, actor,
    subject: { type: 'goal', id: 'goal-truth-feedback' }, goalId: 'goal-truth-feedback',
    supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal',
    payload: {
      evidence: {
        evidenceId: 'evidence-user-feedback', kind: 'user_message', subjectId: 'goal-truth-feedback',
        scope: 'Synthetic feedback', locator: 'user-message-feedback', observedAt: occurredAt,
        verifier: { kind: 'user', id: 'actor-user' }, method: 'Synthetic user feedback', outcome: 'observed',
        policy: { kind: 'immutable_until_superseded' }, sourceRefs: [], sensitivity: 'internal',
      },
    },
  });
  return events;
}

function foldFixtureState() { return foldV2(foldFixtureEvents()); }

function feedbackDraft(eventType, feedback) {
  return {
    eventType, occurredAt,
    actor: { kind: 'user', id: 'actor-user', role: 'user' },
    subject: { type: 'goal', id: 'goal-truth-feedback' }, goalId: 'goal-truth-feedback',
    supersedes: [], contradicts: [], evidenceRefs: ['evidence-user-feedback'], sensitivity: 'internal',
    payload: {
      feedback: {
        feedbackId: `feedback-${eventType.split('.')[1]}-truth`, subjectId: 'goal-truth-feedback',
        statement: 'Synthetic user feedback', evidenceRef: 'evidence-user-feedback',
        ...feedback,
      },
    },
  };
}

function assertMarkerBarrier() {
  const roots = [];
  const makeRoot = (label) => { const root = makeRepository(label); roots.push(root); return root; };
  try {
    const publicRoot = makeRoot('truth-marker-public');
    const publicInput = initInput('public');
    initializeV2(publicRoot, publicInput, { clock: () => new Date(occurredAt) });
    const firstDraft = taskDraft('public-clean', publicInput);
    const firstFile = writeDraft(publicRoot, 'public-clean.json', firstDraft);
    let result = runCli(helper, publicRoot, ['record', '--file', firstFile]);
    assert.equal(result.status, 0, result.stderr);

    const publicFiles = storePaths(publicRoot);
    writeFileSync(publicFiles.migrationMarker, '{}\n');
    const blockedDraft = taskDraft('public-blocked', publicInput);
    const blockedFile = writeDraft(publicRoot, 'public-blocked.json', blockedDraft);
    const publicBefore = treeDigest(publicFiles.store);
    result = runCli(helper, publicRoot, ['record', '--file', blockedFile]);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /continuity: ERROR:/);
    assert.equal(treeDigest(publicFiles.store), publicBefore, 'marker-blocked public record changed the store');

    const directRoot = makeRoot('truth-marker-direct');
    const directInput = initInput('direct');
    initializeV2(directRoot, directInput, { clock: () => new Date(occurredAt) });
    assert.doesNotThrow(() => appendV2(directRoot, taskDraft('direct-clean', directInput)));
    const directFiles = storePaths(directRoot);
    writeFileSync(directFiles.current, '{"stale":"projection sentinel"}\n');
    writeFileSync(directFiles.migrationMarker, '{}\n');
    const directBefore = mutationBarrierSnapshot(directRoot, directFiles);
    let extraDraftReads = 0;
    let extraAuthorityCalls = 0;
    const extraDraft = new Proxy(taskDraft('direct-extra-options', directInput), {
      get(target, property, receiver) { extraDraftReads += 1; return Reflect.get(target, property, receiver); },
    });
    const extraAuthority = new Proxy({}, {
      get() { extraAuthorityCalls += 1; throw new Error('caller authority was invoked'); },
      ownKeys() { extraAuthorityCalls += 1; throw new Error('caller authority was inspected'); },
      getOwnPropertyDescriptor() { extraAuthorityCalls += 1; throw new Error('caller authority was inspected'); },
    });
    assert.throws(
      () => appendV2(directRoot, extraDraft, extraAuthority),
      (error) => error instanceof MemoryError
        && error.exitCode === 3
        && error.message === 'appendV2 does not accept caller options',
      'direct append did not reject its third public argument before authority access',
    );
    assert.equal(extraDraftReads, 0, 'third-argument rejection read the caller draft');
    assert.equal(extraAuthorityCalls, 0, 'third-argument rejection inspected caller authority');
    assertMutationBarrierUnchanged(directRoot, directFiles, directBefore, 'third-argument direct append');

    let draftReads = 0;
    const hostileDraft = new Proxy(taskDraft('direct-blocked', directInput), {
      get(target, property, receiver) {
        draftReads += 1;
        unlinkSync(directFiles.migrationMarker);
        return Reflect.get(target, property, receiver);
      },
    });
    assert.throws(
      () => appendV2(directRoot, hostileDraft),
      (error) => error instanceof MemoryError && error.exitCode === 3 && /mutation is blocked/.test(error.message),
    );
    assert.equal(draftReads, 0, 'marker-blocked direct append read caller-owned draft input');
    assertMutationBarrierUnchanged(directRoot, directFiles, directBefore, 'marker-blocked direct append');

    let initializeClockCalls = 0;
    assert.throws(
      () => initializeV2(directRoot, directInput, {
        clock: () => {
          initializeClockCalls += 1;
          unlinkSync(directFiles.migrationMarker);
          return new Date(occurredAt);
        },
      }),
      (error) => error instanceof MemoryError && error.exitCode === 3 && /mutation is blocked/.test(error.message),
    );
    assert.equal(initializeClockCalls, 0, 'marker-blocked direct initialize invoked the public clock');
    assertMutationBarrierUnchanged(directRoot, directFiles, directBefore, 'marker-blocked direct initialize');

    let rebuildClockCalls = 0;
    assert.throws(
      () => rebuildProjection(directRoot, {
        clock: () => {
          rebuildClockCalls += 1;
          unlinkSync(directFiles.migrationMarker);
          return new Date(occurredAt);
        },
      }),
      (error) => error instanceof MemoryError
        && error.exitCode === 3
        && error.message === 'rebuildProjection does not accept caller options',
    );
    assert.equal(rebuildClockCalls, 0, 'extra-argument direct rebuild invoked a caller clock');
    assertMutationBarrierUnchanged(directRoot, directFiles, directBefore, 'extra-argument direct rebuild');

    const raceRoot = makeRoot('truth-marker-post-lock-race');
    const raceFiles = storePaths(raceRoot);
    const raceMarker = '{"synthetic":"clock-created-race"}\n';
    let raceClockCalls = 0;
    assert.throws(
      () => initializeV2(raceRoot, initInput('post-lock-race'), {
        clock: () => {
          raceClockCalls += 1;
          mkdirSync(raceFiles.store, { recursive: true });
          writeFileSync(raceFiles.migrationMarker, raceMarker);
          return new Date(occurredAt);
        },
      }),
      (error) => error instanceof MemoryError && error.exitCode === 3 && /mutation is blocked/.test(error.message),
    );
    assert.equal(raceClockCalls, 1, 'the public init clock supplied lock metadata or ran more than once');
    assert.equal(readFileSync(raceFiles.migrationMarker, 'utf8'), raceMarker);
    assert.equal(existsSync(raceFiles.history), false, 'post-lock marker race created HISTORY.ndjson');
    assert.equal(existsSync(raceFiles.current), false, 'post-lock marker race created CURRENT.json');
    assert.deepEqual(readdirSync(raceFiles.store), [path.basename(raceFiles.migrationMarker)]);
    assert.equal(existsSync(mutationLockPath(raceRoot)), false, 'post-lock marker race left lock residue');
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

async function assertProjectionTempIdentityRace() {
  const root = makeRepository('truth-projection-temp-race');
  const barrier = mkdtempSync(path.join(os.tmpdir(), 'project-memory-truth-projection-barrier-'));
  let helperProcess;
  try {
    const input = initInput('projection-temp-race');
    input.project.implementationBoundaries = Array.from(
      { length: 24 },
      (_, index) => `Boundary ${index} ${'x'.repeat(900)}`,
    );
    input.project.operatingRules = Array.from(
      { length: 24 },
      (_, index) => `Rule ${index} ${'y'.repeat(900)}`,
    );
    initializeV2(root, input, { clock: () => new Date(occurredAt) });
    const files = storePaths(root);
    const ready = path.join(barrier, 'ready.json');
    const release = path.join(barrier, 'release');
    const journalModule = new URL('../../continuity/scripts/lib/core/journal-v2.mjs', import.meta.url).href;
    const helperScript = String.raw`
      (async () => {
        try {
          const { rebuildProjection } = await import(${JSON.stringify(journalModule)});
          rebuildProjection(process.argv[1]);
        } catch (error) {
          process.stderr.write(String(error && error.message || error) + '\n');
          process.exitCode = Number.isInteger(error && error.exitCode) ? error.exitCode : 1;
        }
      })();
    `;
    let helperStderr = '';
    helperProcess = spawn(process.execPath, ['-e', helperScript, root], {
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PROJECT_MEMORY_TEST_BARRIER_POINT: 'journal-projection-before-rename',
        PROJECT_MEMORY_TEST_BARRIER_DIR: barrier,
      },
    });
    helperProcess.stderr.setEncoding('utf8');
    helperProcess.stderr.on('data', (chunk) => { helperStderr += chunk; });
    const exited = waitForChildExit(helperProcess);
    await waitForBarrierReady(helperProcess, ready, () => helperStderr);

    const details = JSON.parse(readFileSync(ready, 'utf8'));
    assert.equal(details.point, 'journal-projection-before-rename');
    assert.ok(existsSync(details.temporary), 'barrier reported a missing projection temporary');
    assert.equal(fs.realpathSync.native(details.current), fs.realpathSync.native(files.current));
    assert.equal(fs.realpathSync.native(path.dirname(details.temporary)), fs.realpathSync.native(files.store));
    assert.ok(details.rollback && existsSync(details.rollback), 'barrier reported a missing projection rollback link');
    assert.equal(fs.realpathSync.native(path.dirname(details.rollback)), fs.realpathSync.native(files.store));

    const beforeBytes = readFileSync(files.current);
    const beforeIdentity = lstatSync(files.current);
    const rollbackIdentity = lstatSync(details.rollback);
    assert.equal(rollbackIdentity.dev, beforeIdentity.dev, 'barrier rollback link changed canonical projection device');
    assert.equal(rollbackIdentity.ino, beforeIdentity.ino, 'barrier rollback link did not retain canonical projection identity');
    assert.equal(rollbackIdentity.nlink, 2, 'barrier rollback link did not retain the expected two-link identity');
    const temporaryBytes = readFileSync(details.temporary);
    const temporaryIdentity = lstatSync(details.temporary);
    assert.deepEqual(temporaryBytes, beforeBytes, 'rebuild temporary did not contain the canonical projection bytes');
    const displaced = `${details.temporary}.externally-displaced`;
    fs.renameSync(details.temporary, displaced);
    writeFileSync(details.temporary, 'external projection replacement\n', { flag: 'wx' });
    assert.deepEqual(readFileSync(displaced), temporaryBytes, 'helper did not displace the exact owned temporary');
    assert.equal(readFileSync(details.temporary, 'utf8'), 'external projection replacement\n');
    writeFileSync(release, 'release\n', { flag: 'wx' });

    assert.equal(await exited, 3, `temp substitution did not fail closed: ${helperStderr}`);
    assert.deepEqual(readFileSync(files.current), beforeBytes, 'temp substitution changed canonical projection bytes');
    const afterIdentity = lstatSync(files.current);
    assert.equal(afterIdentity.dev, beforeIdentity.dev, 'temp substitution changed canonical projection device');
    assert.equal(afterIdentity.ino, beforeIdentity.ino, 'temp substitution changed canonical projection identity');
    const displacedIdentity = lstatSync(displaced);
    assert.equal(displacedIdentity.dev, temporaryIdentity.dev, 'helper displaced a different projection temporary device');
    assert.equal(displacedIdentity.ino, temporaryIdentity.ino, 'helper displaced a different projection temporary identity');
    assert.equal(readFileSync(details.temporary, 'utf8'), 'external projection replacement\n', 'cleanup removed or changed an unowned replacement');
    assert.deepEqual(readFileSync(displaced), temporaryBytes, 'the retained descriptor did not preserve the displaced owned temp');
    assert.equal(existsSync(details.rollback), false, 'temp substitution left projection rollback residue');
    assert.equal(existsSync(mutationLockPath(root)), false, 'temp substitution left lock residue');
  } finally {
    if (helperProcess && helperProcess.exitCode === null) helperProcess.kill();
    rmSync(barrier, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDescriptorBoundedReadRace() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'project-memory-descriptor-race-'));
  try {
    const safeFile = path.join(root, 'safe-archive.bin');
    const safeBytes = Buffer.from('safe bounded archive bytes\n');
    writeFileSync(safeFile, safeBytes);
    assert.deepEqual(
      readOwnedFileBounded(safeFile, safeBytes.length + 1024, 'synthetic archive'),
      safeBytes,
      'stable short regular descriptor read changed bytes',
    );

    const target = path.join(root, 'race-marker.bin');
    const replacement = path.join(root, 'race-marker.replacement');
    const byteLimit = 32 * 1024 * 1024;
    let observedPostOpenSwap = false;
    for (const delay of [1, 2, 4, 8]) {
      writeFileSync(target, Buffer.alloc(byteLimit, 0x61));
      writeFileSync(replacement, Buffer.alloc(byteLimit, 0x62));
      const helperScript = String.raw`
        const fs = require('node:fs');
        const target = process.argv[1];
        const replacement = process.argv[2];
        const delay = Number(process.argv[3]);
        process.stdout.write('READY\n');
        setTimeout(() => {
          const displaced = target + '.displaced';
          fs.rmSync(displaced, { force: true });
          fs.renameSync(target, displaced);
          fs.renameSync(replacement, target);
          fs.rmSync(displaced, { force: true });
        }, delay);
      `;
      const helperProcess = spawn(process.execPath, ['-e', helperScript, target, replacement, String(delay)], {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      const exited = waitForChildExit(helperProcess);
      await waitForChildLine(helperProcess, 'READY');
      let error;
      try { readOwnedFileBounded(target, byteLimit, 'synthetic marker'); } catch (caught) { error = caught; }
      assert.equal(await exited, 0, 'external descriptor-race helper failed');
      if (error instanceof MemoryError && error.exitCode === 3 && error.message === 'synthetic marker changed while being read') {
        observedPostOpenSwap = true;
        break;
      }
    }
    assert.equal(observedPostOpenSwap, true, 'post-open path substitution did not fail from descriptor evidence');

    const growing = path.join(root, 'growing-legacy.bin');
    writeFileSync(growing, Buffer.alloc(byteLimit - 4096, 0x63));
    const originalGrowthReadSync = fs.readSync;
    let interceptedGrowthRead = false;
    let growthError;
    try {
      fs.readSync = (...args) => {
        const count = originalGrowthReadSync(...args);
        if (!interceptedGrowthRead) {
          interceptedGrowthRead = true;
          fs.appendFileSync(growing, Buffer.alloc(8192, 0x64));
        }
        return count;
      };
      syncBuiltinESMExports();
      try { readOwnedFileBounded(growing, byteLimit, 'synthetic legacy archive'); } catch (caught) { growthError = caught; }
    } finally {
      fs.readSync = originalGrowthReadSync;
      syncBuiltinESMExports();
    }
    assert.equal(interceptedGrowthRead, true, 'growth fixture did not intercept the first descriptor read');
    assert.equal(fs.readSync, originalGrowthReadSync, 'growth fixture leaked its built-in read instrumentation');
    assert.equal(lstatSync(growing).size, byteLimit + 4096, 'growth fixture did not grow the file over the cap');
    assert.ok(
      growthError instanceof MemoryError && growthError.exitCode === 3
        && growthError.message === 'synthetic legacy archive changed while being read',
      'descriptor growth over the cap did not fail closed',
    );

    const shrinking = path.join(root, 'shrinking-journal.bin');
    writeFileSync(shrinking, Buffer.alloc(byteLimit, 0x65));
    const originalReadSync = fs.readSync;
    let interceptedDescriptorRead = false;
    let partialReadError;
    try {
      fs.readSync = (...args) => {
        const count = originalReadSync(...args);
        if (!interceptedDescriptorRead) {
          interceptedDescriptorRead = true;
          fs.truncateSync(shrinking, 1024);
        }
        return count;
      };
      syncBuiltinESMExports();
      try { readOwnedFileBounded(shrinking, byteLimit, 'synthetic journal'); } catch (caught) { partialReadError = caught; }
    } finally {
      fs.readSync = originalReadSync;
      syncBuiltinESMExports();
    }
    assert.equal(interceptedDescriptorRead, true, 'partial-read fixture did not intercept the descriptor read');
    assert.equal(fs.readSync, originalReadSync, 'partial-read fixture leaked its built-in read instrumentation');
    assert.equal(lstatSync(shrinking).size, 1024, 'partial-read fixture did not truncate after the descriptor read');
    assert.ok(
      partialReadError instanceof MemoryError && partialReadError.exitCode === 3
        && partialReadError.message === 'synthetic journal changed while being read',
      'descriptor partial read did not fail closed',
    );
    assert.deepEqual(
      readdirSync(root).sort(),
      ['growing-legacy.bin', 'race-marker.bin', 'safe-archive.bin', 'shrinking-journal.bin'],
      'bounded read created or removed race files',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertMarkerRouting() {
  const root = makeRepository('truth-marker-routing');
  try {
    const input = initInput('routing');
    initializeV2(root, input, { clock: () => new Date(occurredAt) });
    const files = storePaths(root);
    const phases = [
      'prepared', 'history_archived', 'current_archived',
      'v2_journal_installed', 'v2_projection_installed', 'complete',
    ];
    for (const phase of phases) {
      writeFileSync(files.migrationMarker, `${JSON.stringify(validMigrationMarker(phase))}\n`);
      const phaseBefore = treeDigest(files.store);
      for (const { args, input: checkpointInput } of [
        { args: ['checkpoint', '--file', files.current] },
        { args: ['checkpoint', '--stdin'], input: '{}\n' },
        { args: ['checkpoint', '--dry-run', '--file', files.current] },
      ]) {
        const checkpoint = runCli(helper, root, args, checkpointInput);
        assert.equal(checkpoint.status, 3, `${phase} ${args.join(' ')}\n${checkpoint.stderr}`);
        assert.match(checkpoint.stderr, /^continuity: ERROR:/);
        assert.equal(treeDigest(files.store), phaseBefore, `${phase} ${args.join(' ')} changed the store`);
      }
      for (const mutation of [
        () => appendV2(root, taskDraft(`direct-${phase}`, input)),
        () => rebuildProjection(root),
      ]) {
        assert.throws(mutation, (error) => error instanceof MemoryError && error.exitCode === 3);
        assert.equal(treeDigest(files.store), phaseBefore, `direct journal mutator changed the ${phase} store`);
      }
    }

    writeFileSync(files.migrationMarker, `${JSON.stringify(validMigrationMarker('prepared'))}\n`);
    const before = treeDigest(files.store);

    const initFile = writeDraft(root, 'marker-blocked-init.json', input);
    const recordFile = writeDraft(root, 'marker-blocked-record.json', taskDraft('marker-public-callback', input));
    const callbackCalls = { clock: 0, migration: 0, continuity: 0, graphify: 0 };
    const removeMarker = (kind, result) => {
      callbackCalls[kind] += 1;
      unlinkSync(files.migrationMarker);
      return result;
    };
    const hostileIo = {
      clock: () => removeMarker('clock', new Date(occurredAt)),
      migrationCommandHandler: () => removeMarker('migration', 64),
      continuityCommandHandler: () => removeMarker('continuity', 65),
      graphifyCommandHandler: () => removeMarker('graphify', 66),
    };
    for (const args of [
      ['init', '--schema', '2', '--file', initFile],
      ['record', '--file', recordFile],
      ['checkpoint'],
      ['migrate', '--to', '2'],
    ]) {
      const snapshot = mutationBarrierSnapshot(root, files);
      const result = await awaitMain(['--root', root, ...args], hostileIo);
      assert.equal(result.status, 3, `${args.join(' ')}\n${result.stderr}`);
      assert.match(result.stderr, /mutation is blocked/);
      assert.deepEqual(callbackCalls, { clock: 0, migration: 0, continuity: 0, graphify: 0 }, `${args.join(' ')} invoked a caller callback`);
      assertMutationBarrierUnchanged(root, files, snapshot, `public ${args[0]}`);
    }

    for (const args of [
      ['init'],
      ['checkpoint'],
      ['migrate', '--to', '2'],
      ['migrate', '--to', '2', '--dry-run'],
    ]) {
      const result = runCli(helper, root, args);
      assert.equal(result.status, 3, `${args.join(' ')}\n${result.stderr}`);
      assert.equal(treeDigest(files.store), before, `${args.join(' ')} changed the prepared store`);
    }

    const migrationCalls = [];
    const migrationCommandHandler = (context, args) => {
      migrationCalls.push({ operation: context.operation, args: [...args] });
      return 67;
    };
    for (const action of ['--resume', '--rollback']) {
      const result = await awaitMain(['--root', root, 'migrate', '--to', '2', action], { migrationCommandHandler });
      assert.equal(result.status, 67, result.stderr);
      assert.equal(treeDigest(files.store), before, `${action} changed the store in the core dispatch seam`);
    }
    assert.deepEqual(migrationCalls, [
      { operation: 'migrate', args: [] },
      { operation: 'migrate', args: [] },
    ]);

    assert.throws(
      () => initializeV2(root, input, { clock: () => new Date(occurredAt) }),
      (error) => error instanceof MemoryError && error.exitCode === 3,
    );
    assert.equal(treeDigest(files.store), before, 'direct initialize changed the prepared store');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertMalformedComponents() {
  const roots = [];
  const makeRoot = (label) => { const root = makeRepository(label); roots.push(root); return root; };
  try {
    const missingRoot = makeRoot('truth-missing-store');
    const missingBefore = projectDigest(missingRoot);
    let result = runCli(helper, missingRoot, ['validate']);
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(missingRoot, '.continuity')), false, 'read path created .continuity');
    assert.equal(projectDigest(missingRoot), missingBefore, 'read path changed an uninitialized repository');
    const missingInput = initInput('missing');
    const missingFile = writeDraft(missingRoot, 'init.json', missingInput);
    result = runCli(helper, missingRoot, ['init', '--schema', '2', '--file', missingFile]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(storePaths(missingRoot).history), true, 'explicit init did not create the safe missing store');

    for (const [label, arrange] of [
      ['continuity-file', (root) => writeFileSync(path.join(root, '.continuity'), 'malformed component\n')],
      ['store-file', (root) => {
        writeFileSync(path.join(root, '.continuity'), 'malformed component\n');
      }],
    ]) {
      const root = makeRoot(`truth-${label}`);
      const inputFile = writeDraft(root, 'init.json', initInput(label));
      arrange(root);
      const before = projectDigest(root);
      for (const args of [['validate'], ['init', '--schema', '2', '--file', inputFile]]) {
        result = runCli(helper, root, args);
        assert.equal(result.status, 3, `${label} ${args.join(' ')}\n${result.stderr}`);
        assert.match(result.stderr, /continuity: ERROR:/);
        assert.equal(projectDigest(root), before, `${label} ${args.join(' ')} changed the repository`);
      }
    }

    const outsideRoot = makeRoot('truth-outside-component');
    const outsideTarget = path.join(outsideRoot, 'outside-store');
    mkdirSync(outsideTarget);
    writeFileSync(path.join(outsideTarget, 'sentinel.txt'), 'outside bytes stay unchanged\n');
    const linkedRoot = makeRoot('truth-linked-component');
    const linkedInput = writeDraft(linkedRoot, 'init.json', initInput('linked-component'));
    symlinkSync(outsideTarget, path.join(linkedRoot, '.continuity'), process.platform === 'win32' ? 'junction' : 'dir');
    const linkedBefore = projectDigest(linkedRoot);
    const outsideBefore = treeDigest(outsideTarget);
    for (const args of [['validate'], ['init', '--schema', '2', '--file', linkedInput]]) {
      result = runCli(helper, linkedRoot, args);
      assert.equal(result.status, 3, `${args.join(' ')}\n${result.stderr}`);
      assert.equal(projectDigest(linkedRoot), linkedBefore, 'linked component changed the repository');
      assert.equal(treeDigest(outsideTarget), outsideBefore, 'linked component changed the outside target');
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

function assertGoalFailureAttention() {
  const validate = compileInspect();
  const goalFixture = coordinatorInspect();
  goalFixture.attention.goalFailures = [goalFailureSummary()];
  goalFixture.project.finalGoal.failureIds = ['failure-truth-goal'];
  assert.equal(validate(goalFixture), true, JSON.stringify(validate.errors));
  assert.equal(validateInspectSemantics(goalFixture), goalFixture);

  const wrongGoal = structuredClone(goalFixture);
  wrongGoal.attention.goalFailures[0].subject.id = 'goal-unrelated';
  assert.equal(validate(wrongGoal), true, JSON.stringify(validate.errors));
  assert.throws(() => validateInspectSemantics(wrongGoal), MemoryError, 'goal failure crossed onto another goal');

  const unlinkedFailure = structuredClone(goalFixture);
  unlinkedFailure.project.finalGoal.failureIds = [];
  assert.equal(validate(unlinkedFailure), true, JSON.stringify(validate.errors));
  assert.throws(() => validateInspectSemantics(unlinkedFailure), MemoryError, 'goal failure was absent from finalGoal failureIds');

  const taskFixture = structuredClone(goalFixture);
  taskFixture.attention.goalFailures[0].subject = { type: 'task', id: 'task-truth-inspect' };
  taskFixture.attention.goalFailures[0].owner = 'actor-subagent';
  assert.equal(validate(taskFixture), false, 'goalFailures accepted a task-subject failure');
}

function assertFeedbackCoupling() {
  const state = foldFixtureState();
  const eventDraft = compileSchemaDefinition('v2-contract.schema.json', 'EventDraft');
  const feedbackState = compileSchemaDefinition('projection-v2.schema.json', 'FeedbackState');
  const inspect = compileInspect();
  const satisfied = feedbackDraft('feedback.satisfied', {
    disposition: 'satisfied', acceptanceEffect: 'accept', baselineApproachId: 'approach-accepted',
    baselineHypothesisId: 'hypothesis-accepted', lessonId: 'lesson-accepted',
    nextAction: 'Continue with the accepted bounded result', correctionPlan: 'Retain the accepted bounded approach',
  });
  const rejected = feedbackDraft('feedback.rejected', {
    disposition: 'rejected', acceptanceEffect: 'reject', baselineApproachId: 'approach-old',
    baselineHypothesisId: 'hypothesis-old', nextAction: 'Use a different bounded approach',
  });
  const dissatisfied = feedbackDraft('feedback.dissatisfied', {
    disposition: 'dissatisfied', acceptanceEffect: 'keep_pending', baselineApproachId: 'approach-old',
    baselineHypothesisId: 'hypothesis-old', correctionPlan: 'Revise the synthetic implementation',
  });
  for (const draft of [satisfied, rejected, dissatisfied]) {
    assert.equal(eventDraft(draft), true, JSON.stringify(eventDraft.errors));
    assert.doesNotThrow(() => validateDraft(draft, state));
  }

  const envelopeSchema = compileSchemaDefinition('v2-contract.schema.json', 'EventEnvelope');
  const satisfiedEvents = foldFixtureEvents();
  const satisfiedEvent = buildEnvelope(satisfied, {
    epochId: satisfiedEvents[0].epochId, sequence: satisfiedEvents.length + 1, recordedAt: occurredAt,
    workspaceAtRecord: workspaceObservation(), previousEventHash: satisfiedEvents.at(-1).eventHash,
  });
  assert.equal(envelopeSchema(satisfiedEvent), true, JSON.stringify(envelopeSchema.errors));
  const satisfiedReplay = foldV2([...satisfiedEvents, satisfiedEvent]);
  const satisfiedState = satisfiedReplay.feedback.find((item) => item.feedbackId === satisfied.payload.feedback.feedbackId);
  assert.equal(satisfiedState.nextAction, satisfied.payload.feedback.nextAction);
  assert.equal(satisfiedState.correctionPlan, satisfied.payload.feedback.correctionPlan);
  assert.equal(feedbackState(satisfiedState), true, JSON.stringify(feedbackState.errors));
  assert.equal(
    satisfiedReplay.goals.find((item) => item.goalId === satisfied.payload.feedback.subjectId).nextAction,
    satisfied.payload.feedback.nextAction,
  );
  const replayEvents = foldFixtureEvents();
  const appendReplay = (draft) => {
    const event = buildEnvelope(draft, {
      epochId: replayEvents[0].epochId, sequence: replayEvents.length + 1, recordedAt: occurredAt,
      workspaceAtRecord: workspaceObservation(), previousEventHash: replayEvents.at(-1).eventHash,
    });
    assert.equal(envelopeSchema(event), true, JSON.stringify(envelopeSchema.errors));
    replayEvents.push(event);
    return event;
  };
  const prior = feedbackDraft('feedback.dissatisfied', {
    disposition: 'dissatisfied', acceptanceEffect: 'keep_pending', baselineApproachId: 'approach-prior',
    baselineHypothesisId: 'hypothesis-prior', nextAction: 'Revise the prior result',
  });
  prior.payload.feedback.feedbackId = 'feedback-prior-correction';
  appendReplay(prior);
  const correctionState = foldV2(replayEvents);
  const correction = feedbackDraft('feedback.correction', {
    disposition: 'rejected', acceptanceEffect: 'reject', baselineApproachId: 'approach-correction',
    baselineHypothesisId: 'hypothesis-correction', lessonId: 'lesson-correction',
    nextAction: 'Replace the rejected bounded result', correctionPlan: 'Use a changed auditable approach',
    supersedesFeedbackId: 'feedback-prior-correction',
  });
  assert.equal(eventDraft(correction), true, JSON.stringify(eventDraft.errors));
  assert.doesNotThrow(() => validateDraft(correction, correctionState));
  appendReplay(correction);
  const corrected = foldV2(replayEvents);
  const priorState = corrected.feedback.find((item) => item.feedbackId === 'feedback-prior-correction');
  const correctionStateItem = corrected.feedback.find((item) => item.feedbackId === correction.payload.feedback.feedbackId);
  assert.equal(priorState.lifecycle, 'superseded');
  assert.equal(correctionStateItem.lifecycle, 'active');
  assert.equal(correctionStateItem.nextAction, correction.payload.feedback.nextAction);
  assert.equal(correctionStateItem.correctionPlan, correction.payload.feedback.correctionPlan);
  assert.equal(feedbackState(priorState), true, JSON.stringify(feedbackState.errors));
  assert.equal(feedbackState(correctionStateItem), true, JSON.stringify(feedbackState.errors));

  const correctionNegatives = [
    feedbackDraft('feedback.correction', {
      disposition: 'satisfied', acceptanceEffect: 'accept', nextAction: 'Missing the superseded feedback ID',
    }),
    feedbackDraft('feedback.correction', {
      disposition: 'rejected', acceptanceEffect: 'reject', baselineApproachId: 'approach-correction',
      baselineHypothesisId: 'hypothesis-correction', supersedesFeedbackId: 'feedback-prior-correction',
    }),
    feedbackDraft('feedback.correction', {
      disposition: 'satisfied', acceptanceEffect: 'reject', supersedesFeedbackId: 'feedback-prior-correction',
    }),
  ];
  const correctionSnapshot = structuredClone(correctionState);
  for (const invalid of correctionNegatives) {
    assert.equal(eventDraft(invalid), false, 'event schema accepted invalid full feedback correction');
    assert.throws(() => validateDraft(invalid, correctionState), MemoryError);
    assert.deepEqual(correctionState, correctionSnapshot, 'invalid feedback correction mutated replay state');
  }
  const wrongSupersession = structuredClone(correction);
  wrongSupersession.payload.feedback.feedbackId = 'feedback-wrong-supersession';
  wrongSupersession.payload.feedback.supersedesFeedbackId = 'feedback-missing-prior';
  assert.equal(eventDraft(wrongSupersession), true, JSON.stringify(eventDraft.errors));
  assert.throws(() => validateDraft(wrongSupersession, correctionState), MemoryError);
  assert.deepEqual(correctionState, correctionSnapshot, 'crossed correction supersession mutated replay state');
  for (const draft of [
    feedbackDraft('feedback.satisfied', { disposition: 'satisfied', acceptanceEffect: 'reject' }),
    feedbackDraft('feedback.rejected', {
      disposition: 'rejected', acceptanceEffect: 'accept', baselineApproachId: 'approach-old',
      baselineHypothesisId: 'hypothesis-old', nextAction: 'Invalid pair',
    }),
    feedbackDraft('feedback.rejected', {
      disposition: 'rejected', acceptanceEffect: 'reject', baselineApproachId: 'approach-old',
      baselineHypothesisId: 'hypothesis-old',
    }),
    feedbackDraft('feedback.dissatisfied', {
      disposition: 'dissatisfied', acceptanceEffect: 'keep_pending', baselineApproachId: 'approach-old',
      baselineHypothesisId: 'hypothesis-old',
    }),
  ]) {
    assert.equal(eventDraft(draft), false, 'event schema accepted invalid feedback coupling');
    assert.throws(() => validateDraft(draft, state), MemoryError);
  }

  const projectionBase = {
    feedbackId: 'feedback-projection-truth', subjectId: 'goal-truth-feedback',
    disposition: 'rejected', acceptanceEffect: 'reject', statement: 'Rejected synthetic result',
    evidenceRef: 'evidence-user-feedback', baselineApproachId: 'approach-old',
    baselineHypothesisId: 'hypothesis-old', nextAction: 'Use another approach', lifecycle: 'active',
    derivedFromEventIds: ['event-feedback-truth'],
  };
  assert.equal(feedbackState(projectionBase), true, JSON.stringify(feedbackState.errors));
  const invalidProjection = { ...projectionBase, acceptanceEffect: 'accept' };
  assert.equal(feedbackState(invalidProjection), false, 'projection accepted rejected+accept');
  const emptyProjection = { ...projectionBase };
  delete emptyProjection.nextAction;
  assert.equal(feedbackState(emptyProjection), false, 'projection accepted adverse feedback without response');

  const inspectBase = coordinatorInspect();
  inspectBase.feedback = [{
    feedbackId: 'feedback-inspect-truth', subjectId: 'goal-truth-feedback', disposition: 'rejected',
    acceptanceEffect: 'reject', lifecycle: 'active', evidenceRef: 'evidence-user-feedback',
    nextAction: 'Use another approach',
  }];
  assert.equal(inspect(inspectBase), true, JSON.stringify(inspect.errors));
  const invalidInspect = structuredClone(inspectBase);
  invalidInspect.feedback[0].acceptanceEffect = 'accept';
  assert.equal(inspect(invalidInspect), false, 'inspect accepted rejected+accept');
  const emptyInspect = structuredClone(inspectBase);
  delete emptyInspect.feedback[0].nextAction;
  assert.equal(inspect(emptyInspect), false, 'inspect accepted adverse feedback without response');
}

function assertFeedbackEvidenceAuthority() {
  const events = foldFixtureEvents();
  const append = (draft) => {
    const event = buildEnvelope(draft, {
      epochId: events[0].epochId, sequence: events.length + 1, recordedAt: occurredAt,
      workspaceAtRecord: workspaceObservation(), previousEventHash: events.at(-1).eventHash,
    });
    foldV2([...events, event]);
    events.push(event);
  };
  const evidenceDraft = ({ evidenceId, subject, subjectId, actorId }) => ({
    eventType: 'evidence.recorded', occurredAt,
    actor: { kind: 'user', id: actorId, role: 'user' }, subject,
    ...(subject.type === 'goal' ? { goalId: subject.id } : {}),
    supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal',
    payload: { evidence: {
      evidenceId, kind: 'user_message', subjectId, scope: 'Synthetic crossed feedback authority',
      locator: `feedback/${evidenceId}`, observedAt: occurredAt, verifier: { kind: 'user', id: actorId },
      method: 'Synthetic user-backed feedback', outcome: 'observed',
      policy: { kind: 'immutable_until_superseded' }, sourceRefs: [], sensitivity: 'internal',
    } },
  });
  append(evidenceDraft({
    evidenceId: 'evidence-feedback-cross-subject',
    subject: { type: 'project', id: 'project-truth-feedback' },
    subjectId: 'project-truth-feedback', actorId: 'actor-user',
  }));
  append(evidenceDraft({
    evidenceId: 'evidence-feedback-cross-actor',
    subject: { type: 'goal', id: 'goal-truth-feedback' },
    subjectId: 'goal-truth-feedback', actorId: 'actor-other',
  }));
  const state = foldV2(events);
  const eventDraft = compileSchemaDefinition('v2-contract.schema.json', 'EventDraft');
  const valid = feedbackDraft('feedback.satisfied', { disposition: 'satisfied', acceptanceEffect: 'accept' });
  assert.equal(eventDraft(valid), true, JSON.stringify(eventDraft.errors));
  assert.doesNotThrow(() => validateDraft(valid, state));

  const crossedSubject = structuredClone(valid);
  crossedSubject.payload.feedback.feedbackId = 'feedback-crossed-subject';
  crossedSubject.payload.feedback.evidenceRef = 'evidence-feedback-cross-subject';
  crossedSubject.evidenceRefs = ['evidence-feedback-cross-subject'];
  const crossedActor = structuredClone(valid);
  crossedActor.payload.feedback.feedbackId = 'feedback-crossed-actor';
  crossedActor.payload.feedback.evidenceRef = 'evidence-feedback-cross-actor';
  crossedActor.evidenceRefs = ['evidence-feedback-cross-actor'];
  const snapshot = structuredClone(state);
  for (const [label, draft] of [['subject', crossedSubject], ['actor', crossedActor]]) {
    assert.equal(eventDraft(draft), true, `${label}: ${JSON.stringify(eventDraft.errors)}`);
    assert.throws(() => validateDraft(draft, state), MemoryError, `feedback accepted crossed ${label} evidence`);
    assert.deepEqual(state, snapshot, `crossed ${label} feedback evidence mutated state`);
  }
}

function assertCoordinatorHandoffSummary() {
  const validate = compileInspect();
  const minimum = coordinatorInspect();
  minimum.handoffs = [{
    handoffId: 'handoff-summary-minimum', taskId: 'task-summary-minimum', owner: 'actor-subagent',
    state: 'assigned', criterionIds: [], warningIds: [],
  }];
  assert.equal(validate(minimum), true, JSON.stringify(validate.errors));

  const maximum = coordinatorInspect();
  maximum.handoffs = [{
    handoffId: 'handoff-summary-maximum', taskId: 'task-summary-maximum', owner: 'actor-subagent',
    state: 'accepted', criterionIds: ['criterion-summary'], reportOutcome: 'succeeded',
    decisionReason: 'The coordinator verified the bounded report',
    decisionEvidenceRefs: ['evidence-summary-decision'], warningIds: ['warning-summary'],
  }];
  assert.equal(validate(maximum), true, JSON.stringify(validate.errors));

  for (const field of ['assignmentId', 'parentRunId', 'scope', 'pathOwnership', 'deliverables', 'prohibitedActions', 'unknown']) {
    const invalid = structuredClone(minimum);
    invalid.handoffs[0][field] = field.endsWith('Id') ? `assignment-${field.toLowerCase()}`
      : ['pathOwnership', 'deliverables', 'prohibitedActions'].includes(field) ? []
        : field === 'unknown' ? true : 'Full assignment field is not a coordinator summary';
    assert.equal(validate(invalid), false, `coordinator summary accepted full-only field ${field}`);
  }
}

function assertHandoffDetailLinkage() {
  const validate = compileInspect();
  const view = handoffInspect();
  assert.equal(validate(view), true, JSON.stringify(validate.errors));
  const before = structuredClone(view);
  assert.equal(validateInspectSemantics(view), view);
  assert.deepEqual(view, before, 'semantic validation mutated its input');

  const terminalReport = handoffInspect();
  terminalReport.tasks[0].currentAttemptId = 'attempt-handoff';
  terminalReport.tasks[0].execution = 'in_progress';
  terminalReport.handoffs[0].state = 'reported';
  terminalReport.handoffs[0].reportOutcome = 'succeeded';
  assert.equal(validate(terminalReport), true, JSON.stringify(validate.errors));
  assert.equal(validateInspectSemantics(terminalReport), terminalReport);

  const crossedOwner = structuredClone(view);
  crossedOwner.handoffs[0].owner = 'actor-unrelated';
  assert.equal(validate(crossedOwner), true, JSON.stringify(validate.errors));
  assert.throws(() => validateInspectSemantics(crossedOwner), MemoryError, 'handoff owner crossed task ownership');

  const reduced = structuredClone(view);
  reduced.handoffs = [{
    handoffId: 'handoff-detail', taskId: 'task-handoff', owner: 'actor-subagent',
    state: 'assigned', criterionIds: ['criterion-handoff'], warningIds: [],
  }];
  assert.equal(validate(reduced), false, 'handoff view accepted a reduced coordinator summary');

  const missingLocator = structuredClone(view);
  delete missingLocator.selectedEvidence[0].locator;
  assert.equal(validate(missingLocator), false, 'handoff view accepted selected evidence without locator');

  const unrelatedEvidence = structuredClone(view);
  unrelatedEvidence.selectedEvidence[0].subjectId = 'task-unrelated';
  assert.equal(validate(unrelatedEvidence), true, JSON.stringify(validate.errors));
  assert.throws(
    () => validateInspectSemantics(unrelatedEvidence),
    (error) => error instanceof MemoryError && error.exitCode === 3 && error.message === 'inspect semantics are invalid',
  );

  const unrelatedCriterion = structuredClone(view);
  unrelatedCriterion.handoffs[0].criterionIds = ['criterion-unrelated'];
  assert.equal(validate(unrelatedCriterion), true, JSON.stringify(validate.errors));
  assert.throws(() => validateInspectSemantics(unrelatedCriterion), (error) => error instanceof MemoryError && error.exitCode === 3);

  const crossedTask = structuredClone(view);
  crossedTask.handoffs[0].taskId = 'task-unrelated';
  assert.equal(validate(crossedTask), true, JSON.stringify(validate.errors));
  assert.throws(() => validateInspectSemantics(crossedTask), (error) => error instanceof MemoryError && error.exitCode === 3);

  const mismatchedSummary = structuredClone(view);
  mismatchedSummary.evidenceSummary[0].scope = 'Different evidence summary';
  assert.equal(validate(mismatchedSummary), true, JSON.stringify(validate.errors));
  assert.throws(() => validateInspectSemantics(mismatchedSummary), (error) => error instanceof MemoryError && error.exitCode === 3);

  const duplicateEvidence = structuredClone(view);
  duplicateEvidence.selectedEvidence.push({ ...duplicateEvidence.selectedEvidence[0], locator: 'checks/duplicate-linkage' });
  assert.equal(validate(duplicateEvidence), true, JSON.stringify(validate.errors));
  assert.throws(() => validateInspectSemantics(duplicateEvidence), (error) => error instanceof MemoryError && error.exitCode === 3);

  const duplicateSummary = structuredClone(view);
  duplicateSummary.evidenceSummary.push({ ...duplicateSummary.evidenceSummary[0], scope: 'Duplicate evidence summary' });
  assert.equal(validate(duplicateSummary), true, JSON.stringify(validate.errors));
  assert.throws(() => validateInspectSemantics(duplicateSummary), (error) => error instanceof MemoryError && error.exitCode === 3);

  const emptyLocator = structuredClone(view);
  emptyLocator.selectedEvidence[0].locator = '   ';
  assert.equal(validate(emptyLocator), false, 'inspect schema accepted a whitespace-only evidence locator');
  assert.throws(() => validateInspectSemantics(emptyLocator), (error) => error instanceof MemoryError && error.exitCode === 3);

  const criterionEvidence = structuredClone(view);
  criterionEvidence.selectedEvidence[0].subjectId = 'criterion-handoff';
  criterionEvidence.evidenceSummary[0].subjectId = 'criterion-handoff';
  criterionEvidence.criteria[0].evidenceRefs = [];
  assert.equal(validate(criterionEvidence), true, JSON.stringify(validate.errors));
  assert.throws(() => validateInspectSemantics(criterionEvidence), (error) => error instanceof MemoryError && error.exitCode === 3);

  const maximum = handoffInspect();
  maximum.criteria = [];
  maximum.tasks[0].criterionIds = [];
  maximum.handoffs[0].criterionIds = [];
  maximum.selectedEvidence = [];
  maximum.evidenceSummary = [];
  for (let index = 0; index < 50; index += 1) {
    const criterionId = `criterion-bounded-${index}`;
    const evidenceId = `evidence-bounded-${index}`;
    maximum.criteria.push({
      criterionId, condition: `Bounded condition ${index}`, scope: 'Synthetic handoff',
      lifecycle: 'active', verification: 'not_run', freshness: 'unknown', evidenceRefs: [evidenceId],
    });
    maximum.tasks[0].criterionIds.push(criterionId);
    maximum.handoffs[0].criterionIds.push(criterionId);
    maximum.selectedEvidence.push({
      evidenceId, kind: 'test', subjectId: criterionId, outcome: 'observed', observedAt: occurredAt,
      freshness: 'unknown', scope: `Bounded evidence ${index}`, locator: `checks/bounded-${index}`,
    });
    maximum.evidenceSummary.push({
      evidenceId, kind: 'test', subjectId: criterionId, outcome: 'observed', observedAt: occurredAt,
      freshness: 'unknown', scope: `Bounded evidence ${index}`,
    });
  }
  assert.equal(validate(maximum), true, JSON.stringify(validate.errors));
  deepFreeze(maximum);
  assert.equal(validateInspectSemantics(maximum), maximum);
}

function handoffSummaryForState(state) {
  const summary = {
    handoffId: `handoff-${state}-truth`, taskId: 'task-handoff', owner: 'actor-subagent',
    state, criterionIds: ['criterion-handoff'], warningIds: [],
  };
  if (['reported', 'accepted', 'rejected'].includes(state)) summary.reportOutcome = 'succeeded';
  if (['accepted', 'rejected', 'cancelled'].includes(state)) {
    summary.decisionReason = 'The coordinator recorded a bounded decision';
    summary.decisionEvidenceRefs = ['evidence-handoff-decision'];
  }
  return summary;
}

function projectionHandoffForState(state, { withReport = ['reported', 'accepted', 'rejected'].includes(state) } = {}) {
  const value = {
    handoffId: `handoff-${state}-projection`, taskId: 'task-handoff', assignmentId: 'assignment-handoff',
    parentRunId: 'run-parent', owner: 'actor-subagent', scope: 'Synthetic handoff',
    pathOwnership: ['src/handoff'], criterionIds: ['criterion-handoff'], deliverables: ['Return a report'],
    prohibitedActions: ['Do not mutate unrelated paths'], state, evidenceRefs: [],
    derivedFromEventIds: ['event-handoff-assigned'],
  };
  if (withReport) {
    value.report = {
      handoffId: value.handoffId, attemptId: 'attempt-handoff', outcome: 'succeeded',
      summary: 'Synthetic report', changedArtifacts: [], evidenceRefs: [], failureIds: [], uncertainties: [],
    };
  }
  if (['accepted', 'rejected', 'cancelled'].includes(state)) {
    value.decisionReason = 'The coordinator recorded a bounded decision';
    value.evidenceRefs = ['evidence-handoff-decision'];
  }
  return value;
}

function assertHandoffStateCoupling() {
  const inspect = compileInspect();
  for (const state of ['assigned', 'reported', 'accepted', 'rejected', 'cancelled']) {
    const fixture = coordinatorInspect();
    fixture.handoffs = [handoffSummaryForState(state)];
    assert.equal(inspect(fixture), true, `${state}: ${JSON.stringify(inspect.errors)}`);
  }
  const cancelledAfterReport = coordinatorInspect();
  cancelledAfterReport.handoffs = [{ ...handoffSummaryForState('cancelled'), reportOutcome: 'blocked' }];
  assert.equal(inspect(cancelledAfterReport), true, JSON.stringify(inspect.errors));

  for (const mutate of [
    (value) => { value.state = 'assigned'; value.reportOutcome = 'succeeded'; },
    (value) => { value.state = 'reported'; delete value.reportOutcome; },
    (value) => { value.state = 'accepted'; delete value.decisionReason; },
    (value) => { value.state = 'rejected'; value.decisionEvidenceRefs = []; },
    (value) => { value.state = 'cancelled'; delete value.decisionEvidenceRefs; },
  ]) {
    const fixture = coordinatorInspect();
    const summary = handoffSummaryForState('accepted');
    mutate(summary);
    fixture.handoffs = [summary];
    assert.equal(inspect(fixture), false, 'inspect accepted invalid handoff state fields');
  }

  const detail = handoffInspect();
  detail.handoffs[0].state = 'reported';
  assert.equal(inspect(detail), false, 'handoff detail accepted reported without outcome');

  const projection = compileSchemaDefinition('projection-v2.schema.json', 'HandoffState');
  for (const state of ['assigned', 'reported', 'accepted', 'rejected', 'cancelled']) {
    const value = projectionHandoffForState(state);
    assert.equal(projection(value), true, `${state}: ${JSON.stringify(projection.errors)}`);
  }
  const cancelledProjectionWithReport = projectionHandoffForState('cancelled', { withReport: true });
  assert.equal(projection(cancelledProjectionWithReport), true, JSON.stringify(projection.errors));
  for (const invalid of [
    projectionHandoffForState('assigned', { withReport: true }),
    { ...projectionHandoffForState('reported'), report: undefined },
    { ...projectionHandoffForState('accepted'), decisionReason: undefined },
    { ...projectionHandoffForState('rejected'), evidenceRefs: [] },
    { ...projectionHandoffForState('cancelled'), decisionReason: undefined },
  ]) {
    if (invalid.report === undefined) delete invalid.report;
    if (invalid.decisionReason === undefined) delete invalid.decisionReason;
    assert.equal(projection(invalid), false, 'projection accepted invalid handoff state fields');
  }
}

function makeLegacyGoldenRepository() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'project-memory-v1-golden-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Continuity Test', GIT_AUTHOR_EMAIL: 'continuity-test@example.invalid',
    GIT_COMMITTER_NAME: 'Continuity Test', GIT_COMMITTER_EMAIL: 'continuity-test@example.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  };
  const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'user.name', 'Continuity Test']);
  git(['config', 'user.email', 'continuity-test@example.invalid']);
  mkdirSync(path.join(root, 'docs'));
  writeFileSync(path.join(root, 'docs', 'source.md'), '# Source\n');
  git(['add', 'docs/source.md']);
  git(['commit', '-qm', 'fixture']);
  assert.equal(git(['rev-parse', 'HEAD']), '60bbb43234d3e8bc33e79a45f858d1531668b429');
  return root;
}

function assertLegacyStorePathAliasesAndEscapes() {
  const root = makeLegacyGoldenRepository();
  const outside = mkdtempSync(path.join(os.tmpdir(), 'project-memory-v1-path-outside-'));
  const hadStoreOverride = Object.hasOwn(process.env, 'CONTINUITY_STORE_DIR');
  const originalStoreOverride = process.env.CONTINUITY_STORE_DIR;
  try {
    delete process.env.CONTINUITY_STORE_DIR;
    const initialized = runCli(helper, root, ['init']);
    assert.equal(initialized.status, 0, initialized.stderr);
    const files = storePaths(root);
    const stableStore = treeDigest(files.store);

    if (process.platform === 'win32') {
      const extendedPathAlias = `\\\\?\\${root}`;
      const input = readLegacyInspectInput(extendedPathAlias);
      assert.equal(input.store.schemaVersion, 1, 'legacy reader rejected a repository-bounded Windows path alias');
      assert.equal(treeDigest(files.store), stableStore, 'Windows path-alias inspection changed the legacy store');
    }

    const outsideMarker = path.join(outside, 'outside-marker.json');
    writeFileSync(outsideMarker, '{"outside":true}\n');
    const outsideBefore = projectDigest(outside);
    for (const [configured, pattern] of [
      [outside, /bounded repository-relative directory/],
      [`..${path.sep}${path.basename(outside)}`, /traversal segments/],
    ]) {
      process.env.CONTINUITY_STORE_DIR = configured;
      const rootBefore = projectDigest(root);
      assert.throws(
        () => readLegacyInspectInput(root),
        (error) => error instanceof MemoryError && error.exitCode === 3 && pattern.test(error.message),
        `legacy reader accepted escaping store override ${configured}`,
      );
      assert.equal(projectDigest(root), rootBefore, 'escaping store override changed the repository');
      assert.equal(projectDigest(outside), outsideBefore, 'escaping store override changed the outside target');
    }

    const linkedStore = path.join(root, 'linked-store');
    symlinkSync(outside, linkedStore, process.platform === 'win32' ? 'junction' : 'dir');
    process.env.CONTINUITY_STORE_DIR = 'linked-store';
    const linkedRootBefore = projectDigest(root);
    assert.throws(
      () => readLegacyInspectInput(root),
      (error) => /links or reparse points/.test(error.message),
      'legacy reader followed a store reparse point outside the repository',
    );
    assert.equal(projectDigest(root), linkedRootBefore, 'reparse rejection changed the repository');
    assert.equal(projectDigest(outside), outsideBefore, 'reparse rejection changed the outside target');
  } finally {
    if (hadStoreOverride) process.env.CONTINUITY_STORE_DIR = originalStoreOverride;
    else delete process.env.CONTINUITY_STORE_DIR;
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

const V1_INSPECT_GOLDEN = {
  status: 0,
  stdout: 'Project: Bounded project continuity snapshot\nmemory updated: 2026-08-15T00:00:00.000Z\njournal: authoritative; CURRENT projection=current\n\nStable goals\n- none\n\nImplementation boundaries\n- none\n\nOperating rules\n- none\n\nActive work\n- none\n\nDecisions\n- none\n\nRecent work\n- none\n\nValidation evidence\n- none\n\nUnresolved\n- none\n\nNext steps\n- none\n\nWorkspace drift\n- HEAD: recorded=aaaaaaaaaaaa current=60bbb43234d3 drift=YES\n- status: recorded=clean current=clean drift=no fingerprint=full\n\nSource refs\n',
  stderr: '',
};

const V1_HISTORY_GOLDEN = {
  status: 0,
  stdout: '#1 2026-08-15T00:00:00.000Z d0601b3633b6 active=0 unresolved=0\n',
  stderr: '',
};

function commandBytes(result) {
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function assertLegacyDualSurface() {
  const root = makeLegacyGoldenRepository();
  try {
    let result = runCli(helper, root, ['init']);
    assert.equal(result.status, 0, result.stderr);
    const files = storePaths(root);
    const unsupportedLegacyHead = 'a'.repeat(41);
    const legacyEvent = JSON.parse(readFileSync(files.history, 'utf8').trim());
    legacyEvent.timestamp = '2026-08-15T00:00:00.000Z';
    legacyEvent.snapshot.updatedAt = legacyEvent.timestamp;
    legacyEvent.snapshot.workspace = {
      head: unsupportedLegacyHead, branch: 'main', dirty: false,
      statusFingerprint: createHash('sha256').update('').digest('hex'), fingerprintPartial: false,
      capturedAt: legacyEvent.timestamp,
    };
    legacyEvent.snapshotHash = createHash('sha256').update(canonicalLegacy(legacyEvent.snapshot)).digest('hex');
    const legacyMaterial = {
      sequence: legacyEvent.sequence, timestamp: legacyEvent.timestamp, previousHash: legacyEvent.previousHash,
      snapshotHash: legacyEvent.snapshotHash, snapshot: legacyEvent.snapshot,
    };
    legacyEvent.eventHash = createHash('sha256').update(canonicalLegacy(legacyMaterial)).digest('hex');
    writeFileSync(files.history, `${JSON.stringify(legacyEvent)}\n`);
    writeFileSync(files.current, `${JSON.stringify(legacyEvent.snapshot, null, 2)}\n`);
    const before = treeDigest(files.store);
    const bareInspect = runCli(helper, root, ['inspect']);
    const bareHistory = runCli(helper, root, ['history', '--tail', '1']);
    assert.deepEqual(commandBytes(bareInspect), V1_INSPECT_GOLDEN);
    assert.deepEqual(commandBytes(bareHistory), V1_HISTORY_GOLDEN);

    result = runCli(helper, root, ['inspect', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const view = JSON.parse(result.stdout);
    const validate = compileInspect();
    assert.equal(validate(view), true, JSON.stringify(validate.errors));
    assert.equal(view.view, 'legacy-v1');
    assert.equal(view.store.schemaVersion, 1);
    assert.equal(view.workspaceDrift.recorded.head, 'unavailable');
    assert.equal(JSON.stringify(view).includes(unsupportedLegacyHead), false, 'typed JSON leaked an unrepresentable legacy head');
    const projectionWarning = view.warnings.find((warning) => warning.code === 'legacy_v1_projection');
    assert.deepEqual(projectionWarning, {
      warningId: 'warning-legacy-v1-projection', severity: 'blocking', code: 'legacy_v1_projection',
      message: 'A legacy projection fact was unrepresentable; the validated journal remains authoritative',
    });
    assert.equal('finalGoal' in view.project, false);
    for (const forbidden of ['criteria', 'attention', 'tasks', 'nextActions', 'handoffs', 'feedback', 'evidenceSummary', 'graphifyReceipts']) {
      assert.equal(forbidden in view, false, `legacy view invented typed ${forbidden}`);
    }
    const input = readLegacyInspectInput(root);
    assert.equal(input.store.schemaVersion, 1);
    assert.equal(input.recordedWorkspace.head, unsupportedLegacyHead, 'raw v1 input did not preserve its legacy head');
    assert.equal(input.project.name, view.project.name);
    assert.equal('view' in input, false, 'legacy input seam rendered an inspect envelope');
    const gitCalls = [];
    const fakeGit = (_root, args) => {
      gitCalls.push([...args]);
      if (args[0] === 'status') return { status: 0, stdout: '' };
      if (args[0] === 'rev-parse') return { status: 0, stdout: `${'a'.repeat(40)}\n` };
      if (args[0] === 'branch') return { status: 0, stdout: 'main\n' };
      throw new Error('unexpected synthetic git operation');
    };
    const directView = renderLegacyInspectV1(root, { clock: () => new Date(occurredAt), git: fakeGit });
    assert.equal(validate(directView), true, JSON.stringify(validate.errors));
    const directSnapshot = structuredClone(directView);
    assert.throws(
      () => validateInspectSemantics(directView),
      (error) => error instanceof MemoryError && error.exitCode === 3 && error.message === 'inspect semantics are invalid',
      'shared typed/receipt seam accepted a schema-valid rendered LegacyView',
    );
    assert.deepEqual(directView, directSnapshot, 'legacy rejection mutated the rendered view');
    assert.equal(directView.view, 'legacy-v1');
    assert.equal(directView.generatedAt, occurredAt);
    assert.equal(directView.workspaceDrift.recorded.head, 'unavailable');
    assert.equal(directView.workspaceDrift.current.head, 'a'.repeat(40));

    const additiveLegacyView = structuredClone(directView);
    additiveLegacyView.project.name = ' Legacy project name ';
    additiveLegacyView.project.identity = 'Cafe\u0301 legacy identity';
    additiveLegacyView.boundaries = [' Leading legacy boundary '];
    additiveLegacyView.legacy = [{
      legacyId: 'legacy-additive-record', kind: ' legacyKind ', summary: 'Cafe\u0301 legacy summary',
      legacyStatus: ' active ', checkedAt: occurredAt, freshness: 'unknown',
    }];
    additiveLegacyView.workspaceDrift.recorded.branch = ' legacy branch ';
    additiveLegacyView.sourceDrift = [{ path: ' docs/Cafe\u0301.md', purpose: ' legacy purpose ', state: 'unknown' }];
    additiveLegacyView.warnings[0].message = ' Legacy Cafe\u0301 warning ';
    assert.equal(validate(additiveLegacyView), true, JSON.stringify(validate.errors));

    const inspectDocument = JSON.parse(readFileSync(path.join(skillRoot, 'references', 'inspect-v1.schema.json'), 'utf8'));
    const pendingLegacyDefinitions = ['LegacyView'];
    const visitedLegacyDefinitions = new Set();
    while (pendingLegacyDefinitions.length > 0) {
      const definitionName = pendingLegacyDefinitions.pop();
      if (visitedLegacyDefinitions.has(definitionName)) continue;
      visitedLegacyDefinitions.add(definitionName);
      const definition = inspectDocument.$defs[definitionName];
      assert.ok(definition, `LegacyView references missing ${definitionName}`);
      const visit = (value) => {
        if (!value || typeof value !== 'object') return;
        if (typeof value.$ref === 'string') {
          const match = /^#\/\$defs\/(Legacy[A-Za-z0-9]+)$/.exec(value.$ref);
          assert.ok(match, `LegacyView reused a typed reference: ${value.$ref}`);
          pendingLegacyDefinitions.push(match[1]);
        }
        Object.values(value).forEach(visit);
      };
      visit(definition);
    }
    assert.ok(visitedLegacyDefinitions.size > 1, 'LegacyView has no v1-specific additive reference graph');

    result = await awaitMain(['--root', root, 'inspect', '--json'], {
      clock: () => new Date(occurredAt), git: fakeGit,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), directView, 'CLI bypassed the owned legacy renderer seam');
    assert.deepEqual(gitCalls, [
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'], ['rev-parse', 'HEAD'], ['branch', '--show-current'],
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'], ['rev-parse', 'HEAD'], ['branch', '--show-current'],
    ]);
    assert.equal(treeDigest(files.store), before, 'legacy inspect --json changed the store');

    const bareInspectAfter = runCli(helper, root, ['inspect']);
    const bareHistoryAfter = runCli(helper, root, ['history', '--tail', '1']);
    assert.deepEqual(commandBytes(bareInspectAfter), V1_INSPECT_GOLDEN, 'additive JSON changed bare v1 inspect bytes/exits');
    assert.deepEqual(commandBytes(bareHistoryAfter), V1_HISTORY_GOLDEN, 'additive JSON changed v1 history bytes/exits');

    for (const args of [
      ['inspect', '--subject', 'goal-forbidden'],
      ['inspect', '--handoff', 'handoff-forbidden'],
      ['history', '--subject', 'goal-forbidden'],
    ]) {
      const rejected = runCli(helper, root, args);
      assert.equal(rejected.status, 2, `${args.join(' ')}\n${rejected.stderr}`);
      assert.equal(treeDigest(files.store), before, `${args.join(' ')} changed the v1 store`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function notPresentReceipt(overrides = {}) {
  return {
    receiptId: 'receipt-graphify-absent', adapterVersion: 1, state: 'not_present',
    graphifyVersion: '2.4.0', graphPath: 'graphify-out/graph.json',
    repositoryHead: '4'.repeat(40), workspaceDirty: true, observedAt: occurredAt,
    scope: 'Synthetic Graphify observation', limitations: ['The graph file was not present'],
    ...overrides,
  };
}

function assertGraphifyNotPresent() {
  const receipt = compileSchemaDefinition('v2-contract.schema.json', 'GraphifyReceiptV1');
  assert.equal(typeof receipt, 'function', 'canonical GraphifyReceiptV1 is missing');
  const observed = notPresentReceipt();
  assert.equal(receipt(observed), true, JSON.stringify(receipt.errors));
  assert.equal(receipt(notPresentReceipt({ graphifyVersion: null, repositoryHead: 'unavailable', workspaceDirty: null })), true, JSON.stringify(receipt.errors));

  const inspect = compileInspect();
  const view = coordinatorInspect();
  view.graphifyReceipts = [observed];
  assert.equal(inspect(view), true, JSON.stringify(inspect.errors));

  for (const derived of [
    { byteSize: 0 },
    { rawSha256: '5'.repeat(64) },
    { builtAtCommit: '6'.repeat(40) },
  ]) {
    assert.equal(receipt(notPresentReceipt(derived)), false, 'not_present accepted graph-derived facts');
  }
}

function presentReceipt(state = 'observed_unverified', overrides = {}) {
  return {
    receiptId: `receipt-graphify-${state.replaceAll('_', '-')}`, adapterVersion: 1, state,
    graphifyVersion: '2.4.0', graphPath: 'graphify-out/graph.json',
    repositoryHead: '7'.repeat(40), workspaceDirty: false, observedAt: occurredAt,
    scope: 'Synthetic bounded graph observation', limitations: ['Semantic scope is not proven'],
    byteSize: 64 * 1024 * 1024, rawSha256: '8'.repeat(64),
    ...(state === 'commit_aligned_only' ? { builtAtCommit: '7'.repeat(40) } : {}),
    ...overrides,
  };
}

function assertGraphifyCanonicalReceipt() {
  const receipt = compileSchemaDefinition('v2-contract.schema.json', 'GraphifyReceiptV1');
  for (const state of ['observed_unverified', 'commit_aligned_only', 'stale_known']) {
    const value = presentReceipt(state);
    assert.equal(receipt(value), true, `${state}: ${JSON.stringify(receipt.errors)}`);
    const view = coordinatorInspect();
    view.graphifyReceipts = [value];
    const inspectValidate = compileInspect();
    assert.equal(inspectValidate(view), true, JSON.stringify(inspectValidate.errors));
  }
  const fiftyLimitations = Array.from({ length: 50 }, (_, index) => `Bounded limitation ${index + 1}`);
  assert.equal(receipt(presentReceipt('observed_unverified', { limitations: fiftyLimitations })), true, JSON.stringify(receipt.errors));

  for (const invalid of [
    (() => { const value = presentReceipt(); delete value.byteSize; return value; })(),
    (() => { const value = presentReceipt(); delete value.rawSha256; return value; })(),
    (() => { const value = presentReceipt('commit_aligned_only'); delete value.builtAtCommit; return value; })(),
    presentReceipt('current_for_scope'),
    presentReceipt('unknown_state'),
    { ...presentReceipt(), unknown: true },
    presentReceipt('observed_unverified', { limitations: [] }),
    presentReceipt('observed_unverified', { limitations: [...fiftyLimitations, 'Item 51'] }),
    presentReceipt('observed_unverified', { byteSize: (64 * 1024 * 1024) + 1 }),
  ]) assert.equal(receipt(invalid), false, 'canonical receipt accepted an invalid present-graph shape');

  const contract = JSON.parse(readFileSync(path.join(skillRoot, 'references', 'v2-contract.schema.json'), 'utf8'));
  const inspect = JSON.parse(readFileSync(path.join(skillRoot, 'references', 'inspect-v1.schema.json'), 'utf8'));
  assert.equal(Object.hasOwn(contract.$defs, 'GraphifyReceiptV1'), true);
  assert.equal(Object.hasOwn(contract.$defs, 'GraphifyReceipt'), false, 'legacy receipt definition remains');
  assert.equal(
    inspect.$defs.Base.properties.graphifyReceipts.items.$ref,
    `${contract.$id}#/$defs/GraphifyReceiptV1`,
    'inspect does not reference the adapter canonical receipt definition',
  );
}

function assertSemanticRepairFindings() {
  const inspect = compileInspect();
  const receipt = compileSchemaDefinition('v2-contract.schema.json', 'GraphifyReceiptV1');
  const validCoordinator = coordinatorInspect();
  assert.equal(inspect(validCoordinator), true, JSON.stringify(inspect.errors));
  assert.equal(validateInspectSemantics(validCoordinator), validCoordinator);

  const wrongStore = coordinatorInspect();
  wrongStore.store.schemaVersion = 1;
  assert.equal(inspect(wrongStore), false, 'typed coordinator accepted schemaVersion=1');
  assert.throws(() => validateInspectSemantics(wrongStore), (error) => error instanceof MemoryError && error.exitCode === 3);

  const missingGoal = coordinatorInspect();
  delete missingGoal.project.finalGoal;
  assert.equal(inspect(missingGoal), false, 'typed coordinator accepted a missing finalGoal property');
  assert.throws(() => validateInspectSemantics(missingGoal), (error) => error instanceof MemoryError && error.exitCode === 3);

  const recovery = coordinatorInspect();
  recovery.project.finalGoal = null;
  recovery.warnings = [{
    warningId: 'warning-recovery-block', severity: 'blocking', code: 'synthetic_recovery_block',
    message: 'A blocking recovery condition prevents typed work from continuing',
  }];
  assert.equal(inspect(recovery), true, JSON.stringify(inspect.errors));
  assert.equal(validateInspectSemantics(recovery), recovery);
  const unblockedRecovery = structuredClone(recovery);
  unblockedRecovery.warnings = [];
  assert.throws(() => validateInspectSemantics(unblockedRecovery), (error) => error instanceof MemoryError && error.exitCode === 3);

  const nullHandoffGoal = handoffInspect();
  nullHandoffGoal.project.finalGoal = null;
  assert.equal(inspect(nullHandoffGoal), false, 'handoff accepted a null final goal');
  assert.throws(() => validateInspectSemantics({ arbitrary: true }), (error) => error instanceof MemoryError && error.exitCode === 3);

  const identifiedArrays = [
    ['criteria', (view) => {
      const item = handoffInspect().criteria[0];
      view.criteria = [item, { ...item, condition: 'A different summary with the same criterion ID' }];
    }],
    ['tasks', (view) => {
      const item = handoffInspect().tasks[0];
      view.tasks = [item, { ...item, title: 'A different task summary with the same task ID' }];
    }],
    ['nextActions', (view) => {
      const item = { subjectId: 'goal-truth-inspect', action: 'First action', owner: 'actor-coordinator', blockedByIds: [] };
      view.nextActions = [item, { ...item, action: 'Second action for the same subject' }];
    }],
    ['handoffs', (view) => {
      const item = handoffSummaryForState('assigned');
      view.handoffs = [item, { ...item, taskId: 'task-different' }];
    }],
    ['feedback', (view) => {
      const item = { feedbackId: 'feedback-duplicate', subjectId: 'goal-truth-inspect', disposition: 'satisfied', acceptanceEffect: 'accept', lifecycle: 'active', evidenceRef: 'evidence-user-feedback' };
      view.feedback = [item, { ...item, subjectId: 'task-different' }];
    }],
    ['evidenceSummary', (view) => {
      const item = { evidenceId: 'evidence-duplicate', kind: 'test', subjectId: 'goal-truth-inspect', outcome: 'observed', observedAt: occurredAt, freshness: 'unknown', scope: 'First evidence summary' };
      view.evidenceSummary = [item, { ...item, scope: 'Second evidence summary' }];
    }],
    ['sourceDrift', (view) => {
      const item = { path: 'src/duplicate.js', purpose: 'First source purpose', state: 'current' };
      view.sourceDrift = [item, { ...item, purpose: 'Second source purpose' }];
    }],
    ['graphifyReceipts', (view) => {
      const item = notPresentReceipt({ receiptId: 'receipt-duplicate' });
      view.graphifyReceipts = [item, { ...item, scope: 'A different scope with the same receipt ID' }];
    }],
    ['legacy', (view) => {
      const item = { legacyId: 'legacy-duplicate', kind: 'note', summary: 'First legacy note', freshness: 'unknown' };
      view.legacy = [item, { ...item, summary: 'Second legacy note' }];
    }],
    ['warnings', (view) => {
      const item = { warningId: 'warning-duplicate', severity: 'attention', code: 'duplicate_warning', message: 'First warning' };
      view.warnings = [item, { ...item, message: 'Second warning' }];
    }],
  ];
  for (const [family, arrange] of identifiedArrays) {
    const duplicate = coordinatorInspect();
    arrange(duplicate);
    assert.equal(inspect(duplicate), true, `${family}: ${JSON.stringify(inspect.errors)}`);
    assert.throws(
      () => validateInspectSemantics(duplicate),
      (error) => error instanceof MemoryError && error.exitCode === 3,
      `${family} accepted duplicate primary stable IDs`,
    );
  }

  const extraSummary = handoffInspect();
  extraSummary.evidenceSummary.push({
    ...extraSummary.evidenceSummary[0], evidenceId: 'evidence-unselected', scope: 'Unselected extra evidence',
  });
  assert.equal(inspect(extraSummary), true, JSON.stringify(inspect.errors));
  assert.throws(() => validateInspectSemantics(extraSummary), (error) => error instanceof MemoryError && error.exitCode === 3);

  for (const locator of ['/absolute/path', 'C:/drive/path', 'checks/./result', 'checks//result', ' checks/result', 'checks/result ', 'checks/\u200bresult']) {
    const invalidLocator = handoffInspect();
    invalidLocator.selectedEvidence[0].locator = locator;
    assert.equal(inspect(invalidLocator), false, `inspect schema accepted invalid locator ${locator}`);
    assert.throws(() => validateInspectSemantics(invalidLocator), (error) => error instanceof MemoryError && error.exitCode === 3);
  }

  const aligned40 = presentReceipt('commit_aligned_only');
  assert.equal(receipt(aligned40), true, JSON.stringify(receipt.errors));
  assert.equal(validateInspectSemantics(aligned40), aligned40);
  const aligned64 = presentReceipt('commit_aligned_only', {
    repositoryHead: 'a'.repeat(64), builtAtCommit: 'a'.repeat(64),
  });
  assert.equal(receipt(aligned64), true, JSON.stringify(receipt.errors));
  assert.equal(validateInspectSemantics(aligned64), aligned64);
  const invalidGitIds = [
    ['nonhex', `${'a'.repeat(39)}g`],
    ['mixed-case', 'A'.repeat(40)],
    ['short', 'a'.repeat(39)],
    ...Array.from({ length: 23 }, (_, index) => [`length-${index + 41}`, 'a'.repeat(index + 41)]),
    ['long', 'a'.repeat(65)],
  ];
  for (const [label, gitId] of invalidGitIds) {
    assert.equal(
      receipt(presentReceipt('observed_unverified', { repositoryHead: gitId })), false,
      `receipt accepted ${label} repositoryHead`,
    );
    assert.equal(
      receipt(presentReceipt('commit_aligned_only', { builtAtCommit: gitId })), false,
      `receipt accepted ${label} builtAtCommit`,
    );
  }
  const unequalAligned = presentReceipt('commit_aligned_only', { builtAtCommit: '9'.repeat(40) });
  assert.equal(receipt(unequalAligned), true, JSON.stringify(receipt.errors));
  assert.throws(() => validateInspectSemantics(unequalAligned), (error) => error instanceof MemoryError && error.exitCode === 3);
  const inspectWithUnequalReceipt = coordinatorInspect();
  inspectWithUnequalReceipt.graphifyReceipts = [unequalAligned];
  assert.equal(inspect(inspectWithUnequalReceipt), true, JSON.stringify(inspect.errors));
  assert.throws(() => validateInspectSemantics(inspectWithUnequalReceipt), (error) => error instanceof MemoryError && error.exitCode === 3);
}

function assertSemanticCanonicalizationAndRepeatedEquality() {
  const inspect = compileInspect();
  const semanticFailure = (value, label, { schemaValid = true } = {}) => {
    assert.equal(inspect(value), schemaValid, `${label}: ${JSON.stringify(inspect.errors)}`);
    const snapshot = structuredClone(value);
    assert.throws(
      () => validateInspectSemantics(value),
      (error) => error instanceof MemoryError && error.exitCode === 3 && error.message === 'inspect semantics are invalid',
      label,
    );
    assert.deepEqual(value, snapshot, `${label} mutated its input`);
  };

  for (const [label, arrange, schemaValid] of [
    ['schema-invalid Cf text', (value) => { value.project.identity = 'Synthetic\u200b identity'; }, false],
    ['schema-invalid Cc text', (value) => { value.boundaries = ['Synthetic\tboundary']; }, false],
    ['trim-unstable text', (value) => { value.project.name = ' Truth inspect'; }, false],
    ['non-NFC text', (value) => { value.project.identity = 'Cafe\u0301 fixture'; }, true],
    ['invalid calendar timestamp', (value) => { value.generatedAt = '2026-02-30T00:00:00.000Z'; }, true],
    ['invalid nested calendar timestamp', (value) => { value.workspaceDrift.current.capturedAt = '2026-04-31T00:00:00.000Z'; }, true],
  ]) {
    const value = coordinatorInspect();
    arrange(value);
    semanticFailure(value, label, { schemaValid });
  }

  const receiptSchema = compileSchemaDefinition('v2-contract.schema.json', 'GraphifyReceiptV1');
  const badReceiptTime = presentReceipt('observed_unverified', { observedAt: '2026-02-30T00:00:00.000Z' });
  assert.equal(receiptSchema(badReceiptTime), true, JSON.stringify(receiptSchema.errors));
  const receiptSnapshot = structuredClone(badReceiptTime);
  assert.throws(() => validateInspectSemantics(badReceiptTime), (error) => error instanceof MemoryError && error.exitCode === 3);
  assert.deepEqual(badReceiptTime, receiptSnapshot, 'receipt timestamp rejection mutated its input');

  const repeatedTask = coordinatorInspect();
  const taskSummary = taskAttentionSummary('blocked');
  repeatedTask.tasks = [{
    taskId: taskSummary.taskId, title: taskSummary.title, scope: 'Synthetic repeated task', owner: taskSummary.owner,
    requiredForGoal: false, execution: taskSummary.execution, verification: taskSummary.verification,
    acceptance: taskSummary.acceptance, freshness: taskSummary.freshness, dependencyIds: [], criterionIds: [], warningIds: [],
  }];
  repeatedTask.attention.blocked = [structuredClone(taskSummary)];
  assert.equal(inspect(repeatedTask), true, JSON.stringify(inspect.errors));
  assert.equal(validateInspectSemantics(repeatedTask), repeatedTask);
  const conflictingTask = structuredClone(repeatedTask);
  conflictingTask.attention.blocked[0].title = 'Conflicting repeated task title';
  semanticFailure(conflictingTask, 'conflicting repeated task fields');

  const repeatedEvidence = coordinatorInspect();
  const staleEvidence = attentionItem('stale');
  repeatedEvidence.evidenceSummary = [structuredClone(staleEvidence)];
  repeatedEvidence.attention.stale = [structuredClone(staleEvidence)];
  assert.equal(inspect(repeatedEvidence), true, JSON.stringify(inspect.errors));
  assert.equal(validateInspectSemantics(repeatedEvidence), repeatedEvidence);
  const conflictingEvidence = structuredClone(repeatedEvidence);
  conflictingEvidence.attention.stale[0].scope = 'Conflicting repeated evidence scope';
  semanticFailure(conflictingEvidence, 'conflicting repeated evidence fields');
}

function assertHandoffReportAttemptLinkage() {
  const state = foldFixtureState();
  state.tasks.push({ taskId: 'task-handoff-report', goalId: state.finalGoalId });
  state.handoffs.push({
    handoffId: 'handoff-report-linkage', taskId: 'task-handoff-report', owner: 'actor-subagent', state: 'assigned',
  });
  state.attempts.push(
    { attemptId: 'attempt-report-valid', taskId: 'task-handoff-report', owner: 'actor-subagent', outcome: 'succeeded' },
    { attemptId: 'attempt-report-wrong-task', taskId: 'task-other', owner: 'actor-subagent', outcome: 'succeeded' },
    { attemptId: 'attempt-report-wrong-owner', taskId: 'task-handoff-report', owner: 'actor-other', outcome: 'succeeded' },
    { attemptId: 'attempt-report-open', taskId: 'task-handoff-report', owner: 'actor-subagent', outcome: 'in_progress' },
    { attemptId: 'attempt-report-failed', taskId: 'task-handoff-report', owner: 'actor-subagent', outcome: 'failed' },
  );
  const reportDraft = (attemptId, outcome = 'succeeded') => ({
    eventType: 'handoff.reported', occurredAt,
    actor: { kind: 'subagent', id: 'actor-subagent', role: 'subagent' },
    subject: { type: 'handoff', id: 'handoff-report-linkage' },
    goalId: state.finalGoalId, taskId: 'task-handoff-report',
    supersedes: [], contradicts: [], evidenceRefs: ['evidence-user-feedback'], sensitivity: 'internal',
    payload: { report: {
      handoffId: 'handoff-report-linkage', attemptId, outcome, summary: 'Synthetic bounded report',
      changedArtifacts: [], evidenceRefs: ['evidence-user-feedback'], failureIds: [], uncertainties: [],
    } },
  });
  assert.doesNotThrow(() => validateDraft(reportDraft('attempt-report-valid'), state));
  for (const invalid of [
    reportDraft('attempt-report-wrong-task'),
    reportDraft('attempt-report-wrong-owner'),
    reportDraft('attempt-report-open'),
    reportDraft('attempt-report-failed', 'succeeded'),
  ]) assert.throws(() => validateDraft(invalid, state), MemoryError);
}

const TERMINAL_ACTOR_KINDS = Object.freeze(['user', 'coordinator', 'subagent', 'tool', 'migration']);

function terminalActor(kind) {
  return { kind, id: `actor-${kind}`, role: kind };
}

function terminalActorMatrixFixture(root) {
  const criterionId = 'criterion-terminal-actor';
  const taskId = 'task-terminal-actor';
  const attemptId = 'attempt-terminal-actor';
  const completionEvidenceId = 'evidence-terminal-completion';
  const acceptanceEvidenceId = 'evidence-terminal-acceptance';
  const acceptanceFeedbackId = 'feedback-terminal-acceptance';
  const input = initInput('terminal-actor');
  input.finalGoal.criterionIds = [criterionId];
  initializeV2(root, input, { clock: () => new Date(occurredAt) });
  const goalId = input.finalGoal.goalId;
  const draft = (eventType, subject, actorKind, payload, { task = false, evidenceRefs = [] } = {}) => ({
    eventType, occurredAt, actor: terminalActor(actorKind), subject, goalId,
    ...(task ? { taskId } : {}),
    supersedes: [], contradicts: [], evidenceRefs, sensitivity: 'internal', payload,
  });
  const append = (value) => appendV2(root, value);

  append(draft('criterion.declared', { type: 'criterion', id: criterionId }, 'coordinator', {
    criterion: {
      criterionId, ownerType: 'goal', ownerId: goalId,
      condition: 'Terminal state requires independent passing evidence',
      scope: 'Synthetic terminal actor matrix', requiredEvidenceKinds: ['test'],
      freshnessPolicy: { kind: 'immutable_until_superseded' }, waivableByUser: false,
    },
  }));
  append(draft('task.planned', { type: 'task', id: taskId }, 'coordinator', {
    task: {
      taskId, goalId, title: 'Exercise terminal actor authorization', scope: 'Synthetic actor matrix',
      pathOwnership: ['src/terminal-actor'], owner: 'actor-subagent', dependencyIds: [],
      criterionIds: [criterionId], userFacing: false, requiredForGoal: true,
    },
  }, { task: true }));
  append(draft('attempt.started', { type: 'attempt', id: attemptId }, 'subagent', {
    attempt: {
      attemptId, taskId, ordinal: 1, owner: 'actor-subagent', approachId: 'approach-terminal-actor',
      hypothesisId: 'hypothesis-terminal-actor', approachSummary: 'Exercise the exact actor partition',
    },
  }, { task: true }));
  append(draft('task.started', { type: 'task', id: taskId }, 'subagent', { attemptId }, { task: true }));
  append(draft('evidence.recorded', { type: 'criterion', id: criterionId }, 'tool', {
    evidence: {
      evidenceId: completionEvidenceId, kind: 'test', subjectId: criterionId,
      scope: 'Independent terminal completion evidence', locator: 'checks/terminal-actor', observedAt: occurredAt,
      verifier: { kind: 'tool', id: 'actor-tool' }, method: 'Synthetic independent verification',
      outcome: 'passed', policy: { kind: 'immutable_until_superseded' }, sourceRefs: [], sensitivity: 'internal',
    },
  }));
  append(draft('task.implemented', { type: 'task', id: taskId }, 'subagent', {
    attemptId, deliverableEvidenceRefs: [completionEvidenceId],
  }, { task: true }));
  append(draft('attempt.reported', { type: 'attempt', id: attemptId }, 'subagent', {
    attemptId, outcome: 'succeeded', endedAt: occurredAt, summary: 'Synthetic terminal work succeeded',
    evidenceRefs: [completionEvidenceId],
  }, { task: true }));

  const completion = (actorKind) => draft('task.completed', { type: 'task', id: taskId }, actorKind, {
    attemptId, criterionEvidenceRefs: [completionEvidenceId],
  }, { task: true });
  const taskBase = readV2Journal(root);
  append(completion('coordinator'));
  append(draft('evidence.recorded', { type: 'goal', id: goalId }, 'user', {
    evidence: {
      evidenceId: acceptanceEvidenceId, kind: 'user_message', subjectId: goalId,
      scope: 'Exact user goal acceptance', locator: 'user-message-terminal-acceptance', observedAt: occurredAt,
      verifier: { kind: 'user', id: 'actor-user' }, method: 'Synthetic user-authored acceptance',
      outcome: 'observed', policy: { kind: 'immutable_until_superseded' }, sourceRefs: [], sensitivity: 'internal',
    },
  }));
  const feedbackReceipt = append(draft('feedback.satisfied', { type: 'goal', id: goalId }, 'user', {
    feedback: {
      feedbackId: acceptanceFeedbackId, subjectId: goalId, disposition: 'satisfied',
      acceptanceEffect: 'accept', statement: 'The user accepts the exact synthetic goal result',
      evidenceRef: acceptanceEvidenceId,
    },
  }, { evidenceRefs: [acceptanceEvidenceId] }));
  const goalBase = readV2Journal(root);
  const achievement = (actorKind) => draft('goal.achieved', { type: 'goal', id: goalId }, actorKind, {
    criterionEvidenceRefs: [completionEvidenceId], acceptanceFeedbackId,
  });
  return {
    acceptanceEvidenceId, acceptanceFeedbackId, completion, completionEvidenceId,
    feedbackReceipt, goalBase, goalId, achievement, taskBase, taskId,
  };
}

function assertTerminalCompletionAuthority() {
  const root = makeRepository('truth-terminal-actor-matrix');
  try {
    const fixture = terminalActorMatrixFixture(root);
    const feedbackState = compileSchemaDefinition('projection-v2.schema.json', 'FeedbackState');
    const feedback = fixture.goalBase.state.feedback.find((item) => item.feedbackId === fixture.acceptanceFeedbackId);
    const evidence = fixture.goalBase.state.evidence.find((item) => item.evidenceId === fixture.acceptanceEvidenceId);
    assert.equal(feedbackState(feedback), true, JSON.stringify(feedbackState.errors));
    assert.deepEqual(
      {
        subjectId: feedback.subjectId, disposition: feedback.disposition,
        acceptanceEffect: feedback.acceptanceEffect, statement: feedback.statement,
        evidenceRef: feedback.evidenceRef, lifecycle: feedback.lifecycle,
        derivedFromEventIds: feedback.derivedFromEventIds,
      },
      {
        subjectId: fixture.goalId, disposition: 'satisfied', acceptanceEffect: 'accept',
        statement: 'The user accepts the exact synthetic goal result',
        evidenceRef: fixture.acceptanceEvidenceId, lifecycle: 'active',
        derivedFromEventIds: [fixture.feedbackReceipt.eventId],
      },
      'goal acceptance feedback is not the exact active user-authored projection record',
    );
    assert.deepEqual(
      { kind: evidence.kind, subjectId: evidence.subjectId, verifier: evidence.verifier, outcome: evidence.outcome },
      { kind: 'user_message', subjectId: fixture.goalId, verifier: { kind: 'user', id: 'actor-user' }, outcome: 'observed' },
      'goal acceptance feedback is not bound to exact same-goal user evidence',
    );

    const actorMatrix = [
      {
        label: 'goal.achieved', base: fixture.goalBase, makeDraft: fixture.achievement,
        allowed: new Set(['user', 'coordinator']), message: 'goal.achieved requires user or coordinator actor',
        assertApplied: (state) => assert.equal(
          state.goals.find((item) => item.goalId === fixture.goalId).lifecycle,
          'achieved',
          'valid goal actor did not reach the goal reducer',
        ),
      },
      {
        label: 'task.completed', base: fixture.taskBase, makeDraft: fixture.completion,
        allowed: new Set(['coordinator']), message: 'task.completed requires coordinator actor',
        assertApplied: (state) => assert.equal(
          state.tasks.find((item) => item.taskId === fixture.taskId).execution,
          'completed',
          'valid task actor did not reach the task reducer',
        ),
      },
    ];

    for (const row of actorMatrix) {
      const baseEventsBefore = canonicalV2(row.base.events);
      const baseStateBefore = canonicalV2(row.base.state);
      for (const actorKind of TERMINAL_ACTOR_KINDS) {
        const candidate = row.makeDraft(actorKind);
        const label = `${row.label} ${actorKind}`;
        if (row.allowed.has(actorKind)) {
          assert.doesNotThrow(() => validateDraft(candidate, row.base.state), `${label} failed the valid actor path`);
        } else {
          assert.throws(
            () => validateDraft(candidate, row.base.state),
            (error) => error instanceof MemoryError && error.exitCode === 2 && error.message === row.message,
            `${label} passed direct actor validation`,
          );
        }

        const last = row.base.events.at(-1);
        const envelopeDraft = row.allowed.has(actorKind)
          ? candidate
          : row.makeDraft([...row.allowed][0]);
        const replay = buildEnvelope(envelopeDraft, {
          epochId: last.epochId, sequence: row.base.events.length + 1, recordedAt: occurredAt,
          workspaceAtRecord: workspaceObservation(), previousEventHash: last.eventHash,
        });
        if (!row.allowed.has(actorKind)) replay.actor = terminalActor(actorKind);
        const material = structuredClone(replay);
        delete material.eventHash;
        replay.eventHash = createHash('sha256').update(canonicalV2(material)).digest('hex');
        assert.equal(
          replay.eventHash,
          createHash('sha256').update(canonicalV2(material)).digest('hex'),
          `${label} replay fixture is not hash-valid`,
        );
        if (row.allowed.has(actorKind)) {
          row.assertApplied(foldV2([...row.base.events, replay]));
        } else {
          assert.throws(
            () => foldV2([...row.base.events, replay]),
            (error) => error instanceof MemoryError && error.exitCode === 2 && error.message === row.message,
            `${label} passed hash-valid replay actor validation`,
          );
        }
        assert.equal(canonicalV2(row.base.events), baseEventsBefore, `${label} replay mutated retained event bytes`);
        assert.equal(canonicalV2(row.base.state), baseStateBefore, `${label} replay mutated retained projection state`);
      }
    }

    const taskOwnerVerified = structuredClone(fixture.taskBase.state);
    taskOwnerVerified.evidence.find((item) => item.evidenceId === fixture.completionEvidenceId).verifier.id = 'actor-subagent';
    assert.throws(
      () => validateDraft(fixture.completion('coordinator'), taskOwnerVerified),
      MemoryError,
      'task owner independently verified its own terminal work',
    );
    const goalOwnerVerified = structuredClone(fixture.goalBase.state);
    goalOwnerVerified.evidence.find((item) => item.evidenceId === fixture.completionEvidenceId).verifier.id = 'actor-subagent';
    assert.throws(
      () => validateDraft(fixture.achievement('coordinator'), goalOwnerVerified),
      MemoryError,
      'goal completion accepted verification by a relevant task owner',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function accessorBackedSnapshot(base, changes) {
  const value = structuredClone(base);
  const observations = {};
  for (const [property, { first, later }] of Object.entries(changes)) {
    let reads = 0;
    const getter = () => {
      reads += 1;
      return structuredClone(reads === 1 ? first : later);
    };
    Object.defineProperty(value, property, { configurable: true, enumerable: true, get: getter });
    observations[property] = {
      getter,
      reads: () => reads,
    };
  }
  return { observations, value };
}

function rehashEnvelope(event) {
  const material = structuredClone(event);
  delete material.eventHash;
  return {
    ...material,
    eventHash: createHash('sha256').update(canonicalV2(material)).digest('hex'),
  };
}

function assertD19StableSnapshotSemantics() {
  const root = makeRepository('truth-d19-stable-snapshot');
  try {
    const fixture = terminalActorMatrixFixture(root);
    const baseEventsBefore = canonicalV2(fixture.goalBase.events);
    const baseStateBefore = canonicalV2(fixture.goalBase.state);
    const last = fixture.goalBase.events.at(-1);
    const envelopeOptions = {
      epochId: last.epochId,
      sequence: fixture.goalBase.events.length + 1,
      recordedAt: occurredAt,
      workspaceAtRecord: workspaceObservation(),
      previousEventHash: last.eventHash,
    };

    for (const row of [
      {
        label: 'validateDraft',
        invoke: (draft) => validateDraft(draft, fixture.goalBase.state),
        actorOf: (result) => result.actor,
      },
      {
        label: 'buildEnvelope',
        invoke: (draft) => buildEnvelope(draft, envelopeOptions),
        actorOf: (result) => result.actor,
      },
    ]) {
      const allowed = accessorBackedSnapshot(fixture.achievement('user'), {
        actor: { first: terminalActor('user'), later: terminalActor('tool') },
      });
      const allowedDescriptor = Object.getOwnPropertyDescriptor(allowed.value, 'actor');
      const result = row.invoke(allowed.value);
      assert.equal(row.actorOf(result).kind, 'user', `${row.label} returned an actor that was not in its validated snapshot`);
      assert.notStrictEqual(result, allowed.value, `${row.label} returned the caller-owned draft`);
      assert.equal(allowed.observations.actor.reads(), 1, `${row.label} reread the caller-owned actor after snapshot`);
      assert.strictEqual(
        Object.getOwnPropertyDescriptor(allowed.value, 'actor').get,
        allowedDescriptor.get,
        `${row.label} replaced the caller-owned actor accessor`,
      );

      const forbidden = accessorBackedSnapshot(fixture.achievement('tool'), {
        actor: { first: terminalActor('tool'), later: terminalActor('user') },
      });
      const forbiddenDescriptor = Object.getOwnPropertyDescriptor(forbidden.value, 'actor');
      assert.throws(
        () => row.invoke(forbidden.value),
        (error) => error instanceof MemoryError
          && error.exitCode === 2
          && error.message === 'goal.achieved requires user or coordinator actor',
        `${row.label} authorized a later allowed actor instead of rejecting the captured forbidden actor`,
      );
      assert.equal(forbidden.observations.actor.reads(), 1, `${row.label} reread a forbidden caller-owned actor`);
      assert.strictEqual(
        Object.getOwnPropertyDescriptor(forbidden.value, 'actor').get,
        forbiddenDescriptor.get,
        `${row.label} replaced the forbidden caller-owned actor accessor`,
      );
      assert.equal(canonicalV2(fixture.goalBase.events), baseEventsBefore, `${row.label} mutated retained history`);
      assert.equal(canonicalV2(fixture.goalBase.state), baseStateBefore, `${row.label} mutated retained projection state`);
    }

    const validEnvelope = buildEnvelope(fixture.achievement('user'), envelopeOptions);
    const foldRows = [
      {
        label: 'actor mutation',
        changes: { actor: { first: terminalActor('user'), later: terminalActor('tool') } },
        property: 'actor',
      },
      {
        label: 'payload mutation',
        changes: {
          payload: {
            first: validEnvelope.payload,
            later: { ...validEnvelope.payload, acceptanceFeedbackId: 'feedback-not-captured' },
          },
        },
        property: 'payload',
      },
    ];
    for (const row of foldRows) {
      const changing = accessorBackedSnapshot(validEnvelope, row.changes);
      const descriptor = Object.getOwnPropertyDescriptor(changing.value, row.property);
      const projected = foldV2([...fixture.goalBase.events, changing.value]);
      assert.equal(
        projected.goals.find((goal) => goal.goalId === fixture.goalId).lifecycle,
        'achieved',
        `hash-valid ${row.label} did not reduce the captured envelope snapshot`,
      );
      assert.equal(
        changing.observations[row.property].reads(),
        1,
        `foldV2 reread caller-owned envelope ${row.property} after validation`,
      );
      assert.strictEqual(
        Object.getOwnPropertyDescriptor(changing.value, row.property).get,
        descriptor.get,
        `foldV2 replaced caller-owned envelope ${row.property} accessor`,
      );
      assert.equal(canonicalV2(fixture.goalBase.events), baseEventsBefore, `foldV2 ${row.label} mutated retained history`);
      assert.equal(canonicalV2(fixture.goalBase.state), baseStateBefore, `foldV2 ${row.label} mutated retained projection state`);
    }

    const forbiddenEnvelope = rehashEnvelope({ ...validEnvelope, actor: terminalActor('tool') });
    const changingForbidden = accessorBackedSnapshot(forbiddenEnvelope, {
      actor: { first: terminalActor('tool'), later: terminalActor('user') },
    });
    assert.throws(
      () => foldV2([...fixture.goalBase.events, changingForbidden.value]),
      (error) => error instanceof MemoryError
        && error.exitCode === 2
        && error.message === 'goal.achieved requires user or coordinator actor',
      'hash-valid replay authorized a later allowed actor instead of rejecting the captured forbidden actor',
    );
    assert.equal(changingForbidden.observations.actor.reads(), 1, 'forbidden hash-valid replay reread the caller-owned actor');
    assert.equal(canonicalV2(fixture.goalBase.events), baseEventsBefore, 'forbidden replay mutated retained history');
    assert.equal(canonicalV2(fixture.goalBase.state), baseStateBefore, 'forbidden replay mutated retained projection state');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function runTerminalActorMatrix() {
  assertTerminalCompletionAuthority();
}

export function runD19StableSnapshotMatrix() {
  assertD19StableSnapshotSemantics();
}

function assertClaimAuthorityMatrix() {
  const state = foldFixtureState();
  state.evidence.push(
    {
      evidenceId: 'evidence-claim-user', kind: 'user_message', subjectId: state.finalGoalId,
      verifier: { kind: 'user', id: 'actor-user' }, outcome: 'observed',
      policy: { kind: 'immutable_until_superseded' }, sourceRefs: [],
    },
    {
      evidenceId: 'evidence-claim-tool', kind: 'test', subjectId: state.finalGoalId,
      verifier: { kind: 'tool', id: 'tool-verifier' }, outcome: 'passed',
      policy: { kind: 'immutable_until_superseded' }, sourceRefs: [],
    },
    {
      evidenceId: 'evidence-claim-repository', kind: 'file', subjectId: state.finalGoalId,
      verifier: { kind: 'tool', id: 'tool-repository-reader' }, outcome: 'observed',
      policy: { kind: 'source_digest' },
      sourceRefs: [{ path: 'src/claim-authority', purpose: 'Synthetic authority fixture', contentSha256: 'a'.repeat(64) }],
    },
  );
  const claimDraft = ({ suffix, basis, authority, evidenceRefs = [], actor = 'coordinator' }) => ({
    eventType: 'claim.asserted', occurredAt,
    actor: { kind: actor, id: `actor-${actor}`, role: actor },
    subject: { type: 'goal', id: state.finalGoalId }, goalId: state.finalGoalId,
    supersedes: [], contradicts: [], evidenceRefs, sensitivity: 'internal',
    payload: { claim: {
      claimId: `claim-authority-${suffix}`, subject: { type: 'goal', id: state.finalGoalId },
      predicate: 'project.truth', scopeKey: suffix, cardinality: 'one', value: suffix, basis, authority,
    }, evidenceRefs },
  });

  assert.doesNotThrow(() => validateDraft(claimDraft({
    suffix: 'unverified-agent', basis: 'agent_inferred', authority: 'coordinator',
  }), state));
  assert.doesNotThrow(() => validateDraft(claimDraft({
    suffix: 'user-backed', basis: 'user_stated', authority: 'user', evidenceRefs: ['evidence-claim-user'],
  }), state));
  assert.doesNotThrow(() => validateDraft(claimDraft({
    suffix: 'tool-backed', basis: 'tool_observed', authority: 'tool', evidenceRefs: ['evidence-claim-tool'],
  }), state));
  assert.doesNotThrow(() => validateDraft(claimDraft({
    suffix: 'repository-backed', basis: 'source_observed', authority: 'repository', evidenceRefs: ['evidence-claim-repository'],
  }), state));

  for (const invalid of [
    claimDraft({ suffix: 'user-empty', basis: 'user_stated', authority: 'user' }),
    claimDraft({ suffix: 'tool-empty', basis: 'tool_observed', authority: 'tool' }),
    claimDraft({ suffix: 'repository-empty', basis: 'source_observed', authority: 'repository' }),
    claimDraft({ suffix: 'crossed-basis', basis: 'agent_inferred', authority: 'user', evidenceRefs: ['evidence-claim-user'] }),
    claimDraft({ suffix: 'crossed-evidence', basis: 'user_stated', authority: 'user', evidenceRefs: ['evidence-claim-tool'] }),
  ]) assert.throws(() => validateDraft(invalid, state), MemoryError);
}

function assertManualDisputeLifecycle() {
  const events = foldFixtureEvents();
  const append = (draft) => {
    const event = buildEnvelope(draft, {
      epochId: events[0].epochId, sequence: events.length + 1, recordedAt: occurredAt,
      workspaceAtRecord: workspaceObservation(), previousEventHash: events.at(-1).eventHash,
    });
    foldV2([...events, event]);
    events.push(event);
    return event;
  };
  const claim = (claimId, value, {
    scopeKey = 'manual-dispute', cardinality = 'one', valueKey,
    basis = 'agent_inferred', authority = 'coordinator', evidenceRefs = [],
  } = {}) => ({
    eventType: 'claim.asserted', occurredAt,
    actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
    subject: { type: 'goal', id: 'goal-truth-feedback' }, goalId: 'goal-truth-feedback',
    supersedes: [], contradicts: [], evidenceRefs, sensitivity: 'internal',
    payload: { claim: {
      claimId, subject: { type: 'goal', id: 'goal-truth-feedback' }, predicate: 'project.manual',
      scopeKey, cardinality, ...(valueKey ? { valueKey } : {}), value,
      basis, authority,
    }, evidenceRefs },
  });
  const dispute = (claimIds, reason, evidenceRefs = ['evidence-user-feedback']) => ({
    eventType: 'claim.disputed', occurredAt,
    actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
    subject: { type: 'goal', id: 'goal-truth-feedback' }, goalId: 'goal-truth-feedback',
    supersedes: [], contradicts: [], evidenceRefs, sensitivity: 'internal',
    payload: { claimIds, reason, evidenceRefs },
  });
  const resolutionEvidence = (evidenceId, {
    subject = { type: 'goal', id: 'goal-truth-feedback' },
    verifier = { kind: 'coordinator', id: 'actor-resolution-reviewer' },
    outcome = 'passed',
    kind = 'test',
  } = {}) => ({
    eventType: 'evidence.recorded', occurredAt,
    actor: { kind: 'coordinator', id: 'actor-resolution-reviewer', role: 'reviewer' },
    subject, ...(subject.type === 'goal' ? { goalId: subject.id } : {}),
    supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal',
    payload: { evidence: {
      evidenceId, kind, subjectId: subject.id, scope: 'Authorize explicit claim resolution',
      locator: `checks/${evidenceId}`, observedAt: occurredAt, verifier,
      method: 'Independent synthetic claim-resolution review', outcome,
      policy: { kind: 'immutable_until_superseded' }, sourceRefs: [], sensitivity: 'internal',
    } },
  });
  for (const value of [
    resolutionEvidence('evidence-resolution-valid'),
    resolutionEvidence('evidence-resolution-wrong-subject', { subject: { type: 'project', id: 'project-truth-feedback' } }),
    resolutionEvidence('evidence-resolution-wrong-authority', { verifier: { kind: 'tool', id: 'tool-resolution-reviewer' } }),
    resolutionEvidence('evidence-resolution-failed', { outcome: 'failed' }),
    resolutionEvidence('evidence-resolution-self', { verifier: { kind: 'coordinator', id: 'actor-coordinator' } }),
    resolutionEvidence('evidence-resolution-user-assertion', {
      verifier: { kind: 'user', id: 'actor-user' }, outcome: 'observed', kind: 'user_message',
    }),
    resolutionEvidence('evidence-resolution-user', {
      verifier: { kind: 'user', id: 'actor-user' }, kind: 'user_message',
    }),
  ]) append(value);

  append(claim('claim-manual-left', 'same semantic fact'));
  append(claim('claim-manual-right', 'same semantic fact'));
  const disputed = append(dispute(['claim-manual-right', 'claim-manual-left'], 'Explicit semantic dispute'));
  let state = foldV2(events);
  assert.equal(state.contradictions.length, 1, 'manual dispute did not create one durable contradiction');
  assert.deepEqual(state.contradictions[0].claimIds, ['claim-manual-left', 'claim-manual-right']);
  assert.match(state.contradictions[0].claimKey, /^[a-f0-9]{64}$/);
  assert.equal(state.contradictions[0].reason, 'Explicit semantic dispute');
  assert.deepEqual(state.contradictions[0].evidenceRefs, ['evidence-user-feedback']);
  assert.deepEqual(state.contradictions[0].derivedFromEventIds, [disputed.eventId]);
  const validate = compileSchemaDefinition('projection-v2.schema.json', 'ContradictionState');
  assert.equal(validate(state.contradictions[0]), true, JSON.stringify(validate.errors));

  append(claim('claim-manual-unrelated', 'same semantic fact'));
  state = foldV2(events);
  assert.equal(state.contradictions[0].state, 'contested', 'authority, recency, or a later assertion resolved a manual dispute');

  for (const invalid of [
    dispute(['claim-manual-left', 'claim-manual-right'], 'Already contested claims'),
    dispute(['claim-manual-left'], 'Only one claim'),
    dispute(['claim-manual-left', 'claim-manual-left'], 'Duplicate claim IDs'),
    dispute(Array.from({ length: 51 }, (_, index) => `claim-overflow-${String(index).padStart(2, '0')}`), 'Too many claims'),
    dispute(['claim-manual-left', 'claim-manual-right'], 'Missing evidence', []),
  ]) assert.throws(() => validateDraft(invalid, state), MemoryError);

  append(claim('claim-cross-key-left', 'same semantic fact', { scopeKey: 'cross-key-left' }));
  append(claim('claim-cross-key-right', 'same semantic fact', { scopeKey: 'cross-key-right' }));
  append(claim('claim-cross-member-left', 'same semantic fact', { scopeKey: 'cross-member', cardinality: 'many', valueKey: 'member-left' }));
  append(claim('claim-cross-member-right', 'same semantic fact', { scopeKey: 'cross-member', cardinality: 'many', valueKey: 'member-right' }));
  state = foldV2(events);
  assert.throws(() => validateDraft(dispute(['claim-cross-key-left', 'claim-cross-key-right'], 'Cross-key dispute'), state), MemoryError);
  assert.throws(() => validateDraft(dispute(['claim-cross-member-left', 'claim-cross-member-right'], 'Cross-member dispute'), state), MemoryError);

  const retract = (evidenceRef = 'evidence-resolution-valid') => ({
    eventType: 'claim.retracted', occurredAt,
    actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
    subject: { type: 'goal', id: 'goal-truth-feedback' }, goalId: 'goal-truth-feedback',
    supersedes: [], contradicts: [], evidenceRefs: [evidenceRef], sensitivity: 'internal',
    payload: { claimId: 'claim-manual-right', reason: 'Explicitly withdraw the disputed claim', evidenceRefs: [evidenceRef] },
  });
  const supersede = (replacementClaimId, evidenceRef = 'evidence-resolution-valid') => ({
    eventType: 'claim.superseded', occurredAt,
    actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
    subject: { type: 'goal', id: 'goal-truth-feedback' }, goalId: 'goal-truth-feedback',
    supersedes: [], contradicts: [], evidenceRefs: [evidenceRef], sensitivity: 'internal',
    payload: { claimId: 'claim-manual-right', replacementClaimId, evidenceRefs: [evidenceRef] },
  });
  const assertResolutionRejectsWithoutMutation = (draft, label, contestedClaimId = 'claim-manual-left') => {
    const before = canonicalV2(state);
    assert.throws(() => validateDraft(draft, state), MemoryError, `${label} passed append validation`);
    assert.equal(canonicalV2(state), before, `${label} mutated contested state during append validation`);
    const event = buildEnvelope(draft, {
      epochId: events[0].epochId, sequence: events.length + 1, recordedAt: occurredAt,
      workspaceAtRecord: workspaceObservation(), previousEventHash: events.at(-1).eventHash,
    });
    assert.throws(() => foldV2([...events, event]), MemoryError, `${label} passed replay validation`);
    assert.equal(canonicalV2(state), before, `${label} mutated contested state during replay validation`);
    assert.equal(
      state.contradictions.find((item) => item.claimIds.includes(contestedClaimId))?.state,
      'contested',
      `${label} erased the contested lifecycle`,
    );
  };
  for (const [draft, label] of [
    [retract('evidence-resolution-wrong-subject'), 'claim retraction with crossed subject evidence'],
    [retract('evidence-resolution-wrong-authority'), 'claim retraction with crossed authority evidence'],
    [retract('evidence-resolution-failed'), 'claim retraction with non-authorizing evidence outcome'],
    [retract('evidence-resolution-self'), 'claim retraction without independent evidence'],
    [supersede('claim-manual-unrelated'), 'claim supersession with a non-member replacement'],
  ]) assertResolutionRejectsWithoutMutation(draft, label);
  const wrongSubject = retract();
  wrongSubject.subject = { type: 'project', id: 'project-truth-feedback' };
  delete wrongSubject.goalId;
  assertResolutionRejectsWithoutMutation(wrongSubject, 'claim retraction with crossed event subject');
  const wrongActor = retract();
  wrongActor.actor = { kind: 'subagent', id: 'actor-subagent', role: 'subagent' };
  assertResolutionRejectsWithoutMutation(wrongActor, 'claim retraction with non-coordinator actor');

  const resolution = append(retract());
  state = foldV2(events);
  const resolved = state.contradictions.find((item) => item.claimIds.includes('claim-manual-left'));
  assert.equal(resolved?.state, 'resolved', 'an explicit lifecycle event did not resolve the manual dispute');
  assert.equal(resolved?.resolvedByEventId, resolution.eventId);
  assert.equal(state.claims.some((item) => item.claimId === 'claim-manual-right' && item.lifecycle === 'retracted'), true);
  assert.equal(events.some((event) => event.eventId === disputed.eventId && event.eventType === 'claim.disputed'), true);
  assert.equal(events.some((event) => event.eventId === resolution.eventId && event.eventType === 'claim.retracted'), true);

  append(claim('claim-super-left', 'same supersession fact', { scopeKey: 'manual-supersession' }));
  append(claim('claim-super-right', 'same supersession fact', { scopeKey: 'manual-supersession' }));
  append(dispute(['claim-super-left', 'claim-super-right'], 'Choose one explicit member'));
  const superseded = append({
    eventType: 'claim.superseded', occurredAt,
    actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
    subject: { type: 'goal', id: 'goal-truth-feedback' }, goalId: 'goal-truth-feedback',
    supersedes: [], contradicts: [], evidenceRefs: ['evidence-resolution-valid'], sensitivity: 'internal',
    payload: { claimId: 'claim-super-right', replacementClaimId: 'claim-super-left', evidenceRefs: ['evidence-resolution-valid'] },
  });
  state = foldV2(events);
  const supersession = state.contradictions.find((item) => item.claimIds.includes('claim-super-left'));
  assert.equal(supersession?.state, 'resolved');
  assert.equal(supersession?.resolvedByEventId, superseded.eventId);

  const crossAuthorityResolution = (eventType, claimId, evidenceRefs, replacementClaimId) => ({
    eventType, occurredAt,
    actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
    subject: { type: 'goal', id: 'goal-truth-feedback' }, goalId: 'goal-truth-feedback',
    supersedes: [], contradicts: [], evidenceRefs, sensitivity: 'internal',
    payload: eventType === 'claim.superseded'
      ? { claimId, replacementClaimId, evidenceRefs }
      : { claimId, reason: 'Withdraw the cross-authority member explicitly', evidenceRefs },
  });
  append(claim('claim-authority-user-super', 'same authority fact', {
    scopeKey: 'manual-authority-supersede', basis: 'user_stated', authority: 'user',
    evidenceRefs: ['evidence-resolution-user-assertion'],
  }));
  append(claim('claim-authority-coordinator-super', 'same authority fact', {
    scopeKey: 'manual-authority-supersede',
  }));
  append(dispute(
    ['claim-authority-user-super', 'claim-authority-coordinator-super'],
    'Resolve a cross-authority supersession explicitly',
  ));
  state = foldV2(events);
  for (const [evidenceRefs, label] of [
    [['evidence-resolution-valid'], 'cross-authority supersession with replacement-only authority'],
    [['evidence-resolution-user'], 'cross-authority supersession with affected-only authority'],
  ]) assertResolutionRejectsWithoutMutation(crossAuthorityResolution(
    'claim.superseded', 'claim-authority-user-super', evidenceRefs, 'claim-authority-coordinator-super',
  ), label, 'claim-authority-user-super');
  const crossAuthoritySuperseded = append(crossAuthorityResolution(
    'claim.superseded', 'claim-authority-user-super',
    ['evidence-resolution-user', 'evidence-resolution-valid'], 'claim-authority-coordinator-super',
  ));
  state = foldV2(events);
  const crossAuthoritySupersession = state.contradictions.find((item) => (
    item.claimIds.includes('claim-authority-user-super')
  ));
  assert.equal(crossAuthoritySupersession?.state, 'resolved');
  assert.equal(crossAuthoritySupersession?.resolvedByEventId, crossAuthoritySuperseded.eventId);

  append(claim('claim-authority-user-retract', 'same retraction fact', {
    scopeKey: 'manual-authority-retract', basis: 'user_stated', authority: 'user',
    evidenceRefs: ['evidence-resolution-user-assertion'],
  }));
  append(claim('claim-authority-coordinator-retract', 'same retraction fact', {
    scopeKey: 'manual-authority-retract',
  }));
  append(dispute(
    ['claim-authority-user-retract', 'claim-authority-coordinator-retract'],
    'Resolve a cross-authority retraction explicitly',
  ));
  state = foldV2(events);
  for (const [evidenceRefs, label] of [
    [['evidence-resolution-user'], 'cross-authority retraction with affected-only authority'],
    [['evidence-resolution-valid'], 'cross-authority retraction with survivor-only authority'],
  ]) assertResolutionRejectsWithoutMutation(crossAuthorityResolution(
    'claim.retracted', 'claim-authority-user-retract', evidenceRefs,
  ), label, 'claim-authority-user-retract');
  const crossAuthorityRetracted = append(crossAuthorityResolution(
    'claim.retracted', 'claim-authority-user-retract',
    ['evidence-resolution-user', 'evidence-resolution-valid'],
  ));
  state = foldV2(events);
  const crossAuthorityRetraction = state.contradictions.find((item) => (
    item.claimIds.includes('claim-authority-user-retract')
  ));
  assert.equal(crossAuthorityRetraction?.state, 'resolved');
  assert.equal(crossAuthorityRetraction?.resolvedByEventId, crossAuthorityRetracted.eventId);

  const nonCoordinator = dispute(['claim-manual-left', 'claim-manual-right'], 'Unauthorized dispute');
  nonCoordinator.actor = { kind: 'subagent', id: 'actor-subagent', role: 'subagent' };
  assert.throws(() => validateDraft(nonCoordinator, state), MemoryError);
}

function assertProjectionCollectionBounds() {
  const events = foldFixtureEvents();
  const decisionDraft = (index) => ({
    eventType: 'decision.recorded', occurredAt,
    actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
    subject: { type: 'goal', id: 'goal-truth-feedback' }, goalId: 'goal-truth-feedback',
    supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal',
    payload: { decision: {
      decisionId: `decision-bound-${String(index).padStart(2, '0')}`, subjectId: 'goal-truth-feedback',
      choice: `Bounded decision ${index}`, rationale: 'Exercise the projection collection limit', evidenceRefs: [],
    } },
  });
  for (let index = 1; index <= 50; index += 1) {
    const event = buildEnvelope(decisionDraft(index), {
      epochId: events[0].epochId, sequence: events.length + 1, recordedAt: occurredAt,
      workspaceAtRecord: workspaceObservation(), previousEventHash: events.at(-1).eventHash,
    });
    assert.doesNotThrow(() => foldV2([...events, event]));
    events.push(event);
  }
  const overflow = buildEnvelope(decisionDraft(51), {
    epochId: events[0].epochId, sequence: events.length + 1, recordedAt: occurredAt,
    workspaceAtRecord: workspaceObservation(), previousEventHash: events.at(-1).eventHash,
  });
  assert.throws(
    () => foldV2([...events, overflow]),
    (error) => error instanceof MemoryError && error.exitCode === 3,
    'replay accepted a projection collection beyond its schema bound',
  );
}

function assertAppendRejectsBeforeRepair() {
  const root = makeRepository('truth-append-preflight');
  try {
    const input = initInput('append-preflight');
    initializeV2(root, input, { clock: () => new Date(occurredAt) });
    const files = storePaths(root);
    writeFileSync(files.history, '{"partial":', { flag: 'a' });
    writeFileSync(files.current, '{"stale-projection":"must-remain-byte-identical"}\n');
    const before = {
      history: readFileSync(files.history), current: readFileSync(files.current), tree: treeDigest(files.store),
    };
    const rejected = taskDraft('append-preflight-rejected', input);
    rejected.payload.task.goalId = 'goal-missing-authority';
    assert.throws(() => appendV2(root, rejected), MemoryError);
    assert.deepEqual(readFileSync(files.history), before.history, 'rejected append repaired or truncated journal bytes');
    assert.deepEqual(readFileSync(files.current), before.current, 'rejected append repaired projection bytes');
    assert.equal(treeDigest(files.store), before.tree, 'rejected append changed the store tree');
    assert.equal(existsSync(mutationLockPath(root)), false, 'rejected append retained its mutation lock');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertPathOwnershipUnique() {
  const state = foldFixtureState();
  const input = { finalGoal: { goalId: state.finalGoalId } };
  const validDraft = taskDraft('unique-path-ownership', input);
  assert.doesNotThrow(() => validateDraft(validDraft, state));
  const duplicateDraft = structuredClone(validDraft);
  duplicateDraft.payload.task.pathOwnership = ['src/unique', 'src/unique'];
  assert.throws(() => validateDraft(duplicateDraft, state), MemoryError);

  const taskDefSchema = compileSchemaDefinition('v2-contract.schema.json', 'TaskDef');
  const handoffDefSchema = compileSchemaDefinition('v2-contract.schema.json', 'HandoffDef');
  assert.equal(taskDefSchema(validDraft.payload.task), true, JSON.stringify(taskDefSchema.errors));
  assert.equal(taskDefSchema(duplicateDraft.payload.task), false, 'event TaskDef accepted duplicate pathOwnership');
  const handoffDefinition = {
    handoffId: 'handoff-unique-path', taskId: validDraft.payload.task.taskId,
    assignmentId: 'assignment-unique-path', parentRunId: 'run-unique-path', owner: 'actor-subagent',
    scope: 'Synthetic path ownership', pathOwnership: ['src/unique'], criterionIds: [],
    deliverables: ['Return a result'], prohibitedActions: ['Do not touch other paths'],
  };
  assert.equal(handoffDefSchema(handoffDefinition), true, JSON.stringify(handoffDefSchema.errors));
  handoffDefinition.pathOwnership.push('src/unique');
  assert.equal(handoffDefSchema(handoffDefinition), false, 'event HandoffDef accepted duplicate pathOwnership');

  const taskStateSchema = compileSchemaDefinition('projection-v2.schema.json', 'TaskState');
  const taskState = {
    ...validDraft.payload.task, execution: 'planned', verification: 'not_run', acceptance: 'not_requested',
    attemptIds: [], failureIds: [], feedbackIds: [], evidenceRefs: [], derivedFromEventIds: ['event-path-ownership'],
  };
  assert.equal(taskStateSchema(taskState), true, JSON.stringify(taskStateSchema.errors));
  taskState.pathOwnership = ['src/unique', 'src/unique'];
  assert.equal(taskStateSchema(taskState), false, 'projection TaskState accepted duplicate pathOwnership');

  const handoffStateSchema = compileSchemaDefinition('projection-v2.schema.json', 'HandoffState');
  const handoffState = projectionHandoffForState('assigned');
  handoffState.pathOwnership = ['src/unique', 'src/unique'];
  assert.equal(handoffStateSchema(handoffState), false, 'projection HandoffState accepted duplicate pathOwnership');

  const inspect = compileInspect();
  const handoffView = handoffInspect();
  handoffView.handoffs[0].pathOwnership = ['src/unique', 'src/unique'];
  assert.equal(inspect(handoffView), false, 'inspect handoff accepted duplicate pathOwnership');
}

function handoffDecisionFixture() {
  const events = foldFixtureEvents();
  const append = (draft) => {
    const event = buildEnvelope(draft, {
      epochId: events[0].epochId, sequence: events.length + 1, recordedAt: occurredAt,
      workspaceAtRecord: workspaceObservation(), previousEventHash: events.at(-1).eventHash,
    });
    foldV2([...events, event]);
    events.push(event);
    return event;
  };
  const common = {
    occurredAt, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal',
    goalId: 'goal-truth-feedback', taskId: 'task-handoff-evidence',
  };
  append({
    ...common, eventType: 'task.planned',
    actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
    subject: { type: 'task', id: 'task-handoff-evidence' },
    payload: { task: {
      taskId: 'task-handoff-evidence', goalId: 'goal-truth-feedback', title: 'Verify handoff evidence',
      scope: 'Synthetic handoff evidence contract', pathOwnership: ['src/handoff-evidence'],
      owner: 'actor-subagent', dependencyIds: [], criterionIds: [], userFacing: false, requiredForGoal: false,
    } },
  });
  append({
    ...common, eventType: 'handoff.assigned',
    actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
    subject: { type: 'handoff', id: 'handoff-evidence-contract' },
    payload: { handoff: {
      handoffId: 'handoff-evidence-contract', taskId: 'task-handoff-evidence', assignmentId: 'assignment-handoff-evidence',
      parentRunId: 'run-handoff-evidence', owner: 'actor-subagent', scope: 'Synthetic bounded handoff',
      pathOwnership: ['src/handoff-evidence'], criterionIds: [], deliverables: ['Return a bounded result'],
      prohibitedActions: ['Do not alter unrelated state'],
    } },
  });
  append({
    ...common, eventType: 'attempt.started',
    actor: { kind: 'subagent', id: 'actor-subagent', role: 'subagent' },
    subject: { type: 'attempt', id: 'attempt-handoff-evidence' },
    payload: { attempt: {
      attemptId: 'attempt-handoff-evidence', taskId: 'task-handoff-evidence', ordinal: 1,
      owner: 'actor-subagent', approachId: 'approach-handoff-evidence', hypothesisId: 'hypothesis-handoff-evidence',
      approachSummary: 'Produce the bounded handoff result',
    } },
  });
  append({
    ...common, eventType: 'attempt.reported',
    actor: { kind: 'subagent', id: 'actor-subagent', role: 'subagent' },
    subject: { type: 'attempt', id: 'attempt-handoff-evidence' },
    payload: {
      attemptId: 'attempt-handoff-evidence', outcome: 'succeeded', endedAt: occurredAt,
      summary: 'The bounded handoff result succeeded', evidenceRefs: [],
    },
  });
  const reportEvent = append({
    ...common, eventType: 'handoff.reported',
    actor: { kind: 'subagent', id: 'actor-subagent', role: 'subagent' },
    subject: { type: 'handoff', id: 'handoff-evidence-contract' },
    payload: { report: {
      handoffId: 'handoff-evidence-contract', attemptId: 'attempt-handoff-evidence', outcome: 'succeeded',
      summary: 'Synthetic bounded report', changedArtifacts: [], evidenceRefs: [], failureIds: [], uncertainties: [],
    } },
  });
  return { events, reportEventId: reportEvent.eventId, state: foldV2(events) };
}

function assertHandoffDecisionEvidence() {
  const eventDraft = compileSchemaDefinition('v2-contract.schema.json', 'EventDraft');
  const eventEnvelope = compileSchemaDefinition('v2-contract.schema.json', 'EventEnvelope');
  const { events, reportEventId, state } = handoffDecisionFixture();
  const decision = (eventType, evidenceRefs) => ({
    eventType, occurredAt,
    actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
    subject: { type: 'handoff', id: 'handoff-evidence-contract' },
    goalId: 'goal-truth-feedback', taskId: 'task-handoff-evidence',
    supersedes: [], contradicts: [], evidenceRefs, sensitivity: 'internal',
    payload: eventType === 'handoff.cancelled'
      ? { handoffId: 'handoff-evidence-contract', reason: 'Cancel the bounded handoff', evidenceRefs }
      : { handoffId: 'handoff-evidence-contract', reportEventId, reason: 'Decide the bounded report', evidenceRefs },
  });
  const stateSnapshot = structuredClone(state);
  for (const eventType of ['handoff.accepted', 'handoff.rejected', 'handoff.cancelled']) {
    const valid = decision(eventType, ['evidence-user-feedback']);
    assert.equal(eventDraft(valid), true, `${eventType}: ${JSON.stringify(eventDraft.errors)}`);
    assert.doesNotThrow(() => validateDraft(valid, state));
    const event = buildEnvelope(valid, {
      epochId: events[0].epochId, sequence: events.length + 1, recordedAt: occurredAt,
      workspaceAtRecord: workspaceObservation(), previousEventHash: events.at(-1).eventHash,
    });
    assert.equal(eventEnvelope(event), true, `${eventType}: ${JSON.stringify(eventEnvelope.errors)}`);
    const replay = foldV2([...events, event]);
    const handoff = replay.handoffs.find((item) => item.handoffId === 'handoff-evidence-contract');
    assert.equal(handoff.state, eventType.split('.')[1]);
    assert.deepEqual(handoff.evidenceRefs, ['evidence-user-feedback']);

    for (const evidenceRefs of [[], ['evidence-user-feedback', 'evidence-user-feedback']]) {
      const invalid = decision(eventType, evidenceRefs);
      assert.equal(eventDraft(invalid), false, `${eventType} schema accepted invalid decision evidence`);
      assert.throws(() => validateDraft(invalid, state), MemoryError);
      assert.deepEqual(state, stateSnapshot, `${eventType} invalid evidence mutated state`);
    }
  }
}

function assertPersistedFeedbackDiscriminators() {
  const validateEnvelopeSchema = compileSchemaDefinition('v2-contract.schema.json', 'EventEnvelope');
  const draft = feedbackDraft('feedback.satisfied', { disposition: 'satisfied', acceptanceEffect: 'accept' });
  const event = buildEnvelope(draft, {
    epochId: 'epoch-feedback-envelope', sequence: 1, recordedAt: occurredAt,
    workspaceAtRecord: workspaceObservation(), previousEventHash: ZERO_HASH,
  });
  assert.equal(validateEnvelopeSchema(event), true, JSON.stringify(validateEnvelopeSchema.errors));
  const mismatched = structuredClone(event);
  mismatched.eventType = 'feedback.rejected';
  assert.equal(validateEnvelopeSchema(mismatched), false, 'persisted feedback envelope accepted a mismatched event discriminator');
}

function assertAttemptFailureIdSchemaParity() {
  const eventDraftSchema = compileSchemaDefinition('v2-contract.schema.json', 'EventDraft');
  const attemptStateSchema = compileSchemaDefinition('projection-v2.schema.json', 'AttemptState');
  const reportDraft = (outcome, includeFailure) => ({
    eventType: 'attempt.reported', occurredAt,
    actor: { kind: 'subagent', id: 'actor-subagent', role: 'subagent' },
    subject: { type: 'attempt', id: 'attempt-failure-parity' },
    goalId: 'goal-failure-parity', taskId: 'task-failure-parity',
    supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal',
    payload: {
      attemptId: 'attempt-failure-parity', outcome, endedAt: occurredAt,
      summary: 'Exercise bidirectional attempt failure linkage', evidenceRefs: [],
      ...(includeFailure ? { failureId: 'failure-attempt-parity' } : {}),
    },
  });
  const attemptState = (outcome, includeFailure) => ({
    attemptId: 'attempt-failure-parity', taskId: 'task-failure-parity', ordinal: 1,
    owner: 'actor-subagent', approachId: 'approach-failure-parity', hypothesisId: 'hypothesis-failure-parity',
    approachSummary: 'Exercise bidirectional attempt failure linkage', outcome, startedAt: occurredAt,
    evidenceRefs: [], derivedFromEventIds: ['event-attempt-failure-parity'],
    ...(includeFailure ? { failureId: 'failure-attempt-parity' } : {}),
  });
  for (const outcome of ['failed', 'blocked', 'inconclusive']) {
    assert.equal(eventDraftSchema(reportDraft(outcome, true)), true, `${outcome} report rejected its failureId: ${JSON.stringify(eventDraftSchema.errors)}`);
    assert.equal(eventDraftSchema(reportDraft(outcome, false)), false, `${outcome} report schema accepted no failureId`);
    assert.equal(attemptStateSchema(attemptState(outcome, true)), true, `${outcome} state rejected its failureId: ${JSON.stringify(attemptStateSchema.errors)}`);
    assert.equal(attemptStateSchema(attemptState(outcome, false)), false, `${outcome} state schema accepted no failureId`);
  }
  for (const outcome of ['succeeded', 'abandoned']) {
    assert.equal(eventDraftSchema(reportDraft(outcome, false)), true, `${outcome} report without failureId was rejected: ${JSON.stringify(eventDraftSchema.errors)}`);
    assert.equal(eventDraftSchema(reportDraft(outcome, true)), false, `${outcome} report schema accepted a failureId`);
  }
  for (const outcome of ['in_progress', 'succeeded', 'abandoned']) {
    assert.equal(attemptStateSchema(attemptState(outcome, false)), true, `${outcome} state without failureId was rejected: ${JSON.stringify(attemptStateSchema.errors)}`);
    assert.equal(attemptStateSchema(attemptState(outcome, true)), false, `${outcome} state schema accepted a failureId`);
  }
}

function assertProjectionContradictionBounds() {
  const validate = compileSchemaDefinition('projection-v2.schema.json', 'ContradictionState');
  const value = {
    contradictionId: 'contradiction-projection-bounds', claimKey: 'a'.repeat(64),
    claimIds: ['claim-projection-left', 'claim-projection-right'], state: 'contested',
    derivedFromEventIds: ['event-projection-contradiction'],
  };
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...value, claimIds: ['claim-projection-only'] }), false, 'projection accepted one contradiction claim');
  assert.equal(validate({ ...value, claimIds: Array.from({ length: 50 }, (_, index) => `claim-projection-${index}`) }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...value, claimIds: Array.from({ length: 51 }, (_, index) => `claim-projection-${index}`) }), false, 'projection accepted claim 51');
}

function assertReferenceGraphClosure() {
  const events = foldFixtureEvents();
  let state = foldV2(events);
  const eventDraftSchema = compileSchemaDefinition('v2-contract.schema.json', 'EventDraft');
  const failureStateSchema = compileSchemaDefinition('projection-v2.schema.json', 'FailureState');
  const append = (draft) => {
    assert.doesNotThrow(() => validateDraft(draft, state));
    const event = buildEnvelope(draft, {
      epochId: events[0].epochId, sequence: events.length + 1, recordedAt: occurredAt,
      workspaceAtRecord: workspaceObservation(), previousEventHash: events.at(-1).eventHash,
    });
    state = foldV2([...events, event]);
    events.push(event);
    return event;
  };
  const reject = (draft, label) => {
    assert.throws(() => validateDraft(draft, state), MemoryError, `${label} passed append validation`);
    const event = buildEnvelope(draft, {
      epochId: events[0].epochId, sequence: events.length + 1, recordedAt: occurredAt,
      workspaceAtRecord: workspaceObservation(), previousEventHash: events.at(-1).eventHash,
    });
    assert.throws(() => foldV2([...events, event]), MemoryError, `${label} passed replay validation`);
  };
  const task = (suffix) => ({
    eventType: 'task.planned', occurredAt,
    actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
    subject: { type: 'task', id: `task-reference-${suffix}` }, goalId: state.finalGoalId,
    taskId: `task-reference-${suffix}`, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal',
    payload: { task: {
      taskId: `task-reference-${suffix}`, goalId: state.finalGoalId, title: `Reference task ${suffix}`,
      scope: 'Exercise declarative reference closure', pathOwnership: [`src/reference-${suffix}`],
      owner: 'actor-subagent', dependencyIds: [], criterionIds: [], userFacing: false, requiredForGoal: false,
    } },
  });
  append(task('primary'));
  append(task('other'));
  append({
    eventType: 'handoff.assigned', occurredAt,
    actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
    subject: { type: 'handoff', id: 'handoff-reference-graph' }, goalId: state.finalGoalId,
    taskId: 'task-reference-primary', supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal',
    payload: { handoff: {
      handoffId: 'handoff-reference-graph', taskId: 'task-reference-primary', assignmentId: 'assignment-reference-graph',
      parentRunId: 'run-reference-parent', owner: 'actor-subagent', scope: 'Exercise report lineage',
      pathOwnership: ['src/reference-primary'], criterionIds: [], deliverables: ['Return linked failure IDs'],
      prohibitedActions: ['Do not cross task lineage'],
    } },
  });
  append({
    eventType: 'attempt.started', occurredAt,
    actor: { kind: 'subagent', id: 'actor-subagent', role: 'subagent' },
    subject: { type: 'attempt', id: 'attempt-reference-primary' }, goalId: state.finalGoalId,
    taskId: 'task-reference-primary', supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal',
    payload: { attempt: {
      attemptId: 'attempt-reference-primary', taskId: 'task-reference-primary', ordinal: 1,
      owner: 'actor-subagent', approachId: 'approach-reference-primary', hypothesisId: 'hypothesis-reference-primary',
      approachSummary: 'Exercise exact attempt lineage',
    } },
  });
  const failure = {
    eventType: 'failure.recorded', occurredAt,
    actor: { kind: 'subagent', id: 'actor-subagent', role: 'subagent' },
    subject: { type: 'task', id: 'task-reference-primary' }, goalId: state.finalGoalId,
    taskId: 'task-reference-primary', supersedes: [], contradicts: [],
    evidenceRefs: ['evidence-user-feedback'], sensitivity: 'internal',
    payload: { failure: {
      failureId: 'failure-reference-primary', subject: { type: 'task', id: 'task-reference-primary' },
      attemptId: 'attempt-reference-primary', owner: 'actor-subagent', terminal: 'failed',
      approachId: 'approach-reference-primary', hypothesisId: 'hypothesis-reference-primary',
      symptomClass: 'synthetic_failure', observedSymptom: 'The synthetic attempt failed',
      impact: 'The reference graph must retain the adverse outcome', unchanged: ['No external state changed'],
      rootCause: { state: 'hypothesis', summary: 'A crossed reference would corrupt lineage' },
      evidenceRefs: ['evidence-user-feedback'], retryCount: 0, lessonId: 'lesson-reference-primary',
    } },
  };
  const crossedFailure = structuredClone(failure);
  crossedFailure.payload.failure.approachId = 'approach-reference-crossed';
  reject(crossedFailure, 'failure with an approach outside its attempt');
  append(failure);

  const lesson = (taskId) => ({
    eventType: 'lesson.recorded', occurredAt,
    actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
    subject: { type: 'lesson', id: 'lesson-reference-primary' }, supersedes: [], contradicts: [],
    evidenceRefs: ['evidence-user-feedback'], sensitivity: 'internal',
    payload: { lesson: {
      lessonId: 'lesson-reference-primary', taskId, failureId: 'failure-reference-primary',
      summary: 'Keep task, attempt, failure, and lesson lineage exact', evidenceRefs: ['evidence-user-feedback'],
    } },
  });
  reject(lesson('task-reference-other'), 'lesson crossed onto another task');
  const taskLessonWithoutTask = lesson('task-reference-primary');
  delete taskLessonWithoutTask.payload.lesson.taskId;
  reject(taskLessonWithoutTask, 'task failure lesson without its owning task');
  append(lesson('task-reference-primary'));
  append({
    eventType: 'attempt.reported', occurredAt,
    actor: { kind: 'subagent', id: 'actor-subagent', role: 'subagent' },
    subject: { type: 'attempt', id: 'attempt-reference-primary' }, goalId: state.finalGoalId,
    taskId: 'task-reference-primary', supersedes: [], contradicts: [],
    evidenceRefs: ['evidence-user-feedback'], sensitivity: 'internal',
    payload: {
      attemptId: 'attempt-reference-primary', outcome: 'failed', endedAt: occurredAt,
      summary: 'The synthetic attempt failed', evidenceRefs: ['evidence-user-feedback'], failureId: 'failure-reference-primary',
    },
  });
  const report = (failureIds) => ({
    eventType: 'handoff.reported', occurredAt,
    actor: { kind: 'subagent', id: 'actor-subagent', role: 'subagent' },
    subject: { type: 'handoff', id: 'handoff-reference-graph' }, goalId: state.finalGoalId,
    taskId: 'task-reference-primary', supersedes: [], contradicts: [],
    evidenceRefs: ['evidence-user-feedback'], sensitivity: 'internal',
    payload: { report: {
      handoffId: 'handoff-reference-graph', attemptId: 'attempt-reference-primary', outcome: 'failed',
      summary: 'Report the linked terminal attempt', changedArtifacts: [], evidenceRefs: ['evidence-user-feedback'],
      failureIds, uncertainties: [],
    } },
  });
  reject(report([]), 'adverse report without its attempt failure');
  reject(report(['failure-reference-missing']), 'report with a missing failure');
  append(report(['failure-reference-primary']));

  const goalFailure = {
    eventType: 'failure.recorded', occurredAt,
    actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
    subject: { type: 'goal', id: state.finalGoalId }, goalId: state.finalGoalId,
    supersedes: [], contradicts: [], evidenceRefs: ['evidence-user-feedback'], sensitivity: 'internal',
    payload: { failure: {
      failureId: 'failure-reference-goal', subject: { type: 'goal', id: state.finalGoalId },
      responsibleBoundary: 'Synthetic upstream boundary', terminal: 'blocked',
      approachId: 'approach-reference-goal', hypothesisId: 'hypothesis-reference-goal',
      symptomClass: 'synthetic_goal_failure', observedSymptom: 'The synthetic goal is blocked upstream',
      impact: 'The final goal cannot complete', unchanged: ['Task ownership remains unchanged'],
      rootCause: { state: 'unknown', summary: 'The upstream cause is not confirmed' },
      evidenceRefs: ['evidence-user-feedback'], retryCount: 0, lessonId: 'lesson-reference-goal',
    } },
  };
  const goalFailureWithTaskAttempt = structuredClone(goalFailure);
  goalFailureWithTaskAttempt.payload.failure.failureId = 'failure-reference-goal-crossed';
  goalFailureWithTaskAttempt.payload.failure.attemptId = 'attempt-reference-primary';
  assert.equal(eventDraftSchema(goalFailureWithTaskAttempt), false, 'goal failure schema accepted a task attempt');
  const stateBeforeCrossedGoalFailure = structuredClone(state);
  assert.throws(
    () => validateDraft(goalFailureWithTaskAttempt, state),
    MemoryError,
    'goal failure crossed onto a task attempt',
  );
  assert.deepEqual(state, stateBeforeCrossedGoalFailure, 'goal failure rejection mutated state');
  assert.equal(eventDraftSchema(goalFailure), true, JSON.stringify(eventDraftSchema.errors));
  append(goalFailure);
  const projectedGoalFailure = state.failures.find((item) => item.failureId === 'failure-reference-goal');
  assert.equal(failureStateSchema(projectedGoalFailure), true, JSON.stringify(failureStateSchema.errors));
  assert.equal(
    failureStateSchema({ ...projectedGoalFailure, attemptId: 'attempt-reference-primary' }),
    false,
    'projection failure schema accepted a task attempt on a goal failure',
  );

  const goalLesson = (taskId) => ({
    eventType: 'lesson.recorded', occurredAt,
    actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
    subject: { type: 'lesson', id: 'lesson-reference-goal' }, supersedes: [], contradicts: [],
    evidenceRefs: ['evidence-user-feedback'], sensitivity: 'internal',
    payload: { lesson: {
      lessonId: 'lesson-reference-goal', ...(taskId ? { taskId } : {}), failureId: 'failure-reference-goal',
      summary: 'Keep goal failure lineage independent of task attempts', evidenceRefs: ['evidence-user-feedback'],
    } },
  });
  reject(goalLesson('task-reference-primary'), 'goal failure lesson crossed onto a task');
  append(goalLesson());

  const claim = {
    eventType: 'claim.asserted', occurredAt,
    actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
    subject: { type: 'goal', id: state.finalGoalId }, goalId: state.finalGoalId,
    supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal',
    payload: { claim: {
      claimId: 'claim-reference-verification', subject: { type: 'goal', id: state.finalGoalId },
      predicate: 'project.reference_verified', scopeKey: 'reference-graph', cardinality: 'one', value: true,
      basis: 'agent_inferred', authority: 'coordinator',
    }, evidenceRefs: [] },
  };
  append(claim);
  const evidence = (suffix, overrides = {}) => ({
    eventType: 'evidence.recorded', occurredAt,
    actor: { kind: 'coordinator', id: 'actor-reviewer', role: 'reviewer' },
    subject: { type: overrides.subjectType ?? 'goal', id: overrides.subjectId ?? state.finalGoalId },
    goalId: state.finalGoalId, supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal',
    payload: { evidence: {
      evidenceId: `evidence-reference-${suffix}`, kind: 'test', subjectId: overrides.subjectId ?? state.finalGoalId,
      scope: 'Verify the reference claim', locator: `checks/reference-${suffix}`, observedAt: occurredAt,
      verifier: overrides.verifier ?? { kind: 'coordinator', id: 'actor-reviewer' }, method: 'Independent review',
      outcome: overrides.outcome ?? 'passed', policy: { kind: 'immutable_until_superseded' }, sourceRefs: [],
      sensitivity: 'internal',
    } },
  });
  append(evidence('valid'));
  append(evidence('wrong-subject', { subjectType: 'task', subjectId: 'task-reference-primary' }));
  append(evidence('wrong-authority', { verifier: { kind: 'tool', id: 'tool-reference-reviewer' } }));
  append(evidence('failed-outcome', { outcome: 'failed' }));
  append(evidence('self-verified', { verifier: { kind: 'coordinator', id: 'actor-coordinator' } }));
  const verify = (evidenceId) => ({
    eventType: 'claim.verified', occurredAt,
    actor: { kind: 'coordinator', id: 'actor-reviewer', role: 'reviewer' },
    subject: { type: 'goal', id: state.finalGoalId }, goalId: state.finalGoalId,
    supersedes: [], contradicts: [], evidenceRefs: [evidenceId], sensitivity: 'internal',
    payload: { claimId: 'claim-reference-verification', evidenceRefs: [evidenceId] },
  });
  assert.doesNotThrow(() => validateDraft(verify('evidence-reference-valid'), state));
  for (const [evidenceId, label] of [
    ['evidence-reference-wrong-subject', 'claim verification with a crossed subject'],
    ['evidence-reference-wrong-authority', 'claim verification with crossed authority'],
    ['evidence-reference-failed-outcome', 'claim verification with a non-positive outcome'],
    ['evidence-reference-self-verified', 'claim verification by the claimant'],
  ]) reject(verify(evidenceId), label);
}

function assertTaskCurrentAttemptTransitions() {
  const root = makeRepository('truth-current-attempt-transitions');
  try {
    const input = initInput('current-attempt-transitions');
    initializeV2(root, input, { clock: () => new Date(occurredAt) });
    const goalId = input.finalGoal.goalId;
    const taskId = 'task-current-attempt';
    const criterionId = 'criterion-current-attempt';
    const attemptOne = 'attempt-current-one';
    const attemptTwo = 'attempt-current-two';
    const evidenceId = 'evidence-current-attempt';
    const feedbackEvidenceId = 'evidence-current-feedback';
    const feedbackId = 'feedback-current-preterminal';
    const correctionEvidenceId = 'evidence-current-correction';
    const correctionFeedbackId = 'feedback-current-correction';
    const secondCorrectionEvidenceId = 'evidence-current-correction-two';
    const secondCorrectionFeedbackId = 'feedback-current-correction-two';
    const goalFeedbackEvidenceId = 'evidence-current-goal-feedback';
    const goalFeedbackId = 'feedback-current-goal-crossed';
    const coordinator = { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' };
    const subagent = { kind: 'subagent', id: 'actor-subagent', role: 'subagent' };
    const user = { kind: 'user', id: 'actor-user', role: 'user' };
    const draft = (eventType, subject, actor, payload, options = {}) => {
      const { evidenceRefs = [] } = options;
      const task = Object.hasOwn(options, 'task') ? options.task : taskId;
      return {
        eventType, occurredAt, actor, subject, goalId,
        ...(task ? { taskId: task } : {}),
        supersedes: [], contradicts: [], evidenceRefs, sensitivity: 'internal', payload,
      };
    };
    const append = (value) => appendV2(root, value);
    const attempt = (attemptId, ordinal, approachId, retry = {}) => draft(
      'attempt.started',
      { type: 'attempt', id: attemptId },
      subagent,
      { attempt: {
        attemptId, taskId, ordinal, owner: 'actor-subagent', approachId,
        hypothesisId: `hypothesis-${attemptId.slice(8)}`, approachSummary: 'Exercise current-attempt binding',
        ...retry,
      } },
    );
    const completion = (attemptId) => draft(
      'task.completed', { type: 'task', id: taskId }, coordinator,
      { attemptId, criterionEvidenceRefs: [evidenceId] },
    );
    const assertAppendAndReplayReject = (value, label) => {
      const before = projectDigest(root);
      assert.throws(() => append(value), MemoryError, `${label} passed append validation`);
      assert.equal(projectDigest(root), before, `${label} mutated the synthetic repository during append rejection`);
      const stored = readV2Journal(root);
      const replay = buildEnvelope(value, {
        epochId: stored.events[0].epochId, sequence: stored.events.length + 1, recordedAt: occurredAt,
        workspaceAtRecord: workspaceObservation(), previousEventHash: stored.events.at(-1).eventHash,
      });
      const stateBefore = canonicalV2(stored.state);
      assert.throws(() => foldV2([...stored.events, replay]), MemoryError, `${label} passed replay validation`);
      assert.equal(canonicalV2(stored.state), stateBefore, `${label} mutated the retained contested/project state during replay rejection`);
      assert.equal(projectDigest(root), before, `${label} replay rejection mutated the synthetic repository`);
    };
    const assertShapeRejectsAppendAndHashValidReplay = (invalid, validShape, label) => {
      const before = projectDigest(root);
      assert.throws(() => append(invalid), MemoryError, `${label} passed append validation`);
      assert.equal(projectDigest(root), before, `${label} mutated the synthetic repository during append rejection`);
      const stored = readV2Journal(root);
      const replay = buildEnvelope(validShape, {
        epochId: stored.events[0].epochId, sequence: stored.events.length + 1, recordedAt: occurredAt,
        workspaceAtRecord: workspaceObservation(), previousEventHash: stored.events.at(-1).eventHash,
      });
      replay.payload = structuredClone(invalid.payload);
      const material = structuredClone(replay);
      delete material.eventHash;
      replay.eventHash = createHash('sha256').update(canonicalLegacy(material)).digest('hex');
      const stateBefore = canonicalV2(stored.state);
      assert.throws(() => foldV2([...stored.events, replay]), MemoryError, `${label} passed hash-valid replay validation`);
      assert.equal(canonicalV2(stored.state), stateBefore, `${label} mutated retained state during replay rejection`);
      assert.equal(projectDigest(root), before, `${label} hash-valid replay rejection mutated the synthetic repository`);
    };

    append(draft('criterion.declared', { type: 'criterion', id: criterionId }, coordinator, { criterion: {
      criterionId, ownerType: 'goal', ownerId: goalId, condition: 'Current attempt must own terminal state',
      scope: 'Synthetic current-attempt transition', requiredEvidenceKinds: ['test'],
      freshnessPolicy: { kind: 'immutable_until_superseded' }, waivableByUser: false,
    } }, { task: undefined }));
    append(draft('task.planned', { type: 'task', id: taskId }, coordinator, { task: {
      taskId, goalId, title: 'Bind task transitions to one current attempt', scope: 'Synthetic current-attempt transition',
      pathOwnership: ['src/current-attempt'], owner: 'actor-subagent', dependencyIds: [], criterionIds: [criterionId],
      userFacing: true, requiredForGoal: false,
    } }));
    append(draft('evidence.recorded', { type: 'criterion', id: criterionId }, coordinator, { evidence: {
      evidenceId, kind: 'test', subjectId: criterionId, scope: 'Current-attempt criterion evidence',
      locator: 'checks/current-attempt', observedAt: occurredAt,
      verifier: { kind: 'tool', id: 'tool-current-attempt-reviewer' }, method: 'Independent synthetic verification',
      outcome: 'passed', policy: { kind: 'immutable_until_superseded' }, sourceRefs: [], sensitivity: 'internal',
    } }, { task: undefined }));
    append(attempt(attemptOne, 1, 'approach-current-one'));
    append(draft('task.started', { type: 'task', id: taskId }, subagent, { attemptId: attemptOne }));
    append(draft('task.implemented', { type: 'task', id: taskId }, subagent, {
      attemptId: attemptOne, deliverableEvidenceRefs: [evidenceId],
    }));
    append(draft('evidence.recorded', { type: 'task', id: taskId }, user, { evidence: {
      evidenceId: feedbackEvidenceId, kind: 'user_message', subjectId: taskId, scope: 'Pre-terminal task feedback',
      locator: 'user-message-current-attempt', observedAt: occurredAt,
      verifier: { kind: 'user', id: 'actor-user' }, method: 'Synthetic user decision', outcome: 'observed',
      policy: { kind: 'immutable_until_superseded' }, sourceRefs: [], sensitivity: 'internal',
    } }));
    append(draft('feedback.rejected', { type: 'task', id: taskId }, user, { feedback: {
      feedbackId, subjectId: taskId, disposition: 'rejected', acceptanceEffect: 'reject',
      statement: 'The current terminal result needs another criterion', evidenceRef: feedbackEvidenceId,
      baselineApproachId: 'approach-current-one', baselineHypothesisId: 'hypothesis-current-one',
      correctionPlan: 'Add the new bounded acceptance criterion',
    } }, { evidenceRefs: [feedbackEvidenceId] }));
    const validAttemptReport = draft('attempt.reported', { type: 'attempt', id: attemptOne }, subagent, {
      attemptId: attemptOne, outcome: 'succeeded', endedAt: occurredAt,
      summary: 'First attempt succeeded', evidenceRefs: [evidenceId],
    });
    const missingAdverseFailure = structuredClone(validAttemptReport);
    missingAdverseFailure.payload.outcome = 'failed';
    assertShapeRejectsAppendAndHashValidReplay(
      missingAdverseFailure, validAttemptReport, 'adverse attempt report without failureId',
    );
    const nonAdverseFailure = structuredClone(validAttemptReport);
    nonAdverseFailure.payload.failureId = 'failure-current-spurious';
    assertShapeRejectsAppendAndHashValidReplay(
      nonAdverseFailure, validAttemptReport, 'non-adverse attempt report with failureId',
    );
    const firstReport = append(validAttemptReport);
    const firstCompletion = append(completion(attemptOne));
    assertAppendAndReplayReject(draft('task.reopened', { type: 'task', id: taskId }, coordinator, {
      priorEventId: firstCompletion.eventId, reason: 'Reject pre-terminal feedback as stale',
      evidenceRefs: [feedbackEvidenceId], triggerFeedbackId: feedbackId,
    }, { evidenceRefs: [feedbackEvidenceId] }), 'task reopening with stale pre-terminal feedback');

    append(draft('evidence.recorded', { type: 'goal', id: goalId }, user, { evidence: {
      evidenceId: goalFeedbackEvidenceId, kind: 'user_message', subjectId: goalId, scope: 'Crossed goal feedback',
      locator: 'user-message-current-goal', observedAt: occurredAt,
      verifier: { kind: 'user', id: 'actor-user' }, method: 'Synthetic user decision', outcome: 'observed',
      policy: { kind: 'immutable_until_superseded' }, sourceRefs: [], sensitivity: 'internal',
    } }, { task: undefined }));
    append(draft('feedback.dissatisfied', { type: 'goal', id: goalId }, user, { feedback: {
      feedbackId: goalFeedbackId, subjectId: goalId, disposition: 'dissatisfied', acceptanceEffect: 'keep_pending',
      statement: 'Goal-level feedback cannot reopen a task', evidenceRef: goalFeedbackEvidenceId,
      baselineApproachId: 'approach-current-one', baselineHypothesisId: 'hypothesis-current-one',
      correctionPlan: 'Keep the feedback scoped to the goal',
    } }, { evidenceRefs: [goalFeedbackEvidenceId], task: undefined }));
    assertAppendAndReplayReject(draft('task.reopened', { type: 'task', id: taskId }, coordinator, {
      priorEventId: firstCompletion.eventId, reason: 'Reject crossed goal feedback',
      evidenceRefs: [goalFeedbackEvidenceId], triggerFeedbackId: goalFeedbackId,
    }, { evidenceRefs: [goalFeedbackEvidenceId] }), 'task reopening with crossed goal feedback');

    append(draft('evidence.recorded', { type: 'task', id: taskId }, user, { evidence: {
      evidenceId: correctionEvidenceId, kind: 'user_message', subjectId: taskId, scope: 'Correct completed task feedback',
      locator: 'user-message-current-correction', observedAt: occurredAt,
      verifier: { kind: 'user', id: 'actor-user' }, method: 'Synthetic user correction', outcome: 'observed',
      policy: { kind: 'immutable_until_superseded' }, sourceRefs: [], sensitivity: 'internal',
    } }));
    append(draft('feedback.correction', { type: 'task', id: taskId }, user, { feedback: {
      feedbackId: correctionFeedbackId, subjectId: taskId, disposition: 'dissatisfied', acceptanceEffect: 'keep_pending',
      statement: 'Reopen for an additional bounded attempt', evidenceRef: correctionEvidenceId,
      baselineApproachId: 'approach-current-one', baselineHypothesisId: 'hypothesis-current-one',
      correctionPlan: 'Exercise the newly stated bounded criterion', supersedesFeedbackId: feedbackId,
    } }, { evidenceRefs: [correctionEvidenceId] }));
    assertAppendAndReplayReject(draft('task.reopened', { type: 'task', id: taskId }, coordinator, {
      priorEventId: firstReport.eventId, reason: 'Reject a known non-terminal prior event',
      evidenceRefs: [correctionEvidenceId], triggerFeedbackId: correctionFeedbackId,
    }, { evidenceRefs: [correctionEvidenceId] }), 'task reopening with non-terminal priorEventId');
    assertAppendAndReplayReject(draft('task.reopened', { type: 'task', id: taskId }, coordinator, {
      priorEventId: firstCompletion.eventId, reason: 'Reject crossed reopening evidence',
      evidenceRefs: [evidenceId], triggerFeedbackId: correctionFeedbackId,
    }, { evidenceRefs: [evidenceId] }), 'task reopening without matching trigger evidence');
    append(draft('task.reopened', { type: 'task', id: taskId }, coordinator, {
      priorEventId: firstCompletion.eventId, reason: 'Exercise a second current attempt',
      evidenceRefs: [correctionEvidenceId], triggerFeedbackId: correctionFeedbackId,
    }, { evidenceRefs: [correctionEvidenceId] }));
    append(attempt(attemptTwo, 2, 'approach-current-two', {
      respondsToFeedbackId: correctionFeedbackId,
      changeSummary: 'Respond to the active user correction with a different bounded approach',
    }));
    append(draft('task.started', { type: 'task', id: taskId }, subagent, { attemptId: attemptTwo }));

    assertAppendAndReplayReject(draft('task.implemented', { type: 'task', id: taskId }, subagent, {
      attemptId: attemptOne, deliverableEvidenceRefs: [evidenceId],
    }), 'stale attempt implementation');
    append(draft('task.implemented', { type: 'task', id: taskId }, subagent, {
      attemptId: attemptTwo, deliverableEvidenceRefs: [evidenceId],
    }));

    const currentCompletion = completion(attemptTwo);
    const currentState = readV2Journal(root).state;
    assertAppendAndReplayReject(currentCompletion, 'in-progress current attempt completion');
    const wrongOwnerState = structuredClone(currentState);
    const wrongOwnerAttempt = wrongOwnerState.attempts.find((item) => item.attemptId === attemptTwo);
    wrongOwnerAttempt.owner = 'actor-crossed-owner';
    wrongOwnerAttempt.outcome = 'succeeded';
    assert.throws(() => validateDraft(currentCompletion, wrongOwnerState), MemoryError, 'crossed current-attempt owner authorized completion');

    append(draft('attempt.reported', { type: 'attempt', id: attemptTwo }, subagent, {
      attemptId: attemptTwo, outcome: 'succeeded', endedAt: occurredAt,
      summary: 'Second attempt succeeded', evidenceRefs: [evidenceId],
    }));
    assertAppendAndReplayReject(draft('task.abandoned', { type: 'task', id: taskId }, coordinator, {
      attemptId: attemptOne, reason: 'A stale attempt cannot abandon reopened work', evidenceRefs: [evidenceId],
    }, { evidenceRefs: [evidenceId] }), 'stale succeeded attempt abandonment');
    assertAppendAndReplayReject(completion(attemptOne), 'stale succeeded attempt completion');
    const secondCompletion = append(currentCompletion);
    append(draft('evidence.recorded', { type: 'task', id: taskId }, user, { evidence: {
      evidenceId: secondCorrectionEvidenceId, kind: 'user_message', subjectId: taskId,
      scope: 'Correct the second completed task result', locator: 'user-message-current-correction-two',
      observedAt: occurredAt, verifier: { kind: 'user', id: 'actor-user' }, method: 'Synthetic user correction',
      outcome: 'observed', policy: { kind: 'immutable_until_superseded' }, sourceRefs: [], sensitivity: 'internal',
    } }));
    append(draft('feedback.correction', { type: 'task', id: taskId }, user, { feedback: {
      feedbackId: secondCorrectionFeedbackId, subjectId: taskId,
      disposition: 'dissatisfied', acceptanceEffect: 'keep_pending',
      statement: 'Reopen the latest completed result only', evidenceRef: secondCorrectionEvidenceId,
      baselineApproachId: 'approach-current-two', baselineHypothesisId: 'hypothesis-current-two',
      correctionPlan: 'Bind reopening to the latest terminal event', supersedesFeedbackId: correctionFeedbackId,
    } }, { evidenceRefs: [secondCorrectionEvidenceId] }));
    assertAppendAndReplayReject(draft('task.reopened', { type: 'task', id: taskId }, coordinator, {
      priorEventId: firstCompletion.eventId, reason: 'Reject a stale same-task terminal event',
      evidenceRefs: [secondCorrectionEvidenceId], triggerFeedbackId: secondCorrectionFeedbackId,
    }, { evidenceRefs: [secondCorrectionEvidenceId] }), 'task reopening with stale same-task terminal event');
    assert.doesNotThrow(() => append(draft('task.reopened', { type: 'task', id: taskId }, coordinator, {
      priorEventId: secondCompletion.eventId, reason: 'Reopen from the actual latest terminal event',
      evidenceRefs: [secondCorrectionEvidenceId], triggerFeedbackId: secondCorrectionFeedbackId,
    }, { evidenceRefs: [secondCorrectionEvidenceId] })), 'latest terminal event and corrective feedback did not reopen');

    const wrongOwnerTaskId = 'task-current-wrong-owner';
    const wrongOwnerAttemptId = 'attempt-current-wrong-owner';
    append(draft('task.planned', { type: 'task', id: wrongOwnerTaskId }, coordinator, { task: {
      taskId: wrongOwnerTaskId, goalId, title: 'Reject a crossed attempt owner', scope: 'Synthetic owner binding',
      pathOwnership: ['src/current-owner'], owner: 'actor-subagent', dependencyIds: [], criterionIds: [],
      userFacing: false, requiredForGoal: false,
    } }, { task: wrongOwnerTaskId }));
    append(draft('attempt.started', { type: 'attempt', id: wrongOwnerAttemptId }, {
      kind: 'subagent', id: 'actor-crossed-owner', role: 'subagent',
    }, { attempt: {
      attemptId: wrongOwnerAttemptId, taskId: wrongOwnerTaskId, ordinal: 1, owner: 'actor-crossed-owner',
      approachId: 'approach-crossed-owner', hypothesisId: 'hypothesis-crossed-owner',
      approachSummary: 'Attempt ownership intentionally differs from task ownership',
      respondsToFeedbackId: goalFeedbackId,
      changeSummary: 'Respond to the active goal feedback before checking task ownership',
    } }, { task: wrongOwnerTaskId }));
    assertAppendAndReplayReject(draft(
      'task.started', { type: 'task', id: wrongOwnerTaskId }, subagent,
      { attemptId: wrongOwnerAttemptId }, { task: wrongOwnerTaskId },
    ), 'crossed current-attempt owner');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertCanonicalPolicyAndSchemaParity() {
  const textSchema = compileSchemaDefinition('v2-contract.schema.json', 'Text');
  const pathSchema = compileSchemaDefinition('v2-contract.schema.json', 'Path');
  const jcsSchema = compileSchemaDefinition('v2-contract.schema.json', 'JcsValue');
  const astralAtLimit = '\u{1F600}'.repeat(2_000);
  const astralOverLimit = '\u{1F600}'.repeat(2_001);
  assert.equal([...astralAtLimit].length, 2_000, 'astral boundary fixture is not measured in Unicode code points');
  assert.equal(textSchema(astralAtLimit), true, JSON.stringify(textSchema.errors));
  assert.equal(textSchema(astralOverLimit), false, 'Text schema accepted 2,001 astral code points');
  assert.equal(jcsSchema(astralAtLimit), true, JSON.stringify(jcsSchema.errors));
  assert.equal(jcsSchema(astralOverLimit), false, 'JCS schema accepted 2,001 astral code points');
  assert.equal(jcsSchema({ [astralAtLimit]: 'value' }), true, JSON.stringify(jcsSchema.errors));
  assert.equal(jcsSchema({ [astralOverLimit]: 'value' }), false, 'JCS schema accepted a 2,001-code-point object key');
  assert.doesNotThrow(() => canonicalV2(astralAtLimit));
  assert.throws(() => canonicalV2(astralOverLimit), MemoryError, 'JCS runtime accepted 2,001 astral code points');
  assert.doesNotThrow(() => canonicalV2({ [astralAtLimit]: 'value' }));
  assert.throws(() => canonicalV2({ [astralOverLimit]: 'value' }), MemoryError, 'JCS runtime accepted a 2,001-code-point object key');
  for (const [label, surrogate] of [['high', '\uD800'], ['low', '\uDC00']]) {
    assert.equal(textSchema(surrogate), false, `Text schema accepted an isolated ${label} surrogate`);
    assert.equal(jcsSchema(surrogate), false, `JCS schema accepted an isolated ${label} surrogate value`);
    assert.equal(jcsSchema({ [surrogate]: 'value' }), false, `JCS schema accepted an isolated ${label} surrogate key`);
    assert.throws(() => canonicalV2(surrogate), MemoryError, `JCS runtime accepted an isolated ${label} surrogate value`);
    assert.throws(() => canonicalV2({ [surrogate]: 'value' }), MemoryError, `JCS runtime accepted an isolated ${label} surrogate key`);
  }
  assert.equal(textSchema('Canonical Café'), true, JSON.stringify(textSchema.errors));
  assert.equal(pathSchema('src/canonical/path.mjs'), true, JSON.stringify(pathSchema.errors));
  for (const value of [' Leading space', 'Trailing space ']) {
    assert.equal(textSchema(value), false, `Text schema accepted non-canonical ${JSON.stringify(value)}`);
  }
  assert.equal(textSchema('Cafe\u0301'), true, 'Text schema encoded the semantic-only NFC rule');
  for (const value of ['.', 'src/.', 'src/../escape', ' src/path']) {
    assert.equal(pathSchema(value), false, `Path schema accepted non-canonical ${JSON.stringify(value)}`);
  }
  assert.equal(pathSchema('src/Cafe\u0301'), true, 'Path schema encoded the semantic-only NFC rule');

  const state = foldFixtureState();
  const validTask = taskDraft('canonical-scalars', { finalGoal: { goalId: state.finalGoalId } });
  assert.doesNotThrow(() => validateDraft(validTask, state));
  const domainAtLimit = taskDraft('canonical-astral-at-limit', { finalGoal: { goalId: state.finalGoalId } });
  domainAtLimit.payload.task.title = astralAtLimit;
  assert.doesNotThrow(() => validateDraft(domainAtLimit, state), 'domain rejected exactly 2,000 astral code points');
  const domainOverLimit = taskDraft('canonical-astral-over-limit', { finalGoal: { goalId: state.finalGoalId } });
  domainOverLimit.payload.task.title = astralOverLimit;
  assert.throws(() => validateDraft(domainOverLimit, state), MemoryError, 'domain accepted 2,001 astral code points');
  for (const [label, mutate] of [
    ['trimmed text', (draft) => { draft.payload.task.title = ' Leading title'; }],
    ['NFC text', (draft) => { draft.payload.task.title = 'Cafe\u0301'; }],
    ['dot path', (draft) => { draft.payload.task.pathOwnership = ['src/.']; }],
    ['trimmed path', (draft) => { draft.payload.task.pathOwnership = [' src/path']; }],
  ]) {
    const invalid = structuredClone(validTask);
    mutate(invalid);
    assert.throws(() => validateDraft(invalid, state), MemoryError, `runtime did not enforce ${label}`);
  }

  const fiftyProperties = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`k${index}`, index]));
  const fiftyOneProperties = { ...fiftyProperties, k50: 50 };
  assert.equal(jcsSchema(fiftyProperties), true, JSON.stringify(jcsSchema.errors));
  assert.equal(jcsSchema(fiftyOneProperties), false, 'JCS schema accepted property 51');
  assert.doesNotThrow(() => canonicalV2(fiftyProperties));
  assert.throws(() => canonicalV2(fiftyOneProperties), MemoryError, 'runtime accepted JCS property 51');

  const unicodeRoot = makeRepository('truth-unicode-code-point-parity');
  try {
    const input = initInput('unicode-code-point-parity');
    initializeV2(unicodeRoot, input, { clock: () => new Date(occurredAt) });
    const atLimitDraft = taskDraft('unicode-at-limit', input);
    atLimitDraft.payload.task.title = astralAtLimit;
    assert.doesNotThrow(() => appendV2(unicodeRoot, atLimitDraft), 'append rejected exactly 2,000 astral code points');

    const overLimitDraft = taskDraft('unicode-over-limit', input);
    overLimitDraft.payload.task.title = astralOverLimit;
    let before = projectDigest(unicodeRoot);
    assert.throws(() => appendV2(unicodeRoot, overLimitDraft), MemoryError, 'append accepted 2,001 astral code points');
    assert.equal(projectDigest(unicodeRoot), before, 'astral overflow rejection mutated the synthetic repository');

    const claimDraft = (claimId, value) => ({
      eventType: 'claim.asserted', occurredAt,
      actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
      subject: { type: 'goal', id: input.finalGoal.goalId }, goalId: input.finalGoal.goalId,
      supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal',
      payload: { claim: {
        claimId, subject: { type: 'goal', id: input.finalGoal.goalId }, predicate: 'project.unicode_value',
        scopeKey: 'unicode-code-point-parity', cardinality: 'one', value,
        basis: 'agent_inferred', authority: 'coordinator',
      }, evidenceRefs: [] },
    });
    for (const [label, surrogate] of [['high', '\uD800'], ['low', '\uDC00']]) {
      const invalidString = taskDraft(`unicode-${label}-value`, input);
      invalidString.payload.task.title = surrogate;
      before = projectDigest(unicodeRoot);
      assert.throws(() => appendV2(unicodeRoot, invalidString), MemoryError, `append accepted an isolated ${label} surrogate string value`);
      assert.equal(projectDigest(unicodeRoot), before, `${label} surrogate string rejection mutated the synthetic repository`);
      const invalidClaim = claimDraft(`claim-unicode-${label}`, { [surrogate]: 'value' });
      before = projectDigest(unicodeRoot);
      assert.throws(() => appendV2(unicodeRoot, invalidClaim), MemoryError, `append accepted an isolated ${label} surrogate claim key`);
      assert.equal(projectDigest(unicodeRoot), before, `${label} surrogate rejection mutated the synthetic repository`);
    }

    const stored = readV2Journal(unicodeRoot);
    assert.doesNotThrow(() => foldV2(stored.events), 'replay rejected the stored 2,000-astral-code-point event');
    const rehashWithoutDomain = (event) => {
      const material = structuredClone(event);
      delete material.eventHash;
      event.eventHash = createHash('sha256').update(canonicalLegacy(material)).digest('hex');
      return event;
    };
    const replayAtLimitDraft = taskDraft('unicode-replay-boundary', input);
    replayAtLimitDraft.payload.task.title = astralAtLimit;
    const replayOverflow = buildEnvelope(replayAtLimitDraft, {
      epochId: stored.events[0].epochId, sequence: stored.events.length + 1, recordedAt: occurredAt,
      workspaceAtRecord: workspaceObservation(), previousEventHash: stored.events.at(-1).eventHash,
    });
    replayOverflow.payload.task.title = astralOverLimit;
    rehashWithoutDomain(replayOverflow);
    assert.throws(() => foldV2([...stored.events, replayOverflow]), MemoryError, 'replay accepted 2,001 astral code points');

    for (const [label, surrogate] of [['high', '\uD800'], ['low', '\uDC00']]) {
      const replayString = buildEnvelope(taskDraft(`unicode-replay-${label}-value`, input), {
        epochId: stored.events[0].epochId, sequence: stored.events.length + 1, recordedAt: occurredAt,
        workspaceAtRecord: workspaceObservation(), previousEventHash: stored.events.at(-1).eventHash,
      });
      replayString.payload.task.title = surrogate;
      rehashWithoutDomain(replayString);
      assert.throws(() => foldV2([...stored.events, replayString]), MemoryError, `hash-valid replay accepted an isolated ${label} surrogate string value`);

      const replaySurrogate = buildEnvelope(claimDraft(`claim-unicode-replay-${label}`, { valid: 'value' }), {
        epochId: stored.events[0].epochId, sequence: stored.events.length + 1, recordedAt: occurredAt,
        workspaceAtRecord: workspaceObservation(), previousEventHash: stored.events.at(-1).eventHash,
      });
      replaySurrogate.payload.claim.value = { [surrogate]: 'value' };
      rehashWithoutDomain(replaySurrogate);
      assert.throws(() => foldV2([...stored.events, replaySurrogate]), MemoryError, `hash-valid replay accepted an isolated ${label} surrogate claim key`);
    }
    assert.equal(projectDigest(unicodeRoot), before, 'replay rejection mutated the synthetic repository');
  } finally {
    rmSync(unicodeRoot, { recursive: true, force: true });
  }

  const inspectSchema = compileInspect();
  const inspectAtLimit = coordinatorInspect();
  inspectAtLimit.project.identity = astralAtLimit;
  assert.equal(inspectSchema(inspectAtLimit), true, JSON.stringify(inspectSchema.errors));
  assert.doesNotThrow(() => validateInspectSemantics(inspectAtLimit));
  const inspectOverLimit = structuredClone(inspectAtLimit);
  inspectOverLimit.project.identity = astralOverLimit;
  assert.equal(inspectSchema(inspectOverLimit), false, 'inspect schema accepted 2,001 astral code points');
  assert.throws(() => validateInspectSemantics(inspectOverLimit), MemoryError, 'inspect semantics accepted 2,001 astral code points');
  const inspectSurrogate = structuredClone(inspectAtLimit);
  inspectSurrogate.project.identity = '\uDC00';
  assert.equal(inspectSchema(inspectSurrogate), false, 'inspect schema accepted an isolated surrogate');
  assert.throws(() => validateInspectSemantics(inspectSurrogate), MemoryError, 'inspect semantics accepted an isolated surrogate');
  const taskPresenceMismatch = coordinatorInspect();
  const taskSummary = taskAttentionSummary('blocked');
  taskPresenceMismatch.tasks = [{
    taskId: taskSummary.taskId, title: taskSummary.title, scope: 'Repeated optional presence', owner: taskSummary.owner,
    requiredForGoal: false, execution: taskSummary.execution, verification: taskSummary.verification,
    acceptance: taskSummary.acceptance, freshness: taskSummary.freshness, dependencyIds: [], criterionIds: [],
    nextAction: 'Only one repeated record has this field', warningIds: [],
  }];
  taskPresenceMismatch.attention.blocked = [structuredClone(taskSummary)];
  assert.equal(inspectSchema(taskPresenceMismatch), true, JSON.stringify(inspectSchema.errors));
  assert.throws(() => validateInspectSemantics(taskPresenceMismatch), MemoryError, 'optional task field presence mismatch was accepted');
  const evidencePresenceMismatch = coordinatorInspect();
  const staleEvidence = attentionItem('stale');
  evidencePresenceMismatch.evidenceSummary = [{ ...staleEvidence, limitation: 'Only one repeated record has this field' }];
  evidencePresenceMismatch.attention.stale = [structuredClone(staleEvidence)];
  assert.equal(inspectSchema(evidencePresenceMismatch), true, JSON.stringify(inspectSchema.errors));
  assert.throws(() => validateInspectSemantics(evidencePresenceMismatch), MemoryError, 'optional evidence field presence mismatch was accepted');

  const projectionSchema = compileSchemaDocument('projection-v2.schema.json');
  const projection = foldFixtureState();
  assert.equal(projectionSchema(projection), true, JSON.stringify(projectionSchema.errors));
  const projectionAtLimit = structuredClone(projection);
  projectionAtLimit.project.identity = astralAtLimit;
  assert.equal(projectionSchema(projectionAtLimit), true, JSON.stringify(projectionSchema.errors));
  assert.doesNotThrow(() => canonicalV2(projectionAtLimit));
  const projectionOverLimit = structuredClone(projectionAtLimit);
  projectionOverLimit.project.identity = astralOverLimit;
  assert.equal(projectionSchema(projectionOverLimit), false, 'projection schema accepted 2,001 astral code points');
  assert.throws(() => canonicalV2(projectionOverLimit), MemoryError, 'projection JCS accepted 2,001 astral code points');
  const migratedWithoutGoal = structuredClone(projection);
  migratedWithoutGoal.finalGoalId = null;
  migratedWithoutGoal.goals = [];
  assert.equal(projectionSchema(migratedWithoutGoal), true, `goal-less migrated projection rejected: ${JSON.stringify(projectionSchema.errors)}`);

  const eventDraftSchema = compileSchemaDefinition('v2-contract.schema.json', 'EventDraft');
  const base = (eventType, payload) => ({
    eventType, occurredAt, actor: { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' },
    subject: { type: 'goal', id: state.finalGoalId }, supersedes: [], contradicts: [],
    evidenceRefs: [], sensitivity: 'internal', payload,
  });
  for (const [label, draft] of [
    ['goal.achieved evidence', base('goal.achieved', { criterionEvidenceRefs: [], acceptanceFeedbackId: 'feedback-cardinality' })],
    ['task.implemented evidence', base('task.implemented', { attemptId: 'attempt-cardinality', deliverableEvidenceRefs: [] })],
    ['task.completed evidence', base('task.completed', { attemptId: 'attempt-cardinality', criterionEvidenceRefs: [] })],
    ['claim.verified evidence', base('claim.verified', { claimId: 'claim-cardinality', evidenceRefs: [] })],
    ['claim.disputed evidence', base('claim.disputed', { claimIds: ['claim-left', 'claim-right'], reason: 'Bounded dispute', evidenceRefs: [] })],
    ['claim.superseded evidence', base('claim.superseded', { claimId: 'claim-left', replacementClaimId: 'claim-right', evidenceRefs: [] })],
    ['claim.retracted evidence', base('claim.retracted', { claimId: 'claim-left', reason: 'Bounded retraction', evidenceRefs: [] })],
  ]) assert.equal(eventDraftSchema(draft), false, `${label} schema accepted an empty required array`);

  const root = makeRepository('truth-source-digest-empty');
  try {
    const input = initInput('source-digest-empty');
    initializeV2(root, input, { clock: () => new Date(occurredAt) });
    const append = (draft) => appendV2(root, draft);
    const coordinator = { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' };
    const subagent = { kind: 'subagent', id: 'actor-subagent', role: 'subagent' };
    const common = (eventType, subject, payload, actor = coordinator) => ({
      eventType, occurredAt, actor, subject, goalId: input.finalGoal.goalId,
      ...(subject.type === 'task' || subject.type === 'attempt' ? { taskId: 'task-source-digest-empty' } : {}),
      supersedes: [], contradicts: [], evidenceRefs: [], sensitivity: 'internal', payload,
    });
    append(common('criterion.declared', { type: 'criterion', id: 'criterion-source-digest-empty' }, { criterion: {
      criterionId: 'criterion-source-digest-empty', ownerType: 'goal', ownerId: input.finalGoal.goalId,
      condition: 'Require source-backed passing evidence', scope: 'Synthetic source digest', requiredEvidenceKinds: ['test'],
      freshnessPolicy: { kind: 'source_digest' }, waivableByUser: false,
    } }));
    append(common('task.planned', { type: 'task', id: 'task-source-digest-empty' }, { task: {
      taskId: 'task-source-digest-empty', goalId: input.finalGoal.goalId, title: 'Reject vacuous source freshness',
      scope: 'Synthetic source digest', pathOwnership: ['src/source-digest'], owner: 'actor-subagent',
      dependencyIds: [], criterionIds: ['criterion-source-digest-empty'], userFacing: false, requiredForGoal: true,
    } }));
    append(common('attempt.started', { type: 'attempt', id: 'attempt-source-digest-empty' }, { attempt: {
      attemptId: 'attempt-source-digest-empty', taskId: 'task-source-digest-empty', ordinal: 1,
      owner: 'actor-subagent', approachId: 'approach-source-digest-empty', hypothesisId: 'hypothesis-source-digest-empty',
      approachSummary: 'Test vacuous source freshness',
    } }, subagent));
    append(common('task.started', { type: 'task', id: 'task-source-digest-empty' }, { attemptId: 'attempt-source-digest-empty' }, subagent));
    append(common('evidence.recorded', { type: 'criterion', id: 'criterion-source-digest-empty' }, { evidence: {
      evidenceId: 'evidence-source-digest-empty', kind: 'test', subjectId: 'criterion-source-digest-empty',
      scope: 'Synthetic source digest', locator: 'checks/source-digest-empty', observedAt: occurredAt,
      verifier: { kind: 'tool', id: 'tool-source-verifier' }, method: 'Synthetic source check', outcome: 'passed',
      policy: { kind: 'source_digest' }, sourceRefs: [], sensitivity: 'internal',
    } }));
    append(common('task.implemented', { type: 'task', id: 'task-source-digest-empty' }, {
      attemptId: 'attempt-source-digest-empty', deliverableEvidenceRefs: ['evidence-source-digest-empty'],
    }, subagent));
    append(common('attempt.reported', { type: 'attempt', id: 'attempt-source-digest-empty' }, {
      attemptId: 'attempt-source-digest-empty', outcome: 'succeeded', endedAt: occurredAt,
      summary: 'Synthetic implementation report', evidenceRefs: ['evidence-source-digest-empty'],
    }, subagent));
    const before = treeDigest(storePaths(root).store);
    assert.throws(() => append(common('task.completed', { type: 'task', id: 'task-source-digest-empty' }, {
      attemptId: 'attempt-source-digest-empty', criterionEvidenceRefs: ['evidence-source-digest-empty'],
    })), MemoryError, 'source_digest without sourceRefs authorized completion');
    assert.equal(treeDigest(storePaths(root).store), before, 'rejected vacuous source digest changed store bytes/tree');
    const stored = readV2Journal(root);
    const last = stored.events.at(-1);
    const replayedCompletion = buildEnvelope(common('task.completed', { type: 'task', id: 'task-source-digest-empty' }, {
      attemptId: 'attempt-source-digest-empty', criterionEvidenceRefs: ['evidence-source-digest-empty'],
    }), {
      epochId: last.epochId, sequence: last.sequence + 1, recordedAt: occurredAt,
      workspaceAtRecord: last.workspaceAtRecord, previousEventHash: last.eventHash,
    });
    assert.throws(
      () => foldV2([...stored.events, replayedCompletion]),
      MemoryError,
      'historical replay let an empty source_digest authorize completion',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertEveryEventFamilyParity() {
  const contract = JSON.parse(readFileSync(path.join(skillRoot, 'references', 'v2-contract.schema.json'), 'utf8'));
  const eventType = (entry) => entry.properties.eventType.const;
  const expected = [...EXPECTED_EVENT_TYPES].sort();
  const surfaces = new Map([
    ['runtime event types', EVENT_TYPES],
    ['reducer handlers', Object.keys(REDUCER_HANDLERS)],
    ['transition validators', Object.keys(TRANSITION_TABLE)],
    ['template registry', Object.keys(TEMPLATE_REGISTRY)],
    ['draft-base schema enum', contract.$defs.DraftBase.properties.eventType.enum],
    ['envelope-base schema enum', contract.$defs.EnvelopeBase.properties.eventType.enum],
    ['envelope payload variants', contract.$defs.EnvelopePayload.oneOf.map(eventType)],
    ['event-draft variants', contract.$defs.EventDraft.oneOf.map(eventType)],
    ['top-level draft variants', contract.oneOf.map(eventType)],
  ]);

  assert.equal(expected.length, 45, 'the exhaustive v2 fixture must retain all 45 event families');
  assert.equal(new Set(expected).size, expected.length, 'the exhaustive v2 fixture contains duplicate event families');
  for (const [label, values] of surfaces) {
    assert.equal(values.length, expected.length, `${label} does not expose exactly 45 event families`);
    assert.equal(new Set(values).size, values.length, `${label} contains duplicate event families`);
    assert.deepEqual([...values].sort(), expected, `${label} diverges from the exhaustive v2 fixture`);
  }
}

async function assertEmptyCliTokens() {
  const root = makeRepository('truth-empty-cli-tokens');
  try {
    const input = initInput('empty-cli');
    initializeV2(root, input, { clock: () => new Date(occurredAt) });
    const files = storePaths(root);
    const before = treeDigest(files.store);

    const handlerCalls = { migration: 0, continuity: 0, graphify: 0 };
    const handlers = {
      migrationCommandHandler: () => { handlerCalls.migration += 1; return 71; },
      continuityCommandHandler: () => { handlerCalls.continuity += 1; return 72; },
      graphifyCommandHandler: () => { handlerCalls.graphify += 1; return 73; },
    };
    let result = await awaitMain(['--root', root, 'inspect', '--subject', input.finalGoal.goalId], handlers);
    assert.equal(result.status, 72, result.stderr);
    assert.deepEqual(handlerCalls, { migration: 0, continuity: 1, graphify: 0 });
    result = await awaitMain(['event', 'template', 'task.planned']);
    assert.equal(result.status, 0, result.stderr);

    const invalidInvocations = [
      ['inspect', '--subject', ''],
      ['inspect', '--subject', '   '],
      ['inspect', '--subject', ' \t\u0001 '],
      ['inspect', '--subject', '\u200b'],
      ['inspect', '--subject', 'goal-\u2060hidden'],
      ['inspect', '--subject', 'goal-conflict', '--handoff', 'handoff-conflict'],
      ['graphify', 'observe', '--graph', ''],
      ['graphify', 'observe', '--graph', '  '],
      ['graphify', 'observe', '--graph', 'graphify-out/\u200bgraph.json'],
      ['event', 'template', ''],
      ['event', 'template', '\t\u0002'],
      ['graphify', 'query', '--', ''],
      ['graphify', 'query', '--', '   '],
      ['graphify', 'query', '--', '\u2060'],
    ];
    for (const args of invalidInvocations) {
      result = await awaitMain(['--root', root, ...args], handlers);
      assert.equal(result.status, 2, `${JSON.stringify(args)}\n${result.stderr}`);
      assert.deepEqual(handlerCalls, { migration: 0, continuity: 1, graphify: 0 }, 'rejected argv reached a downstream handler');
      assert.equal(treeDigest(files.store), before, `${JSON.stringify(args)} changed the store`);
      const rejected = args.at(-1);
      if (rejected.trim()) assert.equal(`${result.stdout}${result.stderr}`.includes(rejected), false, 'CLI echoed a rejected token');
    }

    for (const args of [
      ['--root', '', 'inspect'],
      ['event', 'lint', '--file', ''],
      ['history', '--tail', ''],
      ['migrate', '--to', ''],
    ]) {
      result = await awaitMain(args);
      assert.equal(result.status, 2, `${JSON.stringify(args)}\n${result.stderr}`);
      assert.equal(treeDigest(files.store), before, `${JSON.stringify(args)} changed the store`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertAttentionClosure() {
  const validate = compileInspect();
  const categories = ['goalFailures', 'blocked', 'failed', 'verificationFailed', 'rejected', 'contested', 'stale'];
  const maximum = coordinatorInspect();
  for (const category of categories) maximum.attention[category] = Array.from({ length: 50 }, (_, index) => attentionItem(category, index));
  maximum.project.finalGoal.failureIds = maximum.attention.goalFailures.map((failure) => failure.failureId);
  assert.equal(validate(maximum), true, JSON.stringify(validate.errors));
  const snapshot = structuredClone(maximum);
  deepFreeze(maximum);
  assert.equal(validateInspectSemantics(maximum), maximum);
  assert.deepEqual(maximum, snapshot, 'attention semantic validation mutated a bounded view');

  const wrong = {
    goalFailures: (item) => { item.subject.type = 'task'; item.owner = 'actor-subagent'; },
    blocked: (item) => { item.execution = 'planned'; },
    failed: (item) => { item.execution = 'blocked'; },
    verificationFailed: (item) => { item.verification = 'passed'; },
    rejected: (item) => { item.acceptance = 'accepted'; },
    contested: (item) => { item.state = 'resolved'; },
    stale: (item) => { item.freshness = 'fresh'; },
  };
  for (const category of categories) {
    const invalid = coordinatorInspect();
    const item = attentionItem(category);
    wrong[category](item);
    invalid.attention[category] = [item];
    assert.equal(validate(invalid), false, `${category} accepted a wrong discriminator`);

    const overBound = coordinatorInspect();
    overBound.attention[category] = Array.from({ length: 51 }, (_, index) => attentionItem(category, index));
    assert.equal(validate(overBound), false, `${category} accepted item 51`);

    const duplicateId = coordinatorInspect();
    const first = attentionItem(category);
    const second = structuredClone(first);
    if (category === 'goalFailures') second.impact = 'A distinct summary with the same stable ID';
    else if (['blocked', 'failed', 'verificationFailed', 'rejected'].includes(category)) second.title = 'A distinct task summary with the same stable ID';
    else if (category === 'contested') second.reason = 'A distinct contradiction summary with the same stable ID';
    else second.limitation = 'A distinct evidence summary with the same stable ID';
    duplicateId.attention[category] = [first, second];
    if (category === 'goalFailures') duplicateId.project.finalGoal.failureIds = [first.failureId];
    assert.equal(validate(duplicateId), true, `${category} duplicate-ID fixture must remain shape-valid`);
    assert.throws(
      () => validateInspectSemantics(duplicateId),
      (error) => error instanceof MemoryError && error.exitCode === 3 && error.message === 'inspect semantics are invalid',
      `${category} accepted a duplicate stable ID`,
    );

    const unknownField = coordinatorInspect();
    unknownField.attention[category] = [{ ...attentionItem(category), unknown: true }];
    assert.equal(validate(unknownField), false, `${category} accepted an unknown item field`);
  }

  const unknownCategory = coordinatorInspect();
  unknownCategory.attention.unknown = [];
  assert.equal(validate(unknownCategory), false, 'attention accepted an unknown category');
}

async function assertOpaqueGraphifyDispatch() {
  const root = makeRepository('truth-opaque-graphify');
  try {
    const before = projectDigest(root);
    const calls = [];
    const forbidden = ['graphifyRunner', 'processRunner', 'shellRunner', 'networkRunner', 'renderer', 'migrationEngine'];
    const sideEffects = Object.fromEntries(forbidden.map((key) => [key, 0]));
    const rejectSideEffect = (name) => () => {
      sideEffects[name] += 1;
      throw new Error(`${name} must remain outside core dispatch`);
    };
    const graphifyCommandHandler = (context, args) => {
      calls.push({
        graph: context.options.graph,
        passthrough: [...context.options.passthrough],
        timeoutMs: context.options.timeoutMs,
        args: [...args],
        exposedAuthorityKeys: forbidden.filter((key) => Object.hasOwn(context, key)),
      });
      return 0;
    };
    const queryArgs = [
      '--root', root, 'graphify', 'query', '--graph', '-graph.json', '--timeout-ms', '2500',
      '--', 'query', '--leading-data', '-second-value', '--graph', '../opaque-data',
    ];
    for (const key of forbidden) {
      const rejected = await awaitMain(queryArgs, { graphifyCommandHandler, [key]: rejectSideEffect(key) });
      assert.equal(rejected.status, 3, `${key} was accepted as public CLI authority`);
      assert.equal(rejected.stdout, '');
      assert.equal(rejected.stderr, 'continuity: ERROR: main options are invalid\n');
      assert.deepEqual(calls, [], `${key} reached Graphify dispatch before option rejection`);
      assert.equal(projectDigest(root), before, `${key} option rejection mutated the synthetic repository`);
    }
    let result = await awaitMain(queryArgs, { graphifyCommandHandler });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls, [{
      graph: '-graph.json',
      passthrough: ['query', '--leading-data', '-second-value', '--graph', '../opaque-data'],
      timeoutMs: 2500,
      args: ['query'],
      exposedAuthorityKeys: [],
    }]);
    assert.deepEqual(sideEffects, Object.fromEntries(forbidden.map((key) => [key, 0])));
    assert.equal(projectDigest(root), before, 'Graphify parser dispatch mutated the synthetic repository');

    for (const args of [
      ['--root', root, 'graphify', 'query', '--unknown', '--', 'query'],
      ['--root', root, 'graphify', 'observe', '--graph'],
    ]) {
      result = await awaitMain(args, { graphifyCommandHandler });
      assert.equal(result.status, 2, `${JSON.stringify(args)}\n${result.stderr}`);
      assert.equal(calls.length, 1, 'rejected Graphify argv reached the injected handler');
      assert.equal(projectDigest(root), before, 'rejected Graphify argv mutated the synthetic repository');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertJournalProjectionCompatibility() {
  const validateProjection = compileSchemaDocument('projection-v2.schema.json');
  const validRoot = makeRepository('truth-valid-journal-rebuild');
  const invalidRoot = makeRepository('truth-invalid-journal-rebuild');
  try {
    const validInput = initInput('journal-valid');
    initializeV2(validRoot, validInput, { clock: () => new Date(occurredAt) });
    appendV2(validRoot, taskDraft('journal-valid', validInput));
    const validFiles = storePaths(validRoot);
    const journalBefore = readFileSync(validFiles.history);
    writeFileSync(validFiles.current, '{"stale":true}\n');
    const rebuilt = rebuildProjection(validRoot);
    assert.equal(validateProjection(rebuilt), true, JSON.stringify(validateProjection.errors));
    assert.equal(validateProjection(JSON.parse(readFileSync(validFiles.current, 'utf8'))), true, JSON.stringify(validateProjection.errors));
    assert.deepEqual(readFileSync(validFiles.history), journalBefore, 'projection rebuild rewrote the valid v2 journal');
    assert.equal(readV2Journal(validRoot).projection, 'current');

    const invalidInput = initInput('journal-invalid');
    initializeV2(invalidRoot, invalidInput, { clock: () => new Date(occurredAt) });
    const duplicateDraft = taskDraft('journal-invalid', invalidInput);
    appendV2(invalidRoot, duplicateDraft);
    const invalidFiles = storePaths(invalidRoot);
    const validStore = readV2Journal(invalidRoot);
    const last = validStore.events.at(-1);
    const duplicate = buildEnvelope(duplicateDraft, {
      epochId: last.epochId,
      sequence: last.sequence + 1,
      recordedAt: last.recordedAt,
      workspaceAtRecord: last.workspaceAtRecord,
      previousEventHash: last.eventHash,
    });
    const invalidJournal = Buffer.concat([
      readFileSync(invalidFiles.history),
      Buffer.from(`${JSON.stringify(duplicate)}\n`, 'utf8'),
    ]);
    const projectionSentinel = Buffer.from('{"invalid-semantic-journal":"must-not-normalize"}\n', 'utf8');
    writeFileSync(invalidFiles.history, invalidJournal);
    writeFileSync(invalidFiles.current, projectionSentinel);
    assert.throws(() => readV2Journal(invalidRoot), MemoryError);
    assert.throws(() => rebuildProjection(invalidRoot), MemoryError);
    assert.deepEqual(readFileSync(invalidFiles.history), invalidJournal, 'invalid semantic journal was rewritten');
    assert.deepEqual(readFileSync(invalidFiles.current), projectionSentinel, 'invalid semantic journal was normalized into a projection');
  } finally {
    rmSync(validRoot, { recursive: true, force: true });
    rmSync(invalidRoot, { recursive: true, force: true });
  }
}

function assertTaskTruthAxesRecompute() {
  const root = makeRepository('truth-task-axes-recompute');
  try {
    const input = initInput('task-axes');
    initializeV2(root, input, { clock: () => new Date(occurredAt) });
    const goalId = input.finalGoal.goalId;
    const taskId = 'task-truth-axes';
    const criterionId = 'criterion-truth-axes';
    const attemptId = 'attempt-truth-axes';
    const handoffId = 'handoff-truth-axes';
    const coordinator = { kind: 'coordinator', id: 'actor-coordinator', role: 'coordinator' };
    const subagent = { kind: 'subagent', id: 'actor-subagent', role: 'subagent' };
    const user = { kind: 'user', id: 'actor-user', role: 'user' };
    const draft = (eventType, subject, actor, payload, { evidenceRefs = [], goal = goalId, task } = {}) => ({
      eventType, occurredAt, actor, subject, ...(goal ? { goalId: goal } : {}), ...(task ? { taskId: task } : {}),
      supersedes: [], contradicts: [], evidenceRefs, sensitivity: 'internal', payload,
    });
    const append = (value) => appendV2(root, value);
    const evidence = (evidenceId, outcome) => draft('evidence.recorded', { type: 'criterion', id: criterionId }, coordinator, {
      evidence: {
        evidenceId, kind: 'test', subjectId: criterionId, scope: 'Task truth-axis verification',
        locator: `checks/${evidenceId}`, observedAt: occurredAt,
        verifier: { kind: 'tool', id: 'tool-independent-verifier' }, method: 'Synthetic public evidence event',
        outcome, policy: { kind: 'immutable_until_superseded' }, sourceRefs: [], sensitivity: 'internal',
      },
    });

    append(draft('criterion.declared', { type: 'criterion', id: criterionId }, coordinator, {
      criterion: {
        criterionId, ownerType: 'goal', ownerId: goalId, condition: 'Independent evidence decides verification',
        scope: 'Synthetic task truth axes', requiredEvidenceKinds: ['test'],
        freshnessPolicy: { kind: 'immutable_until_superseded' }, waivableByUser: false,
      },
    }));
    append(draft('task.planned', { type: 'task', id: taskId }, coordinator, {
      task: {
        taskId, goalId, title: 'Recompute four task truth axes', scope: 'Synthetic event-driven projection',
        pathOwnership: ['src/task-truth-axes'], owner: 'actor-subagent', dependencyIds: [], criterionIds: [criterionId],
        userFacing: true, requiredForGoal: false,
      },
    }, { task: taskId }));
    append(draft('handoff.assigned', { type: 'handoff', id: handoffId }, coordinator, {
      handoff: {
        handoffId, taskId, assignmentId: 'assignment-truth-axes', parentRunId: 'run-parent-truth-axes',
        owner: 'actor-subagent', scope: 'Report without authorizing task axes', pathOwnership: ['src/task-truth-axes'],
        criterionIds: [criterionId], deliverables: ['Synthetic report'], prohibitedActions: ['Do not set acceptance'],
      },
    }, { task: taskId }));
    append(draft('attempt.started', { type: 'attempt', id: attemptId }, subagent, {
      attempt: {
        attemptId, taskId, ordinal: 1, owner: 'actor-subagent', approachId: 'approach-truth-axes',
        hypothesisId: 'hypothesis-truth-axes', approachSummary: 'Exercise independent persisted axes',
      },
    }, { task: taskId }));
    append(draft('task.started', { type: 'task', id: taskId }, subagent, { attemptId }, { task: taskId }));
    append(evidence('evidence-truth-axes-pass-1', 'passed'));
    append(draft('task.implemented', { type: 'task', id: taskId }, subagent, {
      attemptId, deliverableEvidenceRefs: ['evidence-truth-axes-pass-1'],
    }, { task: taskId }));
    append(draft('attempt.reported', { type: 'attempt', id: attemptId }, subagent, {
      attemptId, outcome: 'succeeded', endedAt: occurredAt, summary: 'Implementation reported successful',
      evidenceRefs: ['evidence-truth-axes-pass-1'],
    }, { task: taskId }));
    append(draft('task.completed', { type: 'task', id: taskId }, coordinator, {
      attemptId, criterionEvidenceRefs: ['evidence-truth-axes-pass-1'],
    }, { task: taskId }));
    const reportReceipt = append(draft('handoff.reported', { type: 'handoff', id: handoffId }, subagent, {
      report: {
        handoffId, attemptId, outcome: 'succeeded', summary: 'Report remains historical only', changedArtifacts: [],
        evidenceRefs: ['evidence-truth-axes-pass-1'], failureIds: [], uncertainties: [],
      },
    }, { task: taskId }));
    append(draft('handoff.accepted', { type: 'handoff', id: handoffId }, coordinator, {
      handoffId, reportEventId: reportReceipt.eventId, reason: 'Coordinator accepted the bounded report',
      evidenceRefs: ['evidence-truth-axes-pass-1'],
    }, { evidenceRefs: ['evidence-truth-axes-pass-1'], task: taskId }));

    let task = readV2Journal(root).state.tasks.find((item) => item.taskId === taskId);
    assert.deepEqual(
      { execution: task.execution, verification: task.verification, acceptance: task.acceptance },
      { execution: 'completed', verification: 'passed', acceptance: 'pending' },
      'execution or handoff report supplied verification/acceptance',
    );

    append(draft('evidence.recorded', { type: 'task', id: taskId }, user, {
      evidence: {
        evidenceId: 'evidence-truth-axes-user', kind: 'user_message', subjectId: taskId,
        scope: 'Task acceptance', locator: 'user-message-task-acceptance', observedAt: occurredAt,
        verifier: { kind: 'user', id: 'actor-user' }, method: 'Synthetic user feedback', outcome: 'observed',
        policy: { kind: 'immutable_until_superseded' }, sourceRefs: [], sensitivity: 'internal',
      },
    }, { task: taskId }));
    append(draft('feedback.rejected', { type: 'task', id: taskId }, user, {
      feedback: {
        feedbackId: 'feedback-truth-axes-rejected', subjectId: taskId, disposition: 'rejected',
        acceptanceEffect: 'reject', statement: 'The user rejected this result', evidenceRef: 'evidence-truth-axes-user',
        baselineApproachId: 'approach-truth-axes', baselineHypothesisId: 'hypothesis-truth-axes',
        nextAction: 'Correct the rejected result',
      },
    }, { evidenceRefs: ['evidence-truth-axes-user'], task: taskId }));
    append(evidence('evidence-truth-axes-failed', 'failed'));
    task = readV2Journal(root).state.tasks.find((item) => item.taskId === taskId);
    assert.deepEqual(
      { execution: task.execution, verification: task.verification, acceptance: task.acceptance },
      { execution: 'completed', verification: 'failed', acceptance: 'rejected' },
      'latest evidence and feedback did not independently recompute task axes',
    );

    append(draft('feedback.correction', { type: 'task', id: taskId }, user, {
      feedback: {
        feedbackId: 'feedback-truth-axes-corrected', subjectId: taskId, disposition: 'satisfied',
        acceptanceEffect: 'accept', statement: 'The user now accepts the corrected result',
        evidenceRef: 'evidence-truth-axes-user', supersedesFeedbackId: 'feedback-truth-axes-rejected',
      },
    }, { evidenceRefs: ['evidence-truth-axes-user'], task: taskId }));
    append(evidence('evidence-truth-axes-inconclusive', 'inconclusive'));
    task = readV2Journal(root).state.tasks.find((item) => item.taskId === taskId);
    assert.deepEqual(
      { execution: task.execution, verification: task.verification, acceptance: task.acceptance },
      { execution: 'completed', verification: 'inconclusive', acceptance: 'accepted' },
    );
    append(evidence('evidence-truth-axes-pass-2', 'passed'));

    const files = storePaths(root);
    const canonicalProjection = readFileSync(files.current);
    unlinkSync(files.current);
    const rebuilt = rebuildProjection(root);
    assert.deepEqual(readFileSync(files.current), canonicalProjection, 'delete/rebuild changed canonical projection bytes');
    task = rebuilt.tasks.find((item) => item.taskId === taskId);
    assert.deepEqual(
      { execution: task.execution, verification: task.verification, acceptance: task.acceptance },
      { execution: 'completed', verification: 'passed', acceptance: 'accepted' },
    );
    assert.equal(canonicalV2(rebuilt).includes('"freshness"'), false, 'fold materialized live freshness in persisted projection');

    const stale = structuredClone(rebuilt);
    const staleTask = stale.tasks.find((item) => item.taskId === taskId);
    staleTask.verification = 'not_run';
    staleTask.acceptance = 'pending';
    staleTask.freshness = 'fresh';
    writeFileSync(files.current, `${JSON.stringify(stale)}\n`);
    assert.equal(readV2Journal(root).projection, 'stale', 'cached axes were trusted as authoritative projection data');
    const repaired = rebuildProjection(root);
    assert.deepEqual(readFileSync(files.current), canonicalProjection, 'rebuild retained stale cached task axes');
    assert.equal(Object.hasOwn(repaired.tasks.find((item) => item.taskId === taskId), 'freshness'), false);
    const validateProjection = compileSchemaDocument('projection-v2.schema.json');
    assert.equal(validateProjection(repaired), true, JSON.stringify(validateProjection.errors));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertInjectedHandlerContract() {
  const root = makeRepository('truth-injected-handler-contract');
  try {
    const calls = { migration: [], continuity: [], graphify: [] };
    const forbidden = ['graphifyRunner', 'processRunner', 'shellRunner', 'networkRunner', 'renderer', 'migrationEngine'];
    const commandHandler = (family, sentinel) => (context, args) => {
      for (const key of forbidden) assert.equal(Object.hasOwn(context, key), false, `${family} context exposed ${key}`);
      calls[family].push({ operation: context.operation, options: context.options, args: [...args] });
      return sentinel;
    };
    const handlers = {
      migrationCommandHandler: commandHandler('migration', 61),
      continuityCommandHandler: commandHandler('continuity', 62),
      graphifyCommandHandler: commandHandler('graphify', 63),
    };

    let result = await awaitMain(['--root', root, 'migrate', '--to', '2', '--resume'], handlers);
    assert.equal(result.status, 61, result.stderr);
    assert.deepEqual(calls.migration.map(({ operation, args }) => ({ operation, args })), [{ operation: 'migrate', args: [] }]);

    initializeV2(root, initInput('injected-handlers'), { clock: () => new Date(occurredAt) });
    result = await awaitMain(['--root', root, 'inspect', '--subject', 'goal-truth-injected-handlers'], handlers);
    assert.equal(result.status, 62, result.stderr);
    assert.deepEqual(calls.continuity.map(({ operation, args }) => ({ operation, args })), [{ operation: undefined, args: [] }]);

    result = await awaitMain([
      '--root', root, 'graphify', 'query', '--graph', '-graph.json', '--timeout-ms', '2500',
      '--', 'query', '--leading-value',
    ], handlers);
    assert.equal(result.status, 63, result.stderr);
    assert.deepEqual(calls.graphify.map(({ operation, options, args }) => ({
      operation, graph: options.graph, timeoutMs: options.timeoutMs,
      passthrough: options.passthrough, args,
    })), [{
      operation: undefined, graph: '-graph.json', timeoutMs: 2500,
      passthrough: ['query', '--leading-value'], args: ['query'],
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertInjectedHandlerExitValidation() {
  const root = makeRepository('truth-injected-handler-exits');
  try {
    const genericFailure = async (args, handlers) => {
      const result = await awaitMain(['--root', root, ...args], handlers);
      assert.deepEqual(result, {
        status: 3, stdout: '', stderr: 'continuity: ERROR: unexpected helper failure\n',
      });
    };
    await genericFailure(['migrate', '--to', '2', '--resume'], {
      migrationCommandHandler: async () => undefined,
    });
    initializeV2(root, initInput('injected-handler-exits'), { clock: () => new Date(occurredAt) });
    await genericFailure(['inspect', '--subject', 'goal-truth-injected-handler-exits'], {
      continuityCommandHandler: async () => 256,
    });
    await genericFailure(['graphify', 'observe'], {
      graphifyCommandHandler: async () => '4',
    });
    await genericFailure(['graphify', 'observe'], {
      graphifyCommandHandler: async () => { throw new Error('untrusted handler detail'); },
    });
    await genericFailure(['graphify', 'observe'], {
      graphifyCommandHandler: async (context) => {
        context.stdout.write('discarded handler stdout\n');
        context.stderr.write('discarded handler stderr\n');
        return undefined;
      },
    });
    const accepted = await awaitMain(['--root', root, 'graphify', 'observe'], {
      graphifyCommandHandler: async () => 255,
    });
    assert.deepEqual(accepted, { status: 255, stdout: '', stderr: '' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function cliAccessorFixture({ values = {}, onAccess = () => {}, throwOnMeta = null } = {}) {
  let stdout = ''; let stderr = '';
  const accesses = [];
  const metaTraps = { getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 };
  const defaults = {
    stdin: undefined,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    clock: undefined,
    git: undefined,
    migrationCommandHandler: undefined,
    continuityCommandHandler: undefined,
    graphifyCommandHandler: undefined,
  };
  const target = {};
  for (const [name, value] of Object.entries({ ...defaults, ...values })) {
    Object.defineProperty(target, name, {
      enumerable: true,
      configurable: false,
      get() {
        accesses.push(name);
        onAccess(name);
        return value;
      },
    });
  }
  const io = new Proxy(target, {
    getPrototypeOf() {
      metaTraps.getPrototypeOf += 1;
      if (throwOnMeta === 'getPrototypeOf') throw new Error('caller io prototype is unavailable');
      return Reflect.getPrototypeOf(target);
    },
    ownKeys() {
      metaTraps.ownKeys += 1;
      if (throwOnMeta === 'ownKeys') throw new Error('caller io keys are unavailable');
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(object, key) {
      metaTraps.getOwnPropertyDescriptor += 1;
      if (throwOnMeta === 'getOwnPropertyDescriptor') throw new Error('caller io descriptor is unavailable');
      return Reflect.getOwnPropertyDescriptor(object, key);
    },
  });
  return {
    io,
    accesses,
    metaTraps,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function assertCliMetadataSnapshot(fixture, label) {
  assert.deepEqual(fixture.metaTraps, {
    getPrototypeOf: 1,
    ownKeys: 1,
    getOwnPropertyDescriptor: 8,
  }, `${label} did not inspect the complete public option bag exactly once`);
}

async function assertLazyCliDependencyAccess() {
  const roots = [];
  const makeRoot = (label) => { const root = makeRepository(label); roots.push(root); return root; };
  try {
    const markerRoot = makeRoot('truth-lazy-marker');
    const markerInput = initInput('lazy-marker');
    initializeV2(markerRoot, markerInput, { clock: () => new Date(occurredAt) });
    const markerFiles = storePaths(markerRoot);
    writeFileSync(markerFiles.migrationMarker, `${JSON.stringify(validMigrationMarker('prepared'))}\n`);
    const initFile = writeDraft(markerRoot, 'lazy-marker-init.json', markerInput);
    const recordFile = writeDraft(markerRoot, 'lazy-marker-record.json', taskDraft('lazy-marker-file', markerInput));
    const stdinDraft = `${JSON.stringify(taskDraft('lazy-marker-stdin', markerInput))}\n`;
    const dependencyValues = {
      stdin: stdinDraft,
      clock: () => new Date(occurredAt),
      git: () => ({ status: 0, stdout: '' }),
      migrationCommandHandler: () => 61,
      continuityCommandHandler: () => 62,
      graphifyCommandHandler: () => 63,
    };
    for (const args of [
      ['init', '--schema', '2', '--file', initFile],
      ['record', '--file', recordFile],
      ['record', '--stdin'],
      ['checkpoint'],
      ['migrate', '--to', '2'],
    ]) {
      const before = mutationBarrierSnapshot(markerRoot, markerFiles);
      const fixture = cliAccessorFixture({
        values: dependencyValues,
        onAccess(name) {
          if (name !== 'stderr' && existsSync(markerFiles.migrationMarker)) unlinkSync(markerFiles.migrationMarker);
        },
      });
      const status = await mainV2(['--root', markerRoot, ...args], fixture.io);
      assert.equal(status, 3, `${args.join(' ')} did not stop at the prepared marker`);
      assert.deepEqual(fixture.accesses, ['stderr'], `${args.join(' ')} resolved io before the marker barrier`);
      assert.match(fixture.stderr(), /mutation is blocked/);
      assert.equal(fixture.stdout(), '');
      assertCliMetadataSnapshot(fixture, args.join(' '));
      assertMutationBarrierUnchanged(markerRoot, markerFiles, before, `lazy public ${args.join(' ')}`);
    }

    for (const [command, operation] of [['validate', 'validate-marker'], ['doctor', 'doctor-marker']]) {
      const before = mutationBarrierSnapshot(markerRoot, markerFiles);
      const fixture = cliAccessorFixture({
        values: {
          ...dependencyValues,
          migrationCommandHandler: (context, args) => {
            assert.equal(context.operation, operation);
            assert.deepEqual(args, []);
            return 64;
          },
        },
        onAccess(name) {
          if (!['migrationCommandHandler', 'stdout', 'stderr'].includes(name) && existsSync(markerFiles.migrationMarker)) {
            unlinkSync(markerFiles.migrationMarker);
          }
        },
      });
      const status = await mainV2(['--root', markerRoot, command], fixture.io);
      assert.equal(status, 64);
      assert.deepEqual(fixture.accesses, ['migrationCommandHandler'], `${command} resolved an unused marker-route dependency`);
      assertMutationBarrierUnchanged(markerRoot, markerFiles, before, `lazy marker ${command}`);
    }

    for (const command of ['inspect', 'history']) {
      const before = mutationBarrierSnapshot(markerRoot, markerFiles);
      const fixture = cliAccessorFixture({
        values: dependencyValues,
        onAccess(name) {
          if (name !== 'stderr' && existsSync(markerFiles.migrationMarker)) unlinkSync(markerFiles.migrationMarker);
        },
      });
      const status = await mainV2(['--root', markerRoot, command], fixture.io);
      assert.equal(status, 3);
      assert.deepEqual(fixture.accesses, ['stderr'], `${command} resolved a dependency before interrupted-migration refusal`);
      assertMutationBarrierUnchanged(markerRoot, markerFiles, before, `lazy marker ${command}`);
    }

    const recordRoot = makeRoot('truth-lazy-record');
    const recordInput = initInput('lazy-record');
    initializeV2(recordRoot, recordInput, { clock: () => new Date(occurredAt) });
    const cleanRecord = cliAccessorFixture({
      values: { stdin: `${JSON.stringify(taskDraft('lazy-record', recordInput))}\n` },
    });
    let status = await mainV2(['--root', recordRoot, 'record', '--stdin'], cleanRecord.io);
    assert.equal(status, 0, cleanRecord.stderr());
    assert.deepEqual(cleanRecord.accesses, ['stdin', 'stdout'], 'clean record resolved unrelated io dependencies');
    assert.match(cleanRecord.stdout(), /event recorded: sequence=3/);
    assertCliMetadataSnapshot(cleanRecord, 'clean record');

    const graphRoot = makeRoot('truth-lazy-graphify');
    const cleanGraphify = cliAccessorFixture({
      values: {
        graphifyCommandHandler: (context, args) => {
          assert.deepEqual(args, ['query']);
          context.stdout.write('synthetic graphify output\n');
          return 76;
        },
      },
    });
    status = await mainV2([
      '--root', graphRoot, 'graphify', 'query', '--graph', '-graph.json', '--', 'query', '--opaque',
    ], cleanGraphify.io);
    assert.equal(status, 76, cleanGraphify.stderr());
    assert.deepEqual(cleanGraphify.accesses, ['graphifyCommandHandler', 'stdout'], 'Graphify resolved unrelated io dependencies');
    assert.equal(cleanGraphify.stdout(), 'synthetic graphify output\n');
    assertCliMetadataSnapshot(cleanGraphify, 'clean Graphify');

    const continuityRoot = makeRoot('truth-lazy-continuity');
    const continuityInput = initInput('lazy-continuity');
    initializeV2(continuityRoot, continuityInput, { clock: () => new Date(occurredAt) });
    const cleanContinuity = cliAccessorFixture({
      values: {
        continuityCommandHandler: (context, args) => {
          assert.deepEqual(args, []);
          assert.equal(context.options.subject, continuityInput.finalGoal.goalId);
          return 75;
        },
      },
    });
    status = await mainV2([
      '--root', continuityRoot, 'inspect', '--subject', continuityInput.finalGoal.goalId,
    ], cleanContinuity.io);
    assert.equal(status, 75, cleanContinuity.stderr());
    assert.deepEqual(cleanContinuity.accesses, ['continuityCommandHandler'], 'continuity resolved unrelated io dependencies');
    assert.equal(cleanContinuity.stdout(), '');

    for (const action of ['--resume', '--rollback']) {
      const before = mutationBarrierSnapshot(markerRoot, markerFiles);
      const recovery = cliAccessorFixture({
        values: {
          migrationCommandHandler: (context, args) => {
            assert.equal(context.options.migrationAction, action.slice(2));
            assert.deepEqual(args, []);
            return 74;
          },
        },
      });
      status = await mainV2(['--root', markerRoot, 'migrate', '--to', '2', action], recovery.io);
      assert.equal(status, 74, recovery.stderr());
      assert.deepEqual(recovery.accesses, ['migrationCommandHandler'], `${action} resolved unrelated io dependencies`);
      assertMutationBarrierUnchanged(markerRoot, markerFiles, before, `lazy migration ${action}`);
    }

    for (const args of [
      [],
      ['--root', graphRoot, 'inspect', '--subject', 'goal-conflict', '--handoff', 'handoff-conflict'],
      ['--root', graphRoot, 'graphify', 'observe', '--graph'],
      ['--root', graphRoot, 'graphify', 'query', '--'],
    ]) {
      const rejected = cliAccessorFixture();
      status = await mainV2(args, rejected.io);
      assert.equal(status, 2, `${JSON.stringify(args)}\n${rejected.stderr()}`);
      assert.deepEqual(rejected.accesses, ['stderr'], `${JSON.stringify(args)} resolved io before rejection`);
      assert.match(rejected.stderr(), /^continuity: ERROR:/);
      assert.equal(rejected.stdout(), '');
    }

    for (const [throwOnMeta, expectedMetaTraps] of [
      ['getPrototypeOf', { getPrototypeOf: 1, ownKeys: 0, getOwnPropertyDescriptor: 0 }],
      ['ownKeys', { getPrototypeOf: 1, ownKeys: 1, getOwnPropertyDescriptor: 0 }],
      ['getOwnPropertyDescriptor', { getPrototypeOf: 1, ownKeys: 1, getOwnPropertyDescriptor: 1 }],
    ]) {
      const before = mutationBarrierSnapshot(markerRoot, markerFiles);
      const rejected = cliAccessorFixture({
        throwOnMeta,
        values: dependencyValues,
        onAccess(name) { throw new Error(`metadata failure resolved ${name}`); },
      });
      status = await mainV2(['--root', markerRoot, 'graphify', 'observe'], rejected.io);
      assert.equal(status, 3, `${throwOnMeta} inspection failure did not fail closed`);
      assert.deepEqual(rejected.metaTraps, expectedMetaTraps);
      assert.deepEqual(rejected.accesses, [], `${throwOnMeta} inspection failure resolved caller authority`);
      assert.equal(rejected.stdout(), '');
      assert.equal(rejected.stderr(), '');
      assertMutationBarrierUnchanged(markerRoot, markerFiles, before, `${throwOnMeta} option inspection failure`);
    }

    const legacyRoot = makeRoot('truth-lazy-legacy');
    const legacyInit = runCli(helper, legacyRoot, ['init']);
    assert.equal(legacyInit.status, 0, legacyInit.stderr);
    const legacyGit = (_root, args) => {
      if (args[0] === 'status') return { status: 0, stdout: '' };
      if (args[0] === 'rev-parse') return { status: 0, stdout: `${'a'.repeat(40)}\n` };
      if (args[0] === 'branch') return { status: 0, stdout: 'main\n' };
      throw new Error('unexpected synthetic git operation');
    };
    const legacy = cliAccessorFixture({ values: { clock: () => new Date(occurredAt), git: legacyGit } });
    status = await mainV2(['--root', legacyRoot, 'inspect', '--json'], legacy.io);
    assert.equal(status, 0, legacy.stderr());
    assert.deepEqual(legacy.accesses, ['clock', 'git', 'stdout'], 'legacy JSON resolved unrelated io dependencies');
    assert.equal(JSON.parse(legacy.stdout()).view, 'legacy-v1');

    const defaultMigration = await awaitMain(['--root', markerRoot, 'migrate', '--to', '2', '--resume']);
    assert.equal(defaultMigration.status, 3);
    assert.match(defaultMigration.stderr, /migration support is not available/);
    const defaultContinuity = await awaitMain(['--root', continuityRoot, 'inspect', '--subject', continuityInput.finalGoal.goalId]);
    assert.equal(defaultContinuity.status, 3);
    assert.match(defaultContinuity.stderr, /inspect rendering is not available/);
    const defaultGraphify = await awaitMain(['--root', graphRoot, 'graphify', 'observe']);
    assert.equal(defaultGraphify.status, 4);
    assert.match(defaultGraphify.stderr, /Graphify support is not available/);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

async function assertEmptyArgvUsageBeforeDiscovery() {
  const outside = mkdtempSync(path.join(os.tmpdir(), 'project-memory-empty-argv-non-git-'));
  const previousCwd = process.cwd();
  try {
    const topLevelBefore = treeDigest(outside);
    const topLevel = spawnSync(process.execPath, [helper], {
      cwd: outside,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      maxBuffer: 1024 * 1024,
    });
    assert.equal(topLevel.status, 2, topLevel.stderr);
    assert.equal(topLevel.stdout, '');
    assert.match(topLevel.stderr, /^continuity: ERROR: usage:/);
    assert.equal(topLevel.stderr.includes(outside), false, 'empty top-level argv echoed its cwd');
    assert.equal(treeDigest(outside), topLevelBefore, 'empty top-level argv changed the non-Git cwd');
    assert.equal(existsSync(path.join(outside, '.continuity')), false, 'empty top-level argv created a store path');

    const exportedBefore = treeDigest(outside);
    const fixture = cliAccessorFixture();
    process.chdir(outside);
    const status = await mainV2([], fixture.io);
    assert.equal(status, 2, fixture.stderr());
    assert.deepEqual(fixture.accesses, ['stderr'], 'exported main([]) resolved io before its usage decision');
    assertCliMetadataSnapshot(fixture, 'exported main([])');
    assert.equal(fixture.stdout(), '');
    assert.match(fixture.stderr(), /^continuity: ERROR: usage:/);
    assert.equal(fixture.stderr().includes(outside), false, 'exported main([]) echoed its cwd');
    assert.equal(treeDigest(outside), exportedBefore, 'exported main([]) changed the non-Git cwd');
    assert.equal(existsSync(path.join(outside, '.continuity')), false, 'exported main([]) created a store path');
  } finally {
    process.chdir(previousCwd);
    rmSync(outside, { recursive: true, force: true });
  }
}

async function awaitMain(args, io = {}) {
  let stdout = ''; let stderr = '';
  const { main } = await import('../../continuity/scripts/lib/core/cli.mjs');
  const status = await main(args, {
    ...io,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });
  return { status, stdout, stderr };
}

export async function run() {
  await assertEmptyArgvUsageBeforeDiscovery();
  assertMarkerBarrier();
  await assertProjectionTempIdentityRace();
  await assertDescriptorBoundedReadRace();
  await assertMarkerRouting();
  assertMalformedComponents();
  assertGoalFailureAttention();
  assertFeedbackCoupling();
  assertFeedbackEvidenceAuthority();
  assertCoordinatorHandoffSummary();
  assertHandoffDetailLinkage();
  assertHandoffStateCoupling();
  assertLegacyStorePathAliasesAndEscapes();
  await assertLegacyDualSurface();
  assertGraphifyNotPresent();
  assertGraphifyCanonicalReceipt();
  assertSemanticRepairFindings();
  assertSemanticCanonicalizationAndRepeatedEquality();
  assertHandoffReportAttemptLinkage();
  runTerminalActorMatrix();
  runD19StableSnapshotMatrix();
  assertClaimAuthorityMatrix();
  assertManualDisputeLifecycle();
  assertProjectionCollectionBounds();
  assertAppendRejectsBeforeRepair();
  assertPathOwnershipUnique();
  assertHandoffDecisionEvidence();
  assertPersistedFeedbackDiscriminators();
  assertAttemptFailureIdSchemaParity();
  assertProjectionContradictionBounds();
  assertReferenceGraphClosure();
  assertTaskCurrentAttemptTransitions();
  assertCanonicalPolicyAndSchemaParity();
  await assertEmptyCliTokens();
  await assertOpaqueGraphifyDispatch();
  assertAttentionClosure();
  assertTaskTruthAxesRecompute();
  assertJournalProjectionCompatibility();
  assertEveryEventFamilyParity();
  await runAllEventPaths();
  await assertInjectedHandlerContract();
  await assertInjectedHandlerExitValidation();
  await assertLazyCliDependencyAccess();
}
