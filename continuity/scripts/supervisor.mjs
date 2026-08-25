#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createCliClient } from './lib/protocol/client.mjs';
import {
  STANDING_ORDER,
  buildDispatchPacket,
  leaseConflict,
  selectDispatchWaveReport,
} from './lib/swarm/contract.mjs';
import { snapshot as readStoreSnapshot } from './lib/swarm/store.mjs';

const root = process.cwd();
const once = process.argv.includes('--once');
const heartbeatMs = 15_000;

writeHostPacket(root);
if (!once) {
  const timer = setInterval(() => writeHostPacket(root), heartbeatMs);
  timer.unref?.();
  process.once('SIGINT', () => process.exit(0));
  process.once('SIGTERM', () => process.exit(0));
}

function writeHostPacket(cwd) {
  const client = createCliClient();
  let inspect = null;
  try {
    inspect = client.inspectReady({ root: cwd })?.document ?? null;
  } catch {
    inspect = null;
  }
  const sqlite = readSqliteReadonly(cwd);
  const held = (sqlite.leases ?? []).map((lease) => ({
    taskId: lease.task_id,
    paths: [lease.path],
  }));
  const ready = (sqlite.tasks ?? []).filter((task) => task.status === 'ready');
  const spawnable = ready.filter((task) => !leaseConflict(held, task.paths));
  const report = selectDispatchWaveReport(spawnable, held);
  const missing = inspect?.plan?.missing ?? [];
  const waitingAccept = sqlite.mission?.status === 'waiting_accept';
  const allowed = missing.length
    ? []
    : waitingAccept
      ? report.wave.filter((task) => task.kind === 'test' || task.kind === 'security' || task.kind === 'review')
      : report.wave;
  const wave = allowed.map(buildDispatchPacket);
  const localWorker = wave.filter((item) => Array.isArray(item.focusedChecks) && item.focusedChecks.length);
  const hostOnly = wave.filter((item) => !localWorker.some((row) => row.id === item.id));
  const packet = {
    standingOrder: STANDING_ORDER,
    writtenAt: new Date().toISOString(),
    hostAbsent: true,
    accept: false,
    planMissing: missing,
    inspectGoalId: inspect?.goal?.goalId ?? null,
    userAcceptance: inspect?.goal?.acceptance ?? inspect?.userAcceptance ?? 'pending',
    leases: sqlite.leases ?? [],
    wave,
    rejected: report.rejected,
    stopReason: wave.length ? null : (waitingAccept ? 'waiting_accept' : (missing.length ? 'plan.missing' : 'no-ready-work')),
    localWorkerIds: localWorker.map((item) => item.id),
    hostTaskIds: hostOnly.map((item) => item.id),
    evidenceIds: (inspect?.evidence ?? []).map((item) => item.evidenceId).filter(Boolean),
    nextStep: waitingAccept
      ? 'Wait for record accept --as user; do not invent function tasks'
      : (wave[0]?.brief || 'No ready host packet'),
  };
  const directory = path.join(cwd, 'data');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'host-packet.json'), `${JSON.stringify(packet, null, 2)}\n`);
  writeFileSync(path.join(directory, 'supervisor.heartbeat'), `${packet.writtenAt}\n`);
  process.stdout.write(`${JSON.stringify({
    hostPacket: 'data/host-packet.json',
    wave: packet.wave.length,
    stopReason: packet.stopReason,
    hostAbsent: true,
    accept: false,
  })}\n`);
}

function readSqliteReadonly(cwd) {
  const file = path.join(cwd, 'data', 'swarm.sqlite');
  if (!existsSync(file)) return { mission: null, tasks: [], leases: [] };
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return readStoreSnapshot(db);
  } catch {
    return { mission: null, tasks: [], leases: [] };
  } finally {
    db?.close();
  }
}
