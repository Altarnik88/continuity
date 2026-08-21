import { buildCoordinatorView } from './coordination/index.mjs';
import { ACTOR_KINDS, MemoryError } from './domain-v3.mjs';
import { buildHandoffV3, buildInspectV3, liveContextFromRoot, renderCoordinatorText, renderInspectJson, renderInspectText } from './inspect-v3.mjs';
import { appendV3, initializeV3, readV3Journal, rebuildV3, validateV3Append, validateV3Batch } from './journal-v3.mjs';
import {
  applyRecipes, recipeAccept, recipeAssign, recipeAttemptReport, recipeBacklog, recipeContextHandoff,
  recipeEvidence, recipeFail, recipePacket, recipeRelease, recipeResult, recipeStart, recipeTask,
  recipeVerify,
} from './recipes-v3.mjs';

const ACTOR_ID = /^[a-z][a-z0-9_]*-[a-z0-9][a-z0-9-]{1,72}$/;
const ACTOR_KIND_SET = new Set(ACTOR_KINDS);

function requireStableId(value, label) {
  if (typeof value !== 'string' || !ACTOR_ID.test(value)) throw new MemoryError(`${label} is not a stable ID`, 2);
  return value;
}

function actorFrom(options) {
  const kind = options.as || 'coordinator';
  if (!ACTOR_KIND_SET.has(kind) || kind === 'external_source') throw new MemoryError('--as requires an actor kind', 2);
  const id = requireStableId(options.actorId || `actor-${kind}`, 'actor-id');
  const runId = requireStableId(options.runId || 'run-cli', 'run-id');
  return { kind, id, role: kind, runId };
}

function writeOut(write, value) {
  write('stdout', value.endsWith('\n') ? value : `${value}\n`);
}

function writeRecorded(write, receipt) {
  writeOut(write, `event recorded: sequence=${receipt.sequence} event=${receipt.eventHash.slice(0, 12)} projection=current`);
  const recorded = {
    eventType: receipt.eventType,
    subjectId: receipt.subjectId,
  };
  if (receipt.resultId) recorded.resultId = receipt.resultId;
  if (receipt.assignmentId) recorded.assignmentId = receipt.assignmentId;
  if (receipt.evidenceId) recorded.evidenceId = receipt.evidenceId;
  writeOut(write, JSON.stringify(recorded));
}

