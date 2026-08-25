#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  STANDING_ORDER,
  buildDispatchPacket,
  leaseConflict,
  selectDispatchWaveReport,
} from './lib/swarm/contract.mjs';
import { snapshot as readStoreSnapshot } from './lib/swarm/store.mjs';

const portFlag = process.argv.indexOf('--port');
const port = portFlag === -1 ? 43147 : Number(process.argv[portFlag + 1]);
const root = process.cwd();

const snapshot = await readSnapshot(root, port);
const rawWave = Array.isArray(snapshot.wave) ? snapshot.wave : [];
const rejected = Array.isArray(snapshot.rejected) ? snapshot.rejected : [];
const manager = (snapshot.agents ?? []).some((agent) => agent.role === 'manager');
const waitingAccept = snapshot.mission?.status === 'waiting_accept';
const wave = waitingAccept
  ? rawWave.filter((item) => item.kind === 'test' || item.kind === 'security' || item.kind === 'review')
  : rawWave;
const stopReason = wave.length === 0
  ? (waitingAccept ? 'waiting_accept' : 'no-ready-work')
  : undefined;
const waveId = `wave-${randomUUID().slice(0, 8)}`;

const report = {
  standingOrder: snapshot.standingOrder ?? STANDING_ORDER,
  status: snapshot.mission?.status ?? 'idle',
  accepted: snapshot.mission?.accepted ?? 'pending',
  swarmSize: snapshot.mission?.swarm_size ?? snapshot.agents?.length ?? 0,
  manager,
  fallback: false,
  waveId,
  wave,
  rejected,
  ...(stopReason ? { stopReason } : {}),
  instruction: [
    'You are the Conductor.',
    manager ? 'Appoint a Manager sub-agent that only watches the task database.' : null,
    'Have the host LLM dispatch one isolated Task sub-agent per wave packet in this same turn. Node does not spawn host Task.',
    'Blind packets must receive the brief verbatim and no chat history.',
    'When those sub-agents return, run dispatch.mjs again and dispatch the next wave.',
    'Stop when wave is empty. Do not accept for the user.',
  ].filter(Boolean).join(' '),
};

persistWaveJournal(root, report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function emptySnapshot() {
  return {
    standingOrder: STANDING_ORDER,
    mission: null,
    agents: [],
    wave: [],
    rejected: [],
  };
}

async function readSnapshot(cwd, listenPort) {
  try {
    const response = await fetch(`http://127.0.0.1:${listenPort}/api/swarm`);
    if (response.ok) {
      const body = await response.json();
      if (body && typeof body === 'object') return body;
    }
  } catch {
    // No live control surface; use a read-only store snapshot if one exists.
  }
  return readSqliteSnapshot(cwd);
}

function readSqliteSnapshot(cwd) {
  const file = path.join(cwd, 'data', 'swarm.sqlite');
  if (!existsSync(file)) return emptySnapshot();
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const state = readStoreSnapshot(db);
    if (!state.mission) return emptySnapshot();
    const held = (state.leases ?? []).map((lease) => ({
      taskId: lease.task_id,
      paths: [lease.path],
    }));
    const ready = (state.tasks ?? []).filter((task) => task.status === 'ready');
    const spawnable = ready.filter((task) => !leaseConflict(held, task.paths));
    const report = selectDispatchWaveReport(spawnable, held);
    return {
      ...state,
      standingOrder: STANDING_ORDER,
      wave: report.wave.map(buildDispatchPacket),
      rejected: report.rejected,
    };
  } catch {
    return emptySnapshot();
  } finally {
    db?.close();
  }
}

function persistWaveJournal(cwd, document) {
  try {
    const directory = path.join(cwd, 'data');
    mkdirSync(directory, { recursive: true });
    appendFileSync(path.join(directory, 'waves.ndjson'), `${JSON.stringify({
      waveId: document.waveId,
      taken: (document.wave ?? []).map((item) => item.id),
      rejected: document.rejected ?? [],
      stopReason: document.stopReason ?? null,
      status: document.status,
    })}\n`);
  } catch {
    // Wave journal is best-effort; stdout remains the live report.
  }
}
