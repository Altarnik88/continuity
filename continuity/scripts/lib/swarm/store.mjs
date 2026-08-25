import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { nowIso } from './contract.mjs';

const MEMORY_TITLE_MAX = 200;
const MEMORY_BODY_MAX = 800;
const TAP_LINE = /^(?:ok|not ok)\b|^TAP version\b|^\s*#(?:\s+TAP\b|\s+(?:tests|pass|fail|skip|todo)\b)/i;
const ABS_UNIX = /(?:^|[^\w./-])(\/(?:tmp|home|Users|var|etc|private|root|opt|usr|mnt|Volumes|workspace)\/[^\s"'`)]+)/g;
const ABS_WIN = /(?:^|[^\w./-])([A-Za-z]:\\[^\s"'`)]+)/g;
const ABS_GENERIC = /(^|[\s"'`=(])(\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)/g;
const ENV_ASSIGN_BLOCK = /(?:(?:^|\n)[A-Z_][A-Z0-9_]{1,}=[^\n]*){3,}/;

function boundText(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return text.slice(0, max);
}

function redactAbsPaths(line) {
  return line
    .replace(ABS_UNIX, (match, abs) => match.replace(abs, '<path>'))
    .replace(ABS_WIN, (match, abs) => match.replace(abs, '<path>'))
    .replace(ABS_GENERIC, '$1<path>');
}

function sanitizeMemoryText(raw) {
  let text = String(raw ?? '');
  const envDump = ENV_ASSIGN_BLOCK.test(text) || (/\bprocess\.env\b/.test(text) && /(?:PATH|HOME|USER)=/.test(text));
  if (envDump) return boundText('Output withheld.', MEMORY_BODY_MAX);
  const kept = [];
  let withheld = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (TAP_LINE.test(trimmed) || /# TAP\b/i.test(trimmed) || /\bnot ok\b/i.test(trimmed)) {
      withheld = true;
      continue;
    }
    const redacted = redactAbsPaths(trimmed);
    if (redacted !== trimmed) withheld = true;
    if (redacted) kept.push(redacted);
  }
  const summary = kept.join(' ').trim();
  const body = withheld
    ? (summary ? `${summary} Output withheld.` : 'Output withheld.')
    : (summary || 'Output withheld.');
  return boundText(body, MEMORY_BODY_MAX);
}

export function sanitizeMemoryRecord(record = {}) {
  const rawBody = record.body == null ? '' : String(record.body);
  const clean = {
    kind: record.kind == null ? '' : String(record.kind),
    title: boundText(record.title ?? '', MEMORY_TITLE_MAX),
    body: sanitizeMemoryText(rawBody),
    sha256: createHash('sha256').update(rawBody).digest('hex'),
    length: rawBody.length,
  };
  if (record.id != null) clean.id = record.id;
  if (record.taskId != null) clean.taskId = record.taskId;
  if (record.at != null) clean.at = record.at;
  return clean;
}

export function swarmDataDirectory(root) {
  return path.join(root, 'data');
}

export function openStore(root) {
  const directory = swarmDataDirectory(root);
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
      created_at TEXT NOT NULL,
      sha256 TEXT,
      length INTEGER
    );
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      agent_id TEXT,
      level TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);
  const memoryCols = new Set(all(db, 'PRAGMA table_info(memory)').map((row) => row.name));
  if (!memoryCols.has('sha256')) db.exec('ALTER TABLE memory ADD COLUMN sha256 TEXT');
  if (!memoryCols.has('length')) db.exec('ALTER TABLE memory ADD COLUMN length INTEGER');
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

export function remember(db, entry, clock) {
  const clean = sanitizeMemoryRecord(entry);
  run(db, `
    INSERT INTO memory (id, kind, title, body, task_id, created_at, sha256, length)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [clean.id, clean.kind, clean.title, clean.body, clean.taskId ?? null, nowIso(clock), clean.sha256, clean.length]);
}

export function appendMemoryLog(root, record) {
  const clean = sanitizeMemoryRecord(record);
  const directory = swarmDataDirectory(root);
  mkdirSync(directory, { recursive: true });
  appendFileSync(path.join(directory, 'memory.ndjson'), `${JSON.stringify(clean)}\n`);
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
