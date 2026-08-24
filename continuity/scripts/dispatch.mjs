#!/usr/bin/env node

import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  STANDING_ORDER,
  buildDispatchPacket,
  leaseConflict,
  selectDispatchWave,
} from './lib/swarm/contract.mjs';
import { snapshot as readStoreSnapshot } from './lib/swarm/store.mjs';

const portFlag = process.argv.indexOf('--port');
const port = portFlag === -1 ? 43147 : Number(process.argv[portFlag + 1]);
const root = process.cwd();

const snapshot = await readSnapshot(root, port);
const wave = Array.isArray(snapshot.wave) ? snapshot.wave : [];
const manager = (snapshot.agents ?? []).some((agent) => agent.role === 'manager');
const stopReason = wave.length === 0
  ? (snapshot.mission?.status === 'waiting_accept' ? 'waiting_accept' : 'no-ready-work')
  : undefined;

const report = {
  standingOrder: snapshot.standingOrder ?? STANDING_ORDER,
  status: snapshot.mission?.status ?? 'idle',
  accepted: snapshot.mission?.accepted ?? 'pending',
  swarmSize: snapshot.mission?.swarm_size ?? snapshot.agents?.length ?? 0,
  manager,
  fallback: false,
  wave,
  ...(stopReason ? { stopReason } : {}),
  instruction: [
    'You are the Conductor.',
    manager ? 'Appoint a Manager sub-agent that only watches the task database.' : null,
    'Spawn one isolated Task sub-agent per wave packet in this same turn.',
    'Blind packets must receive the brief verbatim and no chat history.',
    'When those sub-agents return, run dispatch.mjs again and spawn the next wave.',
    'Stop when wave is empty. Do not accept for the user.',
  ].filter(Boolean).join(' '),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function emptySnapshot() {
  return {
    standingOrder: STANDING_ORDER,
    mission: null,
    agents: [],
    wave: [],
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
    return {
      ...state,
      standingOrder: STANDING_ORDER,
      wave: selectDispatchWave(spawnable).map(buildDispatchPacket),
    };
  } catch {
    return emptySnapshot();
  } finally {
    db?.close();
  }
}
