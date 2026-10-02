// lib/state.mjs -- atomic snapshots, an append-only ledger, a TTL lock, and the
// call store that makes `ask` idempotent and crash-replayable.
//
// Everything the loop knows lives on disk, so a crashed executor or a killed
// bridge process can be resumed without re-spending tokens.
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  appendFileSync, readdirSync, rmSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

export function ensureDirs(cfg) {
  const s = cfg.__stateDir;
  for (const d of [s, join(s, 'queue'), join(s, 'cards'), join(s, 'calls'), join(s, 'runs'), join(s, 'handoff')]) {
    mkdirSync(d, { recursive: true });
  }
  return s;
}

export function paths(cfg) {
  const s = cfg.__stateDir;
  return {
    stateDir: s,
    state: join(s, 'state.json'),
    runPlan: join(s, 'run-plan.json'),
    ledger: join(s, 'decisions.jsonl'),
    budget: join(s, 'budget.json'),
    summaryMd: join(s, 'rolling-summary.md'),
    lock: join(s, 'lock.json'),
    queue: join(s, 'queue'),
    cards: join(s, 'cards'),
    calls: join(s, 'calls'),
    runs: join(s, 'runs'),
    handoff: join(s, 'handoff'),
  };
}

/** Atomic-ish write: full write to a temp file, then rename over the target. */
export function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip torn tail line */ }
  }
  return out;
}

