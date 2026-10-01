// lib/config.mjs -- load, validate, default and resolve the run config.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const DEFAULTS = {
  project: { name: 'demo', workspace: '.' },
  codex: {
    transport: 'auto',
    exePath: null,
    // Prefix args for the Codex process. `selftest` points exePath at a Node
    // stub, so it needs ["/abs/path/stub.mjs"] here. Empty for the real CLI.
    nodeArgs: [],
    model: null,
    // Reasoning effort for the brain. null = whatever ~/.codex/config.toml says,
    // which is usually tuned for interactive chat, not for judging work.
    //
    // Measured on this machine (gpt-5.6-luna, trivial prompt): "low" produced 0
    // reasoning tokens, "high" produced 18. The value is model-specific --
    // "minimal" is rejected outright by that model -- so a bad value fails on the
    // first call with `unsupported_value` rather than degrading quietly.
    //
    // Only applies to a fresh exec: `codex exec resume` accepts no -c, so a thread
    // keeps the effort it was created with.
    reasoningEffort: null,
    sandbox: 'workspace-write',
    extraArgs: [],
    workdir: '.codex-scratch',
    apiKeyEnv: 'OPENAI_API_KEY',
    apiModel: 'gpt-5.1-codex',
  },
  budgets: {
    maxRounds: 40,
    maxCodexCallsPerTask: 6,
    maxReviseAttempts: 2,
    maxRepairAttempts: 1,
    maxTurnsTotal: 200,
    // Token spend is NOT a working limit by default. These two daily counters sit far
    // above any realistic run on purpose: they are a runaway circuit-breaker (a crash
    // loop, a runaway prompt), not a rationing mechanism. What actually shapes a run
    // is maxRounds, maxReviseAttempts and timeouts.maxRunDurationMs.
    //
    // Narrow them deliberately if you are sharing an account or running on a metered
    // budget. `budget.json` keeps counting either way -- `status` and the thread
    // rollover both read it.
    maxRequestsPerDay: 10000,
    maxTokensPerDay: 100000000,
    maxTokensPerCall: 120000,
  },
  timeouts: {
    codexCallMs: 900000,
    codexStartupMs: 120000,
    killGraceMs: 5000,
    lockTtlMs: 960000,
    lockWaitMs: 60000,
    // Hard wall-clock ceiling for one whole run. The token ceilings cannot stop a
    // loop that is stuck on cheap calls, and an unattended process needs a bound
    // it cannot reason its way past. 0 disables the deadline.
    maxRunDurationMs: 21600000,
  },
  summary: {
    // The one-line summary is the only long text that travels to the brain, and it
    // is repeated in the rolling summary for the last `cardsKept` cards. Both
    // numbers move together: raising the line limit without raising the rolling
    // budget just evicts older cards sooner.
    oneLineMaxChars: 400,
    rollingMaxChars: 12288,
    cardsKept: 12,
    compactOnOverflow: true,
  },
  retry: { backoffMs: 2000, maxTransportRetries: 2 },
  // How many executor runs one `ask --executor` chain may launch before giving up.
  // Guards against a misunderstanding turning into an unbounded loop.
  maxExecutorRuns: 25,
  unattended: {
    // When true, the prompt tells the brain to keep the loop running by itself:
    // return `next` while any work remains, and reserve `pass`/`stop` for a
    // finished project or a genuine request for a human.
    enabledByDefault: false,
    askPermissionBeforeExternalActions: true,
  },
  compact: {
    // Roll onto a fresh thread once the running thread has ingested this much, so an
    // unattended loop does not grow its context without bound.
    //
    // This is a CONTEXT-QUALITY guard, not a cost guard: past a point the thread
    // accumulates enough history that the brain starts losing the current task in it,
    // and each round re-reads all of it. Set high if you would rather keep continuity
    // and accept the per-round growth.
    auto: true,
    maxThreadTokens: 500000,
  },
  queueMirror: {
    // Push each verdict into a Codex DESKTOP conversation so it is visible in the UI
    // while the loop runs headlessly. Set `thread` to the chat's id or exact name.
    //
    // The chat thread must be DIFFERENT from the work thread: the app holds a writer
    // lock on its own conversations, so the bridge cannot resume them.
    //
    // Costs one small model turn per push (the app treats a queued message as a
    // prompt), which is why the message asks for no reply. Turn it off when you are
    // not watching.
    enabled: false,
    thread: null,
    timeoutMs: 30000,
  },
};

function deepMerge(base, over) {
  if (over === null || over === undefined) return base;
  if (Array.isArray(base) || Array.isArray(over)) return over;
  if (typeof base === 'object' && typeof over === 'object') {
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
      if (k === '$comment') continue;
      out[k] = k in base ? deepMerge(base[k], v) : v;
    }
    return out;
  }
  return over;
}

export function resolveFromRoot(p) {
  if (!p) return ROOT;
  return isAbsolute(p) ? p : resolve(ROOT, p);
}
/** Candidate locations for the Codex CLI, most explicit first. */
export function codexCandidates(cfg) {
  const out = [];
  if (cfg.codex.exePath) out.push(cfg.codex.exePath);
  if (process.env.CODEX_CLI_PATH) out.push(process.env.CODEX_CLI_PATH);
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const binRoot = join(local, 'OpenAI', 'Codex', 'bin');
    if (existsSync(binRoot)) {
      try {
        for (const hash of readdirSync(binRoot)) {
          out.push(join(binRoot, hash, 'codex.exe'));
          out.push(join(binRoot, hash, 'codex'));
        }
      } catch { /* ignore unreadable install dir */ }
    }
  }
  out.push('codex');
  return out;
}

export function loadConfig({ configPath, rootOverride } = {}) {
  // `rootOverride` lets the selftest point every path (state, seeds, config
  // schemas) at its sandbox instead of the real project root.
  const root = rootOverride ? resolve(rootOverride) : ROOT;
  const path = configPath ? resolveFromRoot(configPath) : join(root, 'config', 'run.config.json');
  let raw = {};
  if (existsSync(path)) {
    try {
      // A UTF-8 BOM is invisible but fatal to JSON.parse, and both Windows editors
      // and `Set-Content -Encoding utf8` add one. Strip it instead of failing.
      raw = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    } catch (err) {
      const e = new Error(`CONFIG_ERROR: cannot parse ${path}: ${err.message}`);
      e.code = 'CONFIG_ERROR';
      throw e;
    }
  }
  const cfg = deepMerge(DEFAULTS, raw);
  cfg.__configPath = path;
  cfg.__root = root;
  cfg.__workspace = isAbsolute(cfg.project.workspace) ? cfg.project.workspace : resolve(root, cfg.project.workspace);
  cfg.__workdir = isAbsolute(cfg.codex.workdir) ? cfg.codex.workdir : resolve(root, cfg.codex.workdir);
  cfg.__stateDir = join(root, 'state');
  return cfg;
}

export function configError(msg) {
  const e = new Error(`CONFIG_ERROR: ${msg}`);
  e.code = 'CONFIG_ERROR';
  return e;
}
