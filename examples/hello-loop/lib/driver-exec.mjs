// lib/driver-exec.mjs -- invoke Codex through `codex exec --json`.
//
// Design notes that matter:
//  * The prompt is ALWAYS written to the child's stdin (`... -`). Never build a
//    Windows command line containing the prompt: the JSON schemas contain double
//    quotes and `shell: true` would let cmd.exe mangle them.
//  * The child is spawned with shell:false and an argv array, so there is no
//    quoting layer at all.
//  * Behaviour that matters for the budget is measured from the stream
//    (`turn.completed.usage`), not taken from the model's own estimate.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonl, summarizeEvents, normalizeUsage } from './jsonl.mjs';
import { codexCandidates } from './config.mjs';

/**
 * A usable working directory for probing.
 *
 * `codex.workdir` defaults to `.codex-scratch`, which is gitignored -- so in a fresh
 * clone it does NOT exist. Spawning with a missing cwd fails with ENOENT and
 * `status: null`, which this function previously read as "this executable does not
 * work", so a perfectly good codex.exe was reported as not found. Create it, and fall
 * back to the project root if that is not possible.
 */
function probeWorkdir(cfg) {
  const dir = cfg.__workdir;
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return cfg.__root ?? process.cwd();
  }
}

/** Resolve the Codex CLI executable once per process. */
let cachedExe;
export function resolveCodexExe(cfg, { fresh = false } = {}) {
  if (cachedExe && !fresh) return cachedExe;
  const candidates = codexCandidates(cfg).filter(Boolean);
  const probeCwd = probeWorkdir(cfg);

  // An explicit exePath is a declaration, not a hint. Honor it without probing or
  // second-guessing its existence: the spawn itself reports a bad path as a
  // transport failure, which is the useful diagnostic. Falling through to PATH
  // here would silently run a different Codex than the one configured.
  if (cfg.codex.exePath) {
    const probe = spawnSync(cfg.codex.exePath, [...(cfg.codex.nodeArgs ?? []), '--version'], { encoding: 'utf8', cwd: probeCwd });
    cachedExe = {
      exe: cfg.codex.exePath,
      version: (probe.stdout || '').trim() || 'explicit exePath',
      candidates,
      probed: probe.status === 0,
    };
    return cachedExe;
  }

  for (const cand of candidates) {
    if (cand === 'codex') {
      const probe = spawnSync('codex', ['--version'], { encoding: 'utf8', shell: true, cwd: probeCwd });
      if (probe.status === 0) { cachedExe = { exe: 'codex', version: (probe.stdout || '').trim(), candidates }; return cachedExe; }
      continue;
    }
    if (existsSync(cand)) {
      const probe = spawnSync(cand, ['--version'], { encoding: 'utf8', cwd: probeCwd });
      if (probe.status === 0) {
        cachedExe = { exe: cand, version: (probe.stdout || '').trim(), candidates };
        return cachedExe;
      }
    }
  }
  const e = new Error(
    `CONFIG_ERROR: Codex CLI not found or not executable.\nTried:\n  ${candidates.join('\n  ')}\n` +
    `Fix: set codex.exePath in config/run.config.json or export CODEX_CLI_PATH.`,
  );
  e.code = 'CONFIG_ERROR';
  throw e;
}

/**
 * Build argv for one round-trip.
 *
 * `codex exec resume` accepts a much smaller flag set than a fresh `codex exec`:
 * only --json, -o/--output-last-message, --output-schema, --skip-git-repo-check
 * and --dangerously-bypass-approvals-and-sandbox (verified by probing 0.159.2).
 * It has no -C, so the working root is the child's cwd instead, and it has no -m
 * or -s, so model/sandbox overrides apply only to the first call of a thread.
 */
function buildArgs(cfg, { threadId, schemaPath, lastMessagePath }) {  const args = ['exec'];
  if (threadId) {
    args.push('resume', threadId);
    args.push('--json');
    args.push('--output-last-message', lastMessagePath);
    if (schemaPath) args.push('--output-schema', schemaPath);
    args.push('--skip-git-repo-check');
    args.push('-'); // read the prompt from stdin
    return args;
  }
  args.push('--json');
  args.push('--output-last-message', lastMessagePath);
  if (schemaPath) args.push('--output-schema', schemaPath);
  args.push('--color', 'never');
  args.push('--skip-git-repo-check');
  args.push('-C', cfg.__workdir);
  args.push('--sandbox', cfg.codex.sandbox);
  if (cfg.codex.model) args.push('-m', cfg.codex.model);
  // Reasoning effort has no dedicated flag; it is a config key overridden with -c.
  // Fresh exec only: resume accepts no -c, so a thread keeps the effort it was
  // created with, exactly like --sandbox and -m.
  if (cfg.codex.reasoningEffort) {
    args.push('-c', `model_reasoning_effort="${cfg.codex.reasoningEffort}"`);
  }
  for (const extra of cfg.codex.extraArgs ?? []) args.push(extra);
  args.push('-'); // read the prompt from stdin
  return args;
}

