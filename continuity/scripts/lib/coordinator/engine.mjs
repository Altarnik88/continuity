import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  CONTEXT_ASSIGN_THRESHOLD,
  ProtocolError,
  ownershipOverlap,
  validateWorkPacket,
} from '../protocol/index.mjs';
import { createAdapter } from './adapters/index.mjs';
import { createCliClient } from '../protocol/client.mjs';
import { loadCoordinatorConfig } from './config.mjs';
import {
  createRunState, latestRunId, loadRunState, saveRunState,
} from './run-state.mjs';

const SHELL_META = /[|&;$><`]/;
const NODE_NAMES = new Set(['node', 'node.exe']);
const ROLLOVER_CONTRACT = 'continuity/references/context-rollover.md';

function fail(message, exitCode = 2) {
  throw new ProtocolError(message, exitCode);
}

function adapterClassOf(adapter, config) {
  return adapter.class || (config.adapter === 'local-process' ? 'live' : 'test-only');
}

function assertLiveProof(config, adapter) {
  if (config.liveProofRequired === false) return;
  const name = adapter.name || config.adapter;
  const adapterClass = adapterClassOf(adapter, config);
  if (name === 'fake' || adapterClass === 'test-only') {
    fail(`adapter ${name} is not live proof of autonomous execution`, 4);
  }
}

function newId(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function asDocument(result) {
  return result?.document && typeof result.document === 'object' ? result.document : {};
}

function missingPlan(ready) {
  const missing = ready?.plan?.missing;
  return Array.isArray(missing) && missing.length ? missing : [];
}

function emptyCounts() {
  return { found: 0, executed: 0, passed: 0, failed: 0, skipped: 0 };
}

function failedReport(message) {
  return {
    status: 'failed',
    failures: [message],
    testCounts: emptyCounts(),
    exactNextStep: 'Fix focusedChecks and retry with a new Attempt',
  };
}

/**
 * Focused check format: exactly one argv array for the current Node.js binary.
 * Each WorkPacket.focusedChecks entry is either:
 *   - a string array of argv tokens, or
 *   - a JSON string encoding that array (task.focusedVerification is a text list).
 * argv[0] may be the current Node binary (or basename `node`); otherwise argv is
 * passed as arguments to `process.execPath`. Empty or malformed lists fail closed.
 */
export function buildCommandFromFocusedChecks(focusedChecks) {
  if (!Array.isArray(focusedChecks) || focusedChecks.length === 0) {
    return { ok: false, reason: 'focusedChecks is empty; refusing to fabricate a no-op command' };
  }
  if (focusedChecks.length !== 1) {
    return {
      ok: false,
      reason: 'focusedChecks must contain exactly one argv array for the current Node.js binary',
    };
  }
  let argv = focusedChecks[0];
  if (typeof argv === 'string') {
    try {
      argv = JSON.parse(argv);
    } catch {
      return { ok: false, reason: 'focusedChecks entry is not a JSON argv array' };
    }
  }
  if (!Array.isArray(argv) || argv.length < 1
    || !argv.every((part) => typeof part === 'string' && part.length > 0)) {
    return { ok: false, reason: 'focusedChecks argv must be a nonempty array of strings' };
  }
  if (argv.some((part) => SHELL_META.test(part))) {
    return { ok: false, reason: 'focusedChecks argv contains shell metacharacters' };
  }
  const head = argv[0];
  const base = path.basename(head).toLowerCase();
  if (head === process.execPath || NODE_NAMES.has(base)) {
    return { ok: true, command: [process.execPath, ...argv.slice(1)] };
  }
  if (/[\\/]/.test(head) || /\.(exe|cmd|bat|ps1)$/i.test(head)) {
    return { ok: false, reason: 'focusedChecks may only execute the current Node.js binary' };
  }
  return { ok: true, command: [process.execPath, ...argv] };
}

function waveExhausted(ready) {
  const criteria = ready?.criteria ?? [];
  if (!criteria.length) return false;
  const required = criteria.filter((item) => item.required !== false);
  if (!required.length) return false;
  if (!(ready.confirmed ?? []).length) {
    return Boolean(ready.buildFirst?.passed) && (ready.availableTasks ?? []).length === 0
      && (ready.userAcceptance === 'pending' || ready.userAcceptance === 'accepted' || ready.userAcceptance === 'mixed');
  }
  return (ready.availableTasks ?? []).length === 0
    && (ready.unverified ?? []).length === 0
    && (ready.stale ?? []).length === 0;
}

function waveItems(wave, slots) {
  if (Array.isArray(wave.wave?.wave)) return wave.wave.wave;
  if (Array.isArray(wave.wave)) return wave.wave;
  if (Array.isArray(wave.packets)) return wave.packets.slice(0, slots);
  return [];
}

function overlapsSibling(items, item) {
  return items.some((other) => other !== item
    && ownershipOverlap(item.allowedPaths || [], other.allowedPaths || []));
}

function agentRecord(actorId, { modelFamily, capabilityProfiles, costTier = 'lowest' }) {
  return {
    actorId,
    providerFamily: 'local',
    modelFamily,
    capabilityProfiles,
    costTier,
    speedTier: 'fast',
    trustTier: 'standard',
    calibrationStatus: 'calibrated',
    kind: 'subagent',
  };
}

function ensureAgents(client, root, config, ready) {
  const known = new Set((ready.agents ?? []).map((item) => item.actorId));
  if (!known.has(config.executorActorId)) {
    client.registerAgent({
      root,
      agent: agentRecord(config.executorActorId, {
        modelFamily: 'node-worker',
        capabilityProfiles: ['implementation'],
      }),
    });
  }
  if (!known.has(config.verifierActorId)) {
    client.registerAgent({
      root,
      agent: agentRecord(config.verifierActorId, {
        modelFamily: 'node-verifier',
        capabilityProfiles: ['implementation', 'integration'],
        costTier: 'low',
      }),
    });
  }
}

function packetFromWave(item, waveId, actorId, runId) {
  return validateWorkPacket({
    waveId,
    packetId: item.packetId,
    actorId,
    runId,
    goal: item.completionContract?.[0] || `complete ${item.taskIds.join(',')}`,
    dependencies: item.prerequisites || [],
    taskIds: item.taskIds,
    allowedPaths: item.allowedPaths || [],
    forbiddenPaths: item.forbiddenPaths || [],
    requiredCapabilities: item.requiredCapabilities || [],
    riskCeiling: item.riskCeiling || 'routine',
    contextBudget: item.contextBudget || 4,
    acceptanceCriteria: item.completionContract || [],
    focusedChecks: item.focusedChecks || [],
    knownFailures: [],
    prohibitedApproaches: [],
    reportFormat: 'continuity-agent-report-v1',
    weight: item.weight || 1,
    isolationReason: item.isolationReason || null,
  });
}

function executePacket({
  root, client, adapter, config, packet, role,
}) {
  const actorId = role === 'verifier' ? config.verifierActorId : config.executorActorId;
  const runId = role === 'verifier' ? config.verifierRunId : config.executorRunId;
  const taskId = packet.taskIds[0];
  let assignmentId = null;
  if (role === 'executor') {
    client.recordPacket({ root, taskId, packetId: packet.packetId });
    const assigned = client.recordAssign({
      root, taskId, packetId: packet.packetId, assignee: actorId,
    });
    assignmentId = assigned.assignmentId;
    if (!assignmentId) fail('record assign did not echo assignmentId', 3);
    client.recordStart({
      root,
      taskId,
      approach: 'Run the focused Node.js check for this packet',
      actorId,
      runId,
    });
  }
  const built = buildCommandFromFocusedChecks(packet.focusedChecks);
  if (!built.ok) {
    if (role === 'executor') {
      client.recordFail({
        root,
        actorId,
        runId,
        why: built.reason,
        impact: 'Task is not complete; no authorizing evidence was recorded',
        next: 'Provide exactly one argv array for the current Node.js binary in focusedChecks',
      });
    }
    return {
      report: failedReport(built.reason),
      resultId: null,
      verified: false,
      assignmentId,
    };
  }
  const assignment = {
    assignmentId: assignmentId || newId('assignment'),
    packetId: packet.packetId,
    actorId,
    runId,
    role,
    root,
    packet,
    timeoutMs: config.timeoutMs,
    command: built.command,
  };
  adapter.launchAssignment(assignment);
  adapter.sendContext(assignment, { packet });
  const report = adapter.waitForReport(assignment);
  const evidence = adapter.collectEvidence(assignment);
  if (role === 'executor') {
    client.recordReport({
      root,
      actorId,
      runId,
      execution: report.status === 'done' ? 'succeeded' : report.status,
      summary: report.exactNextStep || report.approach,
    });
    const authorizing = evidence.find((item) => item.exitCode === 0 && (item.kind === 'command' || item.kind === 'test'));
    if (!authorizing) {
      client.recordFail({
        root,
        actorId,
        runId,
        why: report.failures?.[0] || 'executor report lacked authorizing evidence',
        impact: 'Task is not complete',
        next: report.exactNextStep || 'Retry with a different approach and a new Attempt',
      });
      return { report, resultId: null, verified: false, assignmentId };
    }
    client.recordEvidence({
      root,
      actorId,
      runId,
      taskId,
      expected: authorizing.expected || 'focused check exits 0',
      actual: authorizing.actual || 'exit 0',
      kind: authorizing.kind || 'command',
      exitCode: authorizing.exitCode,
    });
    const recorded = client.recordResult({
      root,
      actorId,
      runId,
      expected: 'focused check exits 0',
      actual: 'authorizing command evidence recorded',
      execution: 'succeeded',
    });
    const resultId = recorded.resultId;
    if (!resultId) fail('record result did not echo resultId', 3);
    return { report, resultId, verified: false, assignmentId };
  }
  return { report, resultId: null, verified: report.status === 'done', assignmentId };
}

function persistReleaseFailure(client, { root, config, error }) {
  try {
    client.recordFail({
      root,
      actorId: config.executorActorId,
      runId: config.executorRunId,
      why: `assignment release failed: ${error.message}`,
      impact: 'Assignment lease may still be held',
      next: 'Record release with the explicit assignment id',
    });
  } catch {
    /* still surface the release failure on run state */
  }
}

export function createCoordinatorRuntime({
  root,
  config: configInput,
  configFile,
  client,
  adapter,
  clock,
} = {}) {
  if (!root) fail('coordinator requires --root');
  const config = configInput || loadCoordinatorConfig(configFile);
  const memoryClient = client || createCliClient({
    continuityCli: config.memoryCli || undefined,
    timeoutMs: config.timeoutMs,
  });
  const runtimeAdapter = adapter || createAdapter(config.adapter, { timeoutMs: config.timeoutMs });

  function persist(state) {
    return saveRunState(root, state, { clock });
  }

  function doctor() {
    const memory = memoryClient.doctor({ root });
    const health = runtimeAdapter.healthCheck();
    runtimeAdapter.validateConfiguration(config);
    const capabilities = runtimeAdapter.discoverCapabilities();
    assertLiveProof(config, runtimeAdapter);
    return {
      daemon: false,
      interview: false,
      execution: 'sequential',
      contractId: 'project-memory.coordinator.v1',
      memory: String(memory.stdout || '').trim(),
      adapter: {
        name: config.adapter,
        class: adapterClassOf(runtimeAdapter, config),
        health,
        capabilities: capabilities.map((item) => item.actorId),
      },
      liveProof: config.adapter === 'local-process' && health?.live !== false && health?.ok === true,
    };
  }

  function plan({ runId } = {}) {
    const id = runId || newId('run');
    const ready = asDocument(memoryClient.inspectReady({ root }));
    const wave = asDocument(memoryClient.inspectWave({ root, slots: config.slots }));
    let state = createRunState({
      runId: id, adapter: config.adapter, slots: config.slots, clock,
    });
    const missing = missingPlan(ready);
    if (missing.length) {
      state = persist({
        ...state,
        status: 'blocked',
        stopReason: `plan.missing:${missing.join(',')}`,
      });
    } else {
      state = persist({
        ...state,
        status: 'planning',
        waveId: wave.wave?.[0] ? newId('wave') : null,
      });
    }
    return { state, ready, wave, execution: 'sequential' };
  }

  function run({ runId } = {}) {
    assertLiveProof(config, runtimeAdapter);
    const planned = plan({ runId });
    let state = planned.state;
    if (state.status === 'blocked') return { state, doctor: doctor(), execution: 'sequential' };
    if (typeof config.contextUsedRatio === 'number' && config.contextUsedRatio >= CONTEXT_ASSIGN_THRESHOLD) {
      state = persist({
        ...state,
        status: 'paused',
        stopReason: 'context-threshold',
      });
      return { state, doctor: doctor(), execution: 'sequential' };
    }
    const ready = asDocument(memoryClient.inspectReady({ root }));
    ensureAgents(memoryClient, root, config, ready);
    state = persist({ ...state, status: 'running' });
    const waveId = state.waveId || newId('wave');
    const wave = asDocument(memoryClient.inspectWave({ root, slots: config.slots }));
    const items = waveItems(wave, config.slots);
    const claimed = [];
    let launched = 0;
    let releaseFailed = false;
    for (const item of items) {
      if (state.completedPacketIds.includes(item.packetId)) continue;
      if (overlapsSibling(items, item)) continue;
      if (ownershipOverlap(claimed, item.allowedPaths || [])) continue;
      const packet = packetFromWave(item, waveId, config.executorActorId, config.executorRunId);
      launched += 1;
      const executed = executePacket({
        root, client: memoryClient, adapter: runtimeAdapter, config, packet, role: 'executor',
      });
      claimed.push(...(packet.allowedPaths || []));
      state = persist({
        ...state,
        waveId,
        assignments: [...state.assignments, {
          assignmentId: executed.assignmentId || newId('assignment'),
          packetId: packet.packetId,
          actorId: config.executorActorId,
          runId: config.executorRunId,
          role: 'executor',
          state: 'held',
        }],
        openAttempts: [...state.openAttempts, {
          taskId: packet.taskIds[0],
          actorId: config.executorActorId,
          runId: config.executorRunId,
        }],
      });
      if (executed.resultId) {
        const verifyPacket = packetFromWave(item, waveId, config.verifierActorId, config.verifierRunId);
        const verified = executePacket({
          root, client: memoryClient, adapter: runtimeAdapter, config, packet: verifyPacket, role: 'verifier',
        });
        if (verified.report.status === 'done' && executed.resultId) {
          memoryClient.recordVerify({
            root,
            resultId: executed.resultId,
            actorId: config.verifierActorId,
            runId: config.verifierRunId,
            found: verified.report.testCounts.found,
            executed: verified.report.testCounts.executed,
            passed: verified.report.testCounts.passed,
            failed: verified.report.testCounts.failed,
            skipped: verified.report.testCounts.skipped,
          });
        }
      }
      const assignmentId = executed.assignmentId;
      let packetReleaseFailed = false;
      try {
        if (!assignmentId) fail('assignment release requires the assignmentId from the write', 3);
        memoryClient.recordRelease({ root, assignmentId, why: 'packet complete or failed' });
      } catch (error) {
        persistReleaseFailure(memoryClient, { root, config, error });
        packetReleaseFailed = true;
        releaseFailed = true;
      }
      state = persist({
        ...state,
        completedPacketIds: [...state.completedPacketIds, packet.packetId],
        assignments: state.assignments.map((row) => (
          row.packetId === packet.packetId
            ? { ...row, state: packetReleaseFailed ? 'held' : 'released' }
            : row
        )),
        openAttempts: state.openAttempts.filter((row) => row.runId !== config.executorRunId),
      });
    }
    memoryClient.inspect({ root, json: true });
    const after = asDocument(memoryClient.inspectReady({ root }));
    const exhausted = waveExhausted(after);
    let status;
    let stopReason;
    if (exhausted) {
      status = 'completed';
      stopReason = 'wave-exhausted';
    } else if (launched > 0) {
      status = 'partial';
      stopReason = 'ready-work-remains';
    } else {
      status = 'blocked';
      stopReason = items.length ? 'nothing-could-be-launched' : 'no-independent-ready-work';
    }
    if (releaseFailed) {
      stopReason = `${stopReason};assignment-release-failed`;
    }
    state = persist({
      ...state,
      status,
      stopReason,
      userAcceptance: 'pending',
    });
    return { state, ready: after, doctor: doctor(), execution: 'sequential' };
  }

  function resume({ runId } = {}) {
    const id = runId || latestRunId(root);
    if (!id) fail('no coordinator run to resume', 2);
    const existing = loadRunState(root, id);
    if (existing.status === 'cancelled') return { state: existing };
    if (existing.openAttempts.length) {
      return {
        state: persist({
          ...existing,
          status: 'blocked',
          stopReason: 'open-attempts-require-rollover',
        }),
        resumed: true,
        rollover: ROLLOVER_CONTRACT,
      };
    }
    return run({ runId: id });
  }

  function status({ runId } = {}) {
    const id = runId || latestRunId(root);
    if (!id) fail('no coordinator run', 2);
    return { state: loadRunState(root, id) };
  }

  function cancel({ runId } = {}) {
    const id = runId || latestRunId(root);
    if (!id) fail('no coordinator run to cancel', 2);
    const existing = loadRunState(root, id);
    return { state: persist({ ...existing, status: 'cancelled', stopReason: 'operator-cancel' }) };
  }

  return { config, client: memoryClient, adapter: runtimeAdapter, doctor, plan, run, resume, status, cancel };
}
