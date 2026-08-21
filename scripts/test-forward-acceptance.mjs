import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SKILL_PREFIX,
  assertSkillsDest,
  assertTempInstallHome,
  assertUninstallDest,
  expectedSkillCandidateFiles,
  gitProcessEnv,
  inventoryFromWorktree,
  materializeSkillCandidate,
  skillInstallDest,
} from './package-inventory.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class Skip extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'Skip';
    this.reason = reason;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function samePath(left, right) {
  const normalize = (value) => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  return normalize(left) === normalize(right);
}

function containedIn(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertVerifiedTempRoot(root, label) {
  if (typeof root !== 'string' || root.length === 0) throw new Error(`${label} is empty`);
  const resolved = path.resolve(root);
  const tmp = path.resolve(os.tmpdir());
  if (!containedIn(tmp, resolved)) throw new Error(`${label} is outside the temp directory`);
  if (containedIn(repoRoot, resolved)) throw new Error(`${label} is inside the source worktree`);
  return resolved;
}

function git(root, args, extraEnv = {}) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    env: { ...gitProcessEnv(), ...extraEnv },
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result;
}

function walkInventory(root) {
  if (!existsSync(root)) return [];
  const entries = [];
  const walk = (directory, relative) => {
    for (const name of readdirSync(directory).sort()) {
      const portable = relative ? `${relative}/${name}` : name;
      const absolute = path.join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        entries.push(`d:${portable}`);
        walk(absolute, portable);
      } else if (stat.isSymbolicLink()) {
        entries.push(`l:${portable}`);
      } else {
        entries.push(`f:${portable}:${stat.size}:${sha256(readFileSync(absolute))}`);
      }
    }
  };
  walk(root, '');
  return entries;
}

function hashTree(root) {
  const files = [];
  const walk = (directory, relative) => {
    for (const name of readdirSync(directory).sort()) {
      const portable = relative ? `${relative}/${name}` : name;
      const absolute = path.join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute, portable);
      else {
        const bytes = readFileSync(absolute);
        files.push({ path: portable, size: bytes.length, sha256: sha256(bytes) });
      }
    }
  };
  if (existsSync(root)) walk(root, '');
  return files;
}

function persistenceFingerprint(project) {
  const store = path.join(project, '.continuity');
  const historyPath = path.join(store, 'HISTORY.ndjson');
  const currentPath = path.join(store, 'CURRENT.json');
  const history = existsSync(historyPath) ? readFileSync(historyPath) : Buffer.alloc(0);
  const current = existsSync(currentPath) ? readFileSync(currentPath) : Buffer.alloc(0);
  const events = history.length
    ? history.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const last = events.at(-1);
  const lockName = git(project, ['rev-parse', '--git-path', 'project-memory.checkpoint.lock']).stdout.trim();
  const lock = path.isAbsolute(lockName) ? lockName : path.resolve(project, lockName);
  return {
    historySha256: sha256(history),
    currentSha256: sha256(current),
    historyBytes: history.length,
    currentBytes: current.length,
    records: events.length,
    lastSequence: last?.sequence ?? 0,
    lastEventHash: last?.eventHash ?? null,
    lastEventType: last?.eventType ?? null,
    inventory: walkInventory(store),
    lockExists: existsSync(lock),
  };
}

