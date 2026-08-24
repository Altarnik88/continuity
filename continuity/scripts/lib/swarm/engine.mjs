import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { fileContents } from './craft.mjs';
import {
  STANDING_ORDER,
  buildDispatchPacket,
  buildRoster,
  clampSwarmSize,
  leaseConflict,
  nowIso,
} from './contract.mjs';
import { planContinuations, planPulse } from './planner.mjs';
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
  snapshot,
} from './store.mjs';

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

  seed(db, { swarmSize, clock, root });
  recoverOrphans(db, clock);

  const engine = {
    root,
    db,
    getSnapshot() {
      return {
        ...snapshot(db),
        standingOrder: STANDING_ORDER,
        files: listForge(root),
        inflight: inflight.size,
        maxInflight,
        packets: snapshot(db).tasks
          .filter((task) => task.status === 'ready' || task.status === 'running')
          .map(buildDispatchPacket),
      };
    },
    start() {
      const added = enqueueContinuations();
      const pending = Number(get(db, "SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN ('succeeded', 'failed')")?.n ?? 0);
      const accepted = get(db, 'SELECT accepted FROM mission WHERE id = ?', ['mission-primary'])?.accepted;
      const status = pending > 0 ? 'running' : accepted === 'accepted' ? 'idle' : 'waiting_accept';
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
    accept() {
      run(db, "UPDATE mission SET accepted = 'accepted', status = 'idle', updated_at = ? WHERE id = ?", [nowIso(clock), 'mission-primary']);
      recordMemory({
        id: `mem-accept-${shortId()}`,
        kind: 'decision',
        title: 'User accepted the current product state',
        body: 'Acceptance is a user act. The swarm will not treat this as its own proof.',
      });
      logLine(db, { agentId: 'user', message: 'User accepted. The swarm did not accept on the user\'s behalf.' }, clock);
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

  async function writeProduct(task, agent) {
    const files = selectFiles(task);
    for (const [relative, key] of Object.entries(files)) {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, fileContents(key));
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
      const message = (result.stderr || result.stdout || 'verification failed').slice(0, 1200);
      recordMemory({
        id: `mem-fail-${shortId()}`,
        kind: 'failure',
        title: `${task.title} failed`,
        body: message,
        taskId: task.id,
      });
      if (task.spec.repairTaskId) {
        const ts = nowIso(clock);
        run(db, "UPDATE tasks SET status = 'queued', updated_at = ? WHERE id = ?", [ts, task.spec.repairTaskId]);
        run(db, "UPDATE tasks SET status = 'queued', error = ?, updated_at = ? WHERE id = ?", [message.slice(0, 500), ts, task.id]);
        clearAssignment(task, agent, ts);
        logLine(db, { agentId: agent.id, level: 'warn', message: `${task.id} failed closed. ${task.spec.repairTaskId} reopened.` }, clock);
        return;
      }
      finish(task, agent, { ok: false, message });
      return;
    }
    recordMemory({
      id: `mem-playbook-${shortId()}`,
      kind: 'playbook',
      title: `${task.title} passed`,
      body: 'A verifier, not the writer, ran the focused check.',
      taskId: task.id,
    });
    finish(task, agent, { ok: true, message: 'Verification passed' });
  }

  async function writeHandoff(agent) {
    const state = snapshot(db);
    const leftover = state.tasks.filter((task) => task.status !== 'succeeded');
    const lines = [
      '# Continuity handoff',
      '',
      STANDING_ORDER,
      '',
      `Product: ${state.mission?.product_name ?? 'Pulse'}`,
      `User acceptance: ${state.mission?.accepted ?? 'pending'}`,
      '',
      '## Memory',
      ...state.memory.slice(0, 16).map((item) => `- (${item.kind}) ${item.title}`),
      '',
      leftover.length ? '## Remaining work' : '## Remaining work\n- none',
      ...leftover.map((task) => `- ${task.id} ${task.status}: ${task.title}`),
      '',
      'Resume from this file and data/swarm.sqlite. Do not guess.',
      '',
    ];
    const target = path.join(root, 'forge', 'HANDOFF.md');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${lines.join('\n')}\n`);
    finish({ id: 'task-handoff', kind: 'handoff' }, agent, { ok: true, message: 'Handoff written' });
  }

  async function writeDigest(agent) {
    const state = snapshot(db);
    const lines = [
      '# Product memory',
      '',
      'Written by the Continuity swarm so the next session does not guess.',
      '',
      `Standing order: ${STANDING_ORDER}`,
      '',
      '## Lessons, failures, and playbooks',
      ...(state.memory.length ? state.memory.map((item) => `- (${item.kind}) ${item.title} — ${item.body}`) : ['- none yet']),
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
  }

  function enqueueContinuations() {
    const next = planContinuations(snapshot(db));
    for (const task of next) insertTask(db, task, clock);
    if (next.length) {
      logLine(db, { agentId: 'agent-conductor', message: `Queued ${next.length} continuation task(s). Standing order still holds.` }, clock);
    }
    return next.length;
  }

  function finish(task, agent, { ok, message }) {
    const ts = nowIso(clock);
    clearAssignment(task, agent, ts);
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
      const accepted = get(db, 'SELECT accepted FROM mission WHERE id = ?', ['mission-primary'])?.accepted;
      const status = accepted === 'accepted' ? 'idle' : 'waiting_accept';
      run(db, 'UPDATE mission SET status = ?, updated_at = ? WHERE id = ?', [status, ts, 'mission-primary']);
      logLine(db, {
        agentId: 'agent-conductor',
        message: status === 'idle'
          ? 'Work is idle after user acceptance.'
          : 'Ready wave is complete. Standing order holds until the user accepts.',
      }, clock);
    }
  }

  function clearAssignment(task, agent, ts) {
    run(db, 'DELETE FROM leases WHERE task_id = ?', [task.id]);
    run(db, "UPDATE agents SET status = 'idle', task_id = NULL, detail = '', updated_at = ? WHERE id = ?", [ts, agent.id]);
  }

  return engine;
}

function recoverOrphans(db, clock) {
  const ts = nowIso(clock);
  run(db, "UPDATE tasks SET status = 'queued', assignee = NULL, updated_at = ? WHERE status = 'running'", [ts]);
  run(db, 'DELETE FROM leases');
  run(db, "UPDATE agents SET status = 'idle', task_id = NULL, detail = '', updated_at = ?", [ts]);
}

function seed(db, { swarmSize, clock, root }) {
  const ts = nowIso(clock);
  if (!get(db, 'SELECT id FROM mission WHERE id = ?', ['mission-primary'])) {
    run(db, `
      INSERT INTO mission (
        id, title, standing_order, standing_order_ru, product_name, product_dir,
        status, swarm_size, accepted, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, 'pending', NULL, ?)
    `, [
      'mission-primary',
      'Build Pulse autonomously and keep going',
      STANDING_ORDER,
      STANDING_ORDER,
      'Pulse',
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
    for (const task of planPulse()) insertTask(db, task, clock);
  }
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
    return workers.find((agent) => agent.role === 'archivist')
      ?? workers.find((agent) => agent.role === 'integrator')
      ?? null;
  }
  return workers.find((agent) => agent.role === 'executor') ?? null;
}

function selectFiles(task) {
  if (task.spec.buggyFiles && task.attempts <= (task.spec.buggyUntilAttempt ?? 0)) {
    return task.spec.buggyFiles;
  }
  return task.spec.files ?? {};
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
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env } });
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
