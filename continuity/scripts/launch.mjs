#!/usr/bin/env node

import { launchSwarm } from './lib/swarm/engine.mjs';
import { startControlSurface } from './control-surface.mjs';

const autoStart = !process.argv.includes('--paused');
const once = process.argv.includes('--once');
const sizeFlag = process.argv.indexOf('--swarm-size');
const swarmSize = sizeFlag === -1 ? 8 : Number(process.argv[sizeFlag + 1]);
const portFlag = process.argv.indexOf('--port');
const port = portFlag === -1 ? 43147 : Number(process.argv[portFlag + 1]);

const swarm = launchSwarm({
  root: process.cwd(),
  autoStart,
  swarmSize,
  paceMs: 200,
});

const state = swarm.getSnapshot();
console.log(`continuity swarm ${state.mission?.status ?? 'idle'}`);
console.log(state.standingOrder);
console.log(`agents=${state.agents.length} tasks=${state.counts.tasks} product=${state.mission?.product_name}`);

if (once) {
  await swarm.waitUntilIdle({ timeoutMs: 60_000 });
  const done = swarm.getSnapshot();
  console.log(`succeeded=${done.counts.succeeded} failed=${done.counts.failed} files=${done.files.length}`);
  swarm.stop();
} else {
  const surface = await startControlSurface(swarm, { port });
  console.log(`control surface ${surface.url}`);
}
