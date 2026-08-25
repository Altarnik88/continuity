import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { createCliClient, parseRecordedEvent, sanitizedSpawnEnv } from '../protocol/client.mjs';
import { observeWorkspace } from '../core/workspace-v3.mjs';
import { fileContents } from './craft.mjs';
import {
  STANDING_ORDER,
  buildDispatchPacket,
  buildRoster,
  clampSwarmSize,
  leaseConflict,
  nowIso,
  selectDispatchWaveReport,
  swarmRepairDecision,
} from './contract.mjs';
import { planContinuations, planFromGoal } from './planner.mjs';
import {
  all,
  appendMemoryLog,
  get,
  insertTask,
  logLine,
  openStore,
  parseTask,
  remember,
  replaceAgents,
  run,
  sanitizeMemoryRecord,
  snapshot,
  swarmDataDirectory,
} from './store.mjs';

const ENGINE_LOCK_NAME = 'engine.lock';
const ENGINE_LOCK_TTL_MS = 30 * 60 * 1000;

const REGISTRY = Symbol.for('continuity.swarm.engines');

function registry() {
  if (!globalThis[REGISTRY]) globalThis[REGISTRY] = new Map();
  return globalThis[REGISTRY];
}

export function getSwarm(root = process.cwd()) {
  return registry().get(path.resolve(root)) ?? null;
}

export function launchSwarm(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const existing = registry().get(root);
  if (existing) {
    if (options.autoStart !== false) existing.start();
    return existing;
  }
  const engine = createEngine({ ...options, root });
  registry().set(root, engine);
  if (options.autoStart !== false) engine.start();
  return engine;
}

