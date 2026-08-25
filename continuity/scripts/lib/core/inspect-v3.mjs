import { evaluateFreshness, HANDOFF_JSON_BYTES, HANDOFF_TEXT_BYTES, MemoryError } from './domain-v3.mjs';
import { criterionHasFreshAuthorizingResult } from './coordination/persist-policy.mjs';
import { liveGitContext } from './workspace-v3.mjs';

function fail(message, exitCode = 2) {
  throw new MemoryError(message, exitCode);
}

function take(items, limit) {
  return items.slice(0, limit);
}

export function liveContextFromWorkspace(workspace, { expiredEvidenceIds = [], unreadableSources = false } = {}) {
  return {
    now: workspace?.capturedAt,
    head: workspace?.head ?? 'unavailable',
    dirty: workspace?.dirty ?? null,
    expiredEvidenceIds,
    unreadableSources,
  };
}

export function liveContextFromRoot(root, recorded, extras = {}) {
  return liveGitContext(root, recorded, extras);
}

export function buildInspectV3(store, live, { subjectId } = {}) {
  const state = store.state;
  const goal = state.goals.find((item) => item.goalId === state.finalGoalId) ?? null;
  const evidence = state.evidence.map((item) => ({
    ...item,
    freshness: evaluateFreshness(live, item),
  }));
  const evidenceView = take(evidence.map((item) => ({
    evidenceId: item.evidenceId,
    authorizing: item.authorizing,
    provenance: item.provenance === 'observed' ? 'observed' : 'claimed',
  })), 20);
  const confirmed = state.results.filter((item) => (
    item.execution === 'succeeded' && item.verification === 'passed'
    && evidence.filter((entry) => item.evidenceIds.includes(entry.evidenceId)).every((entry) => entry.freshness.aggregate === 'fresh')
  ));
  const unverified = state.results.filter((item) => item.verification === 'unverified' || item.verification === 'inconclusive');
  const expired = state.results.filter((item) => item.verification === 'expired'
    || evidence.some((entry) => item.evidenceIds.includes(entry.evidenceId) && entry.freshness.aggregate === 'stale'));
  const rejected = state.feedback.filter((item) => item.acceptance === 'rejected' || item.acceptance === 'needs_changes');
  const view = {
    inspectVersion: 2,
    schemaVersion: 3,
    view: 'coordinator',
    generatedAt: live.now,
    store: {
      schemaVersion: 3,
      sequence: store.events.at(-1)?.sequence ?? 0,
      eventHash: store.events.at(-1)?.eventHash ?? null,
      journalState: 'valid',
      projectionState: store.projection,
    },
    goal: goal && { goalId: goal.goalId, title: goal.title, outcome: goal.outcome, acceptance: goal.acceptance },
    criteria: take(state.criteria.map((item) => ({
      criterionId: item.criterionId,
      condition: item.condition,
      verification: criterionHasFreshAuthorizingResult(state, item, live)
        ? 'passed'
        : (item.verification === 'failed' ? 'failed' : 'unverified'),
    })), 20),
    confirmed: take(confirmed.map((item) => ({ resultId: item.resultId, taskId: item.taskId, actual: item.actual })), 20),
    unverified: take(unverified.map((item) => ({ resultId: item.resultId, taskId: item.taskId, verification: item.verification })), 20),
    stale: take(expired.map((item) => ({ resultId: item.resultId, taskId: item.taskId, reason: 'stale-or-expired-evidence' })), 20),
    failures: take(state.failures.map((item) => ({
      failureId: item.failureId,
      subject: item.subject,
      terminal: item.terminal,
      symptom: item.symptom,
      impact: item.impact,
      rootCause: item.rootCause,
      nextActionId: item.nextActionId,
    })), 20),
    rejections: take(rejected.map((item) => ({
      feedbackId: item.feedbackId, subjectId: item.subjectId, acceptance: item.acceptance, statement: item.statement,
    })), 20),
    blocked: take(state.tasks.filter((item) => item.execution === 'blocked').map((item) => ({
      taskId: item.taskId, title: item.title, failureIds: item.failureIds,
    })), 20),
    conflicts: take(state.conflicts.map((item) => ({ conflictId: item.conflictId, claimIds: item.claimIds, state: item.state })), 20),
    actors: [...new Set(store.events.map((event) => `${event.actor.kind}:${event.actor.id}`))],
    nextActions: take(state.nextActions.filter((item) => item.execution === 'planned' || item.execution === 'in_progress').map((item) => ({
      nextActionId: item.nextActionId, action: item.action, owner: item.ownerActor.id, expectedOutcome: item.expectedOutcome,
    })), 20),
    prohibited: take(state.decisions.map((item) => ({ decisionId: item.decisionId, choice: item.choice, rationale: item.rationale })), 20),
    activeTasks: take(state.tasks.filter((item) => ['planned', 'in_progress', 'blocked', 'partial'].includes(item.execution)).map((item) => ({
      taskId: item.taskId, title: item.title, execution: item.execution, owner: item.owner,
    })), 20),
    evidence: evidenceView,
  };
  if (subjectId) {
    const related = JSON.parse(JSON.stringify(view));
    related.view = 'drill-down';
    related.subjectId = subjectId;
    return related;
  }
  return view;
}