/**
 * One Codex round-trip.
 * @returns {Promise<{ok, transportError, lastMessage, threadId, usage, degraded,
 *                    exitCode, durationMs, stderr, streamPath, reason}>}
 */
export async function invokeCodex(cfg, prompt, { threadId = null, schemaPath = null, runDir, tag = 'call' } = {}) {
  const { exe, version } = resolveCodexExe(cfg);
  if (!existsSync(cfg.__workdir)) mkdirSync(cfg.__workdir, { recursive: true });
  if (runDir) mkdirSync(runDir, { recursive: true });

  const stamp = `${Date.now()}-${tag}`;
  const lastMessagePath = join(runDir ?? cfg.__stateDir, `last-message-${stamp}.json`);
  const streamPath = join(runDir ?? cfg.__stateDir, `codex-stdout-${stamp}.jsonl`);
  const args = buildArgs(cfg, { threadId, schemaPath, lastMessagePath });

  const started = Date.now();
  const result = {
    ok: false,
    transportError: null,
    // False when the child process never came up at all, which is how a denied
    // spawn under a sandbox reports itself. That distinction decides whether the
    // attempt should be charged against the budget (see lib/budget.mjs).
    spawnedOk: false,
    lastMessage: null,
    threadId: threadId ?? null,
    usage: normalizeUsage(null),
    degraded: false,
    exitCode: null,
    durationMs: 0,
    stderr: '',
    streamPath,
    cliVersion: version,
    args: [exe, ...(cfg.codex.nodeArgs ?? []), ...args],
  };
  const child = spawn(exe, [...(cfg.codex.nodeArgs ?? []), ...args], {
    // A resume call has no -C, so the child's cwd IS the working root. Always
    // spawn from the scratch dir so this never depends on where the human ran
    // the bridge from.
    cwd: cfg.__workdir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  child.on('spawn', () => { result.spawnedOk = true; });

  let stdout = '';
  let stderr = '';
  const MAX_CAPTURE = 32 * 1024 * 1024; // keep a runaway stream from eating all memory

  const timer = setTimeout(() => {
    result.transportError = `TIMEOUT after ${cfg.timeouts.codexCallMs}ms`;
    try { child.kill('SIGINT'); } catch { /* already gone */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, cfg.timeouts.killGraceMs).unref?.();
  }, cfg.timeouts.codexCallMs);
  timer.unref?.();

  const settle = new Promise((resolvePromise) => {
    child.stdout.on('data', (d) => { if (stdout.length < MAX_CAPTURE) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_CAPTURE) stderr += d.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      result.transportError = `SPAWN_FAILED: ${err.code ?? ''} ${err.message}`;
      resolvePromise();
    });    child.on('close', (code) => {
      clearTimeout(timer);
      result.exitCode = code;
      resolvePromise();
    });
  });

  try {
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
  } catch (err) {
    // A dead child's stdin throws EPIPE; the close handler still reports the truth.
    result.transportError = result.transportError ?? `STDIN_WRITE_FAILED: ${err.message}`;
  }

  await settle;
  result.durationMs = Date.now() - started;

  try { writeFileSync(streamPath, stdout, 'utf8'); } catch { /* evidence only */ }

  const { events, malformed } = parseJsonl(stdout);
  const summary = summarizeEvents(events);
  result.threadId = threadId ? (summary.threadId ?? threadId) : summary.threadId;
  result.degraded = summary.degraded && !result.threadId;
  result.usage = normalizeUsage(summary.usage);
  result.eventCount = events.length;
  result.malformedLines = malformed;
  result.stderr = stderr.slice(-4000);

  if (existsSync(lastMessagePath)) {
    try { result.lastMessage = readFileSync(lastMessagePath, 'utf8').trim(); } catch { /* ignore */ }
  }
  if (!result.lastMessage) result.lastMessage = summary.finalText;

  if (summary.failure) result.reason = summary.failure;

  if (result.transportError) {
    result.ok = false;
    result.transportFailed = true;
    return result;
  }
  if (result.exitCode !== 0) {
    result.ok = false;
    result.reason = result.reason ?? `codex exited with code ${result.exitCode}`;
    // A non-zero exit with no usable answer is plumbing, not a refusal: the
    // process died before it could answer. That is retryable.
    result.transportFailed = !result.lastMessage || /^\s*$/.test(result.lastMessage);
    return result;
  }
  if (!result.lastMessage) {
    result.ok = false;
    result.reason = result.reason ?? 'codex produced no final message';
    result.transportFailed = true;
    return result;
  }
  result.ok = true;
  result.transportFailed = false;
  return result;
}

/**
 * argv builder, exposed for tests.
 *
 * The reasoning-effort override is fresh-exec-only and there is no other cheap way to
 * assert that: a live call cannot tell you whether argv was right, only that the call
 * worked.
 */
export function buildArgsForTest(cfg, opts) {
  return buildArgs(cfg, opts);
}

/** Cheap liveness probe used by `bridge.mjs doctor`. */export function probeCli(cfg) {
  const { exe, version, candidates } = resolveCodexExe(cfg, { fresh: true });
  const authPath = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.codex', 'auth.json');
  return { exe, version, candidates, authPresent: existsSync(authPath), authPath };
}
