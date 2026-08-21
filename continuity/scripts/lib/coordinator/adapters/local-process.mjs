import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ProtocolError, sanitizedSpawnEnv, validateAttemptReport } from '../../protocol/index.mjs';

const WORKER = fileURLToPath(new URL('./local-worker.mjs', import.meta.url));

export function createLocalProcessAdapter({ node = process.execPath, timeoutMs = 30_000 } = {}) {
  const launched = new Map();

  function launch(assignment) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'continuity-adapter-'));
    const file = path.join(dir, 'assignment.json');
    const reportPath = path.join(dir, 'report.json');
    writeFileSync(file, `${JSON.stringify({ ...assignment, reportPath })}\n`);
    const result = spawnSync(node, [WORKER, file], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      shell: false,
      env: sanitizedSpawnEnv(),
    });
    let report;
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf8'));
    } catch {
      try {
        report = JSON.parse(String(result.stdout || '').trim());
      } catch {
        throw new ProtocolError('local-process adapter did not return a structured report', 2);
      }
    }
    rmSync(dir, { recursive: true, force: true });
    const validated = validateAttemptReport(report);
    launched.set(assignment.assignmentId, { ...assignment, report: validated, exitCode: result.status });
    return validated;
  }

  return {
    name: 'local-process',
    class: 'live',
    discoverCapabilities() {
      return [{
        actorId: 'actor-exec-01',
        providerFamily: 'local',
        modelFamily: 'node-worker',
        capabilityProfiles: ['implementation'],
        costTier: 'lowest',
        speedTier: 'fast',
        trustTier: 'standard',
        calibrationStatus: 'calibrated',
        kind: 'subagent',
      }, {
        actorId: 'actor-verify-01',
        providerFamily: 'local',
        modelFamily: 'node-verifier',
        capabilityProfiles: ['implementation', 'integration'],
        costTier: 'low',
        speedTier: 'fast',
        trustTier: 'standard',
        calibrationStatus: 'calibrated',
        kind: 'subagent',
      }];
    },
    validateConfiguration(config = {}) {
      if (config.adapter && config.adapter !== 'local-process') {
        throw new ProtocolError('local-process adapter received a different adapter name', 2);
      }
      return { ok: true, adapter: 'local-process' };
    },
    launchAssignment(assignment) {
      const report = launch(assignment);
      return { ok: true, assignmentId: assignment.assignmentId, report };
    },
    sendContext() {
      return { ok: true };
    },
    waitForReport(assignment) {
      const existing = launched.get(assignment.assignmentId);
      if (!existing) throw new ProtocolError('assignment was not launched', 2);
      return existing.report;
    },
    cancelAssignment(assignment) {
      launched.delete(assignment.assignmentId);
      return { ok: true };
    },
    collectEvidence(assignment) {
      const existing = launched.get(assignment.assignmentId);
      if (!existing) throw new ProtocolError('assignment was not launched', 2);
      return existing.report.evidence ?? [];
    },
    healthCheck() {
      const probe = spawnSync(node, ['-e', 'process.exit(0)'], {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
        shell: false,
        env: sanitizedSpawnEnv(),
      });
      return {
        ok: probe.status === 0,
        runtime: 'node',
        worker: path.basename(WORKER),
        live: true,
      };
    },
  };
}