function readEvents(project) {
  const historyPath = path.join(project, '.continuity', 'HISTORY.ndjson');
  if (!existsSync(historyPath)) return [];
  return readFileSync(historyPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function copySkillCandidate(dest) {
  const materialized = materializeSkillCandidate(repoRoot, dest);
  if (!existsSync(path.join(dest, 'SKILL.md'))) throw new Error('SKILL.md not found in selected skill directory.');
  const expected = expectedSkillCandidateFiles(materialized.inventory);
  assert.deepEqual(materialized.expected, expected);
  assert.deepEqual(
    materialized.files,
    expected.map((repoPath) => repoPath.slice(SKILL_PREFIX.length)),
  );
  const worktreeRelatives = new Set(materialized.inventory.skill.map((file) => file.slice(SKILL_PREFIX.length)));
  const manifest = materialized.files.map((portable) => {
    const bytes = readFileSync(path.join(dest, ...portable.split('/')));
    const repoPath = `${SKILL_PREFIX}${portable}`;
    const included = worktreeRelatives.has(portable);
    return {
      path: portable,
      size: bytes.length,
      sha256: sha256(bytes),
      source: included ? 'worktree' : 'unexpected',
      gitBlob: materialized.inventory.blobs.get(repoPath) ?? null,
    };
  });
  assert.equal(manifest.some((item) => item.source === 'unexpected'), false);
  assert.equal(manifest.some((item) => item.path.split('/').includes('.autopilot')), false);
  assert.equal(manifest.some((item) => item.path.startsWith('.continuity/')), false);
  return { inventory: materialized.inventory, manifest, expected };
}

function copySkillLikeInstaller(src, dest, installHome) {
  assertSkillsDest(installHome, dest);
  if (path.basename(path.resolve(dest)) !== 'continuity') throw new Error('skill dest name must be continuity');
  if (!existsSync(path.join(src, 'SKILL.md'))) throw new Error('SKILL.md not found in selected skill directory.');
  if (existsSync(dest)) throw new Error(`Destination already exists: ${dest}`);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, errorOnExist: true, force: false });
}

function uninstallInstalledSkill(installHome) {
  const realDest = assertUninstallDest(installHome);
  rmSync(realDest, { recursive: true, force: false });
}

function makeTempGitProject(label) {
  const root = mkdtempSync(path.join(os.tmpdir(), `pm-fwd-proj-${label}-`));
  assertVerifiedTempRoot(root, 'project');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Forward Acceptance']);
  git(root, ['config', 'user.email', 'forward-acceptance@example.invalid']);
  writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'fixture']);
  assert.equal(lstatSync(path.join(root, '.git')).isDirectory(), true);
  return root;
}

function helperEnv() {
  const nodeDir = path.dirname(process.execPath);
  const env = {
    ...process.env,
    PATH: [
      'C:\\Program Files\\Git\\cmd',
      'C:\\Program Files\\Git\\bin',
      nodeDir,
      process.env.PATH,
    ].filter(Boolean).join(path.delimiter),
    NODE_PATH: '',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  delete env.NODE_OPTIONS;
  return env;
}

function runHelper(helper, args, { cwd, root } = {}) {
  const argv = root ? [helper, ...args, '--root', root] : [helper, ...args];
  return spawnSync(process.execPath, argv, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    env: helperEnv(),
    maxBuffer: 2 * 1024 * 1024,
  });
}

