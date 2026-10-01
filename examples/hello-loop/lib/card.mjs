// lib/card.mjs -- validate an executor result card.
//
// The card is the ONLY thing that travels to the brain, so this module is the
// enforcement point for "summaries only, never full logs". It refuses a card
// without spending any tokens; the executor compresses and resubmits.
import { readFileSync, existsSync } from 'node:fs';

export const CARD_STATUSES = ['completed', 'failed', 'blocked', 'partial'];

/** Field names that indicate someone tried to smuggle a raw log into the card. */
const FORBIDDEN_KEYS = /^(stdout|stderr|logs?|raw|rawlogs?|full_?output|transcript|trace|dump)$/i;

export class CardError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

function asStringArray(value, field, maxItems, errors) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of strings`);
    return [];
  }
  const cleaned = [];
  for (const item of value) {
    if (typeof item !== 'string') { errors.push(`${field} entries must be strings`); continue; }
    cleaned.push(item.length > 300 ? `${item.slice(0, 297)}...` : item);
  }
  if (cleaned.length > maxItems) {
    errors.push(`${field} has ${cleaned.length} entries, max ${maxItems}`);
  }
  return cleaned;
}

export function loadCard(file) {
  if (file === '-') {
    return { path: '<stdin>', raw: readFileSync(0, 'utf8') };
  }
  if (!existsSync(file)) {
    throw new CardError('CARD_MISSING', `card file not found: ${file}`, 'Write the card before calling ask.');
  }
  return { path: file, raw: readFileSync(file, 'utf8') };
}

/**
 * @returns normalized card
 * @throws  CardError with a fixable hint
 */
export function validateCard(file, cfg) {
  const { path, raw } = loadCard(file);
  const maxOneLine = cfg.summary.oneLineMaxChars;

  let card;
  try {
    card = JSON.parse(raw);
  } catch (err) {
    throw new CardError('CARD_INVALID_JSON', `card is not valid JSON: ${err.message}`, 'Emit strict JSON, no comments, no trailing commas.');
  }
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    throw new CardError('CARD_INVALID_JSON', 'card must be a JSON object', 'Wrap the result in a single object.');
  }

  for (const key of Object.keys(card)) {
    if (FORBIDDEN_KEYS.test(key)) {
      throw new CardError(
        'CARD_HAS_RAW_LOG',
        `card contains a raw-log field "${key}"`,
        'Never send raw output to the brain. Keep only a one-line summary, changed paths and blockers.',
      );
    }
  }

  const errors = [];
  for (const field of ['taskId', 'status', 'summaryOneLine']) {
    if (typeof card[field] !== 'string' || !card[field].trim()) errors.push(`${field} is required (non-empty string)`);
  }
  if (card.status && !CARD_STATUSES.includes(card.status)) {
    errors.push(`status must be one of ${CARD_STATUSES.join(' | ')}`);
  }
  if (typeof card.summaryOneLine === 'string' && card.summaryOneLine.length > maxOneLine) {
    throw new CardError(
      'CARD_TOO_LARGE',
      `summaryOneLine is ${card.summaryOneLine.length} chars, limit ${maxOneLine}`,
      `Rewrite summaryOneLine as one sentence of at most ${maxOneLine} characters. Nothing else may be long.`,
    );
  }

  const changed = asStringArray(card.changed, 'changed', 10, errors);
  const findings = asStringArray(card.findings, 'findings', 5, errors);
  const blockers = asStringArray(card.blockers, 'blockers', 5, errors);
  if (errors.length) {
    throw new CardError('CARD_INVALID', errors.join('; '), 'Fix the listed fields and resubmit. The brain was not called.');
  }

  return {
    taskId: card.taskId,
    runId: typeof card.runId === 'string' ? card.runId : null,
    status: card.status,
    summaryOneLine: card.summaryOneLine,
    changed,
    findings,
    blockers,
    verify: card.verify && typeof card.verify === 'object'
      ? { command: String(card.verify.command ?? '').slice(0, 200), exitCode: card.verify.exitCode ?? null }
      : null,
    nextHint: typeof card.nextHint === 'string' ? card.nextHint.slice(0, 300) : null,
    metrics: card.metrics && typeof card.metrics === 'object'
      ? { turns: card.metrics.turns ?? null, durationMs: card.metrics.durationMs ?? null }
      : null,
    __path: path,
    __bytes: Buffer.byteLength(raw, 'utf8'),
  };
}
