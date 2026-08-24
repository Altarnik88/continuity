import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { nowIso } from './contract.mjs';

export function openStore(root) {
  const directory = path.join(root, 'data');
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'swarm.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS mission (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      standing_order TEXT NOT NULL,
      standing_order_ru TEXT NOT NULL,
      product_name TEXT NOT NULL,
      product_dir TEXT NOT NULL,
      status TEXT NOT NULL,
      swarm_size INTEGER NOT NULL,
      accepted TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      task_id TEXT,
      detail TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      paths_json TEXT NOT NULL,
      deps_json TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      assignee TEXT,
      verifier TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS leases (
      path TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      task_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      agent_id TEXT,
      level TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);
  return db;
}

export function all(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

export function get(db, sql, params = []) {
  return db.prepare(sql).get(...params);
}

export function run(db, sql, params = []) {
  return db.prepare(sql).run(...params);
}

export function replaceAgents(db, roster, clock) {
  db.exec('DELETE FROM agents');
  const insert = db.prepare(`
    INSERT INTO agents (id, name, role, status, task_id, detail, updated_at)
    VALUES (?, ?, ?, 'idle', NULL, '', ?)
  `);
  const ts = nowIso(clock);
  for (const agent of roster) insert.run(agent.id, agent.name, agent.role, ts);
}

export function insertTask(db, task, clock) {
  const ts = nowIso(clock);
  run(db, `
    INSERT INTO tasks (
      id, title, kind, status, priority, paths_json, deps_json, spec_json,
      assignee, verifier, attempts, error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, ?, ?)
  `, [
    task.id,
    task.title,
    task.kind,
    'queued',
    task.priority ?? 100,
    JSON.stringify(task.paths),
    JSON.stringify(task.deps ?? []),
    JSON.stringify(task.spec ?? {}),
    ts,
    ts,
  ]);
}

export function logLine(db, { agentId = null, level = 'info', message }, clock) {
  run(db, 'INSERT INTO logs (ts, agent_id, level, message) VALUES (?, ?, ?, ?)', [
    nowIso(clock), agentId, level, message,
  ]);
  run(db, 'DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 400)');
}

export function remember(db, { id, kind, title, body, taskId = null }, clock) {
  run(db, `
    INSERT INTO memory (id, kind, title, body, task_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [id, kind, title, body, taskId, nowIso(clock)]);
}

export function snapshot(db) {
  const mission = get(db, 'SELECT * FROM mission WHERE id = ?', ['mission-primary']) ?? null;
  const agents = all(db, 'SELECT * FROM agents ORDER BY role, name');
  const tasks = all(db, 'SELECT * FROM tasks ORDER BY priority, id').map(parseTask);
  const leases = all(db, 'SELECT * FROM leases ORDER BY path');
  const memory = all(db, 'SELECT * FROM memory ORDER BY created_at DESC, id DESC LIMIT 80');
  const logs = all(db, 'SELECT * FROM logs ORDER BY id DESC LIMIT 80');
  const counts = {
    tasks: tasks.length,
    queued: tasks.filter((task) => task.status === 'queued' || task.status === 'ready').length,
    running: tasks.filter((task) => task.status === 'running' || task.status === 'verifying').length,
    succeeded: tasks.filter((task) => task.status === 'succeeded').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
    agentsLive: agents.filter((agent) => agent.status === 'working').length,
    lessons: memory.filter((item) => item.kind === 'lesson' || item.kind === 'playbook').length,
    failures: memory.filter((item) => item.kind === 'failure').length,
  };
  return { mission, agents, tasks, leases, memory, logs, counts };
}

export function parseTask(row) {
  if (!row) return null;
  return {
    ...row,
    paths: JSON.parse(row.paths_json),
    deps: JSON.parse(row.deps_json),
    spec: JSON.parse(row.spec_json),
  };
}
