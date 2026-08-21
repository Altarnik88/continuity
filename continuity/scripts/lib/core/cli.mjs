import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { handleV3Command } from './cli-v3.mjs';
import { LEGACY_SCHEMA_UNSUPPORTED, MemoryError } from './errors.mjs';
import { detectStoreVersion, gitAdminTopology } from './store.mjs';

const VERSION = '2.0.0';
const USAGE = 'usage: continuity.mjs <init|record|inspect|history|handoff|validate|doctor|rebuild|migrate>';
const HELP = `${USAGE}

Store: .continuity (default)
Override: CONTINUITY_STORE_DIR=<repository-relative-directory>
This build supports schema v3 only; v1/v2 stores are frozen at git tag legacy-v1v2-final.
Legacy .codex/project-memory data is never read automatically.`;
export const MAX_INPUT_BYTES = 64 * 1024;
const MAIN_IO_KEYS = new Set(['stdin', 'stdout', 'stderr', 'clock', 'git']);
const MAIN_FUNCTION_VALUE_KEYS = new Set(['clock', 'git']);
const LEGACY_COMMANDS = new Set(['checkpoint', 'snapshot', 'lint', 'source', 'event', 'migrate', 'graphify']);

function rejectLegacy() {
  throw new MemoryError(LEGACY_SCHEMA_UNSUPPORTED, 2);
}

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
    migrationAction: 'start',
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

function doctorUninitialized(root, resolveIo) {
  const topology = gitAdminTopology(root);
  const worktree = topology.linkedWorktree ? 'linked' : 'primary';
  const mutation = topology.linkedWorktree ? 'refused' : 'allowed';
  const lock = existsSync(topology.lock) ? 'present-manual-review-required' : 'clear';
  write(resolveIo, 'stdout', `repository=ok worktree=${worktree} mutation=${mutation}`);
  write(resolveIo, 'stdout', 'journal=uninitialized projection=missing');
  write(resolveIo, 'stdout', `lock=${lock}`);
}

export async function main(argv, io = {}) {
  if (arguments.length > 2) return 3;
  const inspectedIo = inspectMainIo(io);
  if (!inspectedIo.inspectable) return 3;
  const resolveIo = createIoResolver(io, inspectedIo.descriptors);
  try {
    if (inspectedIo.error) throw inspectedIo.error;
    if (argv.length === 0) throw new MemoryError(USAGE);
    const options = parse(argv); const [command, subcommand] = options.positionals;
    if (options.delimiter) throw new MemoryError('command delimiter is not valid');
    if (command === '--version' && options.positionals.length === 1) { assertAllowedFlags(options, []); write(resolveIo, 'stdout', `continuity ${VERSION}`); return 0; }
    if (command === '--help' && options.positionals.length === 1) { assertAllowedFlags(options, []); write(resolveIo, 'stdout', HELP); return 0; }
    if (options.schema === 1 || options.schema === 2 || LEGACY_COMMANDS.has(command)) rejectLegacy();
    const root = resolveRoot(options.root, options.rootExplicit);
    const routedStoreVersion = detectStoreVersion(root);
    if (command === 'init' && options.schema !== 3) rejectLegacy();
    if (routedStoreVersion === 'uninitialized' && command === 'doctor' && !subcommand) {
      doctorUninitialized(root, resolveIo);
      return 0;
    }
    if (options.schema === 3 || routedStoreVersion === 3 || routedStoreVersion === 'uninitialized') {
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
    throw new MemoryError(USAGE);
  } catch (error) {
    const known = error instanceof MemoryError;
    try { write(resolveIo, 'stderr', `continuity: ERROR: ${known ? error.message : 'unexpected helper failure'}`); } catch { /* invalid output dependencies fail closed */ }
    return known ? error.exitCode : 3;
  }
}