export function createEngine(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const clock = options.clock ?? (() => new Date());
  const paceMs = options.paceMs ?? 180;
  const db = openStore(root);
  const inflight = new Set();
  let timer = null;
  let swarmSize = clampSwarmSize(options.swarmSize ?? 8);
  let maxInflight = 0;

  const client = createCliClient();
  let journalReady = null;
  const registeredActors = new Set();

  seed(db, { swarmSize, clock, root, client });
  recoverOrphans(db, clock, root);

  function continuityStoreDir() {
    return path.join(root, '.continuity');
  }

  function canRecordJournal() {
    if (journalReady != null) return journalReady;
    if (!existsSync(continuityStoreDir())) {
      journalReady = false;
      return false;
    }
    try {
      journalReady = String(client.doctor({ root }).stdout || '').includes('journal=valid');
    } catch {
      journalReady = false;
    }
    return journalReady;
  }

  function safeRecord(fn) {
    if (!canRecordJournal()) return null;
    try {
      return fn();
    } catch {
      return null;
    }
  }

  function readLiveTask(task) {
    if (!task?.id) return task ?? null;
    return parseTask(get(db, 'SELECT * FROM tasks WHERE id = ?', [task.id])) || task;
  }

  function persistBridge(taskId, patch) {
    if (!taskId || !patch) return;
    const cleaned = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value != null && value !== ''),
    );
    if (!Object.keys(cleaned).length) return;
    const row = get(db, 'SELECT spec_json FROM tasks WHERE id = ?', [taskId]);
    if (!row) return;
    let spec = {};
    try {
      spec = JSON.parse(row.spec_json || '{}');
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) spec = {};
    } catch {
      spec = {};
    }
    run(db, 'UPDATE tasks SET spec_json = ? WHERE id = ?', [JSON.stringify({ ...spec, ...cleaned }), taskId]);
  }

  function actorRef(agent) {
    const raw = agent?.id ? String(agent.id) : 'agent-conductor';
    const actorId = /^[a-z][a-z0-9_]*-[a-z0-9][a-z0-9-]{1,72}$/.test(raw) ? raw : 'agent-conductor';
    return { actorId, runId: `run-${actorId}` };
  }

  function classForKind(kind) {
    if (kind === 'handoff') return 'handoff';
    if (kind === 'test') return 'tests';
    if (kind === 'security') return 'security';
    if (kind === 'review') return 'report';
    return 'function';
  }

  function safeText(title, body, fallback) {
    const clean = sanitizeMemoryRecord({
      kind: 'lesson',
      title: title || fallback,
      body: body || fallback,
    });
    const text = String(clean.title || clean.body || fallback).replace(/\s+/g, ' ').trim();
    return (text || fallback).slice(0, 200);
  }

  function ensureJournalTask(task) {
    if (!task?.id) return null;
    const live = readLiveTask(task) || task;
    if (live.spec?.continuity_task_id) return live.spec.continuity_task_id;
    const recorded = safeRecord(() => client.recordTask({
      root,
      title: String(live.title || live.id).slice(0, 200),
      priority: live.kind === 'test' ? 'verification' : 'core',
      class: classForKind(live.kind),
    }));
    const continuityTaskId = parseRecordedEvent(recorded?.stdout)?.subjectId;
    if (!continuityTaskId) return null;
    persistBridge(live.id, {
      continuity_task_id: continuityTaskId,
      continuity_event_id: continuityTaskId,
    });
    return continuityTaskId;
  }

  function mirrorStart(task, agent) {
    const live = readLiveTask(task);
    const continuityTaskId = ensureJournalTask(live);
    if (!continuityTaskId) return;
    const { actorId, runId } = actorRef(agent);
    persistBridge(live.id, { continuity_actor_id: actorId, continuity_run_id: runId });
    const recorded = safeRecord(() => client.recordStart({
      root,
      taskId: continuityTaskId,
      approach: 'Run the assigned swarm task',
      actorId,
      runId,
    }));
    const attemptId = parseRecordedEvent(recorded?.stdout)?.subjectId;
    if (attemptId) {
      persistBridge(live.id, { continuity_attempt_id: attemptId, continuity_event_id: attemptId });
    }
  }

  function mirrorFailure(task, agent, why) {
    const live = readLiveTask(task);
    const continuityTaskId = ensureJournalTask(live);
    if (!continuityTaskId) return;
    const { actorId, runId } = actorRef(agent);
    const reason = safeText(live?.title, why, 'attempt failed');
    safeRecord(() => client.recordReport({
      root, actorId, runId, execution: 'failed', summary: reason,
    }));
    const recorded = safeRecord(() => client.recordFail({
      root,
      actorId,
      runId,
      why: reason,
      impact: 'Task is not complete',
      next: 'Change approach after the recorded failure',
    }));
    persistBridge(live?.id, {
      continuity_event_id: parseRecordedEvent(recorded?.stdout)?.subjectId,
    });
  }

  function mirrorBlocked(task, why) {
    const live = readLiveTask(task);
    const continuityTaskId = ensureJournalTask(live);
    if (!continuityTaskId) return;
    const { actorId, runId } = actorRef({ id: 'agent-conductor' });
    safeRecord(() => client.recordStart({
      root,
      taskId: continuityTaskId,
      approach: 'Dependency check',
      actorId,
      runId,
    }));
    safeRecord(() => client.recordFail({
      root,
      actorId,
      runId,
      why: safeText(live?.title, why, 'a dependency failed'),
      impact: 'Task is not complete',
      next: 'Unblock the failed dependency',
    }));
  }

  function ensureRegisteredActor(actorId, capabilityProfiles) {
    if (!actorId || registeredActors.has(actorId)) return;
    safeRecord(() => client.registerAgent({
      root,
      agent: {
        actorId,
        providerFamily: 'local',
        modelFamily: 'node-worker',
        capabilityProfiles,
        costTier: 'low',
        speedTier: 'fast',
        trustTier: 'standard',
        calibrationStatus: 'calibrated',
        kind: 'subagent',
      },
    }));
    registeredActors.add(actorId);
  }

  function mirrorVerify(task, agent, evidence) {
    const { actorId, runId } = actorRef(agent);
    for (const depId of task.deps || []) {
      const dep = readLiveTask({ id: depId });
      const resultId = dep?.spec?.continuity_result_id;
      const writer = dep?.spec?.continuity_actor_id;
      if (!resultId || writer === actorId) continue;
      ensureRegisteredActor(actorId, ['implementation', 'integration']);
      const exitCode = Number.isInteger(evidence?.exitCode) ? evidence.exitCode : 0;
      const recorded = safeRecord(() => client.recordVerify({
        root,
        resultId,
        actorId,
        runId,
        found: 1,
        executed: 1,
        passed: exitCode === 0 ? 1 : 0,
        failed: exitCode === 0 ? 0 : 1,
        skipped: 0,
        exitCode,
      }));
      persistBridge(task.id, {
        continuity_verify_id: parseRecordedEvent(recorded?.stdout)?.subjectId,
      });
      return;
    }
  }

  function mirrorFinish(task, agent, { ok, message, evidence } = {}) {
    const live = readLiveTask(task);
    const continuityTaskId = ensureJournalTask(live);
    if (!continuityTaskId) return;
    const { actorId, runId } = actorRef(agent);
    persistBridge(live.id, { continuity_actor_id: actorId, continuity_run_id: runId });
    const summary = safeText(live.title, message, ok ? 'task succeeded' : 'task failed');
    safeRecord(() => client.recordReport({
      root, actorId, runId, execution: ok ? 'succeeded' : 'failed', summary,
    }));
    if (!ok) {
      const recorded = safeRecord(() => client.recordFail({
        root,
        actorId,
        runId,
        why: summary,
        impact: 'Task is not complete',
        next: 'Retry with a different approach and a new attempt',
      }));
      persistBridge(live.id, {
        continuity_event_id: parseRecordedEvent(recorded?.stdout)?.subjectId,
      });
      return;
    }
    const recordedEvidence = safeRecord(() => client.recordEvidence({
      root,
      actorId,
      runId,
      taskId: continuityTaskId,
      expected: evidence?.expected || 'focused check exits 0',
      actual: evidence?.actual || 'exit 0',
      kind: evidence?.kind || 'command',
      exitCode: Number.isInteger(evidence?.exitCode) ? evidence.exitCode : 0,
    }));
    const evidenceId = recordedEvidence?.evidenceId;
    if (!evidenceId) return;
    persistBridge(live.id, { continuity_evidence_id: evidenceId });
    const recorded = safeRecord(() => client.recordResult({
      root,
      actorId,
      runId,
      expected: 'focused check exits 0',
      actual: 'authorizing command evidence recorded',
      execution: 'succeeded',
      evidence: evidenceId,
    }));
    const resultId = recorded?.resultId;
    if (resultId) {
      persistBridge(live.id, {
        continuity_result_id: resultId,
        continuity_event_id: resultId,
      });
    }
    if (live.kind === 'test') mirrorVerify(live, agent, evidence);
    if (live.kind === 'handoff' || live.kind === 'digest') {
      safeRecord(() => client.recordContext({
        root,
        taskId: continuityTaskId,
        next: 'Resume from written memory; do not guess',
        actorId,
        runId,
      }));
    }
  }

  function mirrorMemory(entry) {
    if (entry.kind !== 'lesson' && entry.kind !== 'playbook') return;
    const task = entry.taskId ? readLiveTask({ id: entry.taskId }) : null;
    const continuityTaskId = task ? ensureJournalTask(task) : null;
    if (!continuityTaskId) return;
    const assignee = task?.assignee ? { id: task.assignee } : { id: 'agent-conductor' };
    const { actorId, runId } = actorRef(assignee);
    safeRecord(() => client.recordContext({
      root,
      taskId: continuityTaskId,
      next: safeText(entry.title, entry.body, 'Keep the recorded lesson'),
      actorId,
      runId,
    }));
  }

  const engine = {
    root,
    db,
    getSnapshot() {
      const state = snapshot(db);
      const held = state.leases.map((lease) => ({
        taskId: lease.task_id,
        paths: [lease.path],
      }));
      const ready = state.tasks.filter((task) => task.status === 'ready');
      const spawnable = ready.filter((task) => !leaseConflict(held, task.paths));
      const report = selectDispatchWaveReport(spawnable, held);
      const packets = state.tasks
        .filter((task) => task.status === 'ready' || task.status === 'running')
        .map(buildDispatchPacket);
      const inspect = readJournalInspect(root, client);
      const mission = overlayMissionFromInspect(state.mission, inspect);
      return {
        ...state,
        mission,
        standingOrder: STANDING_ORDER,
        files: listForge(root),
        inflight: inflight.size,
        maxInflight,
        packets,
        wave: report.wave.map(buildDispatchPacket),
        rejected: report.rejected,
        freshness: viewFreshness(root),
      };
    },
    start() {
      syncMissionFromInspect(db, { clock, root, client });
      const added = seedPlanFromGoal(db, { clock, root, client }) + enqueueContinuations();
      const pending = Number(get(db, "SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN ('succeeded', 'failed')")?.n ?? 0);
      const status = pending > 0 ? 'running' : 'waiting_accept';
      run(db, 'UPDATE mission SET status = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?', [
        status, nowIso(clock), nowIso(clock), 'mission-primary',
      ]);
      logLine(db, {
        agentId: 'agent-conductor',
        message: pending > 0
          ? `Standing order is active. Autonomous development continues${added ? ` with ${added} new task(s)` : ''}.`
          : 'Standing order holds. No ready work remains; only the user may accept.',
      }, clock);
      if (status === 'running') {
        if (!timer) {
          timer = setInterval(() => { void tick(); }, 80);
          timer.unref?.();
        }
        void tick();
      }
    },
    pause() {
      run(db, "UPDATE mission SET status = 'paused', updated_at = ? WHERE id = ?", [nowIso(clock), 'mission-primary']);
      logLine(db, { agentId: 'agent-conductor', message: 'Swarm paused. Memory and leases stay intact.' }, clock);
    },
    resume() {
      this.start();
    },
    setSwarmSize(size) {
      swarmSize = clampSwarmSize(size);
      run(db, 'UPDATE mission SET swarm_size = ?, updated_at = ? WHERE id = ?', [swarmSize, nowIso(clock), 'mission-primary']);
      const busy = Number(get(db, "SELECT COUNT(*) AS n FROM agents WHERE status = 'working'")?.n ?? 0);
      if (busy === 0) {
        replaceAgents(db, buildRoster(swarmSize), clock);
        logLine(db, { agentId: 'agent-conductor', message: `Roster resized to ${swarmSize} agents.` }, clock);
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      db.close();
      registry().delete(root);
    },
    async waitUntilIdle({ timeoutMs = 20_000 } = {}) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        await tick();
        if (enqueueContinuations() > 0) {
          run(db, "UPDATE mission SET status = 'running', updated_at = ? WHERE id = ?", [nowIso(clock), 'mission-primary']);
        }
        const state = snapshot(db);
        const pending = state.tasks.some((task) => !['succeeded', 'failed'].includes(task.status));
        if (!pending && inflight.size === 0) return engine.getSnapshot();
        await sleep(20);
      }
      throw new Error('swarm did not become idle in time');
    },
  };

  async function tick() {
    const mission = get(db, 'SELECT * FROM mission WHERE id = ?', ['mission-primary']);
    if (!mission || mission.status !== 'running') return;
    const tasks = all(db, 'SELECT * FROM tasks').map(parseTask);
    const byId = Object.fromEntries(tasks.map((task) => [task.id, task]));
    for (const task of tasks) {
      if (task.status !== 'queued') continue;
      if (task.deps.some((id) => byId[id]?.status === 'failed')) {
        run(db, "UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", [
          'a dependency failed', nowIso(clock), task.id,
        ]);
        mirrorBlocked(task, 'a dependency failed');
        continue;
      }
      if (task.deps.every((id) => byId[id]?.status === 'succeeded')) {
        run(db, "UPDATE tasks SET status = 'ready', updated_at = ? WHERE id = ?", [nowIso(clock), task.id]);
      }
    }
    assignReady();
    briefWatchers();
  }

  function briefWatchers() {
    const counts = snapshot(db).counts;
    const leases = all(db, 'SELECT path, agent_id FROM leases');
    const leaseText = leases.map((row) => `${row.agent_id}:${row.path}`).join('; ') || 'none';
    const ts = nowIso(clock);
    const managerDetail = `watching ${counts.succeeded}/${counts.tasks} done, ${counts.queued} queued, ${counts.running} live; leases ${leaseText}`;
    const conductorDetail = `orchestrating ${counts.running} live / ${counts.queued} ready of ${counts.tasks}; packets on GET /api/swarm`;
    run(db, "UPDATE agents SET status = 'watching', detail = ?, updated_at = ? WHERE role = 'manager' AND status != 'working'", [
      managerDetail, ts,
    ]);
    run(db, "UPDATE agents SET status = 'watching', detail = ?, updated_at = ? WHERE role = 'conductor' AND status != 'working'", [
      conductorDetail, ts,
    ]);
  }

  function assignReady() {
    const ready = all(db, "SELECT * FROM tasks WHERE status = 'ready' ORDER BY priority, id").map(parseTask);
    const idle = all(db, "SELECT * FROM agents WHERE status = 'idle'");
    const held = all(db, 'SELECT path, agent_id, task_id FROM leases').map((row) => ({
      path: row.path,
      agentId: row.agent_id,
      taskId: row.task_id,
      paths: [row.path],
    }));

    for (const task of ready) {
      if (requiresHostImplementation(task)) continue;
      if (leaseConflict(held, task.paths)) continue;
      const agent = pickAgent(idle, task);
      if (!agent) continue;
      idle.splice(idle.findIndex((row) => row.id === agent.id), 1);
      const ts = nowIso(clock);
      for (const filePath of task.paths) {
        run(db, 'INSERT INTO leases (path, agent_id, task_id, created_at) VALUES (?, ?, ?, ?)', [
          filePath, agent.id, task.id, ts,
        ]);
        held.push({ path: filePath, agentId: agent.id, taskId: task.id, paths: [filePath] });
      }
      run(db, "UPDATE agents SET status = 'working', task_id = ?, detail = ?, updated_at = ? WHERE id = ?", [
        task.id, task.title, ts, agent.id,
      ]);
      run(db, "UPDATE tasks SET status = 'running', assignee = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?", [
        agent.id, ts, task.id,
      ]);
      const live = parseTask(get(db, 'SELECT * FROM tasks WHERE id = ?', [task.id]));
      logLine(db, { agentId: agent.id, message: `${agent.name} claimed ${task.id}: ${task.title}` }, clock);
      mirrorStart(live, agent);
      void execute(agent, live);
    }
  }

  async function execute(agent, task) {
    const token = `${task.id}:${agent.id}`;
    inflight.add(token);
    maxInflight = Math.max(maxInflight, inflight.size);
    try {
      if (paceMs) await sleep(paceMs);
      if (task.kind === 'write' || task.kind === 'analyze' || task.kind === 'security' || task.kind === 'review') {
        await writeProduct(task, agent);
      } else if (task.kind === 'test') await verifyProduct(task, agent);
      else if (task.kind === 'handoff') await writeHandoff(agent);
      else if (task.kind === 'digest') await writeDigest(agent);
      else throw new Error(`unknown kind ${task.kind}`);
    } catch (error) {
      finish(task, agent, { ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      inflight.delete(token);
    }
  }

  function releaseToReady(task, agent) {
    const ts = nowIso(clock);
    clearAssignment(task, agent, ts);
    run(db, "UPDATE tasks SET status = 'ready', assignee = NULL, updated_at = ? WHERE id = ?", [ts, task.id]);
  }

  async function writeProduct(task, agent) {
    if (requiresHostImplementation(task)) {
      releaseToReady(task, agent);
      return;
    }
    const files = selectFiles(task);
    const observed = observeSources(root, task.paths);
    for (const [relative, key] of Object.entries(files)) {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      let body = fileContents(key);
      if (
        observed.length
        && (task.kind === 'analyze' || task.kind === 'security' || task.kind === 'review')
      ) {
        body += `\n## Observed without implementer notes\n\n${observed.map((line) => `- ${line}`).join('\n')}\n`;
      }
      writeFileSync(target, body);
    }
    if (task.spec.buggyFiles && task.attempts <= (task.spec.buggyUntilAttempt ?? 0)) {
      recordMemory({
        id: `mem-lesson-${shortId()}`,
        kind: 'lesson',
        title: 'First store write skipped durability',
        body: 'An in-memory store is not evidence. The next attempt must persist.',
        taskId: task.id,
      });
    }
    finish(task, agent, { ok: true, message: `Wrote ${Object.keys(files).join(', ')}` });
  }

  async function verifyProduct(task, agent) {
    for (const [relative, key] of Object.entries(task.spec.files ?? {})) {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, fileContents(key));
    }
    const result = await runNode(task.spec.run ?? ['--test'], root);
    if (result.code !== 0) {
      const rawOutput = String(result.stderr || result.stdout || 'verification failed');
      const safe = sanitizeMemoryRecord({
        kind: 'failure',
        title: `${task.title} failed`,
        body: rawOutput,
      });
      recordMemory({
        id: `mem-fail-${shortId()}`,
        kind: 'failure',
        title: safe.title,
        body: safe.body,
        taskId: task.id,
      });
      if (task.spec.repairTaskId) {
        const failureCount = Number(get(db, "SELECT COUNT(*) AS n FROM memory WHERE task_id = ? AND kind = 'failure'", [task.id])?.n ?? 0);
        const decision = swarmRepairDecision({ attempts: task.attempts, failureCount });
        if (decision.poison) {
          finish(task, agent, { ok: false, message: `poisoned:${decision.reason}` });
          logLine(db, {
            agentId: agent.id,
            level: 'warn',
            message: `${task.id} poisoned (${decision.reason}). ${task.spec.repairTaskId} stays closed.`,
          }, clock);
          return;
        }
        const ts = nowIso(clock);
        run(db, "UPDATE tasks SET status = 'queued', updated_at = ? WHERE id = ?", [ts, task.spec.repairTaskId]);
        run(db, "UPDATE tasks SET status = 'queued', error = ?, updated_at = ? WHERE id = ?", [safe.body.slice(0, 500), ts, task.id]);
        clearAssignment(task, agent, ts);
        logLine(db, { agentId: agent.id, level: 'warn', message: `${task.id} failed closed. ${task.spec.repairTaskId} reopened.` }, clock);
        mirrorFailure(task, agent, safe.body);
        return;
      }
      finish(task, agent, { ok: false, message: safe.body });
      return;
    }
    recordMemory({
      id: `mem-playbook-${shortId()}`,
      kind: 'playbook',
      title: `${task.title} passed`,
      body: 'A verifier, not the writer, ran the focused check.',
      taskId: task.id,
    });
    finish(task, agent, {
      ok: true,
      message: 'Verification passed',
      evidence: {
        expected: 'focused check exits 0',
        actual: 'exit 0',
        kind: 'test',
        exitCode: 0,
      },
    });
  }

  async function writeHandoff(agent) {
    finish({ id: 'task-handoff', kind: 'handoff' }, agent, { ok: true, message: 'Handoff written' });
    const state = snapshot(db);
    const inspect = readJournalInspect(root, client);
    const machine = buildMachineHandoff(state, inspect, root);
    const directory = path.join(root, 'forge');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'HANDOFF.json'), `${JSON.stringify(machine, null, 2)}\n`);
    let markdown = renderInspectHandoff(inspect, machine);
    if (canRecordJournal()) {
      const live = readLiveTask({ id: 'task-handoff' });
      const taskId = live?.spec?.continuity_task_id;
      if (taskId) {
        const recorded = safeRecord(() => client.handoff({ root, taskId }));
        if (recorded?.stdout) markdown = String(recorded.stdout);
      }
    }
    writeFileSync(path.join(directory, 'HANDOFF.md'), markdown.endsWith('\n') ? markdown : `${markdown}\n`);
  }

  async function writeDigest(agent) {
    const state = snapshot(db);
    const freshness = viewFreshness(root);
    const lines = [
      '# Product memory',
      '',
      'view: untrusted-view',
      `freshness: ${freshness.freshness}`,
      `HEAD: ${freshness.head}`,
      `dirty: ${freshness.dirty}`,
      '',
      'This markdown is a view, not a store. Core HISTORY is truth.',
      'A historical PASS is not current. Swarm succeeded is not user accept.',
      '',
      `Standing order: ${STANDING_ORDER}`,
      '',
      '## Lessons, failures, and playbooks',
      ...(state.memory.length
        ? state.memory.map((item) => {
          const clean = sanitizeMemoryRecord({ kind: item.kind, title: item.title, body: item.body });
          return `- (${clean.kind}) ${clean.title} — ${clean.body}`;
        })
        : ['- none yet']),
      '',
    ];
    const target = path.join(root, 'forge', 'MEMORY.md');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${lines.join('\n')}\n`);
    recordMemory({
      id: `mem-digest-${shortId()}`,
      kind: 'playbook',
      title: 'Product memory file written',
      body: 'Lessons were copied into forge/MEMORY.md for the next actor.',
      taskId: 'task-memory-digest',
    });
    finish({ id: 'task-memory-digest', kind: 'digest' }, agent, { ok: true, message: 'Product memory written' });
  }

  function recordMemory(entry) {
    remember(db, entry, clock);
    appendMemoryLog(root, { ...entry, at: nowIso(clock) });
    mirrorMemory(entry);
  }

  function enqueueContinuations() {
    const state = snapshot(db);
    const next = planContinuations(state).filter((task) => (
      state.mission?.status !== 'waiting_accept' || task.kind === 'test' || task.kind === 'security' || task.kind === 'review'
    ));
    for (const task of next) {
      insertTask(db, task, clock);
      ensureJournalTask(task);
    }
    if (next.length) {
      logLine(db, { agentId: 'agent-conductor', message: `Queued ${next.length} continuation task(s). Standing order still holds.` }, clock);
    }
    return next.length;
  }

  function finish(task, agent, { ok, message, evidence } = {}) {
    const ts = nowIso(clock);
    clearAssignment(task, agent, ts);
    mirrorFinish(task, agent, { ok, message, evidence });
    run(db, 'UPDATE tasks SET status = ?, error = ?, verifier = ?, updated_at = ? WHERE id = ?', [
      ok ? 'succeeded' : 'failed',
      ok ? null : String(message).slice(0, 800),
      task.kind === 'test' || task.kind === 'security' || task.kind === 'review' ? agent.id : null,
      ts,
      task.id,
    ]);
    logLine(db, {
      agentId: agent.id,
      level: ok ? 'info' : 'error',
      message: `${task.id} ${ok ? 'succeeded' : 'failed'}: ${message}`,
    }, clock);
    const remaining = Number(get(db, "SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN ('succeeded', 'failed')")?.n ?? 0);
    if (remaining === 0) {
      const added = enqueueContinuations();
      if (added > 0) {
        run(db, "UPDATE mission SET status = 'running', updated_at = ? WHERE id = ?", [ts, 'mission-primary']);
        queueMicrotask(() => { void tick(); });
        return;
      }
      run(db, "UPDATE mission SET status = 'waiting_accept', updated_at = ? WHERE id = ?", [ts, 'mission-primary']);
      logLine(db, {
        agentId: 'agent-conductor',
        message: 'Ready wave is complete. Standing order holds until the user accepts.',
      }, clock);
    }
  }

  function clearAssignment(task, agent, ts) {
    run(db, 'DELETE FROM leases WHERE task_id = ?', [task.id]);
    run(db, "UPDATE agents SET status = 'idle', task_id = NULL, detail = '', updated_at = ? WHERE id = ?", [ts, agent.id]);
  }

  return engine;
}

function recoverOrphans(db, clock, root) {
  if (!shouldReclaimOrphans(root)) return;
  const ts = nowIso(clock);
  run(db, "UPDATE tasks SET status = 'queued', assignee = NULL, updated_at = ? WHERE status = 'running'", [ts]);
  run(db, 'DELETE FROM leases');
  run(db, "UPDATE agents SET status = 'idle', task_id = NULL, detail = '', updated_at = ?", [ts]);
}

function shouldReclaimOrphans(root) {
  const file = path.join(swarmDataDirectory(root), ENGINE_LOCK_NAME);
  if (!existsSync(file)) return false;
  const record = readEngineLockRecord(file);
  if (isLiveEnginePid(record?.pid)) return false;
  return isDeadEnginePid(record?.pid) || isEngineLockExpired(record, file);
}

function readEngineLockRecord(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function isLiveEnginePid(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function isDeadEnginePid(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

function isEngineLockExpired(record, file) {
  const stamp = record?.acquiredAt ?? record?.ts;
  const parsed = typeof stamp === 'number' ? stamp : Date.parse(stamp);
  if (Number.isFinite(parsed)) return Date.now() - parsed > ENGINE_LOCK_TTL_MS;
  try {
    return Date.now() - statSync(file).mtimeMs > ENGINE_LOCK_TTL_MS;
  } catch {
    return false;
  }
}

function journalGoalId(root, client) {
  const inspect = readJournalInspect(root, client);
  return inspect?.goal?.goalId || inspect?.finalGoal?.goalId || '';
}

function overlayMissionFromInspect(mission, inspect) {
  if (!mission) return mission;
  const goalId = inspect?.goal?.goalId || inspect?.finalGoal?.goalId || '';
  const acceptance = inspect?.goal?.acceptance || inspect?.userAcceptance || 'pending';
  return {
    ...mission,
    title: goalId || mission.title || '',
    accepted: acceptance,
    acceptedSource: inspect ? 'inspect-copy' : 'sqlite-pending',
  };
}

function syncMissionFromInspect(db, { clock, root, client }) {
  const inspect = readJournalInspect(root, client);
  const goalId = inspect?.goal?.goalId || inspect?.finalGoal?.goalId || '';
  const acceptance = inspect?.goal?.acceptance || inspect?.userAcceptance || 'pending';
  run(db, 'UPDATE mission SET title = ?, accepted = ?, updated_at = ? WHERE id = ?', [
    goalId,
    acceptance,
    nowIso(clock),
    'mission-primary',
  ]);
}

function viewFreshness(root) {
  const live = observeWorkspace(root, new Date().toISOString());
  const dirty = Boolean(live?.dirty);
  const head = live?.head || 'unavailable';
  return {
    view: 'untrusted-view',
    head,
    dirty,
    freshness: dirty || head === 'unavailable' ? 'untrusted' : 'live-git',
  };
}

function buildMachineHandoff(state, inspect, root) {
  const leftover = (state.tasks ?? []).filter((task) => (
    task.status === 'failed' || task.status === 'queued' || task.status === 'ready'
  ));
  const evidenceIds = uniqueText([
    ...(inspect?.evidence ?? []).map((item) => item.evidenceId),
    ...(state.tasks ?? []).map((task) => task.spec?.continuity_evidence_id),
  ]);
  const failedHypotheses = (state.memory ?? [])
    .filter((item) => item.kind === 'failure')
    .map((item) => item.title)
    .filter(Boolean)
    .slice(0, 8);
  const lastCompleted = (state.tasks ?? []).filter((task) => task.status === 'succeeded').at(-1);
  return {
    taskId: lastCompleted?.id || leftover[0]?.id || 'task-handoff',
    lastCompletedStep: lastCompleted ? `${lastCompleted.id} succeeded` : 'no succeeded swarm task',
    actualState: leftover.length ? `remaining ${leftover.map((task) => task.id).join(',')}` : 'ready wave complete',
    nextStep: leftover[0] ? `Continue ${leftover[0].id} with a new actor and run` : 'Wait for record accept --as user',
    evidenceIds,
    failedHypotheses,
    freshness: viewFreshness(root),
    userAcceptance: inspect?.goal?.acceptance || inspect?.userAcceptance || 'pending',
  };
}

function renderInspectHandoff(inspect, machine) {
  const goal = inspect?.goal;
  return [
    '# Continuity handoff',
    '',
    'view: untrusted-view',
    `taskId: ${machine.taskId}`,
    `lastCompletedStep: ${machine.lastCompletedStep}`,
    `actualState: ${machine.actualState}`,
    `nextStep: ${machine.nextStep}`,
    `evidenceIds: ${machine.evidenceIds.join(',') || 'none'}`,
    `failedHypotheses: ${machine.failedHypotheses.join(' | ') || 'none'}`,
    `GOAL ${goal ? `${goal.goalId} ${goal.title ?? ''}` : 'none'}`,
    `ACCEPTANCE ${machine.userAcceptance}`,
    '',
    'Rendered from inspect / machine ContextHandoff. Markdown is a view, not a store.',
    '',
  ].join('\n');
}

function uniqueText(values) {
  return [...new Set(values.filter((item) => typeof item === 'string' && item))];
}

function readJournalInspect(root, client) {
  if (!client || !existsSync(path.join(root, '.continuity'))) return null;
  for (const method of ['inspectReady', 'inspect']) {
    try {
      const document = client[method]({ root })?.document;
      if (document && typeof document === 'object' && !Array.isArray(document)) return document;
    } catch {
      /* inspectReady can fail closed; inspect may still show a goal */
    }
  }
  return null;
}

function seedPlanFromGoal(db, { clock, root, client }) {
  const mission = get(db, 'SELECT * FROM mission WHERE id = ?', ['mission-primary']);
  let planned = planFromGoal(readJournalInspect(root, client));
  if (mission?.status === 'waiting_accept') {
    planned = planned.filter((task) => task.kind === 'test' || task.kind === 'security' || task.kind === 'review');
  }
  if (!planned.length) return 0;
  const existing = new Set(all(db, 'SELECT id FROM tasks').map((row) => row.id));
  let added = 0;
  for (const task of planned) {
    if (!task?.id || existing.has(task.id)) continue;
    insertTask(db, withJournalOrigin(task), clock);
    existing.add(task.id);
    added += 1;
  }
  return added;
}

function seed(db, { swarmSize, clock, root, client }) {
  const ts = nowIso(clock);
  if (!get(db, 'SELECT id FROM mission WHERE id = ?', ['mission-primary'])) {
    run(db, `
      INSERT INTO mission (
        id, title, standing_order, standing_order_ru, product_name, product_dir,
        status, swarm_size, accepted, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, 'pending', NULL, ?)
    `, [
      'mission-primary',
      journalGoalId(root, client) || '',
      STANDING_ORDER,
      STANDING_ORDER,
      'unspecified',
      'forge',
      swarmSize,
      ts,
    ]);
    const opening = [
      {
        id: `mem-order-${shortId()}`,
        kind: 'decision',
        title: 'Standing order',
        body: STANDING_ORDER,
      },
      {
        id: `mem-isolation-${shortId()}`,
        kind: 'playbook',
        title: 'Path leases isolate parallel work',
        body: 'Two ready tasks may run at the same time only when their paths do not overlap.',
      },
    ];
    for (const entry of opening) {
      remember(db, entry, clock);
      appendMemoryLog(root, { ...entry, at: ts });
    }
  }
  seedPlanFromGoal(db, { clock, root, client });
  const count = Number(get(db, 'SELECT COUNT(*) AS n FROM agents')?.n ?? 0);
  if (count === 0) replaceAgents(db, buildRoster(swarmSize), clock);
}

function pickAgent(idle, task) {
  const workers = idle.filter((agent) => agent.role !== 'conductor' && agent.role !== 'manager');
  if (task.kind === 'test') return workers.find((agent) => agent.role === 'verifier') ?? null;
  if (task.kind === 'security') {
    return workers.find((agent) => agent.role === 'security')
      ?? workers.find((agent) => agent.role === 'verifier')
      ?? null;
  }
  if (task.kind === 'review') {
    return workers.find((agent) => agent.role === 'reviewer')
      ?? workers.find((agent) => agent.role === 'verifier')
      ?? null;
  }
  if (task.kind === 'analyze') {
    return workers.find((agent) => agent.role === 'analyst')
      ?? workers.find((agent) => agent.role === 'archivist')
      ?? null;
  }
  if (task.kind === 'handoff' || task.kind === 'digest') {
    return workers.find((agent) => agent.role === 'archivist') ?? null;
  }
  return workers.find((agent) => agent.role === 'executor') ?? null;
}

function selectFiles(task) {
  if (task.spec.buggyFiles && task.attempts <= (task.spec.buggyUntilAttempt ?? 0)) {
    return task.spec.buggyFiles;
  }
  return task.spec.files ?? {};
}

function asIdList(value) {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).filter((item) => item != null && item !== '');
}

function taskSpec(task) {
  const spec = task?.spec;
  return spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : {};
}

function hasCraftMapping(task) {
  const files = taskSpec(task).files;
  return Boolean(files && typeof files === 'object' && !Array.isArray(files) && Object.keys(files).length);
}

function isJournalSourced(task) {
  const spec = taskSpec(task);
  if (task?.goalId || spec.goalId) return true;
  if (asIdList(task?.criterionIds).length || asIdList(spec.criterionIds).length) return true;
  return Boolean(
    spec.continuity_task_id
    || spec.continuity_event_id
    || spec.continuity_attempt_id
    || spec.continuity_result_id
    || spec.continuity_evidence_id
    || task?.continuity_task_id
  );
}

function isProductKind(task) {
  return task?.kind === 'write' || task?.kind === 'analyze' || task?.kind === 'security' || task?.kind === 'review';
}

function hasFocusedCheck(task) {
  return asIdList(task?.focusedVerification).length > 0
    || asIdList(taskSpec(task).focusedVerification).length > 0
    || asIdList(taskSpec(task).run).length > 0;
}

function requiresHostImplementation(task) {
  if (task?.kind === 'review' || task?.kind === 'security' || task?.kind === 'analyze') {
    if (!hasFocusedCheck(task)) return true;
  }
  return isProductKind(task) && (isJournalSourced(task) || !hasCraftMapping(task));
}

function withJournalOrigin(task) {
  const spec = { ...taskSpec(task) };
  if (task.goalId) spec.goalId = task.goalId;
  if (asIdList(task.criterionIds).length) spec.criterionIds = asIdList(task.criterionIds);
  return { ...task, spec };
}

function observeSources(root, paths = []) {
  const notes = [];
  for (const relative of paths) {
    if (relative.endsWith('.md') || relative.endsWith('.html') || relative.endsWith('.json')) continue;
    const full = path.join(root, relative);
    if (!existsSync(full)) continue;
    const body = readFileSync(full, 'utf8');
    const names = [...body.matchAll(/export (?:async )?function ([A-Za-z0-9_]+)/g)].map((match) => match[1]);
    const markers = ['STATUSES', 'createPulse', 'changeStatus', 'writeFileSync', 'createServer', 'addPulse']
      .filter((token) => body.includes(token));
    notes.push(
      names.length
        ? `${relative} exports ${names.join(', ')}${markers.length ? `; markers ${markers.join(', ')}` : ''}`
        : `${relative} read (${body.length} bytes)${markers.length ? `; markers ${markers.join(', ')}` : ''}`,
    );
  }
  return notes;
}

function listForge(root) {
  const base = path.join(root, 'forge');
  if (!existsSync(base)) return [];
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(path.relative(root, full).replaceAll('\\', '/'));
    }
  };
  walk(base);
  return files.sort();
}

function runNode(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env: sanitizedSpawnEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: error.message }));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortId() {
  return randomUUID().slice(0, 8);
}
