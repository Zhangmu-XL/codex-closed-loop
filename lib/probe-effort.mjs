// Report which reasoning-effort tiers this machine's model actually accepts.
//
// Why this exists: `codex exec` has no flag that lists valid effort values, the set is
// model-specific, and the bridge cannot validate the string -- it only learns from the
// first real call. So a wrong value used to surface as a confusing failure on a real
// task, and a RIGHT value (there are tiers above "high") stayed invisible unless you
// guessed it.
//
// Each probe is a tiny prompt, so the whole sweep costs very little.
import { invokeCodex } from './driver-exec.mjs';
import { runDir, writeJsonAtomic } from './state.mjs';
import { join } from 'node:path';

export const DEFAULT_TIERS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

const PROBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer'],
  properties: { answer: { type: 'integer' } },
};

/**
 * The probe prompt is deliberately NOT trivial.
 *
 * A "say pong" prompt produced 0 reasoning tokens at every tier, which made the report
 * conclude that the highest tier was "low" -- a wrong answer produced confidently. The
 * point of the sweep is to separate the tiers, so the prompt has to be one that
 * genuinely requires working out.
 */
const PROBE_ASK = 'Solve exactly. A lock has 4 dials, each 1-9, and only one combination '
  + 'opens it. Clues: (1) exactly two digits are in their correct place; (2) the sum of '
  + 'the digits is 20; (3) no two adjacent dials differ by exactly 1; (4) the first digit '
  + 'is larger than the last. Enumerate the possibilities and reply with a single JSON '
  + 'object containing the count of valid combinations: {"answer": <integer>}';

/**
 * Probe each tier once.
 *
 * @returns {Promise<{results: Array, accepted: string[], rejected: Array}>}
 */
export async function probeEfforts(cfg, { tiers = DEFAULT_TIERS, onProgress = null } = {}) {
  const schemaPath = join(cfg.__stateDir, 'effort-probe.schema.json');
  writeJsonAtomic(schemaPath, PROBE_SCHEMA);

  const results = [];
  for (const tier of tiers) {
    // A fresh config each time: invokeCodex reads cfg.codex, and mutating the shared
    // object would leak one tier's value into the next probe's argv.
    const probeCfg = structuredClone(cfg);
    probeCfg.codex.reasoningEffort = tier;

    onProgress?.(tier);
    const res = await invokeCodex(probeCfg, PROBE_ASK, {
      schemaPath,
      runDir: runDir(cfg, 'effort-probe'),
      tag: `effort-${tier}`,
    });

    const raw = res.usage?.raw ?? {};
    results.push({
      tier,
      ok: res.ok === true,
      reasoningTokens: raw.reasoning_output_tokens ?? null,
      outputTokens: res.usage?.output ?? null,
      inputTokens: res.usage?.input ?? null,
      // The rejection text names the parameter, which is the useful part.
      error: res.ok ? null : String(res.reason ?? res.transportError ?? '').replace(/\s+/g, ' ').slice(0, 300),
    });
  }

  return {
    model: cfg.codex.model ?? null,
    probedAt: new Date().toISOString(),
    results,
    accepted: results.filter((r) => r.ok).map((r) => r.tier),
    rejected: results.filter((r) => !r.ok).map((r) => ({ tier: r.tier, error: r.error })),
  };
}

/** One-line summary for a human, given a report. */
export function effortAdvice(report) {
  const ok = report.results.filter((r) => r.ok);
  if (!ok.length) {
    const wrongModel = report.rejected.length > 0
      && report.rejected.every((r) => /invalid_request_error|unsupported_value|model/i.test(r.error ?? ''));
    return wrongModel
      ? 'No tier was accepted. That usually means codex.model is wrong, not the tier.'
      : 'No tier was accepted. Check `node bridge.mjs doctor`.';
  }

  // Only tiers with a MEASURED reasoning count can be ranked. Reporting a "highest" from
  // a sweep where every tier measured 0 is how the first version of this advised "low"
  // as the strongest tier.
  const measured = ok.filter((r) => typeof r.reasoningTokens === 'number' && r.reasoningTokens > 0);
  if (!measured.length) {
    return `${ok.map((r) => r.tier).join(', ')} accepted, but every tier measured 0 reasoning `
      + 'tokens on this prompt -- the tiers are not distinguishable from this run alone. '
      + 'Pick the tier whose cost you accept; the bridge cannot tell you which is smarter.';
  }

  const ranked = measured.slice().sort((a, b) => b.reasoningTokens - a.reasoningTokens);
  const top = ranked[0];
  const spread = ranked.length > 1
    ? ` (spread ${ranked[ranked.length - 1].tier}=${ranked[ranked.length - 1].reasoningTokens} → ${top.tier}=${top.reasoningTokens})`
    : '';
  return `${ok.map((r) => r.tier).join(', ')} accepted. Reasoning scales with the tier${spread}, `
    + `so "${top.tier}" is the highest tier this model actually engages.`;
}
