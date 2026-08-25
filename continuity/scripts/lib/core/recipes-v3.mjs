import { createHash, randomUUID } from 'node:crypto';

import { MemoryError } from './domain-v3.mjs';
import { appendV3Batch } from './journal-v3.mjs';

function slug(value) {
  const normalized = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const base = normalized || 'item';
  return base.length < 2 ? `${base}0` : base;
}

function iso(clock) {
  const value = typeof clock === 'function' ? clock() : new Date();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function draftJson(draft) {
  return `${JSON.stringify(draft)}\n`;
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireActive(store, kind) {
  if (kind === 'task') {
    const task = [...store.state.tasks].reverse().find((item) => item.execution === 'in_progress' || item.execution === 'planned');
    if (!task) throw new MemoryError('no active task; pass --task', 2);
    return task;
  }
  const attempt = [...store.state.attempts].reverse().find((item) => item.execution === 'in_progress');
  if (!attempt) throw new MemoryError('no active attempt; pass --attempt or run record start', 2);
  return attempt;
}

export function recipeTask(store, options, { clock } = {}) {
  const goalId = options.goal || store.state.finalGoalId;
  if (!goalId) throw new MemoryError('record task requires a final goal', 2);
  const criterionId = options.criterion || store.state.criteria[0]?.criterionId;
  if (!criterionId) throw new MemoryError('record task requires a criterion', 2);
  const taskId = options.id || `task-${slug(options.title || 'work')}-${randomUUID().slice(0, 8)}`;
  return draftJson({
    eventType: 'task.planned',
    occurredAt: iso(clock),
    actor: options.actor,
    subject: { type: 'task', id: taskId },
    goalId,
    taskId,
    supersedes: [],
    contradicts: [],
    evidenceRefs: [],
    sensitivity: 'internal',
    payload: {
      task: {
        taskId,
        goalId,
        title: options.title || 'Untitled task',
        scope: options.scope || options.title || 'Untitled task',
        owner: options.actor.id,
        criterionIds: options.criterionIds || [criterionId],
        userFacing: options.userFacing !== false,
        ...(options.priority ? { priority: options.priority } : {}),
        ...(options.size ? { size: options.size } : {}),
        ...(options.complexity ? { complexity: options.complexity } : {}),
        ...(options.risk ? { risk: options.risk } : {}),
        ...(options.capabilities ? { requiredCapabilities: options.capabilities } : {}),
        ...(options.pathOwnership ? { pathOwnership: options.pathOwnership } : {}),
        ...(options.dependencyIds ? { dependencyIds: options.dependencyIds } : {}),
        ...(options.moduleId ? { moduleId: options.moduleId } : {}),
        class: options.class ?? 'unclassified',
        ...(options.enablesTaskIds ? { enablesTaskIds: options.enablesTaskIds } : {}),
        ...(options.acceptanceCriteria ? { acceptanceCriteria: options.acceptanceCriteria } : {}),
        ...(options.focusedVerification ? { focusedVerification: options.focusedVerification } : {}),
        ...(options.sourceContext ? { sourceContext: options.sourceContext } : {}),
      },
    },
  });
}

export function recipeStart(store, options, { clock } = {}) {
  const task = options.task
    ? store.state.tasks.find((item) => item.taskId === options.task)
    : requireActive(store, 'task');
  if (!task) throw new MemoryError('task is unknown', 2);
  const ordinal = task.attemptIds.length + 1;
  const attemptId = options.id || `attempt-${slug(task.taskId)}-${ordinal}`;
  return draftJson({
    eventType: 'attempt.started',
    occurredAt: iso(clock),
    actor: options.actor,
    subject: { type: 'attempt', id: attemptId },
    goalId: task.goalId,
    taskId: task.taskId,
    supersedes: [],
    contradicts: [],
    evidenceRefs: [],
    sensitivity: 'internal',
    payload: {
      attempt: {
        attemptId,
        taskId: task.taskId,
        ordinal,
        owner: options.actor.id,
        approachId: options.approachId || `approach-${slug(options.approach || 'default')}`,
        hypothesisId: options.hypothesisId || `hypothesis-${slug(options.approach || 'default')}`,
        approachSummary: options.approach || 'Continue the current approach',
      },
    },
  });
}

export function recipeEvidence(store, options, { clock } = {}) {
  const task = options.task
    ? store.state.tasks.find((item) => item.taskId === options.task)
    : store.state.tasks.at(-1);
  const evidenceId = options.id || `evidence-${randomUUID().slice(0, 12)}`;
  const actual = options.actual || options.stdout || 'observed';
  const expected = options.expected || 'command succeeds';
  const hasExitCode = options.exitCode !== undefined && options.exitCode !== null;
  const kind = options.kind || (hasExitCode ? 'command' : 'agent_report');
  const passed = hasExitCode && Number(options.exitCode) === 0;
  const authorizing = options.authorizing !== false
    && passed
    && (kind === 'command' || kind === 'test');
  const provenance = options.provenance === 'observed' ? 'observed' : 'claimed';
  const claimedLimitation = 'Exit code and outputs are self-reported by the writer; the CLI did not execute or observe the command.';
  const observedLimitation = 'CLI executed the command; stored sha256 and length of truncated output only.';
  return draftJson({
    eventType: 'evidence.recorded',
    occurredAt: iso(clock),
    actor: options.actor,
    subject: { type: 'evidence', id: evidenceId },
    ...(task ? { taskId: task.taskId, goalId: task.goalId } : {}),
    supersedes: [],
    contradicts: [],
    evidenceRefs: [],
    sensitivity: 'internal',
    payload: {
      evidence: {
        evidenceId,
        kind,
        source: options.source || options.command || 'manual',
        expected,
        actual: String(actual).slice(0, 500),
        observedAt: iso(clock),
        actor: options.actor,
        verifier: options.verifier || options.actor,
        method: options.method || 'command-capture',
        outcome: hasExitCode ? (passed ? 'passed' : 'failed') : 'observed',
        criterionIds: options.criterion ? [options.criterion] : (task?.criterionIds ?? []),
        ...(task ? { taskId: task.taskId } : {}),
        ...(options.head ? { commit: options.head } : {}),
        authorizing,
        provenance,
        limitations: options.limitations || [
          provenance === 'observed' ? observedLimitation : claimedLimitation,
        ],
      },
    },
  });
}

function eventSequence(store, eventType, match) {
  const event = store.events?.find((item) => item.eventType === eventType && match(item));
  return event ? event.sequence : null;
}

function authorizingEvidenceForAttempt(store, taskId, attempt) {
  const startedAt = eventSequence(
    store,
    'attempt.started',
    (item) => item.payload?.attempt?.attemptId === attempt.attemptId,
  );
  const laterAttempt = store.state.attempts.find(
    (item) => item.taskId === taskId && item.ordinal > attempt.ordinal,
  );
  const endedAt = laterAttempt
    ? eventSequence(
      store,
      'attempt.started',
      (item) => item.payload?.attempt?.attemptId === laterAttempt.attemptId,
    )
    : Number.POSITIVE_INFINITY;
  return (store.state.evidence ?? []).filter((item) => {
    if (item.taskId !== taskId || item.authorizing !== true) return false;
    const sequence = eventSequence(
      store,
      'evidence.recorded',
      (event) => event.payload?.evidence?.evidenceId === item.evidenceId,
    );
    if (startedAt == null || sequence == null) return false;
    return sequence > startedAt && sequence < endedAt;
  });
}

function listedEvidenceIds(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item);
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function resolveSucceededEvidenceIds(store, options, task, attempt) {
  const listed = listedEvidenceIds(options.evidence);
  if (listed.length) return listed;
  const candidates = authorizingEvidenceForAttempt(store, task.taskId, attempt);
  if (candidates.length === 1) return [candidates[0].evidenceId];
  const candidateIds = candidates.map((item) => item.evidenceId).join(', ');
  throw new MemoryError(
    candidates.length > 1
      ? `record result requires --evidence; current attempt has multiple authorizing evidence: ${candidateIds}`
      : 'record result requires --evidence; succeeded execution has no authorizing evidence for the current attempt',
    2,
  );
}

export function recipeResult(store, options, { clock } = {}) {
  const attempt = options.attempt
    ? store.state.attempts.find((item) => item.attemptId === options.attempt)
    : requireActive(store, 'attempt');
  if (!attempt) throw new MemoryError('attempt is unknown', 2);
  const task = store.state.tasks.find((item) => item.taskId === attempt.taskId);
  const resultId = options.id || `result-${randomUUID().slice(0, 12)}`;
  const execution = options.execution || 'succeeded';
  const evidenceIds = execution === 'succeeded'
    ? resolveSucceededEvidenceIds(store, options, task, attempt)
    : (options.evidence ? [options.evidence] : []);
  return draftJson({
    eventType: 'result.recorded',
    occurredAt: iso(clock),
    actor: options.actor,
    subject: { type: 'result', id: resultId },
    goalId: task.goalId,
    taskId: task.taskId,
    supersedes: [],
    contradicts: [],
    evidenceRefs: evidenceIds,
    sensitivity: 'internal',
    payload: {
      result: {
        resultId,
        goalId: task.goalId,
        criterionIds: task.criterionIds,
        taskId: task.taskId,
        attemptId: attempt.attemptId,
        actor: options.actor,
        expected: options.expected || 'Task meets its criteria',
        actual: options.actual || 'Recorded result',
        execution,
        verification: options.verification || 'unverified',
        acceptance: 'pending',
        evidenceIds,
        verificationMethod: options.method || 'command-or-test-evidence',
      },
    },
  });
}

export function recipeFail(store, options, { clock } = {}) {
  const attempt = options.attempt
    ? store.state.attempts.find((item) => item.attemptId === options.attempt)
    : requireActive(store, 'attempt');
  if (!attempt) throw new MemoryError('attempt is unknown', 2);
  const task = store.state.tasks.find((item) => item.taskId === attempt.taskId);
  const nextActionId = `next-${randomUUID().slice(0, 12)}`;
  const lessonId = `lesson-${randomUUID().slice(0, 12)}`;
  const failureId = `failure-${randomUUID().slice(0, 12)}`;
  const occurredAt = iso(clock);
  const nextAction = draftJson({
    eventType: 'next_action.recorded',
    occurredAt,
    actor: options.actor,
    subject: { type: 'next_action', id: nextActionId },
    goalId: task.goalId,
    taskId: task.taskId,
    supersedes: [],
    contradicts: [],
    evidenceRefs: [],
    sensitivity: 'internal',
    payload: {
      nextAction: {
        nextActionId,
        goalId: task.goalId,
        criterionIds: task.criterionIds,
        taskId: task.taskId,
        attemptId: attempt.attemptId,
        actor: options.actor,
        ownerActor: options.actor,
        action: options.next || 'Change approach after the recorded failure',
        rationale: options.why || 'The current attempt failed',
        expectedOutcome: options.expected || 'A different approach unblocks the task',
        verificationMethod: 're-run the failed check',
        execution: 'planned',
        sourceLessonIds: [lessonId],
      },
    },
  });
  const lesson = draftJson({
    eventType: 'lesson.recorded',
    occurredAt,
    actor: options.actor,
    subject: { type: 'lesson', id: lessonId },
    taskId: task.taskId,
    supersedes: [],
    contradicts: [],
    evidenceRefs: [],
    sensitivity: 'internal',
    payload: {
      lesson: {
        lessonId,
        summary: options.why || 'The attempt failed',
        nextActionId,
      },
    },
  });
  const failure = draftJson({
    eventType: 'failure.recorded',
    occurredAt,
    actor: options.actor,
    subject: { type: 'task', id: task.taskId },
    goalId: task.goalId,
    taskId: task.taskId,
    supersedes: [],
    contradicts: [],
    evidenceRefs: [],
    sensitivity: 'internal',
    payload: {
      failure: {
        failureId,
        subject: { type: 'task', id: task.taskId },
        attemptId: attempt.attemptId,
        owner: attempt.owner,
        terminal: options.blocked ? 'blocked' : 'failed',
        approachId: attempt.approachId,
        hypothesisId: attempt.hypothesisId,
        symptom: options.why || 'Attempt failed',
        impact: options.impact || 'The task is not complete',
        unchanged: [options.unchanged || 'Repository sources outside the attempted change'],
        rootCause: { state: options.rootCause || 'unknown', summary: options.why || 'Cause not yet confirmed' },
        evidenceIds: options.evidence ? [options.evidence] : [],
        lessonId,
        nextActionId,
      },
    },
  });
  return { nextAction, lesson, failure };
}

export function recipeAccept(store, options, { clock } = {}) {
  if (options.actor.kind !== 'user') throw new MemoryError('only the user may accept or reject a result', 2);
  const rejected = Boolean(options.reject);
  const resultId = options.result || store.state.results.at(-1)?.resultId;
  if (!resultId) throw new MemoryError(rejected ? 'record reject requires --result' : 'accept requires --result', 2);
  const result = store.state.results.find((item) => item.resultId === resultId);
  if (!result) throw new MemoryError('result is unknown', 2);
  const next = typeof options.next === 'string' ? options.next.trim() : '';
  if (rejected && !next) throw new MemoryError('record reject requires --next', 2);
  const feedbackId = `feedback-${randomUUID().slice(0, 12)}`;
  const evidenceId = `evidence-user-${randomUUID().slice(0, 8)}`;
  const nextActionId = rejected ? `next-${randomUUID().slice(0, 12)}` : null;
  const occurredAt = iso(clock);
  const evidence = recipeEvidence(store, {
    ...options,
    id: evidenceId,
    kind: 'user_message',
    source: 'user',
    expected: rejected ? 'explicit user rejection' : 'explicit user acceptance',
    actual: options.why || (rejected ? 'rejected' : 'accepted'),
    authorizing: false,
    exitCode: 0,
  }, { clock });
  const nextAction = rejected ? draftJson({
    eventType: 'next_action.recorded',
    occurredAt,
    actor: options.actor,
    subject: { type: 'next_action', id: nextActionId },
    goalId: result.goalId,
    taskId: result.taskId,
    supersedes: [],
    contradicts: [],
    evidenceRefs: [],
    sensitivity: 'internal',
    payload: {
      nextAction: {
        nextActionId,
        goalId: result.goalId,
        criterionIds: result.criterionIds ?? [],
        taskId: result.taskId,
        attemptId: result.attemptId,
        actor: options.actor,
        ownerActor: options.actor,
        action: next,
        rationale: options.why || 'The user rejected this result',
        expectedOutcome: options.expected || 'A different approach satisfies the user',
        verificationMethod: 're-run with a new Attempt',
        execution: 'planned',
        sourceFeedbackIds: [feedbackId],
      },
    },
  }) : null;
  const feedback = draftJson({
    eventType: 'feedback.recorded',
    occurredAt,
    actor: options.actor,
    subject: { type: 'result', id: resultId },
    supersedes: [],
    contradicts: [],
    evidenceRefs: [evidenceId],
    sensitivity: 'internal',
    payload: {
      feedback: {
        feedbackId,
        subjectId: resultId,
        disposition: rejected ? 'rejected' : 'satisfied',
        acceptance: rejected ? 'rejected' : 'accepted',
        statement: options.why || (rejected ? 'rejected' : 'accepted'),
        evidenceId,
        ...(rejected ? { nextActionId } : {}),
      },
    },
  });
  return rejected ? { nextAction, evidence, feedback } : { evidence, feedback };
}

export function applyRecipes(root, draftsOrBuilder, options) {
  return appendV3Batch(root, draftsOrBuilder, options);
}

export function recipePacket(store, options, { clock } = {}) {
  const taskIds = options.taskIds || (options.task ? [options.task] : []);
  if (!taskIds.length) throw new MemoryError('record packet requires task ids', 2);
  const packetId = options.packet || `packet-${slug(taskIds.join('-'))}`;
  const tasks = taskIds.map((taskId) => {
    const task = store.state.tasks.find((item) => item.taskId === taskId);
    if (!task) throw new MemoryError(`packet task ${taskId} is unknown`, 2);
    return task;
  });
  return draftJson({
    eventType: 'work_package.recorded',
    occurredAt: iso(clock),
    actor: options.actor,
    subject: { type: 'work_package', id: packetId },
    supersedes: [],
    contradicts: [],
    evidenceRefs: [],
    sensitivity: 'internal',
    payload: {
      packet: {
        packetId,
        taskIds,
        weight: options.weight ?? tasks.reduce((sum, item) => {
          const weights = { XS: 1, S: 2, M: 4, L: 8 };
          return sum + (weights[item.size] ?? 4);
        }, 0),
        prerequisites: [...new Set(tasks.flatMap((item) => item.dependencyIds ?? []))],
        allowedPaths: [...new Set(tasks.flatMap((item) => item.pathOwnership ?? []))],
        requiredCapabilities: [...new Set(tasks.flatMap((item) => item.requiredCapabilities ?? item.capabilities ?? []))],
        riskCeiling: tasks.some((item) => item.risk === 'critical')
          ? 'critical'
          : tasks.some((item) => item.risk === 'significant') ? 'significant' : 'routine',
      },
    },
  });
}

export function recipeAssign(store, options, { clock } = {}) {
  const taskIds = options.taskIds || (options.task ? [options.task] : []);
  if (!taskIds.length) throw new MemoryError('record assign requires a task', 2);
  const packetId = options.packet || `packet-${slug(taskIds.join('-'))}`;
  const assignmentId = options.assignment || `assignment-${slug(packetId)}-${store.state.assignments.length + 1}`;
  if (typeof options.assignee !== 'string' || !options.assignee.trim()) {
    throw new MemoryError('record assign requires --assignee', 2);
  }
  const actorId = options.assignee;
  return draftJson({
    eventType: 'assignment.recorded',
    occurredAt: iso(clock),
    actor: options.actor,
    subject: { type: 'assignment', id: assignmentId },
    taskId: taskIds[0],
    supersedes: [],
    contradicts: [],
    evidenceRefs: [],
    sensitivity: 'internal',
    payload: {
      assignment: {
        assignmentId,
        packetId,
        taskIds,
        actorId,
        generation: store.events.length + 1,
        pathOwnership: options.pathOwnership
          || [...new Set(taskIds.flatMap((taskId) => (
            store.state.tasks.find((item) => item.taskId === taskId)?.pathOwnership ?? []
          )))],
      },
    },
  });
}

export function recipeRelease(store, options, { clock } = {}) {
  const assignment = options.assignment
    ? store.state.assignments.find((item) => item.assignmentId === options.assignment)
    : [...store.state.assignments].reverse().find((item) => item.state === 'held');
  if (!assignment) throw new MemoryError('record release requires an assignment', 2);
  return draftJson({
    eventType: 'assignment.released',
    occurredAt: iso(clock),
    actor: options.actor,
    subject: { type: 'assignment', id: assignment.assignmentId },
    supersedes: [],
    contradicts: [],
    evidenceRefs: [],
    sensitivity: 'internal',
    payload: {
      assignmentId: assignment.assignmentId,
      reason: options.why || 'assignment released',
    },
  });
}

export function recipeAttemptReport(store, options, { clock } = {}) {
  const attempt = options.attempt
    ? store.state.attempts.find((item) => item.attemptId === options.attempt)
    : requireActive(store, 'attempt');
  if (!attempt) throw new MemoryError('attempt is unknown', 2);
  return draftJson({
    eventType: 'attempt.reported',
    occurredAt: iso(clock),
    actor: options.actor,
    subject: { type: 'attempt', id: attempt.attemptId },
    taskId: attempt.taskId,
    supersedes: [],
    contradicts: [],
    evidenceRefs: [],
    sensitivity: 'internal',
    payload: {
      report: {
        attemptId: attempt.attemptId,
        execution: options.execution || 'partial',
        summary: options.actual || options.why || 'Attempt report',
        authorizing: false,
      },
    },
  });
}

export function recipeVerify(store, options, { clock } = {}) {
  const result = options.result
    ? store.state.results.find((item) => item.resultId === options.result)
    : store.state.results.at(-1);
  if (!result) throw new MemoryError('record verify requires a result', 2);
  if (options.actor.id === result.actor.id || options.actor.runId && options.actor.runId === result.actor.runId) {
    throw new MemoryError('a subagent cannot independently verify its own work', 2);
  }
  const requiredCounts = ['found', 'executed', 'passed', 'failed'];
  if (requiredCounts.some((key) => options[key] === undefined || options[key] === null)) {
    throw new MemoryError('record verify requires explicit found, executed, passed, and failed counts', 2);
  }
  if (!Number.isInteger(options.exitCode)) {
    throw new MemoryError('record verify requires --exit-code observed from the verification run', 2);
  }
  const verificationId = options.id || `verification-${randomUUID().slice(0, 12)}`;
  const found = Number(options.found);
  const executed = Number(options.executed);
  const passed = Number(options.passed);
  const failed = Number(options.failed);
  const skipped = Number(options.skipped ?? 0);
  return draftJson({
    eventType: 'verification.recorded',
    occurredAt: iso(clock),
    actor: options.actor,
    subject: { type: 'verification', id: verificationId },
    taskId: result.taskId,
    supersedes: [],
    contradicts: [],
    evidenceRefs: result.evidenceIds,
    sensitivity: 'internal',
    payload: {
      report: {
        verificationId,
        resultId: result.resultId,
        verifier: options.actor,
        criterionIds: result.criterionIds,
        method: options.method || 'independent-command',
        expected: options.expected || result.expected,
        actual: options.actual || result.actual,
        command: options.command || options.source || 'verification',
        exitCode: Number(options.exitCode),
        verifiedAt: iso(clock),
        limitations: options.limitations || ['Bounded verification output only'],
        outcome: found >= 1 && executed >= 1 && passed >= 1 && failed === 0 ? 'passed' : 'failed',
        counts: { found, executed, passed, failed, skipped },
        skipReasons: options.skipReasons || [],
      },
    },
  });
}

export function recipeContextHandoff(store, options, { clock } = {}) {
  const task = options.task
    ? store.state.tasks.find((item) => item.taskId === options.task)
    : store.state.tasks.at(-1);
  if (!task) throw new MemoryError('context handoff requires a task', 2);
  const handoffId = options.handoff || `handoff-${slug(task.taskId)}-${randomUUID().slice(0, 8)}`;
  const assignment = store.state.assignments.find((item) => item.state === 'held' && item.taskIds.includes(task.taskId));
  return draftJson({
    eventType: 'context_handoff.recorded',
    occurredAt: iso(clock),
    actor: options.actor,
    subject: { type: 'context_handoff', id: handoffId },
    taskId: task.taskId,
    supersedes: [],
    contradicts: [],
    evidenceRefs: options.evidence ? [options.evidence] : [],
    sensitivity: 'internal',
    payload: {
      handoff: {
        handoffId,
        taskId: task.taskId,
        packetId: assignment?.packetId,
        assignmentId: assignment?.assignmentId,
        lastCompletedStep: options.approach || 'last safe atomic step',
        actualState: options.actual || 'partial work preserved',
        changedPaths: options.pathOwnership || task.pathOwnership || [],
        evidenceIds: options.evidence ? [options.evidence] : [],
        approaches: options.approaches || [options.approach].filter(Boolean),
        errors: options.errors || [],
        failedHypotheses: options.failedHypotheses || [],
        limitations: options.limitations || ['No raw diffs or secrets stored'],
        nextStep: options.next || 'continue with a new actor and a new attempt',
      },
    },
  });
}

export function recipeNextStatus(store, options, { clock } = {}) {
  const nextAction = options.subject
    ? store.state.nextActions.find((item) => item.nextActionId === options.subject)
    : [...store.state.nextActions].reverse().find((item) => (
      item.execution === 'planned' || item.execution === 'in_progress'
    ));
  if (options.subject && !nextAction) throw new MemoryError('next action is unknown', 2);
  if (!nextAction) throw new MemoryError('record next requires a planned next action', 2);
  const execution = options.execution || 'succeeded';
  return draftJson({
    eventType: 'next_action.status_changed',
    occurredAt: iso(clock),
    actor: options.actor,
    subject: { type: 'next_action', id: nextAction.nextActionId },
    supersedes: [],
    contradicts: [],
    evidenceRefs: listedEvidenceIds(options.evidence),
    sensitivity: 'internal',
    payload: {
      execution,
      ...(options.why ? { reason: options.why } : {}),
    },
  });
}

export function recipeBacklog(store, options, { clock } = {}) {
  const task = options.task
    ? store.state.tasks.find((item) => item.taskId === options.task)
    : store.state.tasks.at(-1);
  if (!task) throw new MemoryError('record backlog requires a task', 2);
  return draftJson({
    eventType: 'backlog.parked',
    occurredAt: iso(clock),
    actor: options.actor,
    subject: { type: 'task', id: task.taskId },
    taskId: task.taskId,
    supersedes: [],
    contradicts: [],
    evidenceRefs: [],
    sensitivity: 'internal',
    payload: {
      taskId: task.taskId,
      reason: options.why || 'optional improvement',
      source: options.source || options.actor.id,
      expectedBenefit: options.expected || 'later quality improvement',
      revisitWhen: options.next || 'after definition of done',
      criterionIds: task.criterionIds,
      dependencies: task.dependencyIds ?? [],
      freshness: 'unknown',
    },
  });
}

export { sha };
