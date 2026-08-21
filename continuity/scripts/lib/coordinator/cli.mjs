import path from 'node:path';

import {
  COORDINATION_CONTRACT_ID,
  COORDINATOR_RUNTIME_VERSION,
  ProtocolError,
} from '../protocol/index.mjs';
import { loadCoordinatorConfig } from './config.mjs';
import { createCoordinatorRuntime } from './engine.mjs';

const USAGE = 'usage: coordinator.mjs <doctor|plan|run|resume|status|cancel>';
const HELP = `${USAGE}

Foreground Coordinator runtime. It never starts a daemon, watcher, or login task.
Writes go only through the Continuity/Core CLI. User acceptance stays pending.

Store: <repo>/.continuity/coordinator/runs
Contract: ${COORDINATION_CONTRACT_ID}
`;

function fail(message, exitCode = 2) {
  throw new ProtocolError(message, exitCode);
}

function parse(argv) {
  const options = {
    positionals: [],
    root: process.cwd(),
    rootExplicit: false,
    config: null,
    run: null,
    adapter: null,
    slots: null,
    json: false,
  };
  const args = [...argv];
  const take = (message) => {
    if (!args.length) fail(message);
    return args.shift();
  };
  while (args.length) {
    const value = args.shift();
    if (value === '--root') {
      options.root = path.resolve(take('--root requires a path'));
      options.rootExplicit = true;
    } else if (value === '--config') options.config = path.resolve(take('--config requires a path'));
    else if (value === '--run') options.run = take('--run requires an ID');
    else if (value === '--adapter') options.adapter = take('--adapter requires a name');
    else if (value === '--slots') {
      options.slots = Number(take('--slots requires a value'));
      if (!Number.isSafeInteger(options.slots) || options.slots < 1 || options.slots > 8) {
        fail('--slots must be 1..8');
      }
    } else if (value === '--json') options.json = true;
    else if (value === '--help' || value === '-h') options.help = true;
    else if (value === '--version') options.version = true;
    else if (value.startsWith('-')) fail('unknown argument');
    else options.positionals.push(value);
  }
  return options;
}

function writeLine(io, channel, value) {
  const text = value.endsWith('\n') ? value : `${value}\n`;
  io[channel].write(text);
}

function render(options, payload) {
  if (options.json) return `${JSON.stringify(payload, null, 2)}\n`;
  if (payload.help) return HELP;
  if (payload.version) return `continuity-coordinator ${COORDINATOR_RUNTIME_VERSION}\n`;
  if (payload.doctor) {
    const doctor = payload.doctor;
    return [
      `contract=${doctor.contractId}`,
      `daemon=${doctor.daemon}`,
      `adapter=${doctor.adapter.name}`,
      `adapter-class=${doctor.adapter.class}`,
      `live-proof=${doctor.liveProof}`,
      `execution=${doctor.execution || 'sequential'}`,
      `health=${doctor.adapter.health?.ok ? 'ok' : 'failed'}`,
      `memory=${doctor.memory}`,
    ].join('\n');
  }
  if (payload.state) {
    const lines = [
      `run=${payload.state.runId}`,
      `status=${payload.state.status}`,
      `adapter=${payload.state.adapter}`,
      `user-acceptance=${payload.state.userAcceptance}`,
      `stop=${payload.state.stopReason || 'none'}`,
      `completed-packets=${payload.state.completedPacketIds.length}`,
    ];
    if (payload.execution) lines.push(`execution=${payload.execution}`);
    if (payload.rollover) lines.push(`rollover=${payload.rollover}`);
    return lines.join('\n');
  }
  return `${JSON.stringify(payload)}\n`;
}

export async function main(argv = process.argv.slice(2), io = {
  stdout: process.stdout,
  stderr: process.stderr,
}) {
  try {
    const options = parse(argv);
    if (options.version) {
      writeLine(io, 'stdout', render(options, { version: true }));
      return 0;
    }
    if (options.help || options.positionals.length === 0) {
      writeLine(io, 'stdout', HELP);
      return options.help || argv.length === 0 ? 0 : 2;
    }
    const command = options.positionals[0];
    if (options.positionals.length !== 1) fail('exactly one coordinator command is allowed');
    const config = loadCoordinatorConfig(options.config);
    if (options.adapter) config.adapter = options.adapter;
    if (options.slots) config.slots = options.slots;
    const runtime = createCoordinatorRuntime({
      root: options.root,
      config,
    });
    let payload;
    if (command === 'doctor') payload = { doctor: runtime.doctor() };
    else if (command === 'plan') payload = runtime.plan({ runId: options.run });
    else if (command === 'run') payload = runtime.run({ runId: options.run });
    else if (command === 'resume') payload = runtime.resume({ runId: options.run });
    else if (command === 'status') payload = runtime.status({ runId: options.run });
    else if (command === 'cancel') payload = runtime.cancel({ runId: options.run });
    else fail('unknown coordinator command');
    writeLine(io, 'stdout', render(options, payload));
    return 0;
  } catch (error) {
    const message = error instanceof ProtocolError ? error.message : 'coordinator failed';
    writeLine(io, 'stderr', `coordinator: ${message}`);
    return error instanceof ProtocolError ? error.exitCode : 2;
  }
}