function requireStatus(result, expected, label) {
  const ok = Array.isArray(expected) ? expected.includes(result.status) : result.status === expected;
  if (!ok) {
    throw new Error(`${label} exited ${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return result;
}

function requireRejected(result, before, project, label, pattern) {
  assert.notEqual(result.status, 0, `${label} must be rejected`);
  assert.equal(result.stdout, '', `${label} must not write stdout`);
  if (pattern) {
    assert.match(`${result.stderr}`, pattern, `${label} stderr`);
  }
  assert.deepEqual(persistenceFingerprint(project), before, `${label} must be no-effect`);
  return result;
}

function assertReadOnly(project, before, label) {
  assert.deepEqual(persistenceFingerprint(project), before, `${label} must be read-only`);
}

function writeDraft(project, name, draft) {
  const file = path.join(project, name);
  writeFileSync(file, `${JSON.stringify(draft, null, 2)}\n`);
  return file;
}

function agentDraft(actorId, extra = {}) {
  return {
    eventType: 'agent.registered',
    occurredAt: '2026-08-19T00:00:00.000Z',
    actor: { kind: 'coordinator', id: 'actor-coord', role: 'coordinator', runId: 'run-plan' },
    subject: { type: 'agent', id: actorId },
    supersedes: [],
    contradicts: [],
    evidenceRefs: [],
    sensitivity: 'internal',
    payload: {
      agent: {
        actorId,
        providerFamily: extra.providerFamily || 'other',
        modelFamily: extra.modelFamily || 'large',
        capabilityProfiles: extra.capabilityProfiles || ['implementation'],
        costTier: extra.costTier || 'standard',
        speedTier: extra.speedTier || 'standard',
        trustTier: 'standard',
        calibrationStatus: 'calibrated',
        kind: extra.kind || 'subagent',
      },
    },
  };
}

export const CASES = [
  {
    id: 'FWD-000-candidate-equals-continuity-subtree',
    run() {
      const parent = mkdtempSync(path.join(os.tmpdir(), 'pm-fwd-index-'));
      const dest = path.join(parent, 'continuity');
      try {
        assertVerifiedTempRoot(parent, 'candidate');
        const inventory = inventoryFromWorktree(repoRoot);
        const expected = expectedSkillCandidateFiles(inventory);
        const { files, manifest } = (() => {
          const result = copySkillCandidate(dest);
          return { files: result.manifest.map((item) => `${SKILL_PREFIX}${item.path}`).sort(), manifest: result.manifest };
        })();
        assert.deepEqual(files, expected);
        assert.equal(manifest.some((item) => item.source !== 'worktree'), false);
        for (const relative of [
          'references/installation.md',
          'references/project-execution.md',
          'scripts/continuity.mjs',
          'scripts/project-memory.mjs',
        ]) {
          assert.ok(manifest.some((item) => item.path === relative), relative);
        }
        assert.equal(manifest.some((item) => item.path.startsWith('scripts/tests/')), false);
        assert.equal(existsSync(path.join(dest, '.autopilot')), false);
        assert.equal(existsSync(path.join(dest, '.continuity')), false);
      } finally {
        rmSync(assertVerifiedTempRoot(parent, 'cleanup'), { recursive: true, force: true });
      }
    },
  },
  {
    id: 'FWD-001-install-execution-loop',
    run() {
      const temps = [];
      const remember = (root, label) => {
        temps.push(assertVerifiedTempRoot(root, label));
        return root;
      };
      const candidateParent = remember(mkdtempSync(path.join(os.tmpdir(), 'pm-fwd-candidate-')), 'candidate');
      const candidate = path.join(candidateParent, 'continuity');
      const installHome = remember(mkdtempSync(path.join(os.tmpdir(), 'continuity-fwd-install-')), 'install home');
      const project = remember(makeTempGitProject('loop'), 'project');
      try {
        assertTempInstallHome(installHome);
        mkdirSync(path.join(installHome, 'skills'), { recursive: true });
        const { manifest } = copySkillCandidate(candidate);
        assert.ok(manifest.some((item) => item.path === 'scripts/continuity.mjs'));
        assert.ok(manifest.some((item) => item.path === 'assets/init-v3.template.json'));
        assert.ok(manifest.some((item) => item.path === 'references/project-execution.md'));
        assert.ok(manifest.some((item) => item.path === 'references/installation.md'));
        assert.equal(manifest.some((item) => item.path.split('/').includes('node_modules')), false);
        assert.equal(manifest.some((item) => item.path.startsWith('.autopilot/') || item.path.includes('/.autopilot/')), false);
        assert.equal(manifest.some((item) => item.path.startsWith('.continuity/')), false);
        const candidateHashes = hashTree(candidate);
        assert.equal(candidateHashes.length, manifest.length);
        assert.deepEqual(
          candidateHashes.map((item) => `${item.path}:${item.sha256}`),
          manifest.map((item) => `${item.path}:${item.sha256}`),
        );

        const dest = skillInstallDest(installHome);
        assert.equal(existsSync(dest), false);
        copySkillLikeInstaller(candidate, dest, installHome);
        assert.equal(samePath(dest, path.join(installHome, 'skills', 'continuity')), true);
        assert.equal(path.basename(path.resolve(dest)), 'continuity');
        assert.equal(existsSync(path.join(dest, 'scripts', 'continuity.mjs')), true);
        assert.equal(existsSync(path.join(dest, 'assets', 'init-v3.template.json')), true);
        assert.equal(existsSync(path.join(dest, 'references', 'project-execution.md')), true);
        assert.equal(existsSync(path.join(dest, 'references', 'installation.md')), true);
        const installedHashes = hashTree(dest);
        assert.deepEqual(
          installedHashes.map((item) => `${item.path}:${item.sha256}`),
          candidateHashes.map((item) => `${item.path}:${item.sha256}`),
        );

        const helper = path.join(dest, 'scripts', 'continuity.mjs');
        const template = path.join(dest, 'assets', 'init-v3.template.json');
        const store = path.join(project, '.continuity');
        const currentPath = path.join(store, 'CURRENT.json');
        const run = (args, cwd = project) => runHelper(helper, args, { cwd });

        const version = run(['--version'], dest);
        requireStatus(version, 0, 'installed --version');
        assert.match(version.stdout, /^continuity 3\.0\.0\n?$/);

        const installAsProject = run(['doctor'], dest);
        assert.notEqual(installAsProject.status, 0, 'installed skill directory must not be treated as a project root');
        assert.equal(existsSync(path.join(dest, '.continuity')), false);

        const nested = path.join(project, 'nested', 'cwd');
        mkdirSync(nested, { recursive: true });
        const beforeDoctor = persistenceFingerprint(project);
        const doctorEmpty = run(['doctor'], nested);
        requireStatus(doctorEmpty, 0, 'doctor uninitialized');
        assert.match(doctorEmpty.stdout, /journal=uninitialized/);
        assert.match(doctorEmpty.stdout, /projection=missing/);
        assert.equal(existsSync(store), false);
        assertReadOnly(project, beforeDoctor, 'doctor uninitialized');

        const beforeInit = persistenceFingerprint(project);
        const init = run(['init', '--schema', '3', '--file', template], nested);
        requireStatus(init, 0, 'init --schema 3');
        assert.match(init.stdout, /continuity v3 initialized/);
        assert.equal(existsSync(path.join(store, 'HISTORY.ndjson')), true);
        assert.equal(existsSync(path.join(dest, '.continuity')), false);
        assert.notDeepEqual(persistenceFingerprint(project), beforeInit);

        const afterInit = persistenceFingerprint(project);
        const refusedInit = run(['init', '--schema', '3', '--file', template], nested);
        requireRejected(refusedInit, afterInit, project, 'init refusal', /already initialized/);
        rmSync(path.join(project, 'nested'), { recursive: true, force: true });

        unlinkSync(currentPath);
        const missingProjection = persistenceFingerprint(project);
        assert.equal(existsSync(currentPath), false);
        const readyMissing = run(['inspect', 'ready', '--json']);
        requireStatus(readyMissing, 0, 'inspect ready with missing projection');
        assertReadOnly(project, missingProjection, 'inspect ready missing projection');
        const waveMissing = run(['inspect', 'wave', '--json']);
        requireStatus(waveMissing, 0, 'inspect wave with missing projection');
        assertReadOnly(project, missingProjection, 'inspect wave missing projection');
        const doctorMissing = run(['doctor']);
        requireStatus(doctorMissing, 0, 'doctor missing projection');
        assert.match(doctorMissing.stdout, /projection=missing/);
        assertReadOnly(project, missingProjection, 'doctor missing projection');
        const repaired = run(['rebuild']);
        requireStatus(repaired, 0, 'rebuild projection');
        assert.equal(existsSync(currentPath), true);
        assert.match(repaired.stdout, /projection rebuilt/);
        const afterRepair = persistenceFingerprint(project);
        assert.equal(afterRepair.historySha256, missingProjection.historySha256);
        assert.equal(afterRepair.records, missingProjection.records);
        assert.notEqual(afterRepair.currentSha256, missingProjection.currentSha256);

        const doctor = run(['doctor']);
        requireStatus(doctor, 0, 'doctor after init');
        assert.match(doctor.stdout, /store=v3/);
        assert.match(doctor.stdout, /projection=current/);
        assertReadOnly(project, afterRepair, 'doctor after repair');

        const readyBeforeTask = run(['inspect', 'ready', '--json']);
        requireStatus(readyBeforeTask, 0, 'inspect ready before task');
        assertReadOnly(project, afterRepair, 'inspect ready before task');
        const missingView = JSON.parse(readyBeforeTask.stdout);
        assert.equal(missingView.view, 'ready');
        assert.equal(missingView.plan?.sufficient, false);
        assert.equal(missingView.plan?.missing?.includes('taskAccumulator'), true);
        assert.equal(missingView.interview?.offered, false);
        assert.equal(missingView.userAcceptance, 'pending');
        assert.equal(missingView.graphifyRequired, false);
        assert.equal(missingView.daemon, false);

        const task = run([
          'record', 'task', '--title', 'Forward acceptance',
          '--priority', 'core', '--size', 'S', '--class', 'function',
          '--as', 'coordinator', '--actor-id', 'actor-coord', '--run-id', 'run-plan',
        ]);
        requireStatus(task, 0, 'record task');

        const inspectFp = persistenceFingerprint(project);
        const inspectJson = run(['inspect', '--json']);
        requireStatus(inspectJson, 0, 'inspect --json');
        assertReadOnly(project, inspectFp, 'inspect --json');
        const inspectView = JSON.parse(inspectJson.stdout);
        const taskId = inspectView.activeTasks?.[0]?.taskId;
        assert.equal(typeof taskId, 'string');
        assert.equal(inspectView.goal?.goalId, 'goal-final');

        const readyAfterTask = run(['inspect', 'ready', '--json']);
        requireStatus(readyAfterTask, 0, 'inspect ready after task');
        assertReadOnly(project, inspectFp, 'inspect ready after task');
        const readyView = JSON.parse(readyAfterTask.stdout);
        assert.equal(readyView.plan?.sufficient, true);
        assert.deepEqual(readyView.plan?.missing ?? [], []);
        assert.equal(readyView.interview?.offered, false);
        assert.equal(readyView.buildFirst?.passed, false);
        assert.equal(readyView.availableTasks.some((item) => item.id === taskId), true);
        assert.equal(readyView.availableTasks.find((item) => item.id === taskId)?.class, 'function');
        assert.equal(
          readyView.excludedTasks.some((item) => item.taskId === taskId && item.reason === 'unclassified-task-class'),
          false,
        );
        assert.equal(readyView.userAcceptance, 'pending');
        assert.equal(readyView.graphifyRequired, false);
        assert.equal(readyView.daemon, false);

        const draftDir = remember(mkdtempSync(path.join(os.tmpdir(), 'pm-fwd-drafts-')), 'drafts');
        for (const [name, draft] of [
          ['agent-exec.json', agentDraft('actor-exec', { providerFamily: 'local', modelFamily: 'small', costTier: 'lowest', speedTier: 'fast' })],
          ['agent-deep.json', agentDraft('actor-deep', { capabilityProfiles: ['implementation', 'integration', 'deep_reasoning'], costTier: 'high', speedTier: 'slow' })],
          ['agent-next.json', agentDraft('actor-next', { modelFamily: 'medium' })],
        ]) {
          const recorded = run(['record', '--file', writeDraft(draftDir, name, draft)]);
          requireStatus(recorded, 0, `register ${name}`);
        }

        const afterAgents = persistenceFingerprint(project);
        const wave = run(['inspect', 'wave', '--json']);
        requireStatus(wave, 0, 'inspect wave');
        assertReadOnly(project, afterAgents, 'inspect wave');
        const waveView = JSON.parse(wave.stdout);
        assert.equal(waveView.view, 'wave');
        assert.equal(waveView.interview?.offered, false);

        const packet = run([
          'record', 'packet', '--task', taskId,
          '--as', 'coordinator', '--actor-id', 'actor-coord', '--run-id', 'run-plan',
        ]);
        requireStatus(packet, 0, 'record packet');

        const beforeAssign = persistenceFingerprint(project);
        const implicitAssignWithActor = run([
          'record', 'assign', '--task', taskId,
          '--as', 'coordinator', '--actor-id', 'actor-coord', '--run-id', 'run-plan',
        ]);
        requireRejected(implicitAssignWithActor, beforeAssign, project, 'assign without --assignee with --actor-id', /assignee/);
        const implicitAssignWithoutActor = run([
          'record', 'assign', '--task', taskId, '--as', 'coordinator',
        ]);
        requireRejected(implicitAssignWithoutActor, beforeAssign, project, 'assign without --assignee without --actor-id', /assignee/);

        const assign = run([
          'record', 'assign', '--task', taskId, '--assignee', 'actor-exec',
          '--as', 'coordinator', '--actor-id', 'actor-coord', '--run-id', 'run-plan',
        ]);
        requireStatus(assign, 0, 'record assign --assignee');

        const afterAssignFp = persistenceFingerprint(project);
        const assignedReady = run(['inspect', 'ready', '--json']);
        requireStatus(assignedReady, 0, 'inspect ready after assign');
        assertReadOnly(project, afterAssignFp, 'inspect ready after assign');
        const assignedView = JSON.parse(assignedReady.stdout);
        const assignment = (assignedView.assignments ?? []).find((item) => item.state === 'held');
        assert.equal(typeof assignment?.assignmentId, 'string');
        assert.equal(assignment.actorId, 'actor-exec');

        const conflict = run([
          'record', 'assign', '--task', taskId, '--assignee', 'actor-next',
          '--as', 'coordinator', '--actor-id', 'actor-coord', '--run-id', 'run-plan',
        ]);
        requireRejected(conflict, afterAssignFp, project, 'overlapping assign', /conflict|ownership|held/i);

        const start = run([
          'record', 'start', '--task', taskId, '--approach', 'Install and exercise the public loop',
          '--as', 'subagent', '--actor-id', 'actor-exec', '--run-id', 'run-exec',
        ]);
        requireStatus(start, 0, 'record start');

        const report = run([
          'record', 'report', '--execution', 'partial',
          '--as', 'subagent', '--actor-id', 'actor-exec', '--run-id', 'run-exec',
        ]);
        requireStatus(report, 0, 'record report');

        const afterReport = persistenceFingerprint(project);
        const prematureResult = run([
          'record', 'result', '--task', taskId,
          '--expected', 'check passes', '--actual', 'report is not evidence',
          '--as', 'subagent', '--actor-id', 'actor-exec', '--run-id', 'run-exec',
        ]);
        requireRejected(prematureResult, afterReport, project, 'result after report only', /--evidence|authorizing evidence/);

        const agentReport = run([
          'record', 'evidence', '--task', taskId,
          '--expected', 'check passes', '--actual', 'agent said it passed',
          '--as', 'subagent', '--actor-id', 'actor-exec', '--run-id', 'run-exec',
        ]);
        requireStatus(agentReport, 0, 'record agent_report evidence');
        const afterAgentReport = persistenceFingerprint(project);
        const stillPremature = run([
          'record', 'result', '--task', taskId,
          '--expected', 'check passes', '--actual', 'agent_report is not authorizing',
          '--as', 'subagent', '--actor-id', 'actor-exec', '--run-id', 'run-exec',
        ]);
        requireRejected(stillPremature, afterAgentReport, project, 'result after agent_report', /--evidence|authorizing evidence/);

        const commandEvidence = run([
          'record', 'evidence', '--task', taskId,
          '--expected', 'check passes', '--actual', 'exit 0',
          '--kind', 'command', '--exit-code', '0',
          '--as', 'subagent', '--actor-id', 'actor-exec', '--run-id', 'run-exec',
        ]);
        requireStatus(commandEvidence, 0, 'record command evidence');
        const commandEvidenceId = JSON.parse(
          String(commandEvidence.stdout).split(/\r?\n/).find((line) => line.trim().startsWith('{')) || '{}',
        ).evidenceId;
        assert.equal(typeof commandEvidenceId, 'string');
        const testEvidence = run([
          'record', 'evidence', '--task', taskId,
          '--expected', 'tests pass', '--actual', 'exit 0',
          '--kind', 'test', '--exit-code', '0',
          '--as', 'subagent', '--actor-id', 'actor-exec', '--run-id', 'run-exec',
        ]);
        requireStatus(testEvidence, 0, 'record test evidence');

        const result = run([
          'record', 'result', '--task', taskId,
          '--expected', 'check passes', '--actual', 'authorizing command and test evidence recorded',
          '--evidence', commandEvidenceId,
          '--as', 'subagent', '--actor-id', 'actor-exec', '--run-id', 'run-exec',
        ]);
        requireStatus(result, 0, 'record result');

        const afterResultFp = persistenceFingerprint(project);
        const afterResultInspect = run(['inspect', '--json']);
        requireStatus(afterResultInspect, 0, 'inspect after result');
        assertReadOnly(project, afterResultFp, 'inspect after result');
        const afterResultView = JSON.parse(afterResultInspect.stdout);
        const resultId = afterResultView.unverified?.[0]?.resultId || afterResultView.confirmed?.[0]?.resultId;
        assert.equal(typeof resultId, 'string');
        assert.notEqual(afterResultView.goal?.acceptance, 'accepted');

        const readyAfterResult = run(['inspect', 'ready', '--json']);
        requireStatus(readyAfterResult, 0, 'inspect ready after result');
        assertReadOnly(project, afterResultFp, 'inspect ready after result');
        const resultReady = JSON.parse(readyAfterResult.stdout);
        assert.equal(resultReady.userAcceptance, 'pending');
        const cleanFreshness = resultReady.freshness?.[taskId];
        assert.notEqual(cleanFreshness, 'stale');

        writeFileSync(path.join(project, 'README.md'), 'dirty live inspect\n');
        const dirtyStore = persistenceFingerprint(project);
        assert.deepEqual(dirtyStore, afterResultFp);
        const dirtyReady = run(['inspect', 'ready', '--json']);
        requireStatus(dirtyReady, 0, 'inspect ready dirty worktree');
        assertReadOnly(project, afterResultFp, 'inspect ready dirty worktree');
        const dirtyView = JSON.parse(dirtyReady.stdout);
        assert.equal(dirtyView.freshness?.[taskId], 'stale');
        assert.equal(dirtyView.userAcceptance, 'pending');
        git(project, ['checkout', '--', 'README.md']);
        assert.deepEqual(persistenceFingerprint(project), afterResultFp);

        const selfVerify = run([
          'record', 'verify', '--result', resultId,
          '--found', '1', '--executed', '1', '--passed', '1', '--failed', '0',
          '--exit-code', '0',
          '--as', 'subagent', '--actor-id', 'actor-exec', '--run-id', 'run-exec',
        ]);
        requireRejected(selfVerify, afterResultFp, project, 'self-verification', /independently verify|own work/);

        const verify = run([
          'record', 'verify', '--result', resultId,
          '--found', '1', '--executed', '1', '--passed', '1', '--failed', '0',
          '--exit-code', '0',
          '--as', 'subagent', '--actor-id', 'actor-deep', '--run-id', 'run-verify',
        ]);
        requireStatus(verify, 0, 'independent verify');

        const afterVerifyFp = persistenceFingerprint(project);
        const readyAfterVerify = run(['inspect', 'ready', '--json']);
        requireStatus(readyAfterVerify, 0, 'inspect ready after verify');
        assertReadOnly(project, afterVerifyFp, 'inspect ready after verify');
        const verifiedReady = JSON.parse(readyAfterVerify.stdout);
        assert.equal(verifiedReady.userAcceptance, 'pending');
        assert.equal(verifiedReady.graphifyRequired, false);
        assert.equal(verifiedReady.daemon, false);
        const readyText = run(['inspect', 'ready']);
        requireStatus(readyText, 0, 'inspect ready text');
        assertReadOnly(project, afterVerifyFp, 'inspect ready text');
        assert.match(readyText.stdout, /ACCEPTANCE pending/);
        assert.doesNotMatch(readyText.stdout, /ACCEPTANCE accepted/);

        const release = run([
          'record', 'release', '--assignment', assignment.assignmentId,
          '--as', 'coordinator', '--actor-id', 'actor-coord', '--run-id', 'run-plan',
        ]);
        requireStatus(release, 0, 'record release');

        const context = run([
          'record', 'context', '--task', taskId, '--next', 'Continue with a new actor and a new Attempt',
          '--as', 'subagent', '--actor-id', 'actor-exec', '--run-id', 'run-exec',
        ]);
        requireStatus(context, 0, 'record context');

        const afterContext = persistenceFingerprint(project);
        const handoff = run(['handoff']);
        requireStatus(handoff, 0, 'handoff');
        assertReadOnly(project, afterContext, 'handoff');
        assert.equal(handoff.stdout.length > 0, true);

        const continueStart = run([
          'record', 'start', '--task', taskId, '--approach', 'New actor continues after handoff',
          '--as', 'subagent', '--actor-id', 'actor-next', '--run-id', 'run-next',
        ]);
        requireStatus(continueStart, 0, 'record start after handoff');

        const afterContinue = persistenceFingerprint(project);
        const continueReady = run(['inspect', 'ready', '--json']);
        requireStatus(continueReady, 0, 'inspect ready after new attempt');
        assertReadOnly(project, afterContinue, 'inspect ready after new attempt');
        const continueView = JSON.parse(continueReady.stdout);
        assert.equal((continueView.previousAttempts ?? []).length >= 2, true);
        assert.equal(continueView.previousAttempts.some((item) => item.owner === 'actor-next'), true);
        assert.equal(continueView.userAcceptance, 'pending');
        assert.equal(continueView.graphifyRequired, false);
        assert.equal(continueView.daemon, false);

        const coordinatorReject = run([
          'record', 'reject', '--as', 'coordinator', '--actor-id', 'actor-coord', '--run-id', 'run-plan',
          '--result', resultId, '--next', 'Retry with a different approach',
        ]);
        requireRejected(coordinatorReject, afterContinue, project, 'coordinator reject', /only the user/);

        const missingNext = run([
          'record', 'reject', '--as', 'user', '--result', resultId,
        ]);
        requireRejected(missingNext, afterContinue, project, 'reject without --next', /--next/);

        const dryReject = run([
          'record', 'reject', '--as', 'user', '--result', resultId,
          '--next', 'Retry with a different approach', '--dry-run',
        ]);
        requireStatus(dryReject, 0, 'dry-run user reject');
        assert.match(dryReject.stdout, /^record dry-run: ok recipe=reject\r?\n$/);
        assertReadOnly(project, afterContinue, 'dry-run user reject');

        const coordinatorAccept = run([
          'record', 'accept', '--as', 'coordinator', '--actor-id', 'actor-coord', '--run-id', 'run-plan',
          '--result', resultId,
        ]);
        requireRejected(coordinatorAccept, afterContinue, project, 'coordinator accept', /only the user/);

        const userAccept = run(['record', 'accept', '--as', 'user', '--result', resultId]);
        requireStatus(userAccept, 0, 'user accept');

        const afterAcceptFp = persistenceFingerprint(project);
        const acceptedReady = run(['inspect', 'ready', '--json']);
        requireStatus(acceptedReady, 0, 'inspect ready after user accept');
        assertReadOnly(project, afterAcceptFp, 'inspect ready after user accept');
        const acceptedView = JSON.parse(acceptedReady.stdout);
        assert.equal(acceptedView.userAcceptance, 'accepted');
        const acceptedText = run(['inspect', 'ready']);
        requireStatus(acceptedText, 0, 'inspect ready text after user accept');
        assertReadOnly(project, afterAcceptFp, 'inspect ready text after user accept');
        assert.match(acceptedText.stdout, /ACCEPTANCE accepted/);

        const inspectFinal = run(['inspect']);
        requireStatus(inspectFinal, 0, 'inspect');
        const history = run(['history', '--json', '--tail', '10']);
        requireStatus(history, 0, 'history');
        assertReadOnly(project, afterAcceptFp, 'inspect and history');
        assert.equal(inspectFinal.stdout.length > 0, true);
        assert.equal(history.stdout.length > 0, true);
        assert.equal(existsSync(path.join(dest, '.continuity')), false);

        const storeBeforeUpdate = persistenceFingerprint(project);
        const beforeOverwrite = walkInventory(dest);
        assert.throws(() => copySkillLikeInstaller(candidate, dest, installHome), /already exists/);
        assert.equal(existsSync(dest), true);
        assert.deepEqual(walkInventory(dest), beforeOverwrite);
        assert.deepEqual(persistenceFingerprint(project), storeBeforeUpdate);

        uninstallInstalledSkill(installHome);
        assert.equal(existsSync(dest), false);
        assert.equal(existsSync(store), true);
        assert.deepEqual(persistenceFingerprint(project), storeBeforeUpdate);
        assert.throws(() => uninstallInstalledSkill(installHome), /missing|unverified/);
        assert.deepEqual(persistenceFingerprint(project), storeBeforeUpdate);
      } finally {
        for (const root of temps.reverse()) {
          const verified = assertVerifiedTempRoot(root, 'cleanup');
          rmSync(verified, { recursive: true, force: true });
        }
      }
    },
  },
];

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let failed = 0;
  for (const testCase of CASES) {
    try {
      await testCase.run();
      console.log(`PASS ${testCase.id}`);
    } catch (error) {
      if (error?.name === 'Skip') {
        console.log(`SKIP ${testCase.id}: ${error.reason || error.message}`);
        continue;
      }
      failed += 1;
      console.error(`FAIL ${testCase.id}: ${error?.stack || error}`);
    }
  }
  if (failed || CASES.length === 0) {
    console.error(`forward acceptance: FAIL (found=${CASES.length} failed=${failed})`);
    process.exit(1);
  }
  console.log(`forward acceptance: PASS (found=${CASES.length} passed=${CASES.length} failed=0)`);
}
