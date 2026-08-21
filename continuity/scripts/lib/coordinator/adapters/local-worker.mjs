#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function fail(message) {
  const report = {
    status: 'failed',
    actorId: 'actor-unknown',
    runId: 'run-unknown',
    packetId: 'packet-unknown',
    changedPaths: [],
    unchangedPaths: [],
    approach: 'local-process worker',
    commandsExecuted: [],
    testCounts: { found: 0, executed: 0, passed: 0, failed: 1, skipped: 0 },
    evidence: [],
    failures: [message],
    limitations: ['Worker rejected the assignment before execution'],
    prohibitedApproachesLearned: ['Do not pass secrets, absolute paths, or shell strings'],
    exactNextStep: 'Fix the WorkPacket and retry with a new Attempt',
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(2);
}

const assignmentPath = process.argv[2];
if (!assignmentPath) fail('worker requires an assignment file');

let assignment;
try {
  assignment = JSON.parse(readFileSync(assignmentPath, 'utf8'));
} catch {
  fail('assignment file is not valid JSON');
}

const packet = assignment.packet || {};
const root = assignment.root;
if (typeof root !== 'string' || !root) fail('assignment root is missing');
if (path.isAbsolute(String(packet.goal || '')) || String(packet.goal || '').includes('..')) {
  /* goal is prose; ignore */
}

const command = Array.isArray(assignment.command) && assignment.command.length
  ? assignment.command
  : [process.execPath, '-e', 'process.exit(0)'];
if (command[0] !== process.execPath && path.basename(command[0]).replace(/\.exe$/i, '') !== 'node') {
  fail('local-process adapter only executes the current Node.js binary');
}
if (command.some((part) => /[|&;$><`]/.test(String(part)))) {
  fail('command metacharacters are rejected');
}

const result = spawnSync(command[0], command.slice(1), {
  cwd: root,
  encoding: 'utf8',
  timeout: Number(assignment.timeoutMs ?? 15_000),
  windowsHide: true,
  shell: false,
  env: {
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    NO_COLOR: '1',
  },
});

const exitCode = result.status ?? 1;
const passed = exitCode === 0 && !result.error;
const report = {
  status: passed ? 'done' : 'failed',
  actorId: assignment.actorId,
  runId: assignment.runId,
  packetId: packet.packetId,
  changedPaths: [],
  unchangedPaths: packet.allowedPaths || [],
  approach: 'Execute the focused Node.js check for this WorkPacket',
  commandsExecuted: [command.map(String).join(' ')],
  testCounts: {
    found: 1,
    executed: 1,
    passed: passed ? 1 : 0,
    failed: passed ? 0 : 1,
    skipped: 0,
  },
  evidence: [{
    kind: 'command',
    command: 'node',
    expected: 'focused check exits 0',
    actual: `exit ${exitCode}`,
    exitCode,
    authorizing: passed,
  }],
  failures: passed ? [] : [result.error?.message || `focused check exited ${exitCode}`],
  limitations: ['Stdout is not stored; only the exit code authorizes evidence'],
  prohibitedApproachesLearned: passed ? [] : ['Do not treat a nonzero exit as authorizing evidence'],
  exactNextStep: passed ? 'Record evidence and result through Continuity' : 'Record failure and change approach',
};

if (assignment.reportPath) {
  writeFileSync(assignment.reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(passed ? 0 : 1);
