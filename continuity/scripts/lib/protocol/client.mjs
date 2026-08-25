import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ProtocolError, assertSafePayload, rejectSecretText } from './secrets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLED_CONTINUITY_CLI = path.resolve(HERE, '../../continuity.mjs');

const FORBIDDEN_ENV = /^(AWS_|AZURE_|GOOGLE_|OPENAI_|ANTHROPIC_|XAI_|GH_TOKEN|GITHUB_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN)/i;

export function sanitizedSpawnEnv(base = process.env) {
  const env = {
    PATH: base.PATH,
    PATHEXT: base.PATHEXT,
    SystemRoot: base.SystemRoot,
    WINDIR: base.WINDIR,
    ComSpec: base.ComSpec,
    TEMP: base.TEMP,
    TMP: base.TMP,
    USERPROFILE: base.USERPROFILE,
    HOME: base.HOME,
    HOMEDRIVE: base.HOMEDRIVE,
    HOMEPATH: base.HOMEPATH,
    LANG: base.LANG || 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
    if (FORBIDDEN_ENV.test(key)) delete env[key];
  }
  return env;
}

function fail(message, exitCode = 2) {
  throw new ProtocolError(message, exitCode);
}

function parseMaybeJson(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return trimmed;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

export function parseRecordedEvent(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith('{')) continue;
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* keep scanning for a JSON object line */
    }
  }
  return null;
}

