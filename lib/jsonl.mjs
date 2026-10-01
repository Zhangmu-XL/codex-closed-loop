// lib/jsonl.mjs -- tolerant parser for the `codex exec --json` event stream.
//
// The event schema is version-specific and not a stable public contract, so every
// extractor below tries several shapes and NEVER throws. A parse miss degrades to
// "stateless mode" (fresh thread per call + rolling summary as full context) rather
// than failing the run.
//
// Field names confirmed on disk for codex-cli 0.159.2:
//   thread.started / turn.started / turn.completed / turn.failed
//   item.started / item.updated / item.completed
//   ThreadStartedEvent.thread_id
//   TurnCompletedEvent.usage <- ThreadUsageBreakdownGroup
//     { net_new_input_tokens, cached_input_tokens, input_tokens, output_tokens, total_tokens }

const USAGE_KEYS = [
  'net_new_input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
];

/** Any object carrying at least one known token counter counts as a usage record. */
function looksLikeUsage(node) {
  if (!node || typeof node !== 'object') return false;
  return USAGE_KEYS.some((k) => typeof node[k] === 'number');
}

function firstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** Content blocks may be a string or an array of {type,text} parts. */
function coerceText(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const parts = value.map(coerceText).filter(Boolean);
    return parts.length ? parts.join('\n') : null;
  }
  if (value && typeof value === 'object') {
    return coerceText(value.text ?? value.content ?? null);
  }
  return null;
}

function num(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function deepFindUsage(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 4) return null;
  if (looksLikeUsage(node)) {
    const out = {};
    for (const k of USAGE_KEYS) {
      const v = num(node, [k]);
      if (v !== null) out[k] = v;
    }
    return out;
  }
  for (const v of Object.values(node)) {
    const found = deepFindUsage(v, depth + 1);
    if (found) return found;
  }
  return null;
}

function eventType(obj) {
  return firstString(obj, ['type', 'event', 'kind', 'msg_type']);
}

/** Parse a whole stdout buffer into { events, malformed, rawLines }. */
export function parseJsonl(text) {
  const events = [];
  let malformed = 0;
  const rawLines = String(text ?? '').split(/\r?\n/);
  for (const line of rawLines) {
    const t = line.trim();
    if (!t) continue;
    if (!t.startsWith('{')) { malformed++; continue; }
    try {
      events.push(JSON.parse(t));
    } catch {
      malformed++;
    }
  }
  return { events, malformed, rawLines };
}

/**
 * Reduce the parsed events to the handful of facts the bridge actually needs.
 * `degraded` is set when we could not confirm a thread id -- the caller then
 * runs statelessly instead of resuming.
 */
export function summarizeEvents(events) {
  let threadId = null;
  let finalText = null;
  let usage = null;
  let failure = null;
  let itemCount = 0;
  const typesSeen = new Set();

  for (const ev of events) {
    const type = eventType(ev);
    if (type) typesSeen.add(type);

    if (!threadId) {
      threadId =
        firstString(ev, ['thread_id', 'threadId', 'session_id', 'conversation_id']) ??
        (ev.thread ? firstString(ev.thread, ['id', 'thread_id']) : null);
    }

    if (type && /^(turn|run|session)\.failed$/.test(type)) {
      failure = firstString(ev, ['error', 'message']) ?? JSON.stringify(ev).slice(0, 400);
    }
    if (ev.error && typeof ev.error === 'object') {
      failure = firstString(ev.error, ['message']) ?? failure;
    }

    if (type && /^item\.completed$/.test(type)) {
      itemCount++;
      const item = ev.item && typeof ev.item === 'object' ? ev.item : ev;
      const kind = firstString(item, ['type', 'item_type', 'kind']);
      if (!kind || kind === 'agent_message' || kind === 'message' || kind === 'assistant_message') {
        const text = coerceText(item.text ?? item.content ?? item.message ?? null);
        if (text) finalText = text;
      }
      // structured final answers may arrive as an object payload
      if (item.structured_content && typeof item.structured_content === 'object') {
        finalText = JSON.stringify(item.structured_content);
      }
    }

    const maybeUsage = ev.usage ?? ev.token_usage ?? ev.tokens ?? null;
    if (maybeUsage) {
      const u = deepFindUsage(maybeUsage);
      if (u) usage = u;
    }
  }

  // last resort: a bare top-level usage record
  if (!usage) usage = deepFindUsage(events);

  return {
    threadId,
    finalText,
    usage,
    failure,
    itemCount,
    typesSeen: [...typesSeen],
    degraded: !threadId,
  };
}

/** Normalize a raw usage record into a stable shape with a computed total. */
export function normalizeUsage(usage) {
  if (!usage) return { input: 0, cachedInput: 0, cacheWriteInput: 0, output: 0, total: 0, raw: null };
  const input = usage.input_tokens ?? 0;
  const cachedInput = usage.cached_input_tokens ?? 0;
  const cacheWriteInput = usage.cache_write_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  // Confirmed shape on codex-cli 0.159.2 has no total_tokens; derive it.
  const total = usage.total_tokens ?? (input + output);
  return { input, cachedInput, cacheWriteInput, output, total, raw: usage };
}
