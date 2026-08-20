import { spawnSync } from 'node:child_process';
import { readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { MemoryError, createDraftTemplate, validateDraftShape } from './domain-v2.mjs';
import { appendV2, initializeV2, validateV2Append } from './journal-v2.mjs';
import { renderLegacyInspectV1 } from './legacy-v1.mjs';
import { assertMutationAllowed, detectStoreVersion, readV2Journal } from './store.mjs';
import { handleMigrationCommand } from '../migration/index.mjs';
import { handleGraphifyCommand } from '../graphify/index.mjs';
import { handleInspectCommand } from '../continuity/index.mjs';
import { handleV3Command } from './cli-v3.mjs';

const VERSION = '2.0.0';
const USAGE = 'usage: continuity.mjs <init|record|inspect|history|handoff|validate|doctor|rebuild|migrate|graphify>';
const HELP = `${USAGE}\n\nStore: .continuity (default)\nOverride: CONTINUITY_STORE_DIR=<repository-relative-directory>\nLegacy .codex/project-memory data is never read automatically.`;
export const MAX_INPUT_BYTES = 64 * 1024;
const MAIN_IO_KEYS = new Set([
  'stdin', 'stdout', 'stderr', 'clock', 'git',
  'migrationCommandHandler', 'continuityCommandHandler', 'graphifyCommandHandler',
]);
const MAIN_FUNCTION_VALUE_KEYS = new Set(['clock', 'git']);

export function readStdinBounded(fd = 0) {
  const chunks = [];
  const buffer = Buffer.alloc(8 * 1024);
  let total = 0;
  while (true) {
    const count = readSync(fd, buffer, 0, buffer.length, null);
    if (count === 0) break;
    total += count;
    if (total > MAX_INPUT_BYTES) throw new MemoryError('event draft exceeds the size limit');
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function inspectMainIo(io) {
  if (io === null || typeof io !== 'object' || Array.isArray(io)) {
    return { inspectable: false, error: new MemoryError('main options are invalid', 3) };
  }
  let prototype;
  let keys;
  try {
    prototype = Reflect.getPrototypeOf(io);
    keys = Reflect.ownKeys(io);
  } catch {
    return { inspectable: false, error: new MemoryError('main options are invalid', 3) };
  }
  const invalidKeys = (prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== 'string' || !MAIN_IO_KEYS.has(key));
  const descriptors = new Map();
  let invalidValues = false;
  try {
    for (const key of keys) {
      if (typeof key !== 'string' || !MAIN_IO_KEYS.has(key)) continue;
      const descriptor = Reflect.getOwnPropertyDescriptor(io, key);
      if (!descriptor) return { inspectable: false, error: new MemoryError('main options are invalid', 3) };
      descriptors.set(key, descriptor);
      if (MAIN_FUNCTION_VALUE_KEYS.has(key) && Object.hasOwn(descriptor, 'value')
        && descriptor.value !== undefined && typeof descriptor.value !== 'function') {
        invalidValues = true;
      }
    }
  } catch {
    return { inspectable: false, error: new MemoryError('main options are invalid', 3) };
  }
  return {
    inspectable: true,
    descriptors,
    error: invalidKeys || invalidValues ? new MemoryError('main options are invalid', 3) : null,
  };
}

function createIoResolver(io, descriptors = new Map()) {
  const resolved = new Map();
  return (property, fallback) => {
    if (!resolved.has(property)) {
      const descriptor = descriptors.get(property);
      const value = descriptor && Object.hasOwn(descriptor, 'value')
        ? descriptor.value
        : descriptor?.get?.call(io);
      if (MAIN_FUNCTION_VALUE_KEYS.has(property)
        && value !== undefined && typeof value !== 'function') {
        throw new MemoryError('main options are invalid', 3);
      }
      resolved.set(property, value ?? fallback());
    }
    return resolved.get(property);
  };
}

function write(resolveIo, channel, value) {
  const stream = resolveIo(channel, () => process[channel]);
  stream.write(value.endsWith('\n') ? value : `${value}\n`);
}
function readJsonFile(file, label) { if (!file) throw new MemoryError(`${label} requires --file`); if (statSync(file).size > MAX_INPUT_BYTES) throw new MemoryError(`${label} exceeds the size limit`); try { return JSON.parse(readFileSync(file, 'utf8')); } catch { throw new MemoryError(`${label} is not valid JSON`); } }
function parseJsonInput(raw, label) { if (Buffer.byteLength(raw ?? '', 'utf8') > MAX_INPUT_BYTES) throw new MemoryError(`${label} exceeds the size limit`); try { return JSON.parse(raw); } catch { throw new MemoryError(`${label} is not valid JSON`); } }
function requireCliToken(value) {
  if (typeof value !== 'string' || !value.trim() || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new MemoryError('command values must be nonempty text');
  }
  return value;
}

function parse(argv) {
  const delimiterCount = argv.filter((value) => value === '--').length;
  if (delimiterCount > 1) throw new MemoryError('query delimiter may be specified only once');
  const delimiterIndex = argv.indexOf('--');
  const coreArgs = delimiterIndex === -1 ? argv : argv.slice(0, delimiterIndex);
  const passthrough = delimiterIndex === -1 ? [] : argv.slice(delimiterIndex + 1).map(requireCliToken);
  const options = {
    positionals: [], root: process.cwd(), rootExplicit: false, file: null, stdin: false,
    dryRun: false, json: false, tail: 10, subject: null, handoff: null, schema: null, to: null,
    migrationAction: 'start', graph: null, timeoutMs: 10000,
    title: null, task: null, attempt: null, as: null, actorId: null, runId: null, why: null, result: null, approach: null,
    expected: null, actual: null, impact: null, criterion: null, goal: null, execution: null,
    next: null, blocked: false, kind: null, exitCode: null, assignee: null,
    priority: null, size: null, complexity: null, risk: null, class: null, packet: null, assignment: null,
    slots: null, found: null, executed: null, passed: null, failed: null, skipped: null,
    resourceLimit: null,
    delimiter: delimiterIndex !== -1, passthrough,
    seen: new Set(),
  };
  const mark = (flag) => { if (options.seen.has(flag)) throw new MemoryError(`${flag} may be specified only once`); options.seen.add(flag); };
  const args = [...coreArgs];
  const takeValue = (message) => {
    if (!args.length) throw new MemoryError(message);
    return requireCliToken(args.shift());
  };
  while (args.length) {
    const value = args.shift();
    if (value === '--root') { mark(value); options.root = path.resolve(takeValue('--root requires a path')); options.rootExplicit = true; }
    else if (value === '--file') { mark(value); if (options.stdin) throw new MemoryError('exactly one input source is allowed'); options.file = path.resolve(takeValue('exactly one input source is allowed')); }
    else if (value === '--stdin') { mark(value); if (options.file) throw new MemoryError('exactly one input source is allowed'); options.stdin = true; }
    else if (value === '--dry-run') { mark(value); options.dryRun = true; }
    else if (value === '--json') { mark(value); options.json = true; }
    else if (value === '--tail') { mark(value); options.tail = Number(takeValue('--tail requires a value')); if (!Number.isInteger(options.tail) || options.tail < 1 || options.tail > 100) throw new MemoryError('--tail must be 1..100'); }
    else if (value === '--subject') { mark(value); options.subject = takeValue('--subject requires an ID'); }
    else if (value === '--handoff') { mark(value); options.handoff = takeValue('--handoff requires an ID'); }
    else if (value === '--schema') { mark(value); options.schema = Number(takeValue('--schema requires a value')); }
    else if (value === '--to') { mark(value); options.to = Number(takeValue('--to requires a value')); }
    else if (value === '--resume') { mark(value); options.migrationAction = 'resume'; }
    else if (value === '--rollback') { mark(value); options.migrationAction = 'rollback'; }
    else if (value === '--graph') {
      mark(value);
      options.graph = takeValue('--graph requires a path');
    }
    else if (value === '--timeout-ms') {
      mark(value);
      options.timeoutMs = Number(takeValue('--timeout-ms requires a value'));
      if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 30000) throw new MemoryError('--timeout-ms must be 1000..30000');
    }
    else if (value === '--title') { mark(value); options.title = takeValue('--title requires a value'); }
    else if (value === '--task') { mark(value); options.task = takeValue('--task requires an ID'); }
    else if (value === '--attempt') { mark(value); options.attempt = takeValue('--attempt requires an ID'); }
    else if (value === '--as') { mark(value); options.as = takeValue('--as requires an actor kind'); }
    else if (value === '--actor-id') { mark(value); options.actorId = takeValue('--actor-id requires an ID'); }
    else if (value === '--run-id') { mark(value); options.runId = takeValue('--run-id requires an ID'); }
    else if (value === '--assignee') { mark(value); options.assignee = takeValue('--assignee requires an ID'); }
    else if (value === '--kind') { mark(value); options.kind = takeValue('--kind requires a value'); }
    else if (value === '--exit-code') {
      mark(value);
      options.exitCode = Number(takeValue('--exit-code requires a value'));
      if (!Number.isInteger(options.exitCode)) throw new MemoryError('--exit-code must be an integer');
    }
    else if (value === '--why') { mark(value); options.why = takeValue('--why requires a value'); }
    else if (value === '--result') { mark(value); options.result = takeValue('--result requires an ID'); }
    else if (value === '--approach') { mark(value); options.approach = takeValue('--approach requires a value'); }
    else if (value === '--expected') { mark(value); options.expected = takeValue('--expected requires a value'); }
    else if (value === '--actual') { mark(value); options.actual = takeValue('--actual requires a value'); }
    else if (value === '--impact') { mark(value); options.impact = takeValue('--impact requires a value'); }
    else if (value === '--criterion') { mark(value); options.criterion = takeValue('--criterion requires an ID'); }
    else if (value === '--goal') { mark(value); options.goal = takeValue('--goal requires an ID'); }
    else if (value === '--execution') { mark(value); options.execution = takeValue('--execution requires a value'); }
    else if (value === '--next') { mark(value); options.next = takeValue('--next requires a value'); }
    else if (value === '--blocked') { mark(value); options.blocked = true; }
    else if (value === '--priority') { mark(value); options.priority = takeValue('--priority requires a value'); }
    else if (value === '--size') { mark(value); options.size = takeValue('--size requires a value'); }
    else if (value === '--complexity') { mark(value); options.complexity = takeValue('--complexity requires a value'); }
    else if (value === '--risk') { mark(value); options.risk = takeValue('--risk requires a value'); }
    else if (value === '--class') { mark(value); options.class = takeValue('--class requires a value'); }
    else if (value === '--packet') { mark(value); options.packet = takeValue('--packet requires an ID'); }
    else if (value === '--assignment') { mark(value); options.assignment = takeValue('--assignment requires an ID'); }
    else if (value === '--slots') {
      mark(value);
      options.slots = Number(takeValue('--slots requires a value'));
      if (!Number.isInteger(options.slots) || options.slots < 0 || options.slots > 32) throw new MemoryError('--slots must be 0..32');
    }
    else if (value === '--found') { mark(value); options.found = Number(takeValue('--found requires a value')); }
    else if (value === '--executed') { mark(value); options.executed = Number(takeValue('--executed requires a value')); }
    else if (value === '--passed') { mark(value); options.passed = Number(takeValue('--passed requires a value')); }
    else if (value === '--failed') { mark(value); options.failed = Number(takeValue('--failed requires a value')); }
    else if (value === '--skipped') { mark(value); options.skipped = Number(takeValue('--skipped requires a value')); }
    else if (value.startsWith('-') && value !== '--version' && value !== '--help') throw new MemoryError('unknown argument');
    else options.positionals.push(requireCliToken(value));
  }
  if (options.subject !== null && options.handoff !== null) {
    throw new MemoryError('inspect subject and handoff selections are mutually exclusive');
  }
  return options;
}

function assertAllowedFlags(options, allowed) {
  for (const flag of options.seen) if (!allowed.includes(flag)) throw new MemoryError(`${flag} is not valid for this command`);
}

function resolveRoot(candidate, explicit) {
  let candidateReal;
  try { candidateReal = realpathSync.native(candidate); } catch { throw new MemoryError('repository root is unavailable', 3); }
  const result = spawnSync('git', ['-C', candidateReal, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 });
  if (result.status !== 0 || result.error || !result.stdout.trim()) throw new MemoryError('current location is not inside a Git worktree', 3);
  const root = realpathSync.native(result.stdout.trim());
  if (explicit && path.normalize(root) !== path.normalize(candidateReal)) throw new MemoryError('--root must name the Git worktree top-level', 3);
  return root;
}

function commandContext(resolveIo, root, options, operation) {
  const context = { root, options };
  const dependencies = {
    stdin: () => undefined,
    stdout: () => process.stdout,
    stderr: () => process.stderr,
    clock: () => () => new Date(),
    git: () => undefined,
  };
  for (const [property, fallback] of Object.entries(dependencies)) {
    let resolved = false; let value;
    Object.defineProperty(context, property, {
      enumerable: true,
      configurable: false,
      get() {
        if (!resolved) {
          value = resolveIo(property, fallback);
          resolved = true;
        }
        return value;
      },
    });
  }
  if (operation !== undefined) context.operation = operation;
  return context;
}

function commandHandler(resolveIo, property, fallback) {
  return resolveIo(property, () => fallback);
}

async function dispatchCommandHandler(resolveIo, property, fallback, context, args) {
  const handler = commandHandler(resolveIo, property, fallback);
  const buffered = [];
  const handlerContext = {};
  const descriptors = Object.getOwnPropertyDescriptors(context);
  for (const channel of ['stdout', 'stderr']) {
    const stream = { write: (...writeArgs) => { buffered.push({ channel, writeArgs }); return true; } };
    descriptors[channel] = { enumerable: true, configurable: false, get: () => stream };
  }
  Object.defineProperties(handlerContext, descriptors);
  let result;
  try { result = await handler(handlerContext, args); } catch { throw new Error('downstream command handler failed'); }
  if (!Number.isInteger(result) || result < 0 || result > 255) throw new Error('downstream command handler returned an invalid exit code');
  for (const entry of buffered) context[entry.channel].write(...entry.writeArgs);
  return result;
}

function scanInvocation(argv) {
  const valueFlags = new Set([
    '--root', '--file', '--tail', '--subject', '--handoff', '--schema', '--to', '--graph', '--timeout-ms',
    '--title', '--task', '--attempt', '--as', '--actor-id', '--run-id', '--assignee', '--why', '--result', '--approach', '--expected', '--actual',
    '--impact', '--criterion', '--goal', '--execution', '--next', '--kind', '--exit-code',
    '--priority', '--size', '--complexity', '--risk', '--class', '--packet', '--assignment', '--slots',
    '--found', '--executed', '--passed', '--failed', '--skipped',
  ]);
  const flags = new Set();
  let command; let rootValue; let delimiter = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') { delimiter = true; break; }
    if (valueFlags.has(value)) {
      flags.add(value);
      if (value === '--root') rootValue = argv[index + 1];
      index += 1;
      continue;
    }
    if (value.startsWith('-')) { flags.add(value); continue; }
    if (!command) command = value;
  }
  return { command, delimiter, flags, rootValue };
}

export function isV2Invocation(argv) {
  if (argv.length === 0) return true;
  const routing = scanInvocation(argv);
  const { command } = routing;
  if (routing.flags.has('--version') || routing.flags.has('--help')) return true;
  if (routing.flags.has('--resume') || routing.flags.has('--rollback')) return true;
  if (routing.flags.has('--graph') || routing.flags.has('--timeout-ms') || routing.delimiter) return true;
  if (['event', 'record', 'migrate', 'graphify', 'handoff', 'rebuild'].includes(command)) return true;
  if (command === 'init' && routing.flags.has('--schema')) return true;
  if (command === 'inspect' && ['--json', '--subject', '--handoff'].some((flag) => routing.flags.has(flag))) return true;
  if (command === 'history' && ['--json', '--subject', '--handoff'].some((flag) => routing.flags.has(flag))) return true;
  if (!['init', 'inspect', 'validate', 'history', 'doctor', 'checkpoint'].includes(command)) return false;
  try {
    const explicit = routing.flags.has('--root');
    const candidate = explicit ? path.resolve(routing.rootValue) : process.cwd();
    const root = resolveRoot(candidate, explicit);
    const version = detectStoreVersion(root);
    return command === 'init' ? version === 'interrupted-migration' : [2, 3, 'interrupted-migration'].includes(version);
  } catch {
    return true;
  }
}

export async function main(argv, io = {}) {
  if (arguments.length > 2) return 3;
  const inspectedIo = inspectMainIo(io);
  if (!inspectedIo.inspectable) return 3;
  const resolveIo = createIoResolver(io, inspectedIo.descriptors);
  try {
    if (inspectedIo.error) throw inspectedIo.error;
    if (argv.length === 0) throw new MemoryError(USAGE);
    const options = parse(argv); const [command, subcommand, ...rest] = options.positionals;
    if (options.delimiter && (command !== 'graphify' || subcommand !== 'query')) throw new MemoryError('query delimiter is only valid for graphify query');
    if (command === '--version' && options.positionals.length === 1) { assertAllowedFlags(options, []); write(resolveIo, 'stdout', `continuity ${VERSION}`); return 0; }
    if (command === '--help' && options.positionals.length === 1) { assertAllowedFlags(options, []); write(resolveIo, 'stdout', HELP); return 0; }
    if (command === 'event' && subcommand === 'template' && rest.length === 1) { assertAllowedFlags(options, []); write(resolveIo, 'stdout', JSON.stringify(createDraftTemplate(rest[0]))); return 0; }
    if (command === 'event' && subcommand === 'lint' && rest.length === 0) { assertAllowedFlags(options, ['--file']); if (!options.file) throw new MemoryError('event lint requires --file'); validateDraftShape(readJsonFile(options.file, 'event draft')); write(resolveIo, 'stdout', 'event lint: ok'); return 0; }
    const root = resolveRoot(options.root, options.rootExplicit);
    const routedStoreVersion = ['init', 'inspect', 'validate', 'history', 'doctor', 'checkpoint', 'handoff', 'rebuild', 'record'].includes(command)
      ? detectStoreVersion(root)
      : null;
    if (options.schema === 3 || routedStoreVersion === 3) {
      const buffered = [];
      const writeBuffered = (channel, value) => { buffered.push({ channel, value }); };
      const exitCode = await handleV3Command({
        command,
        subcommand,
        options,
        root,
        write: writeBuffered,
        clock: resolveIo('clock', () => () => new Date()),
        readInput: (file, label, stdin = false) => (stdin
          ? resolveIo('stdin', () => readStdinBounded())
          : JSON.stringify(readJsonFile(file, label))),
      });
      if (exitCode === 0) {
        for (const entry of buffered) write(resolveIo, entry.channel, entry.value);
      }
      return exitCode;
    }
    if (command === 'init') {
      assertAllowedFlags(options, ['--root', '--schema', '--file']);
      assertMutationAllowed(root);
      if (subcommand || options.schema !== 2 || !options.file) throw new MemoryError('v2 init requires --schema 2 --file');
      const clock = resolveIo('clock', () => () => new Date());
      const receipt = initializeV2(root, readJsonFile(options.file, 'v2 init input'), { clock }); write(resolveIo, 'stdout', `continuity v2 initialized: sequence=${receipt.sequence} event=${receipt.eventHash.slice(0, 12)} projection=current`); return 0;
    }
    if (command === 'record') {
      assertAllowedFlags(options, ['--root', '--file', '--stdin', '--dry-run']);
      assertMutationAllowed(root);
      if (subcommand || Boolean(options.file) === Boolean(options.stdin)) throw new MemoryError('record requires exactly one of --file or --stdin');
      const draft = options.file
        ? readJsonFile(options.file, 'event draft')
        : parseJsonInput(resolveIo('stdin', () => readStdinBounded()), 'event draft');
      if (options.dryRun) { const validation = validateV2Append(root, draft); write(resolveIo, 'stdout', `record dry-run: ok prospective-sequence=${validation.prospectiveSequence}`); return 0; }
      const receipt = appendV2(root, draft); write(resolveIo, 'stdout', `event recorded: sequence=${receipt.sequence} event=${receipt.eventHash.slice(0, 12)} projection=current`); return 0;
    }
    if (command === 'validate' && !subcommand) {
      assertAllowedFlags(options, ['--root']);
      if (routedStoreVersion === 'interrupted-migration') {
        return await dispatchCommandHandler(resolveIo, 'migrationCommandHandler', handleMigrationCommand, commandContext(resolveIo, root, options, 'validate-marker'), []);
      }
      const store = readV2Journal(root);
      if (store.events.some((event) => event.eventType === 'migration.v1_imported')) {
        return await dispatchCommandHandler(resolveIo, 'migrationCommandHandler', handleMigrationCommand, commandContext(resolveIo, root, options, 'validate-v1-archive'), []);
      }
      write(resolveIo, 'stdout', `continuity v2 valid: ${store.events.length} event(s), projection=${store.projection}, journal-tail=${store.trailingBytes ? 'partial' : 'clean'}`); return 0;
    }
    if (command === 'doctor' && !subcommand) {
      assertAllowedFlags(options, ['--root']);
      if (routedStoreVersion === 'interrupted-migration') {
        return await dispatchCommandHandler(resolveIo, 'migrationCommandHandler', handleMigrationCommand, commandContext(resolveIo, root, options, 'doctor-marker'), []);
      }
      const store = readV2Journal(root); write(resolveIo, 'stdout', `repository=ok store=v2 journal=valid projection=${store.projection} journal-tail=${store.trailingBytes ? 'partial' : 'clean'}`); return 0;
    }
    if (command === 'history') {
      assertAllowedFlags(options, ['--root', '--tail', '--subject', '--json']);
      if (subcommand) throw new MemoryError('invalid history arguments');
      if (routedStoreVersion === 'interrupted-migration') throw new MemoryError('continuity migration is interrupted', 3);
      if (routedStoreVersion === 1) throw new MemoryError('v1 history does not support structured selection');
      if (options.subject) {
        return await dispatchCommandHandler(resolveIo, 'continuityCommandHandler', handleInspectCommand, commandContext(resolveIo, root, options, 'history'), []);
      }
      let events = readV2Journal(root).events;
      events = events.slice(-options.tail);
      if (options.json) write(resolveIo, 'stdout', JSON.stringify({ schemaVersion: 2, events })); else for (const event of events) write(resolveIo, 'stdout', `#${event.sequence} ${event.eventType} ${event.subject.type}:${event.subject.id} ${event.eventHash.slice(0, 12)}`);
      return 0;
    }
    if (command === 'checkpoint') {
      if (routedStoreVersion === 'interrupted-migration') assertMutationAllowed(root);
      assertAllowedFlags(options, ['--root']);
      assertMutationAllowed(root);
      throw new MemoryError('v2 is event-based; use `record`');
    }
    if (command === 'inspect') {
      assertAllowedFlags(options, ['--root', '--json', '--subject', '--handoff']);
      if (routedStoreVersion === 'interrupted-migration') throw new MemoryError('continuity migration is interrupted', 3);
      if (routedStoreVersion === 1) {
        if (subcommand || rest.length || !options.json || options.subject || options.handoff) throw new MemoryError('v1 structured inspect supports only --json');
        const clock = resolveIo('clock', () => () => new Date());
        const git = resolveIo('git', () => undefined);
        write(resolveIo, 'stdout', JSON.stringify(renderLegacyInspectV1(root, { clock, git })));
        return 0;
      }
      return await dispatchCommandHandler(resolveIo, 'continuityCommandHandler', handleInspectCommand, commandContext(resolveIo, root, options), [subcommand, ...rest].filter(Boolean));
    }
    if (command === 'migrate') {
      assertAllowedFlags(options, ['--root', '--to', '--dry-run', '--resume', '--rollback']);
      if (subcommand || rest.length || options.to !== 2) throw new MemoryError('migrate requires --to 2');
      const resume = options.seen.has('--resume'); const rollback = options.seen.has('--rollback');
      if ((resume && rollback) || (options.dryRun && (resume || rollback))) throw new MemoryError('migration actions are mutually exclusive');
      if (options.migrationAction === 'start') assertMutationAllowed(root);
      return await dispatchCommandHandler(resolveIo, 'migrationCommandHandler', handleMigrationCommand, commandContext(resolveIo, root, options, 'migrate'), []);
    }
    if (command === 'graphify') {
      if (subcommand === 'observe') {
        assertAllowedFlags(options, ['--root', '--graph', '--json']);
        if (rest.length || options.delimiter) throw new MemoryError('invalid graphify observe arguments');
      } else if (subcommand === 'query') {
        assertAllowedFlags(options, ['--root', '--graph', '--timeout-ms']);
        if (rest.length || !options.delimiter || !options.passthrough.length) throw new MemoryError('graphify query requires one non-empty -- command delimiter');
      } else {
        throw new MemoryError('invalid graphify command');
      }
      return await dispatchCommandHandler(resolveIo, 'graphifyCommandHandler', handleGraphifyCommand, commandContext(resolveIo, root, options), [subcommand]);
    }
    throw new MemoryError(USAGE);
  } catch (error) {
    const known = error instanceof MemoryError;
    try { write(resolveIo, 'stderr', `continuity: ERROR: ${known ? error.message : 'unexpected helper failure'}`); } catch { /* invalid output dependencies fail closed */ }
    return known ? error.exitCode : 3;
  }
}