export function createCliClient({
  continuityCli = BUNDLED_CONTINUITY_CLI,
  node = process.execPath,
  timeoutMs = 30_000,
} = {}) {
  if (typeof continuityCli !== 'string' || !continuityCli.trim()) {
    fail('Memory/Continuity CLI path is required', 3);
  }

  function run(args, { root, input } = {}) {
    if (!root) fail('protocol client requires --root');
    const result = spawnSync(node, [continuityCli, ...args, '--root', root], {
      encoding: 'utf8',
      input,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      shell: false,
      env: sanitizedSpawnEnv(),
    });
    if (result.error) {
      if (result.error.code === 'ETIMEDOUT') fail('continuity CLI timed out', 3);
      fail(`continuity CLI failed to start (${result.error.message})`, 3);
    }
    if (result.status !== 0) {
      const stderr = String(result.stderr || '').trim();
      fail(stderr || `continuity CLI exited ${result.status}`, result.status || 2);
    }
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      document: parseMaybeJson(result.stdout),
    };
  }

  function record(recipe, flags, { root, as, actorId, runId } = {}) {
    const args = ['record', recipe];
    if (as) args.push('--as', as);
    if (actorId) args.push('--actor-id', actorId);
    if (runId) args.push('--run-id', runId);
    for (const [flag, value] of Object.entries(flags || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (value === true) args.push(`--${flag}`);
      else args.push(`--${flag}`, String(value));
    }
    return run(args, { root });
  }

  function recordFile(draft, { root, as, actorId, runId } = {}) {
    assertSafePayload(draft, 'record draft');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'continuity-protocol-'));
    const file = path.join(dir, 'draft.json');
    try {
      writeFileSync(file, `${JSON.stringify(draft)}\n`);
      const args = ['record', '--file', file];
      if (as) args.push('--as', as);
      if (actorId) args.push('--actor-id', actorId);
      if (runId) args.push('--run-id', runId);
      return run(args, { root });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const writer = {
    as: 'coordinator',
    actorId: 'actor-coord',
    runId: 'run-coord-01',
  };

  return {
    continuityCli,
    doctor({ root }) { return run(['doctor'], { root }); },
    validate({ root }) { return run(['validate'], { root }); },
    inspect({ root, json = true }) {
      return run(json ? ['inspect', '--json'] : ['inspect'], { root });
    },
    inspectReady({ root, json = true }) {
      return run(json ? ['inspect', 'ready', '--json'] : ['inspect', 'ready'], { root });
    },
    inspectWave({ root, slots }) {
      const args = ['inspect', 'wave', '--json'];
      if (Number.isSafeInteger(slots)) args.push('--slots', String(slots));
      return run(args, { root });
    },
    handoff({ root, taskId }) {
      return run(['handoff', '--task', taskId, '--json'], { root });
    },
    history({ root }) { return run(['history', '--json'], { root }); },
    record,
    recordFile,
    recordTask(options) {
      return record('task', {
        title: rejectSecretText(options.title, 'title'),
        priority: options.priority || 'core',
        size: options.size || 'S',
        class: options.class || 'function',
      }, { root: options.root, ...writer });
    },
    recordPacket(options) {
      return record('packet', { task: options.taskId, packet: options.packetId }, {
        root: options.root, ...writer,
      });
    },
    recordAssign(options) {
      const recorded = record('assign', {
        task: options.taskId,
        packet: options.packetId,
        assignee: options.assignee,
      }, { root: options.root, ...writer });
      const parsed = parseRecordedEvent(recorded.stdout);
      const assignmentId = parsed?.assignmentId || parsed?.subjectId || null;
      if (!assignmentId) fail('record assign did not echo assignmentId', 3);
      return { ...recorded, assignmentId, document: parsed };
    },
    recordStart(options) {
      return record('start', { task: options.taskId, approach: options.approach }, {
        root: options.root,
        as: options.as || 'subagent',
        actorId: options.actorId,
        runId: options.runId,
      });
    },
    recordReport(options) {
      return record('report', { execution: options.execution || 'partial', actual: options.summary }, {
        root: options.root,
        as: options.as || 'subagent',
        actorId: options.actorId,
        runId: options.runId,
      });
    },
    recordEvidence(options) {
      const fields = {
        task: options.taskId,
        expected: options.expected,
        kind: options.kind || 'command',
      };
      if (options.run) {
        fields.run = Array.isArray(options.run) ? options.run.join(' ') : options.run;
      } else {
        fields.actual = options.actual;
        fields['exit-code'] = options.exitCode;
      }
      const recorded = record('evidence', fields, {
        root: options.root,
        as: options.as || 'subagent',
        actorId: options.actorId,
        runId: options.runId,
      });
      const parsed = parseRecordedEvent(recorded.stdout);
      const evidenceId = parsed?.evidenceId || parsed?.subjectId || null;
      if (!evidenceId) fail('record evidence did not echo evidenceId', 3);
      return { ...recorded, evidenceId, document: parsed };
    },
    recordResult(options) {
      if ((options.execution || 'succeeded') === 'succeeded' && !options.evidence) {
        fail('record result requires --evidence', 2);
      }
      const recorded = record('result', {
        expected: options.expected,
        actual: options.actual,
        execution: options.execution || 'succeeded',
        evidence: options.evidence,
      }, {
        root: options.root,
        as: options.as || 'subagent',
        actorId: options.actorId,
        runId: options.runId,
      });
      const parsed = parseRecordedEvent(recorded.stdout);
      const resultId = parsed?.resultId || parsed?.subjectId || null;
      if (!resultId) fail('record result did not echo resultId', 3);
      return { ...recorded, resultId, document: parsed };
    },
    recordFail(options) {
      return record('fail', {
        why: options.why,
        impact: options.impact,
        next: options.next,
      }, {
        root: options.root,
        as: options.as || 'subagent',
        actorId: options.actorId,
        runId: options.runId,
      });
    },
    recordVerify(options) {
      if (!Number.isInteger(options.exitCode)) {
        fail('record verify requires --exit-code observed from the verification run', 2);
      }
      return record('verify', {
        result: options.resultId,
        found: options.found,
        executed: options.executed,
        passed: options.passed,
        failed: options.failed,
        skipped: options.skipped ?? 0,
        'exit-code': options.exitCode,
      }, {
        root: options.root,
        as: options.as || 'subagent',
        actorId: options.actorId,
        runId: options.runId,
      });
    },
    recordContext(options) {
      return record('context', { task: options.taskId, next: options.next }, {
        root: options.root,
        as: options.as || 'subagent',
        actorId: options.actorId,
        runId: options.runId,
      });
    },
    recordRelease(options) {
      return record('release', { assignment: options.assignmentId, why: options.why }, {
        root: options.root, ...writer,
      });
    },
    registerAgent({ root, agent, occurredAt }) {
      return recordFile({
        eventType: 'agent.registered',
        occurredAt: occurredAt || new Date().toISOString(),
        actor: { kind: 'coordinator', id: writer.actorId, role: 'coordinator', runId: writer.runId },
        subject: { type: 'agent', id: agent.actorId },
        supersedes: [],
        contradicts: [],
        evidenceRefs: [],
        sensitivity: 'internal',
        payload: { agent },
      }, { root, ...writer });
    },
  };
}
