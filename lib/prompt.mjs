// lib/prompt.mjs -- build every prompt the brain ever sees.
//
// Two invariants live here:
//
//  1. The brain receives STRUCTURE, not logs. It never sees the executor's
//     filesystem, stdout, or conversation -- only the rolling summary, the
//     current task and one result card.
//
//  2. The instruction preamble is kept deliberately terse. `--output-schema`
//     already forces the JSON shape and the action enum, so the prompt does not
//     restate them. What is left is only what the schema cannot express:
//     what each action commits to, that logs never arrive, and that nextTask
//     must stand alone. Measured before trimming: the preamble was 1583 chars
//     (~440 tok), 32% of an ask prompt, repeated on every single round.
import { buildStateBlock, renderRollingSummary } from './summary.mjs';

export const PROBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'nonce'],
  properties: {
    ok: { type: 'string' },
    nonce: { type: 'string' },
  },
};

export const PROBE_PROMPT = [

  'Reply with one JSON object: {"ok":"pong","nonce":"BRIDGE-PROBE-7F3A"}',
].join('\n');

/** Terse preamble. Every line here changes model behaviour; nothing else survived. */
function rulesFor(cfg) {
  const cap = cfg?.summary?.oneLineMaxChars ?? 400;
  return `Decide this turn. You do not run commands and never see logs or files -- only the blocks below.
pass=accepted, stop here. rework=not accepted, reworkInstructions must say what to change and how to verify.
next=accepted, continue with nextTask (it must stand alone: the executor has no other context). stop=end the run.
summaryForRolling <=${cap} chars; it is the only text carried into the next round.
Never ask for a log dump. If evidence is missing, name the one artifact you need.`;
}

/** Added only in unattended mode: who keeps the loop alive, and when to break it. */
const UNATTENDED_RULES = `UNATTENDED RUN: nobody is watching and nobody will prompt the executor again.
Keep the loop alive yourself: return "next" with the next task for as long as the project needs work.
"pass" ends the run and is only for a finished project. "stop" is only for a genuine human decision.
never stop to ask permission for routine, reversible, in-scope work inside the workspace.
Ask for a human ONLY when one of these is true:
- a permission or credential is required that you do not have
- the action is irreversible, destructive, or reaches outside the workspace
- the task is genuinely ambiguous and guessing would waste real work
- the goal is reached, or you can no longer make progress
When you ask, put the exact question and what you need in feedbackForExecutor.`;

export function buildAskPrompt({ cfg, state, card, task, note, unattended = false, queue }) {
  const rolling = renderRollingSummary(cfg, state);

  const taskBlock = task
    ? JSON.stringify({
      taskId: task.taskId,
      title: task.title,
      prompt: task.prompt,
      verification: task.verification,
      constraints: task.constraints ?? [],
      attempt: task.attempts ?? 1,
    }, null, 2)
    : `(no queued task matched id ${card.taskId}; treat the card as a whole-run report)`;

  const cardBlock = JSON.stringify({
    taskId: card.taskId,
    status: card.status,
    summaryOneLine: card.summaryOneLine,
    changed: card.changed,
    findings: card.findings,
    blockers: card.blockers,
    verify: card.verify,
    nextHint: card.nextHint,
    metrics: card.metrics,
  }, null, 2);

  const queued = renderQueueBlock(queue);

  return [
    rulesFor(cfg),
    ...(unattended ? ['', UNATTENDED_RULES] : []),
    '',
    '<state>',
    buildStateBlock(cfg, state),
    '</state>',
    '',
    // Told explicitly rather than left to infer from the state block: the queue
    // being empty must never read as "something else will handle it".
    '<queue>',
    queued,
    '</queue>',
    '',
    '<seen_so_far>',
    rolling,
    '</seen_so_far>',
    '',
    '<task>',
    taskBlock,
    '</task>',
    '',
    '<card>',
    cardBlock,
    '</card>',
    ...(note ? ['', '<note_from_executor>', note, '</note_from_executor>'] : []),
    '',
    task?.verification ? `acceptance: ${task.verification}` : 'judge against the goal above',
    queued.includes('EMPTY')
      ? 'The queue is empty. Return "next" with the next task if work remains, otherwise "pass" (finished) or "stop" (needs a human).'
      : 'Return "next" if more work remains, otherwise "pass" or "stop".',
  ].join('\n');
}

/** What is still queued, so the brain can see why it may or may not continue. */
function renderQueueBlock(queue) {
  if (!Array.isArray(queue)) return '(queue not supplied)';
  if (queue.length === 0) return 'EMPTY -- no tasks remain queued.';
  return queue.map((t) => `${t.taskId} [${t.state}] ${t.title}`).join('\n');
}

export function buildPlanPrompt({ project, cfg, state }) {
  const unattended = cfg.unattended?.enabledByDefault === true;
  return [
    'Decompose the project into an ordered task queue for one executor agent. No orchestrator sits in between.',
    'Each task must stand alone and carry an objective verification (a command, an exit code, a checkable value).',
    'Keep the queue as short as the goal honestly allows. The first task is dispatched immediately.',
    ...(unattended
      ? ['This is an UNATTENDED run: keep authoring follow-on tasks in your verdicts for as long as work remains.',
        'Include a final task whose verification is the overall success criteria, so you can end with "pass".']
      : []),
    'Reply with one JSON object matching the schema. No prose.',
    '',
    '<state>',
    buildStateBlock(cfg, state),
    '</state>',
    '',
    '<project>',
    (project || '(seeds/PROJECT.md is empty -- stop with a clear reason instead of inventing work.)').trim(),
    '</project>',
  ].join('\n');
}
