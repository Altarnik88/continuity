#!/usr/bin/env node

import { launchSwarm } from './lib/swarm/engine.mjs';

const portFlag = process.argv.indexOf('--port');
const port = portFlag === -1 ? 43147 : Number(process.argv[portFlag + 1]);
const root = process.cwd();

const snapshot = await readSnapshot(root, port);
const liveWave = snapshot.wave ?? [];
const files = snapshot.files ?? [];
const fallback = liveWave.length === 0 ? fallbackWave(files) : [];
const wave = liveWave.length ? liveWave : fallback;
const manager = (snapshot.agents ?? []).some((agent) => agent.role === 'manager');

const report = {
  standingOrder: snapshot.standingOrder,
  status: snapshot.mission?.status ?? 'idle',
  accepted: snapshot.mission?.accepted ?? 'pending',
  swarmSize: snapshot.mission?.swarm_size ?? snapshot.agents?.length ?? 0,
  manager,
  fallback: fallback.length > 0,
  wave,
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

function fallbackWave(paths) {
  const product = paths.filter((file) => file.startsWith('forge/'));
  if (!product.length) return [];
  const sources = product.filter((file) => file.endsWith('.mjs'));
  const tests = product.filter((file) => file.includes('/test/') || file.endsWith('.test.mjs'));
  return [
    {
      id: 'eval-security',
      title: 'Blind security audit of current product files',
      kind: 'security',
      paths: sources.filter((file) => file.includes('/http.mjs') || file.includes('/cli.mjs') || file.endsWith('SECURITY.md')),
      deps: [],
      blind: true,
      brief: 'Blind security audit. Read only the listed CLI/HTTP files. Do not read implementer notes, chat history, or other agents\' reasoning. Use tests, the listed files, and available skills, MCP, and plugins.',
    },
    {
      id: 'eval-review',
      title: 'Blind independent review of domain and persistence',
      kind: 'review',
      paths: sources.filter((file) => file.includes('/domain.mjs') || file.includes('/store.mjs') || file.includes('/service.mjs') || file.endsWith('REVIEW.md')),
      deps: [],
      blind: true,
      brief: 'Independent review. Read only the listed domain/store/service files. Do not read implementer notes, chat history, or other agents\' reasoning. Use tests, the listed files, and available skills, MCP, and plugins.',
    },
    {
      id: 'eval-verify',
      title: 'Blind verification of current product tests',
      kind: 'test',
      paths: tests.slice(0, 8),
      deps: [],
      blind: true,
      brief: 'Run the listed tests. Do not read implementer notes, chat history, or other agents\' reasoning. Use tests, the listed files, and available skills, MCP, and plugins.',
    },
  ].filter((packet) => packet.paths.length > 0);
}

async function readSnapshot(cwd, listenPort) {
  try {
    const response = await fetch(`http://127.0.0.1:${listenPort}/api/swarm`);
    if (response.ok) return await response.json();
  } catch {
    // Fall through to a local snapshot of the task database.
  }
  const swarm = launchSwarm({ root: cwd, autoStart: false });
  try {
    return swarm.getSnapshot();
  } finally {
    swarm.stop();
  }
}