export function appendLedger(cfg, record) {
  const p = paths(cfg);
  appendFileSync(p.ledger, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8');
}

export const DEFAULT_STATE = {
  runId: null,
  status: 'new',            // new | planning | running | stopped | exhausted
  rounds: 0,
  turns: 0,
  currentTaskId: null,
  lastVerdict: null,
  stopReason: null,
  // Which task the `stop` was about, so a human resuming with a note answers THAT task
  // rather than silently redirecting the run at whatever card arrives next.
  stoppedForTaskId: null,
  // How many times a human has resumed this run with a note (capped by maxHumanResumes).
  humanResumes: 0,
  threadId: null,
  threadStartedAt: null,
  statelessMode: false,
  revised: {},              // taskId -> rework attempts used
  createdAt: null,
  updatedAt: null,
  // Wall-clock at the last moment the bridge OR an executor was actually doing work.
  // `maxRunDurationMs` is measured against active time, not against createdAt, so an
  // idle gap (a crashed executor, an overnight pause) does not consume the run's life.
  lastActiveAt: null,
  activeMs: 0,
};

export function loadState(cfg) {
  return { ...DEFAULT_STATE, ...(readJson(paths(cfg).state, {}) ?? {}) };
}

export function saveState(cfg, state) {
  state.updatedAt = new Date().toISOString();
  writeJsonAtomic(paths(cfg).state, state);
  return state;
}

export function newRunId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function runDir(cfg, runId) {
  const dir = join(paths(cfg).runs, runId ?? loadState(cfg).runId ?? 'adhoc');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/* ------------------------------------------------------------------ locking */

/**
 * Bounded, event-driven lock. The Codex thread is a shared resource, so exactly
 * one bridge process may be inside the critical section (Codex call + state
 * write) at a time. Waiting re-checks on a timer; it never hot-spins.
 *
 * A lock is reclaimed when either its TTL has passed or the owning process is
 * gone. Both cases matter: every code path here ends in `process.exit`, which
 * skips `finally` blocks, so a normal exit can leave the lock file behind.
 */
export async function withLock(cfg, fn, { onWait } = {}) {
  const p = paths(cfg);
  const deadline = Date.now() + cfg.timeouts.lockWaitMs;
  let announced = false;

  for (;;) {
    try {
      writeFileSync(p.lock, `${JSON.stringify({
        pid: process.pid,
        at: new Date().toISOString(),
        expiresAt: Date.now() + cfg.timeouts.lockTtlMs,
      }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const held = readJson(p.lock, null);
      if (isReclaimable(held)) {
        try { unlinkSync(p.lock); } catch { /* another waiter won the race */ }
        continue;
      }
      if (Date.now() > deadline) {
        const e = new Error(`LOCK_TIMEOUT: another bridge (pid ${held?.pid ?? '?'}) holds the lock`);
        e.code = 'LOCK_TIMEOUT';
        throw e;
      }
      if (!announced && onWait) { announced = true; onWait(held); }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  try {
    return await fn();
  } finally {
    releaseLock(cfg);
  }
}

/** True when the holder is gone or its TTL has lapsed. */
function isReclaimable(held) {
  if (!held) return true;
  if (typeof held.expiresAt === 'number' && held.expiresAt < Date.now()) return true;
  if (typeof held.pid === 'number' && !processAlive(held.pid)) return true;
  return false;
}

function processAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0); // signal 0 only probes for existence
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by someone else
  }
}

/** Release without throwing -- safe to call from a signal handler or at exit. */
export function releaseLock(cfg) {
  try { unlinkSync(paths(cfg).lock); return true; } catch { return false; }
}

/**
 * Release the lock when the process is asked to leave. `process.exit` skips
 * `finally` blocks, so the exit path is wired explicitly instead of relying on
 * the lock TTL to clean up after every single call.
 */
let exitHooked = false;
export function installLockExitHook(cfg) {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => releaseLock(cfg));
}

/* ---------------------------------------------------------------- call store */

/**
 * Identity of a completed round-trip.
 *
 * A replay is only correct when nothing that shaped the answer has changed. The
 * fingerprint covers the budget limits (which the verdict was constrained by)
 * and the task attempt number, so a rerun under different limits can never be
 * served a stale verdict, while a genuine crash-replay still hits the store.
 */
export function configFingerprint(cfg) {
  const b = cfg.budgets;
  const material = [
    b.maxRounds, b.maxCodexCallsPerTask, b.maxReviseAttempts, b.maxRepairAttempts,
    b.maxTurnsTotal, b.maxRequestsPerDay, b.maxTokensPerDay, b.maxTokensPerCall,
    cfg.summary.oneLineMaxChars, cfg.summary.rollingMaxChars,
    cfg.codex.model ?? '', cfg.codex.sandbox, cfg.__configPath,
  ].join('|');
  let h = 2166136261;
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Identity of a completed round-trip.
 *
 * Includes a hash of the CARD, not just the task and attempt. Without it, an
 * executor that fixes the work and resubmits a changed card at the same attempt
 * number receives the previous verdict from the replay cache -- it looks like a
 * fresh judgement but is the old one, and the loop spins without ever asking the
 * brain again.
 *
 * So: same card bytes => replay (the executor genuinely resubmitted the same
 * evidence). Different bytes => a new question, a new call.
 */
export function callKey(cfg, { taskId, attempt, kind, cardHash }) {
  const fp = configFingerprint(cfg);
  const parts = [
    taskId ?? 'run',
    kind,
    `a${attempt ?? 0}`,
    fp,
  ];
  if (cardHash) parts.push(cardHash);
  return parts.join('__');
}

/** Short, stable hash of a submitted card's bytes. */
export function cardFingerprint(rawText) {
  let h = 2166136261;
  const s = String(rawText ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `c${(h >>> 0).toString(16).padStart(8, '0')}`;
}

export function callPath(cfg, key) {
  return join(paths(cfg).calls, `${key.replace(/[^\w.-]/g, '_')}.json`);
}

/**
 * Discard recorded round-trips.
 *
 * `run init` calls this: starting a run is the human saying "begin again", and
 * replaying an old verdict for a task id that a new run happens to reuse would
 * let a stale decision stand in for real work.
 */
export function wipeCalls(cfg) {
  const dir = paths(cfg).calls;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadCall(cfg, key) {
  return readJson(callPath(cfg, key), null);
}

export function saveCall(cfg, key, record) {
  writeJsonAtomic(callPath(cfg, key), record);
  return record;
}

/** Queue helpers -- the queue is written by the brain, read by executors. */
export function queuePath(cfg, taskId) {
  return join(paths(cfg).queue, `${taskId}.json`);
}

export function listQueue(cfg) {
  const dir = paths(cfg).queue;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(join(dir, f), null))
    .filter(Boolean)
    .sort((a, b) => String(a.order ?? a.taskId).localeCompare(String(b.order ?? b.taskId)));
}

export function nextPendingTask(cfg) {
  return listQueue(cfg).find((t) => t.state === 'pending') ?? null;
}

export function writeTask(cfg, task) {
  writeJsonAtomic(queuePath(cfg, task.taskId), task);
  return task;
}

export function writeHandoff(cfg, name, contents) {
  const p = join(paths(cfg).handoff, `${name}.md`);
  writeFileSync(p, contents, 'utf8');
  return p;
}

/** Remove runtime products. `bridge.mjs selftest` uses this; humans use `reset`. */
export function wipeState(cfg, { keepConfig = true } = {}) {  const p = paths(cfg);
  const targets = [p.state, p.runPlan, p.ledger, p.budget, p.summaryMd, p.lock];
  for (const t of targets) { try { rmSync(t, { force: true }); } catch { /* ignore */ } }
  for (const dir of [p.queue, p.cards, p.calls, p.runs, p.handoff]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  ensureDirs(cfg);
  return keepConfig;
}

/**
 * Paths as the executor agent must type them: relative to the project root, so a
 * task brief never depends on the shell's working directory. Uses forward slashes,
 * which both Node and PowerShell accept on Windows.
 */
export function relPaths(cfg) {
  return {
    projectRoot: cfg.__root,
    cardFor: (taskId) => `state/cards/${taskId}.result.json`,
    queueFor: (taskId) => `state/queue/${taskId}.json`,
    briefFor: (taskId) => `seeds/task-${taskId}.txt`,
    summary: 'state/rolling-summary.md',
    bridge: 'bridge.mjs',
  };
}

/** Write the plain-text brief handed to a headless DSH executor. */
export function writeTaskBrief(cfg, task, extra = {}) {
  const rel = relPaths(cfg);
  const workRoot = cfg.__workdir;
  const body = [
    `# Task ${task.taskId}: ${task.title}`,
    '',
    '## Where to work',
    `- Working root for this task: \`${workRoot}\``,
    '  Any relative path in the instructions below resolves against that directory.',
    `- Project root (bridge, state, config): \`${cfg.__root}\``,
    '',
    '## Instructions',
    task.prompt,
    '',
    '## Verification (you must run this and report the real result)',
    task.verification,
    '',
    '## Constraints',
    ...(task.constraints?.length ? task.constraints.map((c) => `- ${c}`) : ['- (none)']),
    '',
    '## Protocol (follow exactly)',
    `1. Do the work. Do not modify this project's \`bridge.mjs\`, \`lib/\` or \`config/\`.`,
    '2. Never paste raw logs into your report. Summaries only.',
    `3. Write your result card to \`${join(cfg.__root, rel.cardFor(task.taskId))}\`:`,
    '',
    '   ```json',
    '   {',
    `     "taskId": "${task.taskId}",`,
    `     "runId": "${task.runId ?? ''}",`,
    '     "status": "completed",',
    `     "summaryOneLine": "One sentence, at most ${cfg.summary.oneLineMaxChars} chars. What is now true that was not before.",`,
    '     "changed": ["relative/path:lines"],',
    '     "findings": ["<= 5 short points"],',
    '     "blockers": [],',
    '     "verify": { "command": "the command you ran", "exitCode": 0 },',
    '     "nextHint": "",',
    '     "metrics": { "turns": 0, "durationMs": 0 }',
    '   }',
    '   ```',
    // Absolute paths throughout: the bridge does not have to live inside the project
    // root (a framework checkout driving several projects is the normal layout), so a
    // bare `node bridge.mjs` would send the executor after a file that is not there.
    `4. Run: \`node "${join(cfg.__root, rel.bridge)}" --project-root "${cfg.__root}" --config "${cfg.__configPath}" ask --card "${join(cfg.__root, rel.cardFor(task.taskId))}"\``,
    `   (or simply \`cd "${cfg.__root}"\` first, then \`node "${join(cfg.__root, rel.bridge)}" ask --card ${rel.cardFor(task.taskId)}\`)`,
    '   This blocks until the brain answers. Do not poll, do not sleep, do not retry on your own.',
    '5. Branch on the exit code and the JSON printed to stdout:',
    '   - 0  pass   -> stop. Report the verdict and what you changed. Do not start another task.',
    '   - 10 rework -> follow reworkInstructions, then repeat from step 3 (the bridge tracks the attempt count).',
    '   - 20 next   -> report the verdict; the human or the next scheduled run starts the next task.',
    '   - 30 stop   -> stop immediately and report the reason.',
    '   - 3 or 4    -> budget or round limit reached. Stop and report.',
    '   - 5 or 6    -> fix the problem the JSON names (bad card, transport failure) and report.',
    ...(extra.notes ? ['', '## Notes from the brain', extra.notes] : []),
    '',
  ].join('\n');

  const dir = join(cfg.__root, 'seeds');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `task-${task.taskId}.txt`);
  writeFileSync(p, body, 'utf8');
  return p;
}
