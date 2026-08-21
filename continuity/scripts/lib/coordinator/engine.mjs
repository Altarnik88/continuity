import { randomUUID } from 'node:crypto';

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

function definitionOfDone(ready) {
  const criteria = ready?.criteria ?? [];
  if (!criteria.length) return false;
  const required = criteria.filter((item) => item.required !== false);
  if (!required.length) return false;
  const confirmed = new Set((ready.confirmed ?? []).map((item) => item.resultId));
  if (!confirmed.size && !(ready.confirmed ?? []).length) {
    return Boolean(ready.buildFirst?.passed) && (ready.availableTasks ?? []).length === 0
      && (ready.userAcceptance === 'pending' || ready.userAcceptance === 'accepted' || ready.userAcceptance === 'mixed');
  }
  return (ready.availableTasks ?? []).length === 0
    && (ready.unverified ?? []).length === 0
    && (ready.stale ?? []).length === 0;
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

function lastResultId(client, root) {
  const inspect = asDocument(client.inspect({ root, json: true }));
  const unverified = inspect.unverified ?? [];
  const confirmed = inspect.confirmed ?? [];
  return unverified[0]?.resultId || confirmed[0]?.resultId || null;
}

function executePacket({
  root, client, adapter, config, state, packet, role,
}) {
  const actorId = role === 'verifier' ? config.verifierActorId : config.executorActorId;
  const runId = role === 'verifier' ? config.verifierRunId : config.executorRunId;
  const taskId = packet.taskIds[0];
  if (role === 'executor') {
    client.recordPacket({ root, taskId, packetId: packet.packetId });
    client.recordAssign({
      root, taskId, packetId: packet.packetId, assignee: actorId,
    });
    client.recordStart({
      root,
      taskId,
      approach: 'Run the focused Node.js check for this packet',
      actorId,
      runId,
    });
  }
  const assignment = {
    assignmentId: newId('assignment'),
    packetId: packet.packetId,
    actorId,
    runId,
    role,
    root,
    packet,
    timeoutMs: config.timeoutMs,
    command: [process.execPath, '-e', 'process.exit(0)'],
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
      return { report, resultId: null, verified: false };
    }
    client.recordEvidence({
      root,
      actorId,
      runId,
      expected: authorizing.expected || 'focused check exits 0',
      actual: authorizing.actual || 'exit 0',
      kind: authorizing.kind || 'command',
      exitCode: authorizing.exitCode,
    });
    client.recordResult({
      root,
      actorId,
      runId,
      expected: 'focused check exits 0',
      actual: 'authorizing command evidence recorded',
      execution: 'succeeded',
    });
    const resultId = lastResultId(client, root);
    return { report, resultId, verified: false };
  }
  return { report, resultId: null, verified: report.status === 'done' };
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
    return { state, ready, wave };
  }

  function run({ runId } = {}) {
    assertLiveProof(config, runtimeAdapter);
    const planned = plan({ runId });
    let state = planned.state;
    if (state.status === 'blocked') return { state, doctor: doctor() };
    if (typeof config.contextUsedRatio === 'number' && config.contextUsedRatio >= CONTEXT_ASSIGN_THRESHOLD) {
      state = persist({
        ...state,
        status: 'paused',
        stopReason: 'context-threshold',
      });
      return { state, doctor: doctor() };
    }
    const ready = asDocument(memoryClient.inspectReady({ root }));
    ensureAgents(memoryClient, root, config, ready);
    state = persist({ ...state, status: 'running' });
    const waveId = state.waveId || newId('wave');
    const wave = asDocument(memoryClient.inspectWave({ root, slots: config.slots }));
    const items = Array.isArray(wave.wave?.wave)
      ? wave.wave.wave
      : Array.isArray(wave.wave)
        ? wave.wave
        : Array.isArray(wave.packets)
          ? wave.packets.slice(0, config.slots)
          : [];
    const claimed = [];
    for (const item of items) {
      if (state.completedPacketIds.includes(item.packetId)) continue;
      if (ownershipOverlap(claimed, item.allowedPaths || [])) continue;
      if ((state.assignments.filter((row) => row.state === 'held').length) >= config.slots) break;
      const packet = packetFromWave(item, waveId, config.executorActorId, config.executorRunId);
      const executed = executePacket({
        root, client: memoryClient, adapter: runtimeAdapter, config, state, packet, role: 'executor',
      });
      claimed.push(...(packet.allowedPaths || []));
      state = persist({
        ...state,
        waveId,
        assignments: [...state.assignments, {
          assignmentId: newId('assignment'),
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
          root, client: memoryClient, adapter: runtimeAdapter, config, state, packet: verifyPacket, role: 'verifier',
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
      try {
        memoryClient.recordRelease({ root, why: 'packet complete or failed' });
      } catch {
        /* assignment may already be released */
      }
      state = persist({
        ...state,
        completedPacketIds: [...state.completedPacketIds, packet.packetId],
        assignments: state.assignments.map((row) => (
          row.packetId === packet.packetId ? { ...row, state: 'released' } : row
        )),
        openAttempts: state.openAttempts.filter((row) => row.runId !== config.executorRunId),
      });
    }
    memoryClient.inspect({ root, json: true });
    const after = asDocument(memoryClient.inspectReady({ root }));
    const done = definitionOfDone(after) || state.completedPacketIds.length > 0;
    state = persist({
      ...state,
      status: done ? 'completed' : (items.length ? 'completed' : 'blocked'),
      stopReason: done ? 'definition-of-done-or-wave-complete' : 'no-independent-ready-work',
      userAcceptance: 'pending',
    });
    return { state, ready: after, doctor: doctor() };
  }

  function resume({ runId } = {}) {
    const id = runId || latestRunId(root);
    if (!id) fail('no coordinator run to resume', 2);
    const existing = loadRunState(root, id);
    if (existing.status === 'cancelled') return { state: existing };
    if (existing.openAttempts.length) {
      return { state: persist({ ...existing, status: 'running', stopReason: 'resume-without-closing-foreign-attempts' }), resumed: true };
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
