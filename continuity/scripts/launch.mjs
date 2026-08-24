#!/usr/bin/env node

import { acquireEngineLock } from './lib/swarm/lock.mjs';
import { launchSwarm } from './lib/swarm/engine.mjs';
import { startControlSurface } from './control-surface.mjs';

const autoStart = !process.argv.includes('--paused');
const once = process.argv.includes('--once');
const sizeFlag = process.argv.indexOf('--swarm-size');
const swarmSize = sizeFlag === -1 ? 8 : Number(process.argv[sizeFlag + 1]);
const portFlag = process.argv.indexOf('--port');
const port = portFlag === -1 ? 43147 : Number(process.argv[portFlag + 1]);
const root = process.cwd();

let lock;
try {
  lock = acquireEngineLock(root);
} catch (error) {
  const message = error instanceof Error ? error.message : 'engine-already-live';
  console.error(message.includes('engine-already-live') ? message : `engine-already-live: ${message}`);
  process.exit(1);
}

let swarm;
try {
  swarm = launchSwarm({
    root,
    autoStart,
    swarmSize,
    paceMs: 200,
  });

  const state = swarm.getSnapshot();
  console.log(`continuity swarm ${state.mission?.status ?? 'idle'}`);
  console.log(state.standingOrder);
  console.log(`agents=${state.agents.length} tasks=${state.counts.tasks} product=${state.mission?.product_name}`);

  const release = () => {
    try { swarm?.stop(); } catch { /* already stopped */ }
    lock.release();
  };

  if (once) {
    await swarm.waitUntilIdle({ timeoutMs: 60_000 });
    const done = swarm.getSnapshot();
    console.log(`succeeded=${done.counts.succeeded} failed=${done.counts.failed} files=${done.files.length}`);
    release();
  } else {
    const surface = await startControlSurface(swarm, { port });
    console.log(`control surface ${surface.url}`);
    const shutdown = () => {
      try { surface.server.close(); } catch { /* already closed */ }
      release();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
} catch (error) {
  try { swarm?.stop(); } catch { /* already stopped */ }
  lock.release();
  const message = error instanceof Error ? error.message : 'launch failed';
  console.error(message);
  process.exit(1);
}