export async function handleV3Command({ command, subcommand, options, root, write, clock, readInput }) {
  const actor = actorFrom(options);
  if (options.class != null && !(command === 'record' && subcommand === 'task')) {
    throw new MemoryError('--class is only valid for record task', 2);
  }
  if (command === 'init') {
    if (options.schema !== 3 || !options.file) throw new MemoryError('v3 init requires --schema 3 --file');
    const receipt = initializeV3(root, readInput(options.file, 'v3 init input'), { clock });
    writeOut(write, `continuity v3 initialized: sequence=${receipt.sequence} event=${receipt.eventHash.slice(0, 12)} projection=current`);
    return 0;
  }
  if (command === 'record') {
    const recipe = subcommand;
    const recipeOptions = {
      actor,
      title: options.title,
      task: options.task,
      attempt: options.attempt,
      goal: options.goal,
      criterion: options.criterion,
      approach: options.approach,
      expected: options.expected,
      actual: options.actual,
      why: options.why,
      impact: options.impact,
      next: options.next,
      result: options.result,
      execution: options.execution,
      blocked: options.blocked,
      reject: recipe === 'reject',
      priority: options.priority,
      size: options.size,
      complexity: options.complexity,
      risk: options.risk,
      class: options.class,
      packet: options.packet,
      assignment: options.assignment,
      assignee: options.assignee,
      found: options.found,
      executed: options.executed,
      passed: options.passed,
      failed: options.failed,
      skipped: options.skipped,
      kind: options.kind,
      evidence: options.evidence,
      exitCode: options.exitCode,
    };
    const builders = {
      task: (store) => [recipeTask(store, recipeOptions, { clock })],
      start: (store) => [recipeStart(store, recipeOptions, { clock })],
      evidence: (store) => [recipeEvidence(store, recipeOptions, { clock })],
      result: (store) => [recipeResult(store, recipeOptions, { clock })],
      fail: (store) => {
        const drafts = recipeFail(store, recipeOptions, { clock });
        return [drafts.lesson, drafts.nextAction, drafts.failure];
      },
      accept: (store) => {
        const drafts = recipeAccept(store, recipeOptions, { clock });
        return [drafts.evidence, drafts.feedback];
      },
      reject: (store) => {
        const drafts = recipeAccept(store, recipeOptions, { clock });
        return [drafts.nextAction, drafts.evidence, drafts.feedback];
      },
      assign: (store) => [recipeAssign(store, recipeOptions, { clock })],
      packet: (store) => [recipePacket(store, recipeOptions, { clock })],
      release: (store) => [recipeRelease(store, recipeOptions, { clock })],
      report: (store) => [recipeAttemptReport(store, recipeOptions, { clock })],
      verify: (store) => [recipeVerify(store, recipeOptions, { clock })],
      context: (store) => [recipeContextHandoff(store, recipeOptions, { clock })],
      backlog: (store) => [recipeBacklog(store, recipeOptions, { clock })],
    };
    const builder = builders[recipe];
    if (builder) {
      if (options.dryRun) {
        validateV3Batch(root, builder, { clock });
        writeOut(write, `record dry-run: ok recipe=${recipe}`);
        return 0;
      }
      const receipts = applyRecipes(root, builder, { clock });
      writeRecorded(write, receipts.at(-1));
      return 0;
    }
    if (options.file || options.stdin) {
      const raw = options.file ? readInput(options.file, 'event draft') : readInput(null, 'event draft', true);
      if (options.dryRun) {
        const validation = validateV3Append(root, raw);
        writeOut(write, `record dry-run: ok prospective-sequence=${validation.prospectiveSequence}`);
        return 0;
      }
      const receipt = appendV3(root, raw, { clock });
      writeRecorded(write, receipt);
      return 0;
    }
    throw new MemoryError('record requires a recipe or --file/--stdin');
  }
  if (command === 'validate') {
    const store = readV3Journal(root);
    writeOut(write, `continuity v3 valid: ${store.events.length} event(s), projection=${store.projection}`);
    return 0;
  }
  if (command === 'doctor') {
    const store = readV3Journal(root);
    writeOut(write, `repository=ok store=v3 journal=valid projection=${store.projection}`);
    return 0;
  }
  if (command === 'rebuild') {
    const receipt = rebuildV3(root, { dryRun: options.dryRun });
    writeOut(write, options.dryRun
      ? `rebuild dry-run: equivalent=${receipt.equivalent} sequence=${receipt.sequence}`
      : `projection rebuilt: sequence=${receipt.sequence} projection=current`);
    return 0;
  }
  if (command === 'inspect' || command === 'handoff' || command === 'history') {
    const store = readV3Journal(root);
    const live = liveContextFromRoot(root, store.state.workspaceAtLastEvent);
    if (command === 'inspect' && (subcommand === 'ready' || subcommand === 'wave')) {
      let agents = store.state.agents ?? [];
      let slots = options.slots ?? 1;
      if (options.file) {
        const input = JSON.parse(readInput(options.file, 'coordination input'));
        agents = input.agents ?? agents;
        slots = input.slots ?? slots;
      }
      const view = buildCoordinatorView(store, live, {
        view: subcommand,
        agents,
        slots,
        resourceLimit: options.resourceLimit,
      });
      writeOut(write, options.json || subcommand === 'wave' ? renderInspectJson(view) : renderCoordinatorText(view));
      return 0;
    }
    const view = command === 'handoff' || options.handoff
      ? buildHandoffV3(store, live, { taskId: options.task, handoffId: options.handoff })
      : buildInspectV3(store, live, { subjectId: options.subject });
    writeOut(write, options.json ? renderInspectJson(view) : renderInspectText(view));
    return 0;
  }
  throw new MemoryError('unsupported v3 command');
}
