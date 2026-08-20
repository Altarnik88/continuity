export const EXPECTED_EVENT_TYPES = Object.freeze([
  'project.initialized',
  'goal.declared', 'goal.revised', 'goal.blocked', 'goal.reopened', 'goal.abandoned', 'goal.retired', 'goal.achieved',
  'criterion.declared', 'criterion.revised', 'criterion.waived_by_user', 'criterion.reactivated', 'criterion.retired',
  'task.planned', 'task.revised', 'task.started', 'task.implemented', 'task.blocked', 'task.failed', 'task.completed', 'task.abandoned', 'task.reopened',
  'attempt.started', 'attempt.reported',
  'claim.asserted', 'claim.verified', 'claim.disputed', 'claim.superseded', 'claim.retracted',
  'evidence.recorded', 'failure.recorded',
  'feedback.satisfied', 'feedback.dissatisfied', 'feedback.rejected', 'feedback.correction',
  'handoff.assigned', 'handoff.reported', 'handoff.accepted', 'handoff.rejected', 'handoff.cancelled',
  'lesson.recorded', 'decision.recorded', 'decision.revised',
  'migration.v1_imported', 'migration.v1_records_imported',
]);
