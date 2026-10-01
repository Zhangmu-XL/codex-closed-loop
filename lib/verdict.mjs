// lib/verdict.mjs -- normalize the brain's answer and map it onto an exit code.
//
// The exit code is the machine-readable signal the executor agent branches on;
// stdout carries the full JSON for humans and logs.
export const EXIT = {
  OK: 0,          // pass
  REWORK: 10,     // rework
  NEXT: 20,       // next
  STOP: 30,       // stop
  BUDGET: 3,      // a budget gate refused the call
  ROUNDS: 4,      // maxRounds / maxTurnsTotal reached
  INFRA: 5,       // transport, config or protocol failure
  CARD_TOO_LARGE: 6,
  CARD_INVALID: 6,
  CARD_HAS_RAW_LOG: 6,
  CARD_MISSING: 6,
  PROTOCOL: 5,
};

export const ACTION_EXIT = { pass: EXIT.OK, rework: EXIT.REWORK, next: EXIT.NEXT, stop: EXIT.STOP };

export function verdictToExit(action) {
  return ACTION_EXIT[action] ?? EXIT.PROTOCOL;
}

export class VerdictError extends Error {
  constructor(message, code = 'VERDICT_INVALID') {
    super(message);
    this.code = code;
  }
}

const ACTIONS = new Set(Object.keys(ACTION_EXIT));

function str(value, max = 2000) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t || /^(none|null|n\/a)$/i.test(t)) return null;
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

function coerceTask(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new VerdictError(`${label} must be an object`);
  }
  for (const field of ['taskId', 'title', 'prompt', 'verification']) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      throw new VerdictError(`${label}.${field} is required`);
    }
  }
  return {
    taskId: value.taskId.trim().slice(0, 80),
    title: value.title.trim().slice(0, 200),
    prompt: value.prompt.trim(),
    verification: value.verification.trim(),
    constraints: Array.isArray(value.constraints) ? value.constraints.filter((c) => typeof c === 'string').slice(0, 20) : [],
    dependsOn: Array.isArray(value.dependsOn) ? value.dependsOn.filter((c) => typeof c === 'string').slice(0, 20) : [],
  };
}

/**
 * @throws {VerdictError} when the shape cannot be trusted. The caller then runs
 *         the bounded repair round before giving up.
 */
export function normalizeVerdict(raw, cfg) {
  const oneLineCap = cfg?.summary?.oneLineMaxChars ?? 400;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new VerdictError('verdict must be a JSON object');
  }
  // Tolerate a brain that wrapped the answer, e.g. { verdict: {...} } or { result: {...} }
  const obj = (raw.verdict && typeof raw.verdict === 'object') ? raw.verdict
    : (raw.result && typeof raw.result === 'object' && raw.result.action) ? raw.result
      : raw;

  const action = str(obj.action, 20)?.toLowerCase();
  if (!action || !ACTIONS.has(action)) {
    throw new VerdictError(`action must be one of pass | rework | next | stop (got ${JSON.stringify(raw.action)})`);
  }

  const reason = str(obj.reason ?? obj.summary, 1000) ?? '(no reason given)';
  const feedbackForExecutor = str(obj.feedbackForExecutor ?? obj.feedback, 2000) ?? 'none';
  const reworkInstructions = str(obj.reworkInstructions ?? obj.instructions, 4000);
  // Shares the card summary's limit so a brain that answers at the documented cap
  // is never trimmed or rejected for being one character over a stale constant.
  const summaryForRolling = str(obj.summaryForRolling ?? obj.rollingSummary, oneLineCap)
    ?? `${action}: ${reason}`.slice(0, oneLineCap);

  let nextTask = null;
  if (obj.nextTask) nextTask = coerceTask(obj.nextTask, 'nextTask');
  const additionalTasks = Array.isArray(obj.additionalTasks)
    ? obj.additionalTasks.slice(0, 20).map((t, i) => coerceTask(t, `additionalTasks[${i}]`))
    : [];

  if (action === 'rework' && !reworkInstructions) {
    // Not fatal: fall back to the general feedback rather than burning a repair round.
    return {
      action, reason, feedbackForExecutor, summaryForRolling,
      reworkInstructions: feedbackForExecutor === 'none'
        ? 'Previous attempt was rejected without specific instructions. Re-read the task verification and fix what is objectively missing, then resubmit.'
        : feedbackForExecutor,
      nextTask: null, additionalTasks,
    };
  }

  return { action, reason, feedbackForExecutor, reworkInstructions, nextTask, additionalTasks, summaryForRolling };
}