export function buildHandoffV3(store, live, { taskId, handoffId } = {}) {
  const inspect = buildInspectV3(store, live);
  const task = taskId
    ? store.state.tasks.find((item) => item.taskId === taskId)
    : store.state.tasks.find((item) => item.execution === 'in_progress') || store.state.tasks.at(-1);
  if (!task) fail('handoff requires a task');
  const assignment = handoffId
    ? store.state.handoffs.find((item) => item.handoffId === handoffId)
    : store.state.handoffs.find((item) => item.taskId === task.taskId);
  return {
    ...inspect,
    view: 'handoff',
    assignment: assignment ? {
      handoffId: assignment.handoffId,
      taskId: assignment.taskId,
      state: assignment.state,
    } : { taskId: task.taskId, state: 'implicit-coordinator' },
    activeTasks: [{ taskId: task.taskId, title: task.title, execution: task.execution, owner: task.owner }],
    nextActions: inspect.nextActions.filter((item) => item.owner === task.owner || true).slice(0, 10),
  };
}

export function renderInspectText(view) {
  const lines = [
    `GOAL ${view.goal ? `${view.goal.goalId} ${view.goal.title}` : 'none'}`,
    `CRITERIA ${view.criteria.map((item) => item.criterionId).join(',') || 'none'}`,
    `CONFIRMED ${view.confirmed.map((item) => item.resultId).join(',') || 'none'}`,
    `UNVERIFIED ${view.unverified.map((item) => item.resultId).join(',') || 'none'}`,
    `STALE ${view.stale.map((item) => item.resultId).join(',') || 'none'}`,
    `FAILURES ${view.failures.map((item) => `${item.failureId}:${item.symptom}`).join(' | ') || 'none'}`,
    `REJECTED ${view.rejections.map((item) => item.feedbackId).join(',') || 'none'}`,
    `BLOCKED ${view.blocked.map((item) => item.taskId).join(',') || 'none'}`,
    `CONFLICTS ${view.conflicts.map((item) => item.conflictId).join(',') || 'none'}`,
    `ACTORS ${view.actors.join(',') || 'none'}`,
    `EVIDENCE ${(view.evidence ?? []).map((item) => `${item.evidenceId}:${item.provenance}`).join(',') || 'none'}`,
    `NEXT ${view.nextActions.map((item) => `${item.nextActionId}:${item.action}`).join(' | ') || 'none'}`,
    `PROHIBITED ${view.prohibited.map((item) => item.choice).join(' | ') || 'none'}`,
  ];
  const text = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(text, 'utf8') > HANDOFF_TEXT_BYTES) fail('handoff text exceeds the 16 KiB budget', 3);
  return text;
}

export function renderInspectJson(view) {
  const text = `${JSON.stringify(view)}\n`;
  if (Buffer.byteLength(text, 'utf8') > HANDOFF_JSON_BYTES) fail('handoff JSON exceeds the 32 KiB budget', 3);
  return text;
}

export function buildHistoryV3(store, { tail = 10 } = {}) {
  const limit = Number.isInteger(tail) ? Math.min(100, Math.max(1, tail)) : 10;
  const recorded = store.events ?? [];
  const events = recorded.slice(-limit).map((event) => ({
    sequence: event.sequence,
    eventType: event.eventType,
    eventId: event.eventId,
    subjectId: event.subject?.id ?? null,
  }));
  return {
    schemaVersion: 3,
    view: 'history',
    store: {
      schemaVersion: 3,
      sequence: recorded.at(-1)?.sequence ?? 0,
      eventHash: recorded.at(-1)?.eventHash ?? null,
      journalState: 'valid',
      projectionState: store.projection,
    },
    tail: limit,
    events,
  };
}

export function renderHistoryText(view) {
  const rows = (view.events ?? []).map((item) => (
    `${item.sequence} ${item.eventType} ${item.eventId}${item.subjectId ? ` ${item.subjectId}` : ''}`
  ));
  const lines = [
    `HISTORY events=${rows.length} tail=${view.tail ?? rows.length} sequence=${view.store?.sequence ?? 0}`,
    ...rows,
  ];
  const text = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(text, 'utf8') > HANDOFF_TEXT_BYTES) fail('handoff text exceeds the 16 KiB budget', 3);
  return text;
}

export function renderCoordinatorText(view) {
  const ready = (view.availableTasks ?? []).map((item) => item.id).join(',') || 'none';
  const next = (view.nextActions ?? []).map((item) => `${item.taskId}:${item.action}`).join(' | ') || 'none';
  const lines = [
    `COORDINATION ${view.contractId}@${view.contractVersion}`,
    `PLAN ${view.plan?.sufficient ? 'sufficient' : `missing:${(view.plan?.missing ?? []).join(',') || 'unknown'}`}`,
    `BUILD_FIRST ${view.buildFirst?.passed ? 'passed' : 'pending'}`,
    `INTERVIEW no`,
    `READY ${ready}`,
    `NEXT ${next}`,
    `ACCEPTANCE ${view.userAcceptance || 'pending'}`,
  ];
  const text = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(text, 'utf8') > HANDOFF_TEXT_BYTES) fail('handoff text exceeds the 16 KiB budget', 3);
  return text;
}
