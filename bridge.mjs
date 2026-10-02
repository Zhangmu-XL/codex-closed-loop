#!/usr/bin/env node
// bridge.mjs -- the transport layer between DSH executor agents and Codex.
//
// WHAT THIS IS NOT: it is not an orchestrator. It does not decide tasks, approve
// work, or route anything. It assembles a summary, calls Codex, accounts for the
// spend, records state, and returns the brain's verdict as a process exit code.
// The executor agent drives the loop by calling `ask` itself.
import { writeFileSync, existsSync, readFileSync, mkdirSync, cpSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

/** This file's directory: the framework checkout, which may not be the project. */
const FRAMEWORK_ROOT = dirname(fileURLToPath(import.meta.url));

import { loadConfig, codexCandidates, DEFAULTS } from './lib/config.mjs';
import { validateCard, CardError } from './lib/card.mjs';
import { invokeCodex, probeCli } from './lib/driver-exec.mjs';
import { EXIT, verdictToExit, normalizeVerdict, VerdictError } from './lib/verdict.mjs';
import { buildAskPrompt, buildPlanPrompt, PROBE_SCHEMA, PROBE_PROMPT } from './lib/prompt.mjs';
import { renderRollingSummary, buildStateBlock, refreshRollingSummary } from './lib/summary.mjs';
import { mirrorEnabled, pushToChat, renderVerdictReport } from './lib/queue-mirror.mjs';
import { inspectState, archiveState, staleArtifacts, isEmptyState } from './lib/archive.mjs';
import { probeEfforts, effortAdvice, DEFAULT_TIERS } from './lib/probe-effort.mjs';
import {
  ensureDirs, paths, loadState, saveState, appendLedger, newRunId, runDir,
  withLock, loadCall, saveCall, callKey, writeTask, listQueue, nextPendingTask,
  writeJsonAtomic, writeHandoff, readJson, wipeState, relPaths, writeTaskBrief,
  installLockExitHook, wipeCalls, cardFingerprint,
} from './lib/state.mjs';
import {
  loadBudget, saveBudget, assertCanCall, chargeCall, budgetView, BudgetExceeded, dayKey,
} from './lib/budget.mjs';

/** Flags that never take a value, even when a bare token follows them. Must be
 *  declared before the parseArgs call below: a `const` is in its temporal dead zone
 *  until initialised, so a later declaration throws rather than reading undefined. */
const KNOWN_BOOLEAN_FLAGS = new Set(['json', 'live', 'keep', 'yes', 'unattended', 'dry-run', 'no-mirror']);

const argv = process.argv.slice(2);
const { flags, verb } = parseArgs(argv);


/** Split flags (and their values) from positional words, so a flag value can
 *  never be mistaken for the command verb.
 *
 *  A flag takes the next bare token as its value whenever one is present. This used
 *  to be a hard-coded whitelist, which meant every new value-taking flag silently
 *  became a boolean -- `--label before-v2` set `label: true` and dropped `before-v2`
 *  into the positional list. Inferring it removes that whole class of mistake, and
 *  flags that appear after all positionals are still plain booleans. */
function parseArgs(args) {
  const out = { _: [] };
  const skip = new Set();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c') { out.card = args[i + 1]; skip.add(i + 1); continue; }
    if (a.startsWith('--no-')) {
      // --no-mirror turns a configured mirror off for one invocation.
      const key = a.replace(/^--no-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = false;
      continue;
    }
    if (a.startsWith('--')) {
      const bare = a.replace(/^--/, '');
      const key = bare.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = args[i + 1];
      // `-` is the stdin sentinel, not a flag: `--card -` must take it as the value.
      const isSentinel = next === '-';
      const hasValue = !KNOWN_BOOLEAN_FLAGS.has(bare) && next !== undefined
        && (isSentinel || !next.startsWith('-'));
      if (hasValue) { out[key] = next; skip.add(i + 1); } else { out[key] = true; }
      continue;
    }
    // A bare `-` is a positional value (the stdin sentinel), never the verb.
    if (a === '-') { if (!skip.has(i)) out._.push(a); continue; }
    if (a.startsWith('-')) continue;
    if (!skip.has(i)) out._.push(a);
  }
  return { flags: out, verb: out._[0] ?? 'help' };
}

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

/**
 * Thrown by `fail()` to unwind straight to the top-level exit handler.
 *
 * `process.exit()` cannot be used: with stdout piped it truncates buffered output.
 * `process.exitCode` alone is not enough either -- setting it does not stop
 * execution, so every `fail()` would fall through into whatever came next (in
 * practice straight into whatever branch followed, causing crashes and double
 * reporting). Throwing unwinds cleanly and still lets stdout flush on natural exit.
 */
class BridgeExit extends Error {
  constructor(code) {
    super(`bridge exiting with ${code}`);
    this.exitCode = code;
  }
}

/**
 * Set the process exit code without stopping execution.
 *
 * Safe for the `process.exit()`-free path: when stdout is a pipe, `process.exit`
 * drops anything still buffered, which silently swallowed a chained round's
 * verdict. Natural exit flushes first.
 */
function exitWith(code) {
  process.exitCode = typeof code === 'number' ? code : 0;
}

function fail(code, payload = {}) {
  out({ ok: false, code, ...payload });
  throw new BridgeExit(EXIT[code] ?? 5);
}

/**
 * Terminal handler for the `BridgeExit` thrown by `fail()`.
 *
 * `fail` already wrote its diagnostic to stdout and the code is carried on the
 * error, so this only has to stop the process with that code and let the stdout
 * buffer flush. Kept as a safety net for rejections that escape `runVerbs`.
 */
process.on('unhandledRejection', (err) => {
  if (!(err instanceof BridgeExit)) {
    process.stderr.write(`bridge: unhandled ${err?.stack ?? err}\n`);
  }
  exitWith(err instanceof BridgeExit ? err.exitCode : 5);
});

/**
 * True when this process is a nested round spawned by `--executor`'s driver.
 *
 * Detected by an environment marker, not by an argv flag: nested rounds carry the
 * same `--executor` value (so the driver can chain further), so argv alone cannot
 * tell the outermost call from an inner one.
 */
const isNestedRound = process.env.DSH_BRIDGE_CHAIN === '1';

/**
 * Suppress this process's verdict on stdout.
 *
 * The outermost call in a chain must stay silent because the driver prints the
 * final round's document as the command's single output. A NESTED round must NOT be
 * silent: it is the driver's only way to learn where to go next.
 */
const suppressVerdict = Boolean(flags.executor) && !isNestedRound;

/**
 * Add keys a project's config is missing, without touching values it already has.
 *
 * Why this has to exist: `init` and `install-bridge` deliberately never overwrite an
 * existing config (clobbering someone's tuned limits would be worse than any schema
 * drift). But that leaves no path for a project created before a new key existed, so
 * new features silently do nothing -- `reasoningEffort` being the first real case.
 *
 * Conservative by construction: existing values always win, including `null`, and
 * nothing is ever removed.
 */
function upgradeProjectConfig(target, { dryRun = false } = {}) {
  const root = resolve(target);

  // Find the config: <root>/config/run.config.json, or a path passed directly.
  let cfgPath = join(root, 'config', 'run.config.json');
  if (!existsSync(cfgPath) && existsSync(root) && root.endsWith('.json')) cfgPath = root;
  if (!existsSync(cfgPath)) {
    process.stderr.write(`upgrade-config: no config at ${cfgPath}\n`);
    process.stderr.write('Run `node bridge.mjs init <dir>` first.\n');
    exitWith(2);
    return;
  }

  let current;
  try {
    current = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    process.stderr.write(`upgrade-config: ${cfgPath} is not valid JSON: ${err.message}\n`);
    exitWith(2);
    return;
  }

  // Captured before the walk adds configVersion, so a pre-versioning config reports
  // its real origin (1) rather than the value we just inserted.
  const fromVersion = Object.prototype.hasOwnProperty.call(current, 'configVersion')
    ? current.configVersion
    : 1;
  const added = [];
  const kept = [];  const walked = new Set();

  const walk = (defs, cur, path) => {
    for (const [key, defVal] of Object.entries(defs)) {
      if (key.startsWith('_') || key === '$comment') continue;
      const here = path ? `${path}.${key}` : key;
      walked.add(here);
      const has = Object.prototype.hasOwnProperty.call(cur, key);

      if (!has) {
        added.push({ key: here, value: defVal });
        cur[key] = structuredClone(defVal);
        continue;
      }
      const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
      if (isPlainObject(defVal) && isPlainObject(cur[key])) {
        walk(defVal, cur[key], here);
      } else {
        kept.push(here);
      }
    }
  };

  walk(DEFAULTS, current, '');

  // Report keys the project carries that the schema no longer knows about. Not an
  // error: it may be a hand-written key, or one a different framework version added.
  const stale = [];
  const collect = (cur, path) => {
    for (const [key, val] of Object.entries(cur)) {
      if (key.startsWith('_') || key === '$comment') continue;
      const here = path ? `${path}.${key}` : key;
      const valIsObj = val && typeof val === 'object' && !Array.isArray(val);
      const known = walked.has(here);
      if (!known && !valIsObj) { stale.push(here); continue; }
      if (valIsObj && !known) collect(val, here);
    }
  };
  collect(current, '');

  current.configVersion = DEFAULTS.configVersion;

  if (!dryRun && added.length) {
    writeFileSync(cfgPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  }

  out({
    ok: true,
    config: cfgPath,
    dryRun,
    configVersion: { from: fromVersion, to: DEFAULTS.configVersion },
    addedKeys: added.map((a) => a.key),
    addedCount: added.length,
    keptCount: kept.length,
    unknownKeys: stale.sort(),
    written: !dryRun && added.length > 0,
    note: added.length
      ? (dryRun ? 'dry run: nothing written' : 'missing keys added; existing values untouched')
      : 'already up to date',
    next: added.length ? [`Review the added keys in ${cfgPath}, then run: node bridge.mjs doctor`] : [],
  });
}

/**
 * Scaffold a new project directory, then point you at `doctor`.
 *
 * Exists because a shipped `run.config.json` cannot contain a working
 * `codex.exePath`: the install directory is a per-install hash. So this probes for
 * a real CLI, writes a config with it (or leaves a placeholder plus instructions if
 * nothing was found), and drops in the PROJECT.md template. Never overwrites an
 * existing config.
 */
function scaffoldProject(target) {
  const root = resolve(target);
  mkdirSync(root, { recursive: true });
  for (const d of ['config', 'seeds', 'state', '.codex-scratch']) {
    mkdirSync(join(root, d), { recursive: true });
  }

  // The CLI path is the one value that cannot be templated.
  let exePath = null;
  let version = null;
  const tried = [];
  for (const cand of codexCandidates({ codex: { exePath: null } })) {
    if (cand === 'codex') continue;
    tried.push(cand);
    if (!existsSync(cand)) continue;
    const probe = probeVersion(cand);
    if (probe.ok) { exePath = cand; version = probe.version; break; }
  }

  const cfgPath = join(root, 'config', 'run.config.json');
  let wroteConfig = false;
  if (!existsSync(cfgPath)) {
    const cfg = structuredClone(DEFAULTS);
    cfg.$comment = 'Generated by `node bridge.mjs init`. Every limit lives here. See the README.';
    cfg.project.workspace = join(root, 'work');
    cfg.codex.exePath = exePath;          // null => resolved from PATH at runtime
    cfg.codex.workdir = join(root, '.codex-scratch');
    mkdirSync(join(root, 'work'), { recursive: true });
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    wroteConfig = true;
  }

  const projPath = join(root, 'seeds', 'PROJECT.md');
  const tplPath = join(FRAMEWORK_ROOT, 'seeds', 'PROJECT.md.template');
  let wroteTemplate = false;
  if (!existsSync(projPath) && existsSync(tplPath)) {
    cpSync(tplPath, projPath, { force: true });
    wroteTemplate = true;
  }

  // Make the project self-contained in the same step. Two steps here is a trap: the
  // generated task brief tells the executor to run `<project-root>/bridge.mjs`, and
  // someone who skips the copy gets `MODULE_NOT_FOUND` from a confused agent.
  const selfContained = join(root, 'bridge.mjs') !== fileURLToPath(import.meta.url);
  let copiedBridge = false;
  if (selfContained) {
    for (const f of ['bridge.mjs']) cpSync(join(FRAMEWORK_ROOT, f), join(root, f), { force: true });
    cpSync(join(FRAMEWORK_ROOT, 'lib'), join(root, 'lib'), { recursive: true, force: true });
    for (const s of ['plan.schema.json', 'verdict.schema.json']) {
      const from = join(FRAMEWORK_ROOT, 'config', s);
      if (existsSync(from)) cpSync(from, join(root, 'config', s), { force: true });
    }
    copiedBridge = true;
  }

  out({
    ok: true,
    scaffolded: root,
    config: cfgPath,
    configWritten: wroteConfig,
    selfContained: copiedBridge,
    codexExe: exePath,
    codexVersion: version,
    probedCandidates: tried,
    projectBrief: projPath,
    projectBriefFromTemplate: wroteTemplate,
    next: [
      exePath ? null : `No Codex CLI found. Set codex.exePath in ${cfgPath} or export CODEX_CLI_PATH.`,
      `Edit ${cfgPath}: point project.workspace at your real code directory.`,
      `Edit ${projPath}: the brain reads this and nothing else.`,
      `cd "${root}" && node bridge.mjs doctor`,
      `node bridge.mjs run init`,
    ].filter(Boolean),
  });
}

/** Probe one candidate executable. Kept separate so scaffold stays declarative. */
function probeVersion(cand) {
  try {
    const v = execFileSync(cand, ['--version'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    return { ok: true, version: (v ?? '').trim() };
  } catch {
    return { ok: false };
  }
}

/**
 * Scaffold a project directory.
 *
 * Handled BEFORE the config loads, because its whole job is to create the config
 * that loading requires. Also the first thing a stranger runs, so it must work in
 * an empty directory -- including finding the Codex CLI, whose install path
 * contains a per-install hash and therefore cannot be shipped in a template.
 */
if (verb === 'init') {
  // `bridge.mjs init [dir]`, like `git init`: the directory is the second positional
  // word, and defaults to the current directory.
  scaffoldProject(flags._[1] ?? '.');
  exitWith(0);
} else if (verb === 'upgrade-config') {
  // Also config-independent: it repairs a config that may predate the current schema.
  upgradeProjectConfig(flags._[1] ?? '.', { dryRun: flags.dryRun === true });
  exitWith(process.exitCode ?? 0);
} else {
  await main();
}

async function main() {
const cfg = loadConfig({ configPath: flags.config, rootOverride: flags.projectRoot });
ensureDirs(cfg);
installLockExitHook(cfg);

/** Every project-relative path derives from the loaded config, never from a
 *  hard-coded root, so `--project-root` redirects the whole tool. */
const PROJECT = {
  schema: (name) => join(cfg.__root, 'config', `${name}.schema.json`),
};

/* --------------------------------------------------------------- prompt files */

function schemaPath(name) {
  return PROJECT.schema(name);
}

/* ------------------------------------------------------------------ dispatch */

/**
 * Run the requested verb and set the exit code.
 *
 * A function (not loose top-level blocks) so `return` genuinely ends a verb:
 * `exitWith` only sets `process.exitCode`, and without a real return every verb
 * would fall through into the ones below it.
 */
/**
 * Handle the verb and set the exit code.
 *
 * Every branch must set one. `printHelp` below fires on an unset exit code as the
 * "no command matched" signal, so a branch that returns without setting it makes
 * usage text appear after a command that actually succeeded.
 */
async function dispatch() {
  if (verb === 'doctor') { await verbDoctor(); return; }
  if (verb === 'selftest') { await verbSelftest(); return; }
  if (verb === 'reset') { verbReset(); return; }
  if (verb === 'status') { verbStatus(); return; }
  if (verb === 'archive-state') { exitWith(verbArchiveState()); return; }
  if (verb === 'probe-effort') { exitWith(await verbProbeEffort()); return; }
  if (verb === 'run' && (flags._[1] === 'init' || argv.includes('init'))) { exitWith(await cmdRunInit()); return; }
  if (verb === 'ask') { exitWith(await cmdAsk()); return; }
  if (verb === 'compact') { exitWith(await cmdCompact()); return; }
  // An unrecognised verb is the one case that wants usage text, and it must set an exit
  // code here: `main` prints help again on an unset code as the "no command" signal, so
  // leaving it unset printed the whole usage block twice.
  printHelp();
  exitWith(verb === 'help' ? 0 : EXIT.PROTOCOL);
}

/* ------------------------------------------------------------- archive-state */

/**
 * Move the current run's state aside so a new run does not inherit it.
 *
 * The collision it prevents is real and silent: task ids restart at T-001 every run,
 * so the previous run's `cards/T-001.accepted.json` sits exactly where the new run
 * writes, and the new run's rolling summary can adopt the old verdict as its own.
 */
function verbArchiveState() {
  const manifest = inspectState(cfg);

  // "Present but empty" is not enough to archive: after a previous archive the
  // directory still exists with a bridge-written ledger in it, so archiving on that
  // basis would silently produce an archive with nothing in it and report success.
  if (isEmptyState(manifest)) {
    out({
      ok: false,
      reason: !manifest.present
        ? `no state directory at ${cfg.__stateDir}`
        : 'nothing to archive: this state has no run, cards, calls or rounds',
      hint: 'Nothing has run since the last archive.',
    });
    return 0;
  }

  if (flags.dryRun === true) {
    out({ ok: true, dryRun: true, wouldArchive: manifest, note: 'dry run: nothing moved' });
    return 0;
  }

  const res = archiveState(cfg, { label: typeof flags.label === 'string' ? flags.label : null });
  if (!res.ok) {
    out({ ok: false, reason: res.reason });
    return EXIT.PROTOCOL;
  }

  appendLedger(cfg, {
    kind: 'state_archived',
    runId: res.manifest.runId,
    archiveDir: res.archiveDirRelative,
    files: res.manifest.files,
    verdicts: res.manifest.verdicts,
  });

  out({
    ok: true,
    archived: res.archiveDirRelative,
    files: res.manifest.files,
    runId: res.manifest.runId,
    status: res.manifest.status,
    verdicts: res.manifest.verdicts,
    note: 'state moved (not deleted); a README recording the provenance was written',
    nextRuns: 'node bridge.mjs run init',
  });
  return 0;
}

/* --------------------------------------------------------------- probe-effort */

/**
 * Ask the model which reasoning tiers it accepts.
 *
 * Necessary because the valid set is model-specific, there is no CLI flag that lists
 * them, and a wrong value only fails on a real call. It also reveals tiers above
 * "high", which is not guessable from the docs.
 */
async function verbProbeEffort() {
  const tiers = typeof flags.tiers === 'string'
    ? String(flags.tiers).split(',').map((t) => t.trim()).filter(Boolean)
    : DEFAULT_TIERS;

  const report = await probeEfforts(cfg, {
    tiers,
    onProgress: (t) => process.stderr.write(`probing effort=${t} ...\n`),
  });

  out({
    ok: report.accepted.length > 0,
    model: report.model ?? '(from ~/.codex/config.toml)',
    configured: cfg.codex.reasoningEffort ?? null,
    accepted: report.accepted,
    rejected: report.rejected,
    results: report.results,
    advice: effortAdvice(report),
    note: 'Tiers are model-specific, and a rejected tier is information rather than an '
      + 'error. Set codex.reasoningEffort, then `compact` so a new thread picks it up '
      + '(resume accepts no -c, so a live thread keeps its own).',
  });

  // Exit 0 whenever the probe itself ran. A model that rejects a tier is a finding,
  // not a failure of this command.
  return 0;
}

/* --------------------------------------------------------------------- doctor */

async function verbDoctor() {
  const probe = probeCli(cfg);
  out({
    ok: true,
    config: cfg.__configPath,
    cli: { path: probe.exe, version: probe.version },
    auth: { present: probe.authPresent, path: probe.authPath },
    workdir: cfg.__workdir,
    workspace: cfg.__workspace,
    probedCandidates: probe.candidates,
  });

  if (!flags.json && !flags.live) { exitWith(0); return; }

  const schema = join(cfg.__stateDir, 'probe.schema.json');
  writeJsonAtomic(schema, PROBE_SCHEMA);
  const res = await invokeCodex(cfg, PROBE_PROMPT, {
    schemaPath: schema, runDir: runDir(cfg, 'doctor'), tag: 'probe',
  });
  out({
    ok: res.ok,
    live: true,
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    threadId: res.threadId,
    threadIdCaptured: Boolean(res.threadId),
    degraded: res.degraded,
    eventCount: res.eventCount,
    malformedLines: res.malformedLines,
    usage: res.usage,
    lastMessage: res.lastMessage,
    reason: res.reason ?? null,
    transportError: res.transportError,
    streamPath: res.streamPath,
  });
  exitWith(res.ok && res.threadId ? 0 : 5);
}

/* -------------------------------------------------------------------- selftest */

async function verbSelftest() {
  const mod = await import('./lib/selftest.mjs');
  exitWith(await mod.runSelftest(cfg, { keep: flags.keep }));
}

/* ----------------------------------------------------------------------- reset */

function verbReset() {
  if (!flags.yes) fail('PROTOCOL', { hint: 'reset deletes all run state. Re-run with --yes.' });
  wipeState(cfg);
  out({ ok: true, reset: true, stateDir: cfg.__stateDir });
  exitWith(0);
}

/* ---------------------------------------------------------------------- status */

function verbStatus() {
  const state = loadState(cfg);
  const budget = loadBudget(cfg);
  const tasks = listQueue(cfg);
  out({
    ok: true,
    runId: state.runId,
    status: state.status,
    stopReason: state.stopReason,
    currentTaskId: state.currentTaskId,
    threadId: state.threadId,
    statelessMode: state.statelessMode,
    lastVerdict: state.lastVerdict,
    budget: budgetView(cfg, budget, state),
    queue: tasks.map((t) => ({ taskId: t.taskId, title: t.title, state: t.state })),
    nextTaskId: nextPendingTask(cfg)?.taskId ?? null,
  });
  exitWith(0);
}

/* -------------------------------------------------------------------- dispatch */

await runDispatch();
if (process.exitCode === undefined) printHelp();

async function runDispatch() {
  try {
    await dispatch();
  } catch (err) {
    if (err instanceof BridgeExit) {
      exitWith(err.exitCode);
      return;
    }
    process.stderr.write(`bridge: unhandled ${err?.stack ?? err}\n`);
    exitWith(EXIT.PROTOCOL);
  }
}

/* ================================================================== commands == */
/**
 * Record that real work just happened, and how much of it was not idle waiting.
 *
 * The lifetime ceiling is measured against this rather than against `createdAt`, so an
 * idle gap (a crashed executor, an overnight pause) does not consume a run's budget.
 * Deliberately not a timer: it is stamped by the operations that cost something.
 */
function markActive(state, workedMs = 0) {
  const now = new Date().toISOString();
  state.lastActiveAt = now;
  if (workedMs > 0) state.activeMs = (state.activeMs ?? 0) + workedMs;
  return state;
}

async function guardedCall(cfg_, state, budget, meta, prompt) {
  // Gate first: a refused call must not cost a token.
  assertCanCall(cfg_, state, budget, meta);

  // Heartbeat: the round-trip about to happen is real work, so it refreshes the
  // lifetime anchor before the call rather than after. Recording it afterwards would
  // let a crash during a long call look like idleness.
  markActive(state);

  // `freshThread` is what makes `compact` a rollover: the whole point is to leave
  // the accumulated thread behind and reseed from the rolling summary.
  const useThread = meta.freshThread ? null : (state.statelessMode ? null : (state.threadId ?? null));

  const startedAt = Date.now();
  let res;
  let lastError = null;
  for (let attempt = 0; attempt <= cfg_.retry.maxTransportRetries; attempt++) {
    res = await invokeCodex(cfg_, prompt, {
      threadId: attempt === 0 ? useThread : (meta.freshThread ? null : useThread),
      schemaPath: meta.schemaPath,
      runDir: runDir(cfg_, state.runId),
      tag: attempt === 0 ? meta.tag : `${meta.tag}-retry${attempt}`,
    });
    if (res.ok || !isTransportFailure(res)) break;
    lastError = res.transportError ?? res.reason ?? 'unknown';
    appendLedger(cfg_, {
      kind: 'transport_retry', taskId: meta.taskId, kindTag: meta.tag,
      attempt, error: lastError, exitCode: res.exitCode,
    });
    if (attempt < cfg_.retry.maxTransportRetries) {
      await new Promise((r) => setTimeout(r, cfg_.retry.backoffMs * (attempt + 1)));
    }
  }
  markActive(state, Date.now() - startedAt);

  if (res.threadId && res.threadId !== state.threadId) {
    state.threadId = res.threadId;
    state.threadStartedAt = new Date().toISOString();
    state.threadTokens = 0;
  }
  if (res.degraded) state.statelessMode = true;
  // Track how much this thread has ingested, so an unattended loop can roll over
  // before its context grows without bound.
  state.threadTokens = (state.threadTokens ?? 0) + (res.usage?.input ?? 0);

  // Charged only when the child process actually came up, because only then was
  // the model consulted. A denied spawn must not drain the daily budget.
  chargeCall(cfg_, budget, state, {
    taskId: meta.taskId,
    usage: res.usage,
    reachedModel: res.spawnedOk !== false,
  });
  saveBudget(cfg_, budget);
  if (lastError && res.ok) res.retriedFrom = lastError;
  // Every round-trip to the brain counts against the round budget, whatever
  // prompted it -- planning, asking, repairing or compacting.
  state.rounds += 1;
  return res;
}

/**
 * Distinguish "the plumbing broke" from "the model said no". Plumb failures are
 * the only ones worth retrying: a timeout, a spawn error, a hard crash with no
 * usable stream, or a non-zero exit that produced no final message.
 */
function isTransportFailure(res) {
  // The driver classifies this: timeout, spawn failure, stdin failure, a hard
  // crash, or an empty answer. Everything else is a real answer worth keeping.
  return res.transportFailed === true;
}

async function cmdRunInit() {
  // Detect artifacts left by an earlier run BEFORE anything writes. Task ids restart at
  // T-001, so a stale `cards/T-001.accepted.json` sits exactly where this run will
  // write, and this run's rolling summary would adopt the old verdict as its own
  // history. Warnings only: whether to archive, delete or reuse is the operator's call.
  const collisions = staleArtifacts(cfg);
  if (collisions.count > 0) {
    process.stderr.write(
      `bridge: warning: ${collisions.count} artifact(s) in state/ do not belong to `
      + `run ${collisions.currentRunId ?? '(none)'}:\n`
      + collisions.stale.slice(0, 8).map((s) => `  ${s.file}  (runId=${s.runId ?? 'unreadable'})\n`).join('')
      + (collisions.count > 8 ? `  ... and ${collisions.count - 8} more\n` : '')
      + 'Their task ids collide with this run\'s. Archive or remove them first:\n'
      + '  node bridge.mjs archive-state --label "before-<why>"\n',
    );
  }

  const code = await withLock(cfg, async () => {
    const state = loadState(cfg);
    const budget = loadBudget(cfg);
    const runId = state.runId ?? newRunId();

    const seedPath = join(cfg.__root, 'seeds', 'PROJECT.md');
    const planSeedPath = join(cfg.__root, 'seeds', 'run-plan.seed.json');
    const project = existsSync(seedPath) ? await import('node:fs').then((fs) => fs.readFileSync(seedPath, 'utf8')) : '';
    const planSeed = readJson(planSeedPath, null);

    state.runId = runId;
    state.status = 'planning';
    state.currentTaskId = null;
    // A fresh run must not inherit the previous run's Codex thread; resuming a
    // thread whose context belongs to other tasks is how a brain gets confused.
    state.threadId = null;
    state.threadStartedAt = null;
    state.statelessMode = false;
    state.revised = {};
    state.callsByTask = {};
    state.repairAttempts = 0;
    state.rounds = 0;
    state.stopReason = null;
    // A new run gets a NEW wall-clock start. Without this, `run init` inherits the
    // previous run's createdAt and a long-lived project immediately trips
    // maxRunDurationMs -- every re-init after that inherits the same stale start,
    // so the deadline fires forever and the loop can never actually run.
    state.createdAt = new Date().toISOString();
    // A fresh run is not exhausted/stopped just because the previous one ended that way.
    if (state.status === 'exhausted' || state.status === 'stopped') state.status = 'planning';
    saveState(cfg, state);

    // A new run invalidates every recorded answer: the queue is rebuilt, so a
    // task id reused by the new plan must not be served a verdict from the old
    // one. Cleared unconditionally, before anything can be replayed.
    wipeCalls(cfg);

    let plan;
    let planSource;
    if (planSeed && Array.isArray(planSeed.tasks) && planSeed.tasks.length) {
      plan = planSeed;
      planSource = 'seeds/run-plan.seed.json';
      appendLedger(cfg, { kind: 'plan', source: 'seed', taskCount: plan.tasks.length });
    } else {
      const prompt = buildPlanPrompt({ project, cfg, state });
      const res = await guardedCall(cfg, state, budget, {
        taskId: null, tag: 'plan', schemaPath: schemaPath('plan'),
      }, prompt);
      saveState(cfg, state);

      if (!res.ok) {
        state.status = 'stopped';
        state.stopReason = `PLAN_CALL_FAILED: ${res.transportError ?? res.reason ?? 'unknown'}`;
        saveState(cfg, state);
        appendLedger(cfg, { kind: 'plan', ok: false, error: state.stopReason });
        const ledger = writeHandoff(cfg, `plan-failed-${runId}`,
          `# Plan call failed\n\n${state.stopReason}\n\nstream: ${res.streamPath}\n`);
        fail('INFRA', { reason: state.stopReason, streamPath: res.streamPath, handoff: ledger });
      }

      try {
        plan = JSON.parse(res.lastMessage);
      } catch (err) {
        state.status = 'stopped';
        state.stopReason = `PLAN_PARSE_FAILED: ${err.message}`;
        saveState(cfg, state);
        fail('PROTOCOL', { reason: state.stopReason, streamPath: res.streamPath });
      }
      if (!plan || typeof plan !== 'object' || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
        state.status = 'stopped';
        state.stopReason = 'PLAN_SHAPE_INVALID: the brain returned no usable task array';
        saveState(cfg, state);
        const h = writeHandoff(cfg, `plan-invalid-${runId}`,
          `# Codex returned an unusable plan\n\n${state.stopReason}\n\nRaw reply:\n\n\`\`\`\n${res.lastMessage}\n\`\`\`\n`);
        appendLedger(cfg, { kind: 'plan', ok: false, error: state.stopReason, usage: res.usage });
        fail('PROTOCOL', { reason: state.stopReason, handoff: h, streamPath: res.streamPath });
      }
      appendLedger(cfg, { kind: 'plan', source: 'codex', taskCount: plan.tasks.length, usage: res.usage });
    }

    writeJsonAtomic(paths(cfg).runPlan, plan);
    const tasks = plan.tasks.map((t, i) => ({
      ...t,
      order: i + 1,
      state: 'pending',
      attempts: 0,
      runId: state.runId,
    }));
    for (const t of tasks) writeTask(cfg, t);

    state.status = 'running';
    const first = tasks[0];
    state.currentTaskId = first.taskId;
    saveState(cfg, state);
    writeJsonAtomic(paths(cfg).budget, budget);

    // Prepare the executor-facing brief for every queued task up front, so the
    // executor never has to ask anyone how to report its result.
    const rel = relPaths(cfg);
    for (const t of tasks) writeTaskBrief(cfg, t);

    out({
      ok: true,
      runId: state.runId,
      goal: plan.goal,
      planSource: planSource ?? 'codex',
      taskCount: tasks.length,
      queue: tasks.map((t) => ({ taskId: t.taskId, title: t.title })),
      budget: budgetView(cfg, budget, state),
      next: {
        taskId: first.taskId,
        title: first.title,
        briefFile: rel.briefFor(first.taskId),
        promptFile: rel.queueFor(first.taskId),
        cardFile: rel.cardFor(first.taskId),
        askCommand: `node ${rel.bridge} ask --card ${rel.cardFor(first.taskId)}`,
        launchCommand: launchCommand(first.taskId),
      },
    });
    return EXIT.OK;
  }).catch(handleThrown);
  return typeof code === 'number' ? code : EXIT.OK;
}

function launchCommand(taskId) {
  const p = join(cfg.__root, 'seeds', `task-${taskId}.txt`);
  return `dsh --profile headless "Read ${p} and execute it. Follow the codex-executor skill exactly."`;
}

/**
 * The submitted card's bytes, for the idempotency key.
 *
 * Read here rather than threaded out of the validator: a card file is tiny, and
 * stdin cannot be read twice so the validator has to own that case anyway.
 */
function rawCardText(cardFile) {
  if (!cardFile || cardFile === '-') return `<stdin:${Date.now()}>`;
  try { return readFileSync(cardFile, 'utf8'); } catch { return `<unreadable:${cardFile}>`; }
}

async function cmdAsk() {
  if (!flags.card) fail('PROTOCOL', { hint: 'ask requires --card <path>. The executor writes the card first.' });

  // An optional short message from the executor for things that do not belong in
  // a 200-character summary: a changed plan, an ambiguity, a question.
  const note = flags.note ? String(flags.note).trim() : null;
  const noteLimit = 1000;
  if (note && note.length > noteLimit) {
    fail('CARD_INVALID', {
      message: `--note is ${note.length} chars, limit ${noteLimit}`,
      hint: 'A note is one short message, not a report. Put findings in the card.',
      codexCalled: false,
    });
  }
  const unattended = flags.unattended === true || cfg.unattended.enabledByDefault === true;
  // Set inside the locked section, consumed after it is released: the unattended
  // driver must not spawn anything while holding the lock.
  let nextForDriver = null;

  const code = await withLock(cfg, async () => {
    const state = loadState(cfg);
    const budget = loadBudget(cfg);

    // ---- lifetime deadline -------------------------------------------------
    //
    // Measured against ACTIVE time, not against `createdAt`.
    //
    // A pure wall clock conflates "this run has been working for six hours" with "this
    // run sat idle for five and a half because an executor crashed and nobody was at the
    // keyboard". The second one killed a live run: `alive 398min` after a 5.5h gap, even
    // though the run had done a couple of rounds of work. Idle time is not a budget.
    //
    // `lastActiveAt` is refreshed on every round-trip and every executor run, so the
    // ceiling now means "six hours of actual work". A genuinely stuck loop still trips it.
    const deadline = cfg.timeouts.maxRunDurationMs;
    if (deadline > 0) {
      const anchor = state.lastActiveAt ?? state.createdAt;
      if (anchor) {
        const elapsed = Date.now() - Date.parse(anchor);
        if (elapsed > deadline) {
          return budgetStop(new BudgetExceeded('MAX_DURATION',
            `run has been active ${Math.round((state.activeMs ?? 0) / 60000)}min `
            + `(idle ${Math.round((elapsed - (state.activeMs ?? 0)) / 60000)}min excluded), `
            + `maxRunDurationMs=${deadline}`));
        }
      }
    }

    // ---- card validation: no tokens are spent when this throws
    let card;
    try {
      card = validateCard(flags.card, cfg);
    } catch (err) {
      if (err instanceof CardError) {
        appendLedger(cfg, { kind: 'card_rejected', code: err.code, message: err.message, card: flags.card });
        fail(err.code === 'CARD_TOO_LARGE' ? 'CARD_TOO_LARGE'
          : err.code === 'CARD_HAS_RAW_LOG' ? 'CARD_HAS_RAW_LOG'
            : err.code === 'CARD_MISSING' ? 'CARD_MISSING' : 'CARD_INVALID',
        { message: err.message, hint: err.hint, codexCalled: false });
      }
      throw err;
    }

    const task = listQueue(cfg).find((t) => t.taskId === card.taskId) ?? null;
    const attempt = state.revised?.[card.taskId] ?? 0;
    // The card's bytes are part of the identity: a changed card is a new question.
    const cardHash = cardFingerprint(rawCardText(flags.card));
    const key = callKey(cfg, { taskId: card.taskId, attempt, kind: 'ask', cardHash });
    // Set by the resume block below when this invocation is answering a stop.
    let wasStopped = false;

    // ---- a human answering a stopped run -----------------------------------
    //
    // Runs BEFORE the replay cache, deliberately. A stopped run must refuse, or resume,
    // on the strength of the note alone -- if the cache answered first, re-submitting an
    // identical card would replay the archived `stop` and report exit 30 for a run that
    // is in fact still stopped and still waiting for a person.
    //
    // `stop` means the brain asked for a human, and the handoff file it writes says the
    // answer is given back with `ask --note`. That path used to be unreachable: this
    // check ran unconditionally, so the documented recovery step returned exit 5 and the
    // only way out was `run init` -- a full re-plan, new task ids, a new thread, and the
    // loss of the round the human was answering. Three restarts were the observed cost.
    //
    // The stickiness that IS wanted is against an unattended loop restarting itself, not
    // against a person answering a question. So: a note from a human resumes, silence
    // does not, and either way it is recorded.
    if (state.status === 'stopped') {
      wasStopped = true;
      if (!note) {
        fail('PROTOCOL', {
          hint: `run is stopped (${state.stopReason}). Answer the question with `
            + '`ask --card <card> --note "<your answer>"`, or start over with `run init`.',
        });
      }

      const stopTask = state.stoppedForTaskId ?? null;
      if (stopTask && card.taskId !== stopTask) {
        fail('PROTOCOL', {
          hint: `run is stopped waiting on a human for ${stopTask}, but this card is for `
            + `${card.taskId}. Answer for ${stopTask}, or run \`run init\` to start over.`,
        });
      }

      const resumes = (state.humanResumes ?? 0) + 1;
      if (resumes > cfg.maxHumanResumes) {
        fail('PROTOCOL', {
          hint: `this run has already been resumed ${state.humanResumes} times `
            + `(maxHumanResumes=${cfg.maxHumanResumes}). Something is not converging -- `
            + 'fix the cause and run `run init`.',
        });
      }

      appendLedger(cfg, {
        kind: 'resumed_by_human',
        taskId: card.taskId,
        attempt,
        resumeNumber: resumes,
        note: note.slice(0, 500),
        stopReason: state.stopReason,
      });
      state.humanResumes = resumes;
      state.status = 'running';
      state.stopReason = null;
      state.stoppedForTaskId = null;
      saveState(cfg, state);
    }

    // ---- idempotency + crash replay: an already-answered call returns its verdict
    //
    // Skipped when a human just answered a stop in this same invocation. The stop
    // verdict is cached under the same key (same task, same attempt -- a `stop` does not
    // consume a revise attempt), so replaying it would hand back the very `stop` the note
    // was answering.
    //
    // The test is `wasStopped`, captured before the resume block cleared the status: a
    // per-run flag would be wrong here, since a run may be resumed more than once and a
    // counter cannot tell "just resumed" from "resumed earlier in this run".
    const prior = wasStopped ? null : loadCall(cfg, key);
    if (prior?.verdict) {
      appendLedger(cfg, {
        kind: 'ask_replayed', taskId: card.taskId, attempt, cardHash,
        reason: 'identical card already answered',
      });
      emitVerdict(prior.verdict, { state, replayed: true, taskId: card.taskId, attempt, quiet: suppressVerdict });
      // A replay must feed the unattended driver too. Returning without this made
      // the driver silently skip its round, so a chain stopped on its second task.
      nextForDriver = continuationFor(cfg, state, prior.verdict);
      return verdictToExit(prior.verdict.action);
    }
    if (prior && !prior.verdict) {
      appendLedger(cfg, { kind: 'ask_replay_after_crash', taskId: card.taskId, attempt, cardHash });
    }

    // Auto-compact: an unattended loop must not grow its thread context without
    // bound. Done here, inside the existing lock and before the call, so the
    // rollover cannot race with the verdict this same invocation is about to get.
    //
    // Thresholds are consulted BEFORE the gates on purpose: rolling over keeps the
    // next round affordable, so it should win even when the budget is nearly spent.
    // The headroom check stops it from eating the last call's worth of budget.
    const rolloverDue = cfg.compact.auto && !state.statelessMode
      && (state.threadTokens ?? 0) > cfg.compact.maxThreadTokens;
    if (rolloverDue) {
      const spent = budget.requests;
      const affordable = spent + 2 <= cfg.budgets.maxRequestsPerDay
        && budget.tokens < cfg.budgets.maxTokensPerDay * 0.9
        && state.rounds + 2 <= cfg.budgets.maxRounds
        && state.turns + 2 <= cfg.budgets.maxTurnsTotal;
      if (affordable) {
        const rolled = await rolloverThread(cfg);
        if (rolled) {
          appendLedger(cfg, {
            kind: 'auto_compact', from: rolled.from, to: rolled.to,
            threshold: cfg.compact.maxThreadTokens,
          });
          // rolloverThread saved its own snapshot; adopt the fields it changed so
          // this invocation's call goes to the NEW thread.
          state.threadId = rolled.to;
          state.threadTokens = 0;
        }
      } else {
        appendLedger(cfg, {
          kind: 'auto_compact_skipped', reason: 'no headroom left for a rollover',
          threadTokens: state.threadTokens ?? 0,
        });
      }
    }

    if (task) {
      task.state = 'in_progress';
      task.attempts = (task.attempts ?? 0) + 1;
      writeTask(cfg, task);
    }

    const prompt = buildAskPrompt({
      cfg, state, card, task, note, unattended, queue: listQueue(cfg),
    });
    // Recorded BEFORE the call so a crash mid-flight still leaves the exact prompt
    // that was sent. The verdict is merged into this same record afterwards.
    saveCall(cfg, key, {
      key, taskId: card.taskId, attempt, prompt,
      cardPath: card.__path, sentAt: new Date().toISOString(),
    });

    let res;
    try {
      res = await guardedCall(cfg, state, budget, {
        taskId: card.taskId, tag: 'ask', schemaPath: schemaPath('verdict'),
      }, prompt);
    } catch (err) {
      if (err instanceof BudgetExceeded) return budgetStop(err);
      return handleThrown(err);
    }

    if (!res.ok) {
      const infra = res.transportFailed === true;
      state.status = infra ? 'running' : state.status;
      saveState(cfg, state);
      if (task) { task.state = 'submitted'; writeTask(cfg, task); }
      appendLedger(cfg, { kind: 'ask_failed', taskId: card.taskId, infra, error: res.transportError ?? res.reason });
      if (!infra) {
        state.status = 'stopped';
        state.stopReason = `ASK_FAILED: ${res.reason ?? 'unknown'}`;
        saveState(cfg, state);
      }
      fail('INFRA', {
        taskId: card.taskId, infra, retryable: infra,
        reason: res.transportError ?? res.reason ?? 'codex call failed',
        streamPath: res.streamPath,
      });
    }

    // ---- verdict normalization: a bad shape gets a bounded repair round
    let verdict;
    try {
      verdict = normalizeVerdict(JSON.parse(res.lastMessage), cfg);
      enforceVerdict(verdict, state, cfg, card.taskId);
    } catch (err) {
      const repaired = await repairVerdict(err, res, card.taskId);
      if (!repaired) {
        state.status = 'stopped';
        state.stopReason = `VERDICT_INVALID: ${err.message}`;
        saveState(cfg, state);
        const h = writeHandoff(cfg, `verdict-invalid-${card.taskId}`,
          `# Codex returned an unusable verdict\n\nTask: ${card.taskId}\nError: ${err.message}\n\nRaw:\n\n\`\`\`\n${res.lastMessage}\n\`\`\`\n`);
        appendLedger(cfg, { kind: 'verdict_invalid', taskId: card.taskId, error: err.message });
        fail('PROTOCOL', { taskId: card.taskId, reason: err.message, handoff: h });
      }
      verdict = repaired;
    }

    applyVerdictState(cfg, state, budget, card, task, verdict, res);
    // Merged, not replaced: the archived prompt from before the call must survive.
    saveCall(cfg, key, {
      ...(loadCall(cfg, key) ?? { key, taskId: card.taskId, attempt }),
      verdict,
      usage: res.usage,
      answeredAt: new Date().toISOString(),
    });
    emitVerdict(verdict, { state, taskId: card.taskId, attempt, usage: res.usage, quiet: suppressVerdict });
    // Stashed for the unattended driver, which runs AFTER the lock is released.
    nextForDriver = continuationFor(cfg, state, verdict);
    return verdictToExit(verdict.action);
  }).catch(handleThrown);

  const finalCode = typeof code === 'number' ? code : EXIT.PROTOCOL;

  // The unattended driver runs ONLY in the outermost process. A nested round must
  // simply answer "here is the verdict and where to go next" -- if it also drove, the
  // chain would recurse and each task would be executed twice.
  if (flags.executor && nextForDriver && !isNestedRound) {
    return await driveUnattended(nextForDriver, finalCode, { note, unattended });
  }
  return finalCode;
}

/**
 * Chain executor -> ask -> executor until the brain stops asking for more.
 *
 * Guards that keep this from becoming an uncontrolled loop:
 *   - the wall-clock deadline and every budget gate still apply to each round,
 *     because each round goes through a fresh `ask` process
 *   - a depth cap so a misunderstanding cannot recurse without bound
 *   - everything is logged, so a stuck chain leaves a readable trace
 */
async function driveUnattended(firstNext, code, { note, unattended }) {
  const maxExecutorRuns = cfg.maxExecutorRuns;
  let current = firstNext;
  let lastCode = code;
  let depth = 0;

  while (current && depth < maxExecutorRuns) {
    depth += 1;
    // The next task needs an executor run before it can be reported. When a card is
    // already present the work was done by the executor that called us, so the chain
    // only needs to ask -- but then the caller should not have passed --executor at
    // all, and re-running is the safe reading.
    const cardAbsent = !existsSync(join(cfg.__root, current.cardFile));
    if (cardAbsent) {
      const cmd = flags.executor.replace(/\{taskId\}/g, current.taskId)
        .replace(/\{brief\}/g, current.briefFile)
        .replace(/\{card\}/g, current.cardFile)
        .replace(/\{root\}/g, cfg.__root);

      appendLedger(cfg, { kind: 'executor_launch', taskId: current.taskId, depth, command: cmd });
      process.stderr.write(`[bridge] executor run ${depth}/${maxExecutorRuns} for ${current.taskId}\n`);

      const executorStartedAt = Date.now();
      const child = spawnSync(cmd, {
        cwd: cfg.__root,
        // stdout captured so the executor's chatter cannot corrupt this command's
        // single-JSON stdout; stderr inherited so progress stays visible live.
        stdio: ['ignore', 'pipe', 'inherit'],
        shell: true,
        env: process.env,
        encoding: 'utf8',
      });
      if (child.stdout) process.stderr.write(child.stdout);
      // The executor was working, not the loop idling -- refresh the lifetime anchor
      // and bank the time. This is the exact spot where a 5.5h crash used to consume
      // the run's whole maxRunDurationMs budget.
      const freshState = loadState(cfg);
      markActive(freshState, Date.now() - executorStartedAt);
      saveState(cfg, freshState);

      appendLedger(cfg, { kind: 'executor_exit', taskId: current.taskId, depth, status: child.status, error: child.error?.message ?? null });

      if (child.error || child.status !== 0) {
        const why = child.error ? child.error.message : `executor exited with code ${child.status}`;
        const handoff = writeHandoff(cfg, `executor-failed-${current.taskId}`, [
          '# The unattended executor failed',
          '',
          `- Task: ${current.taskId}`,
          `- Depth: ${depth}`,
          `- Command: \`${cmd}\``,
          `- Failure: ${why}`,
          '',
          'The loop stopped rather than retrying blindly. Inspect the task brief, then resume with:',
          '',
          `\`node bridge.mjs ask --card ${current.cardFile} --unattended --executor "<your executor command>"\``,
          '',
        ].join('\n'));
        appendLedger(cfg, { kind: 'unattended_stop', reason: why, taskId: current.taskId, handoff });
        out({
          ok: false, code: 'EXECUTOR_FAILED', taskId: current.taskId, depth, reason: why, handoff,
          unattendedStopped: true,
        });
        return EXIT.INFRA;
      }

      if (!existsSync(join(cfg.__root, current.cardFile))) {
        const handoff = writeHandoff(cfg, `executor-no-card-${current.taskId}`, [
          '# The unattended executor produced no result card',
          '',
          `- Task: ${current.taskId}`,
          `- Expected card: \`${current.cardFile}\``,
          `- Command: \`${cmd}\` exited 0`,
          '',
          'Without a card there is nothing to report to the brain, so the loop stopped.',
          '',
        ].join('\n'));
        appendLedger(cfg, { kind: 'unattended_stop', reason: 'executor produced no card', taskId: current.taskId, handoff });
        out({ ok: false, code: 'NO_CARD', taskId: current.taskId, depth, handoff, unattendedStopped: true });
        return EXIT.INFRA;
      }
    }

    const nextArgs = ['--project-root', cfg.__root, '--config', cfg.__configPath,
      'ask', '--card', current.cardFile, '--executor', flags.executor];
    if (unattended) nextArgs.push('--unattended');
    if (note) nextArgs.push('--note', note);

    const round = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...nextArgs], {
      // stdout captured, not inherited: every round prints its own verdict, and the
      // caller of the outer command must receive exactly ONE JSON document. stderr
      // is inherited so progress stays visible while the chain runs.
      cwd: cfg.__root,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: { ...process.env, DSH_BRIDGE_CHAIN: '1' },
    });
    appendLedger(cfg, {
      kind: 'chain_child_raw', depth, taskId: current.taskId,
      status: round.status, error: round.error?.message ?? null,
      len: (round.stdout ?? '').length, head: (round.stdout ?? '').slice(0, 120),
      tail: (round.stdout ?? '').slice(-120),
    });
    lastCode = round.status;
    if (round.stderr) process.stderr.write(round.stderr);
    appendLedger(cfg, {
      kind: 'chain_round', depth, taskId: current.taskId, status: round.status,
      stdoutLen: (round.stdout ?? '').length, stdoutHead: (round.stdout ?? '').slice(0, 200),
    });

    // Recover where to go next from the round's own JSON output.
    let parsed = null;
    try {
      parsed = JSON.parse((round.stdout ?? '').trim());
    } catch { /* fall through to the stop below */ }

    // A round that failed must stop the chain, not be mistaken for "no more work".
    //
    // NOTE: a chained round's exit code is the VERDICT, not a success flag. 0, 10,
    // 20 and 30 are all valid answers (pass / rework / next / stop); only the
    // payload's `ok` says whether the round actually worked.
    if (!parsed || parsed.ok !== true) {
      const why = parsed?.reason ?? parsed?.message ?? `chained round produced unreadable output (exit ${round.status})`;
      const handoff = writeHandoff(cfg, `chain-failed-${current.taskId}`, [
        '# A chained round failed',
        '',
        `- Task: ${current.taskId}`,
        `- Depth: ${depth}`,
        `- Round exit: ${round.status}`,
        `- Reported: ${why}`,
        `- Code: ${parsed?.code ?? '(unparsed output)'}`,
        '',
        'stdout from the failed round:',
        '',
        '```',
        (round.stdout ?? '').slice(0, 2000),
        '```',
        '',
      ].join('\n'));
      appendLedger(cfg, { kind: 'unattended_stop', reason: why, taskId: current.taskId, status: round.status, handoff });
      out({ ok: false, code: 'CHAIN_FAILED', taskId: current.taskId, depth, reason: why, handoff, unattendedStopped: true });
      return round.status || EXIT.PROTOCOL;
    }

    current = parsed.continue ?? null;
    if (!current) {
      appendLedger(cfg, {
        kind: 'unattended_done', action: parsed.action, depth, reason: parsed.reason,
        rounds: depth, lastCode, emittedLen: (round.stdout ?? '').length, nested: isNestedRound,
      });
      // Re-emit the final round's verdict: the caller gets one clean document.
      process.stdout.write(round.stdout);
      return lastCode;
    }
  }

  if (depth >= maxExecutorRuns) {
    const handoff = writeHandoff(cfg, 'unattended-depth-cap', [
      '# Unattended loop hit its executor-run cap',
      '',
      `- Cap: ${maxExecutorRuns} (config \`maxExecutorRuns\`)`,
      `- Last task: ${current?.taskId ?? '(none)'}`,
      '',
      'Raise `maxExecutorRuns` if the project legitimately needs more rounds in one command.',
      '',
    ].join('\n'));
    appendLedger(cfg, { kind: 'unattended_stop', reason: 'executor run cap reached', depth, handoff });
    out({ ok: false, code: 'DEPTH_CAP', depth, cap: maxExecutorRuns, handoff, unattendedStopped: true });
    return EXIT.ROUNDS;
  }
  return lastCode;
}

/**
 * Push one verdict into the watched Codex conversation.
 *
 * Failures are logged and swallowed: the verdict is already durable in the ledger
 * and the call store, and a mirror is a convenience, not part of the contract.
 */
/**
 * The single next step the executor should take, ready to follow without judgement.
 *
 * `thenRun` is always a command that can be pasted verbatim, including the re-ask
 * after a rework -- the attempt bookkeeping is the bridge's business, so the
 * executor should never reconstruct that command itself.
 */
function instructionFor(cfg_, state, verdict, continuation, meta) {
  const rel = relPaths(cfg_);
  const cardRel = rel.cardFor(meta.taskId);
  const askCmdFor = (card) => `node ${rel.bridge} ask --card ${card}`;

  if (verdict.action === 'rework') {
    return {
      do: 'rework',
      because: verdict.reason,
      what: verdict.reworkInstructions ?? verdict.feedbackForExecutor,
      rewriteCardAt: cardRel,
      thenRun: askCmdFor(cardRel),
      note: 'The bridge tracks the retry count. Resubmit the SAME card path; a changed card is judged afresh.',
    };
  }

  if (verdict.action === 'next' && continuation) {
    return {
      do: 'execute',
      because: verdict.reason,
      taskId: continuation.taskId,
      readFirst: continuation.briefFile,
      authoritative: rel.queueFor(continuation.taskId),
      thenRun: continuation.askCommand,
      launch: continuation.launchCommand,
      note: 'The brief is the task; the queue file is the authority.',
    };
  }

  if (verdict.action === 'pass' && continuation) {
    return {
      do: 'execute',
      because: verdict.reason,
      taskId: continuation.taskId,
      readFirst: continuation.briefFile,
      authoritative: rel.queueFor(continuation.taskId),
      thenRun: continuation.askCommand,
      launch: continuation.launchCommand,
      note: 'This task was accepted; the queue still has work.',
    };
  }

  if (verdict.action === 'stop') {
    return {
      do: 'stop',
      because: verdict.reason,
      what: verdict.feedbackForExecutor !== 'none' ? verdict.feedbackForExecutor : null,
      thenRun: null,
      note: 'The brain asked for a human. See state/handoff/.',
    };
  }

  return {
    do: 'stop',
    because: verdict.reason,
    thenRun: null,
    note: verdict.action === 'pass'
      ? 'Accepted and nothing is queued. The project may be finished.'
      : 'Nothing further to run.',
  };
}

/**
 * Push one verdict into the watched Codex conversation.
 *
 * Failures are logged and swallowed: the verdict is already durable in the ledger
 * and the call store, and a mirror is a convenience, not part of the contract.
 */
function mirrorVerdict(cfg_, { verdict, taskId, state, usage, payload }) {
  const text = renderVerdictReport({
    verdict, taskId, state, usage, continuation: payload.continue,
  });
  const res = pushToChat(cfg_, text, { thread: flags.mirrorThread });
  appendLedger(cfg_, {
    kind: res.ok ? 'mirror_pushed' : 'mirror_failed',
    taskId, chatThread: flags.mirrorThread ?? cfg_.queueMirror.thread,
    messageId: res.messageId ?? null, reason: res.reason ?? null,
  });
  if (!res.ok) {
    process.stderr.write(`[bridge] mirror to chat thread failed: ${res.reason}\n`);
  }
}

function enforceVerdict(verdict, state, cfg_, taskId) {
  if (verdict.action === 'rework') {
    const used = state.revised?.[taskId] ?? 0;
    if (used >= cfg_.budgets.maxReviseAttempts) {
      const e = new VerdictError('Rework budget exhausted: the brain must pass, move on, or stop.', 'MAX_REVISE');
      e.corrective = `Action "rework" was refused because the rework budget for ${taskId} is exhausted (${used}/${cfg_.budgets.maxReviseAttempts}). Choose "pass" if the work is actually acceptable, "next" if a later task supersedes it, or "stop" if the work cannot continue.`;
      throw e;
    }
  }
  if (verdict.action === 'next' && !verdict.nextTask) {
    const e = new VerdictError('action=next requires a nextTask object.', 'NEXT_WITHOUT_TASK');
    e.corrective = 'Provide nextTask with taskId, title, prompt and verification, or choose "stop" when the queue is empty.';
    throw e;
  }
}

/**
 * One bounded repair round: hand the validation error back to the brain.
 *
 * The repaired answer is re-checked against `enforceVerdict`. Without that, a
 * brain that keeps answering "rework" would have its own refusal undone by the
 * repair path and the attempt ceiling would never actually hold.
 */
async function repairVerdict(err, priorRes, taskId) {
  const state = loadState(cfg);
  if ((state.repairAttempts ?? 0) >= cfg.budgets.maxRepairAttempts) return null;
  state.repairAttempts = (state.repairAttempts ?? 0) + 1;
  saveState(cfg, state);

  const corrective = err.corrective
    ?? `Your previous reply did not satisfy the schema: ${err.message}`;
  const prompt = [
    'Your previous reply could not be accepted by the bridge. Reply again with ONLY the corrected JSON object.',
    '',
    `Validation error: ${err.message}`,
    `Correction required: ${corrective}`,
    '',
    'Previous reply:',
    (priorRes.lastMessage ?? '').slice(0, 4000),
  ].join('\n');

  const budget = loadBudget(cfg);
  const res = await guardedCall(cfg, state, budget, { taskId: null, tag: 'repair', schemaPath: schemaPath('verdict') }, prompt);
  saveState(cfg, state);
  if (!res.ok) return null;
  try {
    const v = normalizeVerdict(JSON.parse(res.lastMessage), cfg);
    const check = loadState(cfg);
    enforceVerdict(v, check, cfg, taskId);
    return v;
  } catch {
    return null;
  }
}

function applyVerdictState(cfg_, state, budget, card, task, verdict, res) {
  const taskId = card.taskId;
  state.lastVerdict = { at: new Date().toISOString(), taskId, action: verdict.action, reason: verdict.reason };

  if (task) {
    if (verdict.action === 'pass' || verdict.action === 'next' || verdict.action === 'stop') {
      task.state = 'accepted';
      task.acceptedAt = new Date().toISOString();
    } else if (verdict.action === 'rework') {
      task.state = 'pending';
      state.revised[taskId] = (state.revised?.[taskId] ?? 0) + 1;
    }
    writeTask(cfg_, task);
  }

  if (verdict.nextTask) {
    const order = (listQueue(cfg_).reduce((m, t) => Math.max(m, t.order ?? 0), 0)) + 1;
    const created = { ...verdict.nextTask, order, state: 'pending', attempts: 0, runId: state.runId };
    writeTask(cfg_, created);
    writeTaskBrief(cfg_, created);
  }
  for (const extra of verdict.additionalTasks ?? []) {
    if (!listQueue(cfg_).some((t) => t.taskId === extra.taskId)) {
      const order = (listQueue(cfg_).reduce((m, t) => Math.max(m, t.order ?? 0), 0)) + 1;
      const created = { ...extra, order, state: 'pending', attempts: 0, runId: state.runId };
      writeTask(cfg_, created);
      writeTaskBrief(cfg_, created);
    }
  }

  if (verdict.action === 'stop') {
    state.status = 'stopped';
    state.stopReason = verdict.reason;
    // Remember WHICH task the question is about. Resuming with a note must answer that
    // task, not silently redirect the run onto whatever card arrives next.
    state.stoppedForTaskId = taskId;
    // `stop` is the brain's way of asking for a human. Park an explicit request so
    // an unattended operator can see why the loop halted, instead of finding it
    // silently frozen.
    const h = writeHandoff(cfg_, `needs-human-${taskId}`, [
      `# The brain asked for a human`,
      '',
      `- Task: ${taskId}`,
      `- Round: ${state.rounds}`,
      `- Reason: ${verdict.reason}`,
      verdict.feedbackForExecutor && verdict.feedbackForExecutor !== 'none'
        ? `- What it needs: ${verdict.feedbackForExecutor}` : '',
      '',
      `## Last accepted card`,
      '```json',
      JSON.stringify({ taskId, status: card.status, summaryOneLine: card.summaryOneLine, blockers: card.blockers }, null, 2),
      '```',
      '',
      '## Resume',
      '',
      'Answer the question above, then either:',
      '',
      '- `node bridge.mjs ask --card <card> --note "<your answer>"` to hand the answer back, or',
      '- `node bridge.mjs run init` to start a fresh run under the new information.',
      '',
    ].filter(Boolean).join('\n'));
    appendLedger(cfg_, { kind: 'needs_human', taskId, reason: verdict.reason, handoff: h });
  } else if (verdict.action === 'next') {
    const nxt = nextPendingTask(cfg_);
    state.currentTaskId = nxt?.taskId ?? verdict.nextTask?.taskId ?? null;
    if (!nxt && !verdict.nextTask) {
      // The brain said "continue" but supplied nothing to continue with. That is a
      // protocol violation, not a reason for the transport layer to invent work.
      state.status = 'stopped';
      state.stopReason = 'next without a queued or supplied task';
    }
  } else if (verdict.action === 'pass') {
    const nxt = nextPendingTask(cfg_);
    state.currentTaskId = nxt?.taskId ?? null;
    // Deliberately NOT stopping when the queue runs dry. An empty queue is a fact
    // about the queue, not a decision about the project -- and deciding it here
    // would be the bridge playing orchestrator. `pass` already means "stop this
    // iteration"; whether more work exists is the brain's call, made on the next
    // card (or never, because pass really did finish the project).
    if (!nxt) {
      state.status = 'idle';
      state.stopReason = null;
    }
  }

  appendLedger(cfg_, {
    kind: 'verdict', taskId, action: verdict.action, reason: verdict.reason,
    usage: res.usage, cardBytes: card.__bytes, summaryChars: card.summaryOneLine.length,
  });

  // Report the ceilings that applied to THIS decision. The next call's gate is
  // what actually enforces them (`assertCanCall`), so a limit reached here still
  // returns the verdict the executor is waiting for, then refuses the next ask.
  const ceilings = [];
  if (state.rounds >= cfg_.budgets.maxRounds) ceilings.push(`maxRounds=${cfg_.budgets.maxRounds}`);
  if (state.turns >= cfg_.budgets.maxTurnsTotal) ceilings.push(`maxTurnsTotal=${cfg_.budgets.maxTurnsTotal}`);
  if (budget.requests >= cfg_.budgets.maxRequestsPerDay) ceilings.push(`maxRequestsPerDay=${cfg_.budgets.maxRequestsPerDay}`);
  if (budget.tokens >= cfg_.budgets.maxTokensPerDay) ceilings.push(`maxTokensPerDay=${cfg_.budgets.maxTokensPerDay}`);

  if (ceilings.length) {
    state.status = 'exhausted';
    state.stopReason = `budget reached: ${ceilings.join(', ')}`;
  }
  saveState(cfg_, state);

  // Keep a normalized copy for the rolling summary and for audit -- in a SEPARATE
  // file. The executor's own card is its working document and gets rewritten on
  // every rework attempt; overwriting it here would hand the executor back a
  // bridge-mangled version of what it just wrote.
  const cardRecord = {};
  for (const [k, v] of Object.entries(card)) {
    if (!k.startsWith('__')) cardRecord[k] = v;
  }
  writeJsonAtomic(join(paths(cfg_).cards, `${taskId}.accepted.json`), cardRecord);
  refreshRollingSummary(cfg_, state);
}

function emitVerdict(verdict, meta) {
  const state = loadState(cfg);
  const budget = loadBudget(cfg);
  const continuation = continuationFor(cfg, state, verdict);

  const payload = {
    ok: true,
    action: verdict.action,
    reason: verdict.reason,
    feedbackForExecutor: verdict.feedbackForExecutor,
    reworkInstructions: verdict.reworkInstructions ?? null,
    nextTask: verdict.nextTask ?? null,
    // Where to go next, spelled out, so an executor never has to read the state
    // files or ask a human how to continue. `next` means the loop keeps going.
    continue: continuation,
    // ONE authoritative next step. The other fields (exit code, nextTask, queue
    // files, brief files) remain for compatibility and diagnostics, but an executor
    // that follows only this block cannot pick the wrong file or rebuild a command
    // incorrectly -- which is how mis-read verdicts actually happen.
    instruction: instructionFor(cfg, state, verdict, continuation, meta),
    taskId: meta.taskId,
    attempt: meta.attempt,
    replayed: Boolean(meta.replayed),
    usage: meta.usage ?? null,
    exitCode: verdictToExit(verdict.action),
    exitCodeMap: EXIT,
    status: state.status,
    stopReason: state.stopReason,
    budget: budgetView(cfg, budget, state),
  };
  // Mirror into a watched Codex conversation, if one is configured. Only from the
  // outermost call: a nested round would otherwise push the same verdict again.
  if (mirrorEnabled(cfg, flags.mirrorThread) && !isNestedRound) {
    mirrorVerdict(cfg, { verdict, taskId: meta.taskId, state, usage: meta.usage, payload });
  }
  // In an unattended chain the OUTER process re-emits the final round's document,
  // so each nested round is silenced to keep the command's stdout exactly one JSON
  // object. A non-nested call is the command's stdout and must be written here.
  if (!meta.quiet) out(payload);

  return payload;
}

/**
 * The coordinates of the next iteration, or null when there is nothing to run.
 *
 * Pure description: it names the files and the command. The bridge still does not
 * dispatch anything -- the executor (or the caller) decides to follow it.
 *
 * Queue order wins over the brain's newly-named task: the queue holds work the
 * brain already dispatched, and skipping ahead to a freshly-authorized task would
 * silently abandon it.
 */
function continuationFor(cfg_, state, verdict) {
  const rel = relPaths(cfg_);
  const queued = nextPendingTask(cfg_);
  // A `nextTask` is a FRESH assignment whose card does not exist yet, so its
  // absence is expected and must not suppress the continuation.
  const next = queued?.taskId ?? verdict.nextTask?.taskId ?? null;
  if (!next) return null;
  return {
    taskId: next,
    briefFile: rel.briefFor(next),
    cardFile: rel.cardFor(next),
    askCommand: `node ${rel.bridge} ask --card ${rel.cardFor(next)}`,
    launchCommand: launchCommand(next),
    workdir: cfg_.__workdir,
  };
}

function budgetStop(err) {
  const state = loadState(cfg);
  const budget = loadBudget(cfg);
  state.status = 'exhausted';
  state.stopReason = `${err.code}: ${err.message}`;
  saveState(cfg, state);
  appendLedger(cfg, { kind: 'budget_stop', code: err.code, message: err.message, day: budget.day });
  out({ ok: false, code: 'BUDGET', gate: err.code, message: err.message, budget: budgetView(cfg, budget, state) });
  return EXIT.BUDGET;
}

async function cmdCompact() {
  const code = await withLock(cfg, () => rolloverThread(cfg, { announce: true })).catch(handleThrown);
  // An explicit number: an implicit `undefined` here used to reach process.exit,
  // which rejects it at runtime rather than at review time.
  return typeof code === 'number' ? code : EXIT.OK;
}

/**
 * Roll the brain onto a fresh thread, reseeded from the rolling summary.
 *
 * MUST be called while already holding the lock -- it uses `freshThread` on
 * purpose and re-reads state, so calling it without the lock could clobber a
 * concurrent verdict. `cmdCompact` wraps it; `cmdAsk` calls it inline on the auto
 * threshold. Returns null when there was nothing to roll over.
 */
async function rolloverThread(cfg_, { announce = false } = {}) {
  const state = loadState(cfg_);
  const budget = loadBudget(cfg_);
  const before = state.threadId;

  const rolling = renderRollingSummary(cfg_, state);
  const prompt = [
    'ROLLOVER: continue this project in a new thread. Everything you need is below.',
    'You are the brain for an executor agent. Keep the same rules: reply with a single JSON object matching the schema.',
    '',
    '<state>',
    buildStateBlock(cfg_, state),
    '</state>',
    '',
    '<rolling_summary>',
    rolling,
    '</rolling_summary>',
    '',
    'Acknowledge by returning action "pass" with reason "rollover complete", and set nextTask to the next pending task from the queue (or null if the queue is empty).',
  ].join('\n');

  let res;
  try {
    res = await guardedCall(cfg_, state, budget, {
      taskId: null, tag: 'compact', schemaPath: schemaPath('verdict'), freshThread: true,
    }, prompt);
  } catch (err) {
    if (err instanceof BudgetExceeded) {
      // A rollover we cannot afford is not fatal: the loop keeps working on the
      // existing thread and simply pays more context per round.
      appendLedger(cfg_, { kind: 'compact_skipped', code: err.code, message: err.message });
      if (announce) return budgetStop(err);
      return null;
    }
    throw err;
  }
  if (!res.ok) {
    if (announce) fail('INFRA', { reason: res.transportError ?? res.reason, streamPath: res.streamPath });
    appendLedger(cfg_, { kind: 'compact_failed', error: res.transportError ?? res.reason });
    return null;
  }

  state.threadId = res.threadId;
  state.threadTokens = 0;
  saveState(cfg_, state);
  appendLedger(cfg_, { kind: 'compact', from: before, to: state.threadId, usage: res.usage, auto: !announce });
  if (announce) {
    out({ ok: true, compacted: true, from: before, to: state.threadId, usage: res.usage, budget: budgetView(cfg_, budget, state) });
  }
  return { from: before, to: state.threadId, usage: res.usage };
}

function handleThrown(err) {
  // `fail()` already reported; let it unwind to the terminal handler without
  // being re-reported as an internal error.
  if (err instanceof BridgeExit) throw err;
  if (err instanceof BudgetExceeded) return budgetStop(err);
  if (err?.code === 'LOCK_TIMEOUT') { out({ ok: false, code: 'LOCK', message: err.message }); return EXIT.INFRA; }
  if (err?.code === 'CONFIG_ERROR') { out({ ok: false, code: 'CONFIG', message: err.message }); return EXIT.INFRA; }
  out({ ok: false, code: 'INTERNAL', message: err?.stack ?? String(err) });
  return EXIT.PROTOCOL;
}

function printHelp() {
  process.stdout.write(`bridge.mjs -- Codex brain <-> executor agent transport

  node bridge.mjs init [dir]          scaffold a project here or in <dir>:
                                      config + PROJECT.md template + a probed
                                      codex.exePath, and copy the bridge in
  node bridge.mjs upgrade-config [dir] [--dry-run]
                                      add config keys this project is missing
                                      (never overwrites existing values)
  node bridge.mjs archive-state [--label <why>] [--dry-run]
                                      move the current run's state to
                                      work/run-archives/<stamp>-<runId>/ with a README
  node bridge.mjs probe-effort [--tiers a,b,c]
                                      report which reasoning tiers this model accepts
  node bridge.mjs doctor [--live]     probe the Codex CLI (add --live for a real round-trip)
  node bridge.mjs run init            have Codex decompose seeds/PROJECT.md into a task queue
  node bridge.mjs ask --card <file>   submit a result card, block until Codex answers
                        [--note "<msg>"]       a short message the card cannot carry
                        [--unattended]         tell the brain to keep the loop alive
                        [--executor "<cmd>"]   run the next task yourself, then continue
                        [--mirror-thread <id>] push each verdict into a Codex app chat
                        [--no-mirror]          disable a configured mirror for this call
  node bridge.mjs status [--json]     budget, queue and last verdict
  node bridge.mjs compact             roll the Codex thread onto a fresh one
  node bridge.mjs selftest [--keep]   offline run of the whole state machine (stub brain)
  node bridge.mjs reset --yes         delete all run state

Unattended chain (the brain still authors every task; the bridge only walks the loop):
  node bridge.mjs ask --card <file> --unattended \\
       --executor 'dsh --profile headless "Read {brief} and execute it."'
  Placeholders: {taskId} {brief} {card} {root}

Exit codes of \`ask\`: 0 pass | 10 rework | 20 next | 30 stop | 3 budget | 4 rounds | 5 infra | 6 bad card
Day key: ${dayKey()}
`);
}

} // end main()
