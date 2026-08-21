import { ProtocolError } from '../../protocol/index.mjs';

export function createFakeAdapter({ reports = new Map() } = {}) {
  const launched = new Map();
  return {
    name: 'fake',
    class: 'test-only',
    discoverCapabilities() {
      return [{
        actorId: 'actor-exec-01',
        providerFamily: 'local',
        modelFamily: 'fake',
        capabilityProfiles: ['implementation'],
        costTier: 'lowest',
        speedTier: 'fastest',
        trustTier: 'standard',
        calibrationStatus: 'calibrated',
        kind: 'subagent',
      }, {
        actorId: 'actor-verify-01',
        providerFamily: 'local',
        modelFamily: 'fake-other',
        capabilityProfiles: ['implementation'],
        costTier: 'low',
        speedTier: 'fast',
        trustTier: 'standard',
        calibrationStatus: 'calibrated',
        kind: 'subagent',
      }];
    },
    validateConfiguration() {
      return { ok: true, adapter: 'fake', live: false };
    },
    launchAssignment(assignment) {
      launched.set(assignment.assignmentId, assignment);
      return { ok: true, assignmentId: assignment.assignmentId };
    },
    sendContext() { return { ok: true }; },
    waitForReport(assignment) {
      if (reports.has(assignment.assignmentId)) return reports.get(assignment.assignmentId);
      return {
        status: 'done',
        actorId: assignment.actorId,
        runId: assignment.runId,
        packetId: assignment.packet.packetId,
        changedPaths: [],
        unchangedPaths: assignment.packet.allowedPaths || [],
        approach: 'fake adapter',
        commandsExecuted: [],
        testCounts: { found: 1, executed: 1, passed: 1, failed: 0, skipped: 0 },
        evidence: [{ kind: 'command', expected: 'ok', actual: 'exit 0', exitCode: 0, authorizing: true }],
        failures: [],
        limitations: ['Fake adapter is not live proof'],
        prohibitedApproachesLearned: [],
        exactNextStep: 'Use local-process for live proof',
      };
    },
    cancelAssignment(assignment) {
      launched.delete(assignment.assignmentId);
      return { ok: true };
    },
    collectEvidence(assignment) {
      return this.waitForReport(assignment).evidence;
    },
    healthCheck() {
      return { ok: true, live: false, adapter: 'fake' };
    },
    assertNotLive() {
      throw new ProtocolError('fake adapter is not live proof of autonomous execution', 4);
    },
  };
}
