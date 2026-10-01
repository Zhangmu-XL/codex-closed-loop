// lib/budget.mjs -- daily and per-run budget gates.
//
// This is a local accounting gate: it stops the loop from spending more than the
// configured amount. It is NOT a billing control -- set a hard limit in the
// OpenAI account as well.
import { paths, readJson, writeJsonAtomic } from './state.mjs';

const TZ = 'Asia/Shanghai';

/** Day key in a fixed zone so a laptop timezone change cannot reset the budget. */
export function dayKey(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(now); // en-CA renders YYYY-MM-DD
}

const EMPTY = { day: null, requests: 0, tokens: 0, runs: [] };

export function loadBudget(cfg, now = new Date()) {
  const raw = readJson(paths(cfg).budget, null) ?? { ...EMPTY };
  const key = dayKey(now);
  if (raw.day !== key) {
    return { day: key, requests: 0, tokens: 0, runs: raw.runs ?? [], rolledFrom: raw.day ?? null };
  }
  return { ...EMPTY, ...raw };
}

export function saveBudget(cfg, budget) {
  writeJsonAtomic(paths(cfg).budget, budget);
  return budget;
}

/** Thrown when a gate refuses a call. `code` is stable for exit-code mapping. */
export class BudgetExceeded extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Check every gate BEFORE spending tokens.
 * @returns {{ok: true, budget}} or throws BudgetExceeded.
 */
export function assertCanCall(cfg, state, budget, { taskId, kind }) {
  const b = cfg.budgets;

  if (state.rounds >= b.maxRounds) {
    throw new BudgetExceeded('MAX_ROUNDS', `maxRounds=${b.maxRounds} reached`);
  }
  if (state.turns >= b.maxTurnsTotal) {
    throw new BudgetExceeded('MAX_TURNS', `maxTurnsTotal=${b.maxTurnsTotal} reached`);
  }
  if (budget.requests >= b.maxRequestsPerDay) {
    throw new BudgetExceeded('DAILY_REQUESTS', `maxRequestsPerDay=${b.maxRequestsPerDay} reached (day ${budget.day})`);
  }
  if (budget.tokens >= b.maxTokensPerDay) {
    throw new BudgetExceeded('DAILY_TOKENS', `maxTokensPerDay=${b.maxTokensPerDay} reached (day ${budget.day})`);
  }
  const perTask = state.callsByTask?.[taskId] ?? 0;
  if (taskId && perTask >= b.maxCodexCallsPerTask) {
    throw new BudgetExceeded('TASK_CALLS', `maxCodexCallsPerTask=${b.maxCodexCallsPerTask} reached for ${taskId}`);
  }
  void kind;
  return { ok: true, budget };
}

/**
 * Record a completed attempt.
 *
 * Deliberately asymmetric: an attempt that reached the model is always charged,
 * because it was billed. An attempt whose child process never came up at all (a
 * denied spawn, a missing binary) is counted as a turn but costs no request and
 * no tokens -- otherwise a sandbox that blocks spawning would drain the daily
 * budget without the brain ever being consulted.
 */
export function chargeCall(cfg, budget, state, { taskId, usage, requests = 1, reachedModel = true }) {
  const tokens = usage?.total ?? 0;

  if (reachedModel) {
    budget.requests += requests;
    budget.tokens += tokens;
    budget.lastChargeAt = new Date().toISOString();
  } else {
    budget.unreachedAttempts = (budget.unreachedAttempts ?? 0) + 1;
  }

  state.turns += 1;

  if (!state.callsByTask) state.callsByTask = {};
  if (taskId) state.callsByTask[taskId] = (state.callsByTask[taskId] ?? 0) + 1;

  const perCallLimit = cfg.budgets.maxTokensPerCall;
  const overSingleCall = tokens > perCallLimit;
  return { tokens, overSingleCall, perCallLimit, charged: reachedModel };
}

export function budgetView(cfg, budget, state) {
  return {
    day: budget.day,
    requestsUsed: budget.requests,
    requestsLimit: cfg.budgets.maxRequestsPerDay,
    tokensUsed: budget.tokens,
    tokensLimit: cfg.budgets.maxTokensPerDay,
    unreachedAttempts: budget.unreachedAttempts ?? 0,
    roundsUsed: state.rounds,
    roundsLimit: cfg.budgets.maxRounds,
    turnsUsed: state.turns,
    turnsLimit: cfg.budgets.maxTurnsTotal,
  };
}
