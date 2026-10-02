// lib/selftest.mjs -- offline end-to-end run of the whole state machine.
//
// Nothing here touches the network. A sandbox project is built under
// state/selftest/, `codex.exePath` is pointed at the Node stub, and the bridge
// CLI is then driven as a real subprocess so exit codes and file effects are
// exercised exactly as the executor agent will experience them.
import { spawnSync } from 'node:child_process';
import {
  mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadConfig } from './config.mjs';
import { loadState, writeJsonAtomic } from './state.mjs';
import { buildAskPrompt } from './prompt.mjs';
import { mirrorEnabled, pushToChat, renderVerdictReport } from './queue-mirror.mjs';

const STUB = join(ROOT, 'tools', 'codex-stub.mjs');
const BRIDGE = join(ROOT, 'bridge.mjs');

/* ----------------------------------------------------------------- tiny assert */

let passed = 0;
const failures = [];
const results = [];

function check(name, condition, detail = '') {
  if (condition) { passed++; results.push(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` -- ${detail}` : ''}`); results.push(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
  return Boolean(condition);
}

/* ------------------------------------------------------------- sandbox project */

function makeSandbox(keep) {
  const dir = join(ROOT, 'state', 'selftest');
  if (existsSync(dir) && !keep) rmSync(dir, { recursive: true, force: true });
  for (const d of ['config', 'seeds', 'scratch', 'state', 'work']) {
    mkdirSync(join(dir, d), { recursive: true });
  }
  // The bridge resolves its JSON schemas from <project-root>/config, so the
  // sandbox needs its own copy to behave exactly like a real project.
  for (const name of ['verdict', 'plan', 'probe']) {
    const src = join(ROOT, 'config', `${name}.schema.json`);
    if (existsSync(src)) {
      writeFileSync(join(dir, 'config', `${name}.schema.json`), readFileSync(src, 'utf8'), 'utf8');
    }
  }
  const configPath = join(dir, 'config', 'run.config.json');
  return { dir, configPath };
}

function writeSandboxConfig(sb, overrides = {}) {
  const cfg = {
    project: { name: 'selftest', workspace: join(sb.dir, 'work') },
    codex: {
      transport: 'exec',
      exePath: process.execPath,
      nodeArgs: [STUB],
      model: null,
      sandbox: 'workspace-safe-none',
      extraArgs: [],
      workdir: join(sb.dir, 'scratch'),
    },
    budgets: {
      maxRounds: 40, maxCodexCallsPerTask: 6, maxReviseAttempts: 2, maxRepairAttempts: 1,
      maxTurnsTotal: 200, maxRequestsPerDay: 60, maxTokensPerDay: 1500000, maxTokensPerCall: 120000,
    },
    timeouts: { codexCallMs: 20000, codexStartupMs: 5000, killGraceMs: 1000, lockTtlMs: 60000, lockWaitMs: 5000 },
    summary: { oneLineMaxChars: 400, rollingMaxChars: 12288, cardsKept: 12, compactOnOverflow: true },
    retry: { backoffMs: 50, maxTransportRetries: 2 },
    ...overrides,
  };
  writeFileSync(sb.configPath, JSON.stringify(cfg, null, 2), 'utf8');
  // Kept so a scenario can tweak one knob (e.g. point at a bad executable)
  // without rebuilding every other field.
  sb.cfg = cfg;
  return cfg;
}

function stubScript(sb, entries) {
  writeFileSync(join(sb.dir, 'scratch', 'stub-script.json'), JSON.stringify(entries, null, 2), 'utf8');
  stubReset(sb);
}

/** Patch only the timeout block, leaving the budgets the scenario scripted. */
function setSandboxTimeouts(sb, over) {
  const p = join(sb.dir, 'config', 'run.config.json');
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  raw.timeouts = { ...raw.timeouts, ...over };
  writeFileSync(p, JSON.stringify(raw, null, 2), 'utf8');
}

/**
 * Clear the consumed-entry counter and the call log.
 *
 * Setup calls (`run init`) must not eat the answers scripted for the assertions
 * that follow, so a scenario scripts its answers and then resets immediately
 * before the call it actually cares about.
 */
function stubReset(sb) {
  rmSync(join(sb.dir, 'scratch', 'stub-count.json'), { force: true });
  rmSync(join(sb.dir, 'scratch', 'stub-calls.jsonl'), { force: true });
}

/**
 * Isolate one scenario from the previous one.
 *
 * The daily budget, the round counters and the call store are all real durable
 * state -- that is the point of them -- so scenarios must start from a known
 * blank slate or the tenth scenario runs out of the budget the first one spent.
 * Kept separate from stubReset because the stub script must survive this.
 */
function resetRun(sb) {
  for (const f of ['state.json', 'budget.json', 'decisions.jsonl', 'rolling-summary.md', 'run-plan.json']) {
    rmSync(join(sb.dir, 'state', f), { force: true });
  }
  for (const d of ['calls', 'queue', 'cards', 'runs', 'handoff']) {
    rmSync(join(sb.dir, 'state', d), { recursive: true, force: true });
  }
  // Seeds are project input, not run state, but a scenario that scripted its own
  // must not leak into the next one -- that is how S18 silently reused S11b's queue.
  rmSync(join(sb.dir, 'seeds', 'run-plan.seed.json'), { force: true });
  for (const f of readdirSync(join(sb.dir, 'seeds'))) {
    if (/^task-.+\.txt$/.test(f)) rmSync(join(sb.dir, 'seeds', f), { force: true });
  }
}

function stubCalls(sb) {
  const p = join(sb.dir, 'scratch', 'stub-calls.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Run the bridge as the executor agent would: a real subprocess, stdin inherited
 * so the sandbox's pipe restrictions can never mask a real failure.
 */
function bridge(sb, args, { input, env } = {}) {
  const res = spawnSync(process.execPath, [BRIDGE, '--project-root', sb.dir, '--config', sb.configPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  let json = null;
  const text = (res.stdout ?? '').trim();
  try {
    json = JSON.parse(text);
  } catch {
    // stdout may carry more than one document; take the last complete top-level
    // object so a stray notice can never make a real result unreadable.
    const docs = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{') { if (depth === 0) start = i; depth++; } else if (c === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          try { docs.push(JSON.parse(text.slice(start, i + 1))); } catch { /* not a document */ }
          start = -1;
        }
      }
    }
    json = docs.length ? docs[docs.length - 1] : null;
  }
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', json };
}

function card(sb, name, body) {
  const p = join(sb.dir, 'state', 'cards', `${name}.json`);
  mkdirSync(join(sb.dir, 'state', 'cards'), { recursive: true });
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2), 'utf8');
  return p;
}

function stateOf(sb) {
  const p = join(sb.dir, 'state', 'state.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

function budgetOf(sb) {
  const p = join(sb.dir, 'state', 'budget.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

/* --------------------------------------------------------------- scenario defs */

const PLAN = {
  goal: 'Offline state-machine coverage',
  successCriteria: ['every branch has a verdict'],
  tasks: [
    { taskId: 'T-001', title: 'First task', prompt: 'Do the first thing.', verification: 'exit code 0 from node -e "process.exit(0)"' },
    { taskId: 'T-002', title: 'Second task', prompt: 'Do the second thing.', verification: 'file work/two.txt exists' },
  ],
};

function goodCard(taskId, extra = {}) {
  return {
    taskId,
    runId: 'selftest',
    status: 'completed',
    summaryOneLine: `${taskId} finished cleanly`,
    changed: ['work/out.txt:1-3'],
    findings: ['nothing surprising'],
    blockers: [],
    verify: { command: 'node -e "process.exit(0)"', exitCode: 0 },
    nextHint: '',
    metrics: { turns: 3, durationMs: 1200 },
    ...extra,
  };
}

const verdict = (m) => ({ raw: JSON.stringify(m) });

/* ------------------------------------------------------------------ the run */

export async function runSelftest(cfg, { keep = false } = {}) {
  void cfg;
  const sb = makeSandbox(keep);
  results.push(`selftest sandbox: ${sb.dir}`);

  /* --- S1: planning + first dispatch ------------------------------------- */
  writeSandboxConfig(sb);
  resetRun(sb);
  writeFileSync(join(sb.dir, 'seeds', 'run-plan.seed.json'), JSON.stringify({ tasks: [] }), 'utf8');
  stubScript(sb, [{ message: PLAN }]);

  const init = bridge(sb, ['run', 'init']);
  check('S1 run init exits 0', init.code === 0, `code=${init.code} ${init.stderr.slice(0, 200)}`);
  check('S1 queue has both tasks', init.json?.taskCount === 2, JSON.stringify(init.json?.queue));
  check('S1 first task dispatched', init.json?.next?.taskId === 'T-001');
  check('S1 brief written for T-001', existsSync(join(sb.dir, 'seeds', 'task-T-001.txt')));
  const brief = readFileSync(join(sb.dir, 'seeds', 'task-T-001.txt'), 'utf8');
  // The briefed command must be runnable as written: absolute bridge path, project
  // root and config, because the bridge does not have to live inside the project.
  check('S1 brief names a runnable ask command',
    brief.includes(`"${join(sb.dir, 'bridge.mjs')}"`)
    && brief.includes(`--project-root "${sb.dir}"`)
    && brief.includes('ask --card'), brief.split('\n').filter((l) => l.startsWith('4.')).join(''));
  check('S1 brief states the working root', brief.includes('Working root for this task') && brief.includes(join(sb.dir, 'scratch')),
    brief.slice(0, 200));
  check('S1 state is running', stateOf(sb)?.status === 'running');

  /* --- S2: bad cards are refused without spending a call ------------------ */
  stubReset(sb);
  const before = stubCalls(sb).length;
  // Derived from the sandbox config rather than hard-coded, so raising the limit
  // cannot silently turn this into a test that no longer tests anything.
  const tooLongCard = card(sb, 'T-001.long', goodCard('T-001', {
    summaryOneLine: 'x'.repeat(sb.cfg.summary.oneLineMaxChars + 200),
  }));
  const rLong = bridge(sb, ['ask', '--card', tooLongCard]);
  check('S2 oversized card -> exit 6', rLong.code === 6, `code=${rLong.code}`);
  check('S2 oversized card names the gate', rLong.json?.code === 'CARD_TOO_LARGE', JSON.stringify(rLong.json));
  check('S2 oversized card did NOT call the brain', stubCalls(sb).length === before);

  const rawLog = card(sb, 'T-001.raw', goodCard('T-001', { stdout: 'a very long log...' }));
  const rRaw = bridge(sb, ['ask', '--card', rawLog]);
  check('S2 raw-log card -> exit 6', rRaw.code === 6, `code=${rRaw.code}`);
  check('S2 raw-log card names the gate', rRaw.json?.code === 'CARD_HAS_RAW_LOG');

  const notJson = card(sb, 'T-001.bad', '{ this is not json');
  const rBad = bridge(sb, ['ask', '--card', notJson]);
  check('S2 malformed card -> exit 6', rBad.code === 6, `code=${rBad.code}`);

  const rMissing = bridge(sb, ['ask', '--card', join(sb.dir, 'state', 'nope.json')]);
  check('S2 missing card -> exit 6', rMissing.code === 6, `code=${rMissing.code}`);

  /* --- S3: pass ----------------------------------------------------------- */
  writeSandboxConfig(sb);
  resetRun(sb);
  stubScript(sb, [verdict({
    action: 'pass', reason: 'accepted', feedbackForExecutor: 'none',
    reworkInstructions: null, nextTask: null, summaryForRolling: 'T-001 accepted',
  })]);
  const ok1 = card(sb, 'T-001.result', goodCard('T-001'));
  const r1 = bridge(sb, ['ask', '--card', ok1]);
  check('S3 pass -> exit 0', r1.code === 0, `code=${r1.code} ${JSON.stringify(r1.json).slice(0, 300)}`);
  check('S3 verdict action is pass', r1.json?.action === 'pass');
  check('S3 the accepted card is archived separately',
    existsSync(join(sb.dir, 'state', 'cards', 'T-001.accepted.json')));
  check('S3 the executor\'s own card is left untouched',
    existsSync(ok1) && !readFileSync(ok1, 'utf8').includes('__path'),
    'the bridge must not overwrite the card the executor wrote');
  const usedAfterPass = stubCalls(sb).length;
  check('S3 exactly one brain call', usedAfterPass === 1, `calls=${usedAfterPass}`);

  // The authoritative next step must be present and point at real things.
  check('S3 the verdict carries a single authoritative instruction',
    r1.json?.instruction?.do === 'stop' || r1.json?.instruction?.do === 'execute',
    JSON.stringify(r1.json?.instruction));
  check('S3 the instruction is self-describing',
    typeof r1.json?.instruction?.because === 'string' && r1.json.instruction.because.length > 0,
    JSON.stringify(r1.json?.instruction));

  /* --- S4: idempotent replay --------------------------------------------- */
  const r1b = bridge(sb, ['ask', '--card', ok1]);
  check('S4 identical resubmission replays the verdict', r1b.code === 0 && r1b.json?.replayed === true, JSON.stringify(r1b.json).slice(0, 200));
  check('S4 replay spent NO extra call', stubCalls(sb).length === usedAfterPass, `calls=${stubCalls(sb).length}`);

  /* --- S4b: a CHANGED card must be judged afresh ------------------------- */
  // Regression guard. Without the card's bytes in the idempotency key, an executor
  // that fixes its work and resubmits a changed card at the same attempt number
  // receives the OLD verdict from the replay cache -- it looks like a fresh
  // judgement, so the loop spins without ever asking the brain again.
  stubScript(sb, [
    verdict({ action: 'rework', reason: 'CHANGED-CARD-JUDGED', feedbackForExecutor: 'fix it', reworkInstructions: 'Do the thing.', nextTask: null, summaryForRolling: 'x' }),
  ]);
  const callsBefore4b = stubCalls(sb).length;
  const changed = card(sb, 'T-001.result', goodCard('T-001', {
    summaryOneLine: 'T-001 finished cleanly, and this time the evidence changed',
    findings: ['a new finding the brain has not seen before'],
  }));
  const r1c = bridge(sb, ['ask', '--card', changed]);
  check('S4b a changed card is sent to the brain again',
    stubCalls(sb).length === callsBefore4b + 1,
    `calls ${callsBefore4b} -> ${stubCalls(sb).length}`);
  check('S4b the fresh verdict is returned, not the cached one',
    r1c.json?.replayed === false && r1c.json?.reason === 'CHANGED-CARD-JUDGED',
    `replayed=${r1c.json?.replayed} reason=${r1c.json?.reason}`);
  check('S4b a rework verdict hands back a paste-ready re-ask command',
    r1c.json?.instruction?.do === 'rework'
    && String(r1c.json?.instruction?.thenRun).includes('ask --card')
    && typeof r1c.json?.instruction?.what === 'string',
    JSON.stringify(r1c.json?.instruction));

  /* --- S5: rework -> next ------------------------------------------------ */
  writeSandboxConfig(sb);
  resetRun(sb);
  stubScript(sb, [{ message: PLAN }]);
  bridge(sb, ['run', 'init']);
  stubScript(sb, [
    verdict({
      action: 'rework', reason: 'missing evidence', feedbackForExecutor: 'attach the exit code',
      reworkInstructions: 'Run the verification command and put its exit code in verify.exitCode.',
      nextTask: null, summaryForRolling: 'T-002 needs evidence',
    }),
    verdict({
      action: 'next', reason: 'evidence accepted',
      feedbackForExecutor: 'none',
      reworkInstructions: null,
      nextTask: { taskId: 'T-003', title: 'Third task', prompt: 'Do the third thing.', verification: 'exit 0' },
      summaryForRolling: 'T-002 accepted, T-003 queued',
    }),
  ]);
  const reworkCard = card(sb, 'T-002.result', goodCard('T-002', { summaryOneLine: 'T-002 done but unverified', verify: { command: 'none', exitCode: null } }));
  const r2 = bridge(sb, ['ask', '--card', reworkCard]);
  check('S5 rework -> exit 10', r2.code === 10, `code=${r2.code} ${JSON.stringify(r2.json).slice(0, 240)}`);
  check('S5 rework instructions delivered', typeof r2.json?.reworkInstructions === 'string' && r2.json.reworkInstructions.length > 10);
  check('S5 task returned to pending', JSON.parse(readFileSync(join(sb.dir, 'state', 'queue', 'T-002.json'), 'utf8')).state === 'pending');
  check('S5 revision counter incremented', stateOf(sb)?.revised?.['T-002'] === 1);

  const r25 = bridge(sb, ['ask', '--card', reworkCard]);
  check('S5 second attempt -> next, exit 20', r25.code === 20, `code=${r25.code} ${JSON.stringify(r25.json).slice(0, 240)}`);
  check('S5 nextTask created T-003', existsSync(join(sb.dir, 'state', 'queue', 'T-003.json')));
  check('S5 T-003 brief written', existsSync(join(sb.dir, 'seeds', 'task-T-003.txt')));
  const st25 = stateOf(sb);
  // T-001 was never executed in this scenario, so the queue's next pending task
  // (T-001) is the correct hand-off, not the T-003 that was just appended.
  const queuedIds = readdirSync(join(sb.dir, 'state', 'queue')).filter((f) => f.endsWith('.json'));
  check('S5 current task points at a queued pending task',
    queuedIds.some((f) => f.startsWith(`${st25?.currentTaskId}.`)), `current=${st25?.currentTaskId} queue=${queuedIds.join(',')}`);

  /* --- S6: malformed verdict -> bounded repair round ---------------------- */
  writeSandboxConfig(sb);
  resetRun(sb);
  stubScript(sb, [{ message: PLAN }]);
  bridge(sb, ['run', 'init']);
  stubScript(sb, [
    { raw: 'I think the task is fine, no JSON here.' },
    verdict({ action: 'stop', reason: 'repaired answer', feedbackForExecutor: 'none', reworkInstructions: null, nextTask: null, summaryForRolling: 'stopped after repair' }),
  ]);
  const repairCard = card(sb, 'T-001.result', goodCard('T-001'));
  const r3 = bridge(sb, ['ask', '--card', repairCard]);
  check('S6 malformed verdict is repaired -> exit 30', r3.code === 30, `code=${r3.code} ${JSON.stringify(r3.json).slice(0, 240)}`);
  check('S6 repair cost exactly one extra call', stubCalls(sb).length === 2, `calls=${stubCalls(sb).length}`);
  check('S6 run stopped', stateOf(sb)?.status === 'stopped');

  /* --- S7: stop is sticky ------------------------------------------------- */
  const r4 = bridge(sb, ['ask', '--card', card(sb, 'T-002.result', goodCard('T-002'))]);
  check('S7 a stopped run refuses new work', r4.code === 5, `code=${r4.code}`);
  check('S7 refusal names the stop reason', /stopped/i.test(r4.json?.hint ?? r4.json?.message ?? ''), JSON.stringify(r4.json));

  /* --- S8: rework ceiling ------------------------------------------------- */
  writeSandboxConfig(sb);
  resetRun(sb);
  stubScript(sb, [
    { message: PLAN },
    verdict({ action: 'rework', reason: 'again', feedbackForExecutor: 'fix it', reworkInstructions: 'Fix the thing again.', nextTask: null, summaryForRolling: 'rework 1' }),
    verdict({ action: 'rework', reason: 'again', feedbackForExecutor: 'fix it', reworkInstructions: 'Fix the thing again.', nextTask: null, summaryForRolling: 'rework 2' }),
    // Repeating the refused answer here proves the repair round cannot undo the ceiling.
    verdict({ action: 'rework', reason: 'again', feedbackForExecutor: 'fix it', reworkInstructions: 'Fix the thing again.', nextTask: null, summaryForRolling: 'rework 3' }),
  ]);
  bridge(sb, ['run', 'init']);
  const c8 = card(sb, 'T-001.result', goodCard('T-001'));
  const a8 = bridge(sb, ['ask', '--card', c8]);
  const b8 = bridge(sb, ['ask', '--card', c8]);
  check('S8 rework allowed within budget', a8.code === 10 && b8.code === 10, `${a8.code}/${b8.code}`);
  const callsBeforeCeiling = stubCalls(sb).length;
  const d8 = bridge(sb, ['ask', '--card', c8]);
  check('S8 rework ceiling halts instead of looping', d8.code === 5, `code=${d8.code} ${JSON.stringify(d8.json).slice(0, 300)}`);
  const ledger8 = readFileSync(join(sb.dir, 'state', 'decisions.jsonl'), 'utf8');
  const kinds8 = ledger8.split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l).kind; } catch { return '?'; } });
  check('S8 ceiling is recorded in the ledger', kinds8.includes('verdict_invalid'), `kinds=${kinds8.join(',')}`);
  check('S8 the ceiling cost exactly one repair round',
    stubCalls(sb).length === 5, `totalCalls=${stubCalls(sb).length} expected=5 (1 init + 2 rework + 1 ask + 1 repair)`);
  check('S8 the refused rework was not repaired into acceptance',
    stubCalls(sb).length - callsBeforeCeiling <= 2,
    `extraCalls=${stubCalls(sb).length - callsBeforeCeiling} a8=${a8.code} b8=${b8.code}`);

  /* --- S9: daily request budget ------------------------------------------ */
  writeSandboxConfig(sb, {
    budgets: {
      maxRounds: 40, maxCodexCallsPerTask: 6, maxReviseAttempts: 2, maxRepairAttempts: 1,
      maxTurnsTotal: 200, maxRequestsPerDay: 2, maxTokensPerDay: 1500000, maxTokensPerCall: 120000,
    },
  });
  resetRun(sb);
  stubScript(sb, [
    { message: PLAN },
    verdict({ action: 'pass', reason: 'ok', feedbackForExecutor: 'none', reworkInstructions: null, nextTask: null, summaryForRolling: 'ok' }),
  ]);
  bridge(sb, ['run', 'init']);
  const first9 = bridge(sb, ['ask', '--card', card(sb, 'T-001.result', goodCard('T-001'))]);
  const second9 = bridge(sb, ['ask', '--card', card(sb, 'T-002.result', goodCard('T-002'))]);
  check('S9 first call allowed', first9.code === 0, `code=${first9.code} ${JSON.stringify(first9.json).slice(0, 240)}`);
  check('S9 second call refused -> exit 3', second9.code === 3, `code=${second9.code} ${JSON.stringify(second9.json).slice(0, 200)}`);
  check('S9 refusal names the request gate', second9.json?.gate === 'DAILY_REQUESTS');
  check('S9 run marked exhausted', stateOf(sb)?.status === 'exhausted');

  /* --- S10: daily token budget ------------------------------------------ */
  writeSandboxConfig(sb, {
    budgets: {
      maxRounds: 40, maxCodexCallsPerTask: 6, maxReviseAttempts: 2, maxRepairAttempts: 1,
      maxTurnsTotal: 200, maxRequestsPerDay: 60, maxTokensPerDay: 500, maxTokensPerCall: 120000,
    },
  });
  resetRun(sb);
  stubScript(sb, [{ message: PLAN, usage: { input_tokens: 900, cached_input_tokens: 0, output_tokens: 50 } }]);
  bridge(sb, ['run', 'init']);
  const t10 = budgetOf(sb);
  check('S10 tokens counted from the stream', t10?.tokens >= 950, JSON.stringify(t10));
  const second10 = bridge(sb, ['ask', '--card', card(sb, 'T-001.result', goodCard('T-001'))]);
  check('S10 token gate refuses the next call -> exit 3', second10.code === 3, `code=${second10.code}`);
  check('S10 refusal names the token gate', second10.json?.gate === 'DAILY_TOKENS', JSON.stringify(second10.json));

  /* --- S11: round ceiling ------------------------------------------------ */
  writeSandboxConfig(sb, {
    budgets: {
      maxRounds: 2, maxCodexCallsPerTask: 6, maxReviseAttempts: 2, maxRepairAttempts: 1,
      maxTurnsTotal: 200, maxRequestsPerDay: 60, maxTokensPerDay: 1500000, maxTokensPerCall: 120000,
    },
  });
  resetRun(sb);
  stubScript(sb, [
    { message: PLAN },
    verdict({ action: 'pass', reason: 'ok', feedbackForExecutor: 'none', reworkInstructions: null, nextTask: null, summaryForRolling: 'ok' }),
  ]);
  bridge(sb, ['run', 'init']);
  const r11 = bridge(sb, ['ask', '--card', card(sb, 'T-001.result', goodCard('T-001'))]);
  const st11 = stateOf(sb);
  check('S11 verdict still returns at the ceiling', r11.code === 0, `code=${r11.code} json=${JSON.stringify(r11.json).slice(0, 300)}`);
  check('S11 round ceiling ends the run', st11?.status === 'exhausted',
    `status=${st11?.status} rounds=${st11?.rounds} stopReason=${st11?.stopReason} debug=${JSON.stringify(r11.json?.debug)}`);
  check('S11 ceiling reason recorded', /maxRounds/.test(st11?.stopReason ?? ''), `stopReason=${st11?.stopReason}`);

  /* --- S11b: round gate refuses once spent ------------------------------- */
  writeSandboxConfig(sb, {
    budgets: {
      maxRounds: 1, maxCodexCallsPerTask: 6, maxReviseAttempts: 2, maxRepairAttempts: 1,
      maxTurnsTotal: 200, maxRequestsPerDay: 60, maxTokensPerDay: 1500000, maxTokensPerCall: 120000,
    },
  });
  resetRun(sb);
  stubScript(sb, [
    { message: PLAN },
    verdict({ action: 'pass', reason: 'ok', feedbackForExecutor: 'none', reworkInstructions: null, nextTask: null, summaryForRolling: 'ok' }),
  ]);
  bridge(sb, ['run', 'init']);
  const r11b = bridge(sb, ['ask', '--card', card(sb, 'T-001.result', goodCard('T-001'))]);
  check('S11b round gate refuses the call -> exit 3', r11b.code === 3, `code=${r11b.code}`);
  check('S11b refusal names the round gate', r11b.json?.gate === 'MAX_ROUNDS', JSON.stringify(r11b.json).slice(0, 200));

  /* --- S12: transport failure ------------------------------------------- */
  writeSandboxConfig(sb);
  resetRun(sb);
  stubScript(sb, [{ message: PLAN }]);
  bridge(sb, ['run', 'init']);
  // Three entries: one per attempt, because a transport failure is retried.
  stubScript(sb, [
    { transport: 'crash', exitCode: 1 },
    { transport: 'crash', exitCode: 1 },
    { transport: 'crash', exitCode: 1 },
  ]);
  const c12 = card(sb, 'T-001.result', goodCard('T-001'));
  const r12 = bridge(sb, ['ask', '--card', c12]);
  check('S12 crashed CLI -> exit 5', r12.code === 5, `code=${r12.code}`);
  check('S12 reported as retryable infrastructure failure', r12.json?.retryable === true, JSON.stringify(r12.json).slice(0, 200));
  check('S12 transport failures were retried', stubCalls(sb).length === 3, `calls=${stubCalls(sb).length}`);
  check('S12 task parked in submitted for replay',
    JSON.parse(readFileSync(join(sb.dir, 'state', 'queue', 'T-001.json'), 'utf8')).state === 'submitted');

  /* --- S13: timeout ------------------------------------------------------ */
  writeSandboxConfig(sb, { timeouts: { codexCallMs: 800, codexStartupMs: 5000, killGraceMs: 500, lockTtlMs: 60000, lockWaitMs: 5000 } });
  resetRun(sb);
  stubScript(sb, [{ message: PLAN }]);
  bridge(sb, ['run', 'init']);
  stubScript(sb, [
    { delayMs: 60000, message: { action: 'stop' } },
    { delayMs: 60000, message: { action: 'stop' } },
    { delayMs: 60000, message: { action: 'stop' } },
  ]);
  const r13 = bridge(sb, ['ask', '--card', card(sb, 'T-001.result', goodCard('T-001'))]);
  check('S13 hung brain is killed -> exit 5', r13.code === 5, `code=${r13.code}`);
  check('S13 timeout is named', /TIMEOUT/.test(r13.json?.reason ?? ''), JSON.stringify(r13.json).slice(0, 200));

  /* --- S14: rolling summary discipline ---------------------------------- */
  writeSandboxConfig(sb);
  resetRun(sb);
  stubScript(sb, [{ message: PLAN }]);
  bridge(sb, ['run', 'init']);
  stubScript(sb, [verdict({ action: 'stop', reason: 'done', feedbackForExecutor: 'none', reworkInstructions: null, nextTask: null, summaryForRolling: 'done' })]);
  bridge(sb, ['ask', '--card', card(sb, 'T-001.result', goodCard('T-001'))]);
  const summaryPath = join(sb.dir, 'state', 'rolling-summary.md');
  check('S14 rolling summary written', existsSync(summaryPath));
  const summary = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : '';
  check('S14 rolling summary stays inside its char budget', summary.length <= 9000, `len=${summary.length}`);
  check('S14 rolling summary carries no raw log', !/very long log/.test(summary));
  check('S14 rolling summary names the finished task', summary.includes('T-001'));

  const promptSeenByBrain = stubCalls(sb).map((c) => c.promptHead).join('\n');
  check('S14 the brain was actually called', stubCalls(sb).length === 1, `calls=${stubCalls(sb).length}`);
  check('S14 the brain never received a raw log', !/very long log/.test(promptSeenByBrain));
  check('S14 the brain received the rolling summary section', promptSeenByBrain.includes('<seen_so_far>'));
  check('S14 the brain received the result card', promptSeenByBrain.includes('<card>'));
  check('S14 the brain received the task verification', promptSeenByBrain.includes('<task>'));
  const preamble = promptSeenByBrain.split('<state>')[0];
  check('S14 the preamble stays terse', preamble.length < 700,
    `preamble=${preamble.length} chars`);

  /* --- S15: thread continuity and rollover ------------------------------ */
  writeSandboxConfig(sb);
  resetRun(sb);
  stubReset(sb);
  stubScript(sb, [{ message: PLAN, threadId: 'stub-thread-A' }]);
  bridge(sb, ['run', 'init']);
  check('S15 first call captured the thread id', stateOf(sb)?.threadId === 'stub-thread-A', stateOf(sb)?.threadId);

  stubScript(sb, [verdict({ action: 'stop', reason: 'done', feedbackForExecutor: 'none', reworkInstructions: null, nextTask: null, summaryForRolling: 'done' })]);
  bridge(sb, ['ask', '--card', card(sb, 'T-001.result', goodCard('T-001'))]);
  const askCalls = stubCalls(sb);
  check('S15 the ask resumed the same thread', askCalls.at(-1)?.isResume === true, `isResume=${askCalls.at(-1)?.isResume}`);
  check('S15 the ask carried the real prompt', (askCalls.at(-1)?.promptChars ?? 0) > 200, `chars=${askCalls.at(-1)?.promptChars}`);

  stubScript(sb, [verdict({ action: 'stop', reason: 'rollover', feedbackForExecutor: 'none', reworkInstructions: null, nextTask: null, summaryForRolling: 'rollover' })]);
  stubReset(sb);
  stubScript(sb, [verdict({ action: 'stop', reason: 'rollover', feedbackForExecutor: 'none', reworkInstructions: null, nextTask: null, summaryForRolling: 'rollover' })]);
  const compact = bridge(sb, ['compact']);
  check('S15 compact exits 0', compact.code === 0, `code=${compact.code} OUT=${compact.stdout.slice(0, 300)} ERR=${compact.stderr.slice(0, 600)}`);
  check('S15 compact did not resume the old thread', stubCalls(sb).at(-1)?.isResume === false, `isResume=${stubCalls(sb).at(-1)?.isResume}`);
  check('S15 compact moved the thread id', stateOf(sb)?.threadId !== 'stub-thread-A', stateOf(sb)?.threadId);

  /* --- S16: unknown thread id degrades to stateless --------------------- */
  writeSandboxConfig(sb);
  resetRun(sb);
  stubScript(sb, [{ message: PLAN, omitThread: true }]);
  bridge(sb, ['run', 'init']);
  check('S16 stateless mode engaged when the id is missing', stateOf(sb)?.statelessMode === true, JSON.stringify(stateOf(sb)?.statelessMode));
  stubReset(sb);
  stubScript(sb, [verdict({ action: 'stop', reason: 'done', feedbackForExecutor: 'none', reworkInstructions: null, nextTask: null, summaryForRolling: 'done' })]);
  bridge(sb, ['ask', '--card', card(sb, 'T-001.result', goodCard('T-001'))]);
  check('S16 stateless mode never resumes', stubCalls(sb).at(-1)?.isResume === false, `isResume=${stubCalls(sb).at(-1)?.isResume}`);

  /* --- S17: status is readable without calling the brain ---------------- */
  writeSandboxConfig(sb);
  resetRun(sb);
  stubScript(sb, [{ message: PLAN }]);
  bridge(sb, ['run', 'init']);
  const callsBeforeStatus = stubCalls(sb).length;
  const status = bridge(sb, ['status']);
  check('S17 status exits 0', status.code === 0);
  check('S17 status reports the budget', typeof status.json?.budget?.requestsUsed === 'number');
  check('S17 status called the brain zero times', stubCalls(sb).length === callsBeforeStatus);
  // Regression guard: `printHelp` fires on an unset exit code as the "no command
  // matched" signal, so a verb that returned without setting one appended usage text
  // to its own JSON output and broke anything parsing it.
  check('S17 status emits only its own document',
    !/Codex brain <->/.test(status.stdout),
    `stdout starts help at line ${status.stdout.split('\n').findIndex((l) => l.includes('Codex brain <->')) + 1}`);

  const doc1 = bridge(sb, ['doctor']);
  check('S17 doctor emits only its own document',
    doc1.code === 0 && !/Codex brain <->/.test(doc1.stdout),
    `code=${doc1.code}`);

  /* --- S18: seeded queue skips the planning call ------------------------ */
  writeSandboxConfig(sb);
  resetRun(sb);
  writeFileSync(join(sb.dir, 'seeds', 'run-plan.seed.json'),
    JSON.stringify({ goal: 'seeded', tasks: [{ taskId: 'S-001', title: 'Seeded', prompt: 'p', verification: 'v' }] }), 'utf8');
  stubScript(sb, [{ message: { action: 'stop' } }]);
  const seeded = bridge(sb, ['run', 'init']);
  check('S18 seeded plan exits 0', seeded.code === 0, `code=${seeded.code}`);
  check('S18 seeded plan cost zero brain calls', stubCalls(sb).length === 0, `calls=${stubCalls(sb).length}`);
  check('S18 seeded plan dispatched its task', seeded.json?.next?.taskId === 'S-001',
    `next=${JSON.stringify(seeded.json?.next)} queue=${JSON.stringify(seeded.json?.queue)}`);

  /* --- S19: turn ceiling ------------------------------------------------- */
  writeSandboxConfig(sb, {
    budgets: {
      maxRounds: 40, maxCodexCallsPerTask: 6, maxReviseAttempts: 2, maxRepairAttempts: 1,
      maxTurnsTotal: 2, maxRequestsPerDay: 60, maxTokensPerDay: 1500000, maxTokensPerCall: 120000,
    },
  });
  resetRun(sb);
  stubScript(sb, [
    { message: PLAN },
    verdict({ action: 'pass', reason: 'ok', feedbackForExecutor: 'none', reworkInstructions: null, nextTask: null, summaryForRolling: 'ok' }),
  ]);
  bridge(sb, ['run', 'init']);
  const r19 = bridge(sb, ['ask', '--card', card(sb, 'T-001.result', goodCard('T-001'))]);
  check('S19 turn ceiling ends the run', stateOf(sb)?.status === 'exhausted', `status=${stateOf(sb)?.status} reason=${stateOf(sb)?.stopReason}`);
  check('S19 turn ceiling names itself', /maxTurnsTotal/.test(stateOf(sb)?.stopReason ?? ''), stateOf(sb)?.stopReason);
  check('S19 the verdict still returned', r19.code === 0, `code=${r19.code}`);

  /* --- S20: the lock is reclaimed, and released on a forced exit --------- */
  writeSandboxConfig(sb);
  resetRun(sb);
  stubScript(sb, [{ message: PLAN }]);
  writeFileSync(join(sb.dir, 'state', 'lock.json'),
    JSON.stringify({ pid: 999999999, at: new Date(0).toISOString(), expiresAt: Date.now() + 3600000 }), 'utf8');
  bridge(sb, ['run', 'init']);
  check('S20 a dead holder\'s lock is reclaimed', !existsSync(join(sb.dir, 'state', 'lock.json')),
    'lock file survived run init');
  check('S20 the run proceeded past the stale lock', stateOf(sb)?.status === 'running', stateOf(sb)?.status);

  const future = Date.now() + 3600000;
  writeFileSync(join(sb.dir, 'state', 'lock.json'),
    JSON.stringify({ pid: process.pid, at: new Date().toISOString(), expiresAt: future }), 'utf8');
  setSandboxTimeouts(sb, { lockWaitMs: 1200 });
  const locked = bridge(sb, ['status']);
  check('S20 status needs no lock', locked.code === 0, `code=${locked.code}`);
  rmSync(join(sb.dir, 'state', 'lock.json'), { force: true });

  /* --- S21: a live lock makes ask fail fast instead of hanging ----------- */  writeSandboxConfig(sb);
  resetRun(sb);
  stubScript(sb, [{ message: PLAN }]);
  bridge(sb, ['run', 'init']);
  setSandboxTimeouts(sb, { lockWaitMs: 1200 });
  const start = Date.now();
  writeFileSync(join(sb.dir, 'state', 'lock.json'),
    JSON.stringify({ pid: process.pid, at: new Date().toISOString(), expiresAt: Date.now() + 3600000 }), 'utf8');
  const blocked = bridge(sb, ['ask', '--card', card(sb, 'T-001.result', goodCard('T-001'))]);
  const waited = Date.now() - start;
  rmSync(join(sb.dir, 'state', 'lock.json'), { force: true });
  check('S21 a held lock makes ask give up', blocked.code === 5, `code=${blocked.code}`);
  check('S21 the refusal names the lock', blocked.json?.code === 'LOCK', JSON.stringify(blocked.json).slice(0, 200));
  check('S21 it waited rather than spinning', waited >= 1000 && waited < 15000, `waited=${waited}ms`);
  check('S21 no tokens were spent while blocked', stubCalls(sb).length === 1, `calls=${stubCalls(sb).length}`);

  /* --- S22: a spawn the runtime denies is not billed -------------------- */
  writeSandboxConfig(sb, {
    budgets: {
      maxRounds: 40, maxCodexCallsPerTask: 6, maxReviseAttempts: 2, maxRepairAttempts: 1,
      maxTurnsTotal: 200, maxRequestsPerDay: 2, maxTokensPerDay: 1500000, maxTokensPerCall: 120000,
    },
  });
  resetRun(sb);
  stubScript(sb, [{ message: PLAN }]);
  bridge(sb, ['run', 'init']);                       // reaches the model, costs 1 request
  const before22 = budgetOf(sb);
  check('S22 init was charged', before22?.requests === 1, JSON.stringify(before22));

  // Point the driver at a path that exists but cannot be executed. `spawn` then
  // emits an 'error' event, which is exactly what a denied process creation does
  // and is distinct from "the CLI ran and failed".
  const badDir = join(sb.dir, 'state', 'not-an-executable');
  mkdirSync(badDir, { recursive: true });
  const prevExe = sb.cfg.codex.exePath;
  const prevArgs = sb.cfg.codex.nodeArgs;
  sb.cfg.codex.exePath = badDir;
  sb.cfg.codex.nodeArgs = [];
  writeSandboxConfig(sb, { codex: { ...sb.cfg.codex } });

  const denied = bridge(sb, ['ask', '--card', card(sb, 'T-001.result', goodCard('T-001'))]);
  const after22 = budgetOf(sb);
  check('S22 a denied spawn still fails loudly', denied.code === 5, `code=${denied.code}`);
  check('S22 the failure is reported as a spawn failure',
    /SPAWN_FAILED/.test(denied.json?.reason ?? ''), JSON.stringify(denied.json).slice(0, 240));
  check('S22 a denied spawn costs no request', after22?.requests === before22?.requests,
    `before=${before22?.requests} after=${after22?.requests}`);
  check('S22 a denied spawn costs no tokens', after22?.tokens === before22?.tokens,
    `before=${before22?.tokens} after=${after22?.tokens}`);
  check('S22 the attempt is still recorded as unreached', (after22?.unreachedAttempts ?? 0) >= 1,
    JSON.stringify(after22));

  sb.cfg.codex.exePath = prevExe;
  sb.cfg.codex.nodeArgs = prevArgs;
  writeSandboxConfig(sb, { codex: { ...sb.cfg.codex } });

  /* --- S23: an empty queue must NOT end the run ------------------------- */
  // The bridge deciding "no tasks queued => stop" would be the transport layer
  // playing orchestrator. `pass` already means "stop this iteration"; whether the
  // project needs more work is the brain's call.
  writeSandboxConfig(sb);
  resetRun(sb);
  stubScript(sb, [{ message: PLAN }]);
  bridge(sb, ['run', 'init']);
  stubScript(sb, [
    verdict({ action: 'pass', reason: 'done', feedbackForExecutor: 'none', reworkInstructions: null, nextTask: null, summaryForRolling: 'ok' }),
    verdict({ action: 'pass', reason: 'drained', feedbackForExecutor: 'none', reworkInstructions: null, nextTask: null, summaryForRolling: 'drained' }),
  ]);
  // T-001 is still pending in the queue, so a pass hands off to it rather than idling.
  const r23 = bridge(sb, ['ask', '--card', card(sb, 'T-001.result', goodCard('T-001'))]);
  check('S23 a pass with work left still exits 0', r23.code === 0, `code=${r23.code}`);
  check('S23 a pending task is picked up rather than stopping',
    stateOf(sb)?.status === 'running' && stateOf(sb)?.currentTaskId === 'T-002',
    `status=${stateOf(sb)?.status} current=${stateOf(sb)?.currentTaskId}`);
  check('S23 a resumable verdict still carries a continue descriptor',
    r23.json?.continue?.taskId === 'T-002', JSON.stringify(r23.json?.continue));

  // Now drain it: T-002 pass leaves nothing pending. That must NOT be a stop.
  const r23drain = bridge(sb, ['ask', '--card', card(sb, 'T-002.result', goodCard('T-002'))]);
  check('S23 draining the queue leaves the run resumable',
    stateOf(sb)?.status === 'idle' && stateOf(sb)?.stopReason === null,
    `status=${stateOf(sb)?.status} reason=${stateOf(sb)?.stopReason} code=${r23drain.code}`);
  check('S23 an idle queue offers no continuation', r23drain.json?.continue === null,
    JSON.stringify(r23drain.json?.continue));
  // And the run is still usable, not dead.
  const statusAfter = bridge(sb, ['status']);
  check('S23 status still reports the run after idling', statusAfter.code === 0 && statusAfter.json?.status === 'idle',
    JSON.stringify(statusAfter.json).slice(0, 160));

  /* --- S24: --note is carried, and bounded ----------------------------- */
  writeSandboxConfig(sb);
  resetRun(sb);
  stubScript(sb, [{ message: PLAN }]);
  bridge(sb, ['run', 'init']);
  stubScript(sb, [verdict({ action: 'stop', reason: 'noted', feedbackForExecutor: 'none', reworkInstructions: null, nextTask: null, summaryForRolling: 'ok' })]);
  const r24 = bridge(sb, ['ask', '--card', card(sb, 'T-001.result', goodCard('T-001')), '--note', 'the spec was ambiguous so I chose the safer reading']);
  check('S24 ask with a note exits 30', r24.code === 30, `code=${r24.code}`);
  check('S24 the note reached the brain',
    stubCalls(sb).some((c) => c.promptHead.includes('<note_from_executor>')
      && c.promptHead.includes('safer reading')), 'note block missing from the prompt');

  const callsBefore24 = stubCalls(sb).length;
  const r24b = bridge(sb, ['ask', '--card', card(sb, 'T-001.result', goodCard('T-001')), '--note', 'x'.repeat(2000)]);
  check('S24 an oversized note is refused -> exit 6', r24b.code === 6, `code=${r24b.code}`);
  check('S24 an oversized note spends no tokens', stubCalls(sb).length === callsBefore24,
    `calls=${stubCalls(sb).length} before=${callsBefore24}`);

  /* --- S25: auto-compact keeps the thread bounded ----------------------- */
  // The stub reports 1000 input tokens per call, so a limit of 500 is crossed by
  // the very first call: the next ask must roll over before it runs.
  writeSandboxConfig(sb, {
    budgets: {
      maxRounds: 40, maxCodexCallsPerTask: 6, maxReviseAttempts: 2, maxRepairAttempts: 1,
      maxTurnsTotal: 200, maxRequestsPerDay: 60, maxTokensPerDay: 500000, maxTokensPerCall: 120000,
    },
    compact: { auto: true, maxThreadTokens: 500 },
  });
  resetRun(sb);
  stubScript(sb, [
    { message: PLAN, threadId: 'stub-thread-A' },
    // Consumed in order: the rollover reply, then the real verdict.
    verdict({ action: 'pass', reason: 'rollover complete', feedbackForExecutor: 'none', reworkInstructions: null, nextTask: null, summaryForRolling: 'rolled' }),
    verdict({ action: 'stop', reason: 'REAL-VERDICT', feedbackForExecutor: 'none', reworkInstructions: null, nextTask: null, summaryForRolling: 'done' }),
  ]);
  bridge(sb, ['run', 'init']);
  const cfg25 = JSON.parse(readFileSync(sb.configPath, 'utf8'));
  check('S25 the sandbox carries the compact override',
    cfg25.compact?.auto === true && cfg25.compact?.maxThreadTokens === 500, JSON.stringify(cfg25.compact));
  check('S25 the thread token counter is tracked', (stateOf(sb)?.threadTokens ?? 0) === 1000,
    `threadTokens=${stateOf(sb)?.threadTokens}`);

  const s25 = bridge(sb, ['ask', '--card', card(sb, 'T-001.result', goodCard('T-001'))]);
  check('S25 the real verdict is the one returned, not the rollover ack',
    s25.code === 30 && s25.json?.reason === 'REAL-VERDICT',
    `code=${s25.code} reason=${s25.json?.reason}`);
  const kinds25 = readFileSync(join(sb.dir, 'state', 'decisions.jsonl'), 'utf8')
    .split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l).kind; } catch { return '?'; } });
  check('S25 auto-compact fired before the call', kinds25.includes('auto_compact'), `kinds=${kinds25.join(',')}`);
  check('S25 the rollover landed on a different thread', stateOf(sb)?.threadId !== 'stub-thread-A',
    `threadId=${stateOf(sb)?.threadId}`);

  const order25 = stubCalls(sb);
  check('S25 the rollover ran before the verdict call',
    order25.length === 3 && order25[0].isResume === false && order25[1].isResume === false && order25[2].isResume === true,
    `calls=${order25.map((c) => (c.isResume ? 'resume' : 'fresh')).join(',')}`);

  /* --- S25b: auto-compact yields when there is no headroom -------------- */
  writeSandboxConfig(sb, {
    budgets: {
      maxRounds: 40, maxCodexCallsPerTask: 6, maxReviseAttempts: 2, maxRepairAttempts: 1,
      maxTurnsTotal: 200, maxRequestsPerDay: 1, maxTokensPerDay: 1500000, maxTokensPerCall: 120000,
    },
    compact: { auto: true, maxThreadTokens: 500 },
  });
  resetRun(sb);
  stubScript(sb, [{ message: PLAN }, verdict({ action: 'stop', reason: 'no room to roll', feedbackForExecutor: 'none', reworkInstructions: null, nextTask: null, summaryForRolling: 'ok' })]);
  bridge(sb, ['run', 'init']);
  const s25b = bridge(sb, ['ask', '--card', card(sb, 'T-001.result', goodCard('T-001'))]);
  // With maxRequestsPerDay=1 the init already spent it, so the ask is refused by
  // the gate rather than by a failed rollover -- either way no crash, no stuck lock.
  check('S25b a rollover without headroom does not crash the ask',
    [3, 30, 5].includes(s25b.code), `code=${s25b.code} ${JSON.stringify(s25b.json).slice(0, 200)}`);
  check('S25b the lock was released', !existsSync(join(sb.dir, 'state', 'lock.json')));

  /* --- S26: the lifetime deadline is measured against ACTIVE time -------- */
  // `createdAt` alone used to be the anchor, so an idle gap (a crashed executor, an
  // overnight pause) consumed the run's life and killed a run that had barely worked.
  // The deadline now reads lastActiveAt, which only advances when the bridge or an
  // executor actually does something.
  writeSandboxConfig(sb, {
    timeouts: { codexCallMs: 20000, codexStartupMs: 5000, killGraceMs: 1000, lockTtlMs: 60000, lockWaitMs: 5000, maxRunDurationMs: 400 },
  });
  resetRun(sb);
  stubScript(sb, [{ message: PLAN }]);
  bridge(sb, ['run', 'init']);
  // Backdate the activity anchor: a loop that has been WORKING continuously.
  const st26pre = stateOf(sb);
  st26pre.lastActiveAt = new Date(Date.now() - 5000).toISOString();
  st26pre.createdAt = new Date(Date.now() - 5000).toISOString();
  st26pre.activeMs = 5000;
  writeJsonAtomic(join(sb.dir, 'state', 'state.json'), st26pre);
  const callsBefore26 = stubCalls(sb).length;
  const r26 = bridge(sb, ['ask', '--card', card(sb, 'T-001.result', goodCard('T-001'))]);
  check('S26 a run past its deadline is refused -> exit 3', r26.code === 3, `code=${r26.code} ${JSON.stringify(r26.json).slice(0, 200)}`);
  check('S26 the deadline names itself', r26.json?.gate === 'MAX_DURATION', JSON.stringify(r26.json).slice(0, 200));
  check('S26 the expired run spends no tokens', stubCalls(sb).length === callsBefore26,
    `calls=${stubCalls(sb).length}`);

  /* --- S26c: an idle gap does not consume the run's life ---------------- */
  // The observed failure: an executor crashed, nobody was at the keyboard for 5.5h,
  // and the next ask was refused with "alive 398min" even though the run had done a
  // couple of rounds of real work. Idle time is not a budget.
  writeSandboxConfig(sb, {
    timeouts: { codexCallMs: 20000, codexStartupMs: 5000, killGraceMs: 1000, lockTtlMs: 60000, lockWaitMs: 5000, maxRunDurationMs: 600000 },
  });
  resetRun(sb);
  stubScript(sb, [{ message: PLAN }]);
  bridge(sb, ['run', 'init']);
  const st26c = stateOf(sb);
  // Created long ago, but idle for all of it: activeMs is small and lastActiveAt is old.
  st26c.createdAt = new Date(Date.now() - 6 * 3600_000).toISOString();
  st26c.lastActiveAt = new Date(Date.now() - 30_000).toISOString();
  st26c.activeMs = 30_000;
  writeJsonAtomic(join(sb.dir, 'state', 'state.json'), st26c);

  stubScript(sb, [verdict({ action: 'stop', reason: 'idle gap did not kill this run', feedbackForExecutor: 'x', reworkInstructions: null, nextTask: null, summaryForRolling: 'x' })]);
  const r26c = bridge(sb, ['ask', '--card', card(sb, 'T-001.result', goodCard('T-001'))]);
  check('S26c a 6h-old run that was idle is NOT refused',
    r26c.code === 30, `code=${r26c.code} ${JSON.stringify(r26c.json).slice(0, 200)}`);
  check('S26c the activity anchor advanced',
    Date.now() - Date.parse(stateOf(sb).lastActiveAt) < 60000,
    `lastActiveAt=${stateOf(sb).lastActiveAt}`);
  check('S26c active time was banked',
    (stateOf(sb).activeMs ?? 0) > 30000, `activeMs=${stateOf(sb).activeMs}`);

  /* --- S26d: a stopped run is resumable by a human note ----------------- */
  // The handoff file tells the operator to answer with `ask --note`, but that path was
  // unreachable: the status check ran unconditionally, so the documented recovery
  // returned exit 5 and the only way out was run init (full re-plan, new ids, new
  // thread). Three restarts were the observed cost in a real project.
  writeSandboxConfig(sb, {
    timeouts: { codexCallMs: 20000, codexStartupMs: 5000, killGraceMs: 1000, lockTtlMs: 60000, lockWaitMs: 5000, maxRunDurationMs: 600000 },
  });
  resetRun(sb);
  stubScript(sb, [{ message: PLAN }]);
  bridge(sb, ['run', 'init']);
  const stoppedCard = card(sb, 'T-001.result', goodCard('T-001'));

  // Reach a stopped state through a real verdict.
  stubScript(sb, [verdict({ action: 'stop', reason: 'need a human answer', feedbackForExecutor: 'which of the two files?', reworkInstructions: null, nextTask: null, summaryForRolling: 'asked' })]);
  const rStop = bridge(sb, ['ask', '--card', stoppedCard]);
  check('S26d the stop is recorded', rStop.code === 30 && stateOf(sb).status === 'stopped', `code=${rStop.code}`);
  check('S26d the stop remembers its task',
    stateOf(sb).stoppedForTaskId === 'T-001', `stoppedForTaskId=${stateOf(sb).stoppedForTaskId}`);

  // Without a note it must still refuse: an unattended loop may not restart itself.
  const noNote = bridge(sb, ['ask', '--card', stoppedCard]);
  check('S26d without a note the stopped run is still refused',
    noNote.code === 5, `code=${noNote.code}`);
  check('S26d the refusal points at the note',
    /--note/.test(noNote.json?.hint ?? ''), (noNote.json?.hint ?? '').slice(0, 160));

  // With a note, the run resumes on the SAME run and thread.
  const runIdBefore = stateOf(sb).runId;
  stubScript(sb, [verdict({ action: 'pass', reason: 'answered, carry on', feedbackForExecutor: 'none', reworkInstructions: null, nextTask: null, summaryForRolling: 'resumed' })]);
  const resumed = bridge(sb, ['ask', '--card', stoppedCard, '--note', 'use the second file']);
  check('S26d a note resumes the stopped run',
    resumed.code === 0, `code=${resumed.code} ${JSON.stringify(resumed.json).slice(0, 200)}`);
  check('S26d the same run continues',
    stateOf(sb).runId === runIdBefore, `${stateOf(sb).runId} vs ${runIdBefore}`);
  check('S26d the run is no longer stopped',
    stateOf(sb).status !== 'stopped' && stateOf(sb).stopReason === null,
    `status=${stateOf(sb).status} stopReason=${stateOf(sb).stopReason}`);
  check('S26d the resume counter advanced',
    stateOf(sb).humanResumes === 1, `humanResumes=${stateOf(sb).humanResumes}`);
  check('S26d the resume is recorded with the note',
    readFileSync(join(sb.dir, 'state', 'decisions.jsonl'), 'utf8').includes('resumed_by_human')
    && readFileSync(join(sb.dir, 'state', 'decisions.jsonl'), 'utf8').includes('use the second file'));
  // Regression guard: the stop verdict is cached under the same key as the note-bearing
  // call (a stop is not a revise attempt, so `attempt` is unchanged), so replaying the
  // cache would hand back the very stop the note was answering.
  check('S26d answering a stop is not served from the replay cache',
    (() => {
      const lines = readFileSync(join(sb.dir, 'state', 'decisions.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
      const afterResume = lines.slice(lines.findIndex((l) => l.includes('resumed_by_human')));
      // A replay entry AFTER the resume would mean the note never reached the brain.
      return !afterResume.some((l) => l.includes('ask_replayed'));
    })(),
    'the note must reach the brain, not the cache');

  /* --- S26b: run init restarts the wall clock ---------------------------- */
  // Regression guard. `run init` used to keep the previous run's createdAt, so a
  // long-lived project tripped maxRunDurationMs on every re-init and could never
  // run at all -- the deadline fired forever.
  writeSandboxConfig(sb, {
    timeouts: { codexCallMs: 20000, codexStartupMs: 5000, killGraceMs: 1000, lockTtlMs: 60000, lockWaitMs: 5000, maxRunDurationMs: 60000 },
  });
  resetRun(sb);
  stubScript(sb, [{ message: PLAN }]);
  bridge(sb, ['run', 'init']);
  // Backdate createdAt to simulate a run that started long ago.
  const st26 = stateOf(sb);
  st26.createdAt = new Date(Date.now() - 3600_000).toISOString();
  st26.status = 'exhausted';
  st26.stopReason = 'from a previous life';
  writeJsonAtomic(join(sb.dir, 'state', 'state.json'), st26);

  stubScript(sb, [{ message: PLAN }]);
  bridge(sb, ['run', 'init']);
  const fresh = stateOf(sb);
  check('S26b run init resets the wall clock',
    Date.now() - Date.parse(fresh.createdAt) < 120000,
    `createdAt=${fresh.createdAt} age=${Math.round((Date.now() - Date.parse(fresh.createdAt)) / 1000)}s`);
  check('S26b run init clears a stale exhausted status',
    fresh.status === 'running', `status=${fresh.status}`);
  check('S26b run init clears the stale stop reason', fresh.stopReason === null, `stopReason=${fresh.stopReason}`);

  stubScript(sb, [verdict({ action: 'stop', reason: 'fresh run works', feedbackForExecutor: 'none', reworkInstructions: null, nextTask: null, summaryForRolling: 'ok' })]);
  const r26b = bridge(sb, ['ask', '--card', card(sb, 'T-001.result', goodCard('T-001'))]);
  check('S26b the deadline does not fire on a fresh run', r26b.code === 30,
    `code=${r26b.code} ${JSON.stringify(r26b.json).slice(0, 200)}`);

  /* --- S27: unattended mode is expressed in the prompt ------------------ */
  // Asserted directly against the builder: the exact queue contents are the thing
  // under test, and driving it through a full run would only add noise.
  writeSandboxConfig(sb);
  resetRun(sb);
  const cfg27 = loadConfig({ configPath: sb.configPath, rootOverride: sb.dir });
  const state27 = loadState(cfg27);
  const card27 = goodCard('T-001');
  const singleTask = { taskId: 'T-001', title: 'only task', prompt: 'p', verification: 'v', attempts: 1 };
  const emptyQueuePrompt = buildAskPrompt({
    cfg: cfg27, state: state27, card: card27, task: singleTask, queue: [],
  });
  const unattended27 = buildAskPrompt({
    cfg: cfg27, state: state27, card: card27, task: singleTask, queue: [], unattended: true,
  });
  const withQueue27 = buildAskPrompt({
    cfg: cfg27, state: state27, card: card27, task: singleTask,
    queue: [{ taskId: 'T-002', state: 'pending', title: 'later' }],
  });

  check('S27 an empty queue is stated explicitly in the prompt',
    emptyQueuePrompt.includes('EMPTY -- no tasks remain queued.'), emptyQueuePrompt.slice(0, 200));
  check('S27 an empty queue asks the brain to decide continue-or-finish',
    /queue is empty[\s\S]*Return "next"/.test(emptyQueuePrompt));
  check('S27 a non-empty queue is listed instead',
    withQueue27.includes('T-002 [pending] later') && !withQueue27.includes('EMPTY'),
    (withQueue27.match(/<queue>[\s\S]*?<\/queue>/) ?? ['(none)'])[0]);

  check('S27 unattended mode tells the brain to keep the loop alive',
    unattended27.includes('UNATTENDED RUN') && unattended27.includes('return "next"'),
    unattended27.slice(0, 120));
  check('S27 unattended mode names when to ask for a human',
    /Ask for a human ONLY when/.test(unattended27) && /reversible/.test(unattended27));
  check('S27 unattended mode says nobody will prompt the executor again',
    /nobody will prompt the executor again/.test(unattended27));
  check('S27 a normal ask omits the unattended policy',
    !emptyQueuePrompt.includes('UNATTENDED RUN'));
  check('S27 the unattended preamble stays terse',
    unattended27.split('<state>')[0].length < 1400,
    `preamble=${unattended27.split('<state>')[0].length} chars`);

  /* --- S28: the unattended chain ------------------------- */
  // Drives the real driver: executor -> card -> brain -> next -> executor, with a
  // fake executor so nothing is spent. This is the whole point of the feature, so it
  // is asserted end to end rather than unit by unit.
  writeSandboxConfig(sb, {
    compact: { auto: false, maxThreadTokens: 999999999 },
    maxExecutorRuns: 5,
  });
  resetRun(sb);
  const ONE_TASK = {
    goal: 'chain',
    tasks: [{ taskId: 'T-001', title: 'first', prompt: 'p1', verification: 'v1' }],
  };
  stubScript(sb, [
    { message: ONE_TASK, threadId: 'chain-thread' },
    verdict({
      action: 'next', reason: 'more work', feedbackForExecutor: 'none', reworkInstructions: null,
      nextTask: { taskId: 'T-002', title: 'second', prompt: 'p2', verification: 'v2' },
      summaryForRolling: 'n1',
    }),
    verdict({
      action: 'next', reason: 'still more', feedbackForExecutor: 'none', reworkInstructions: null,
      nextTask: { taskId: 'T-003', title: 'third', prompt: 'p3', verification: 'v3' },
      summaryForRolling: 'n2',
    }),
    verdict({ action: 'pass', reason: 'ALL DONE', feedbackForExecutor: 'none', reworkInstructions: null, nextTask: null, summaryForRolling: 'done' }),
  ]);
  bridge(sb, ['run', 'init']);

  const card28 = card(sb, 'T-001.result', goodCard('T-001'));   // stage the first task's card
  const executorCmd = `"${process.execPath}" "${join(ROOT, 'tools', 'fake-executor.mjs')}" {taskId} {root}`;
  // Absolute card path: the bridge runs with cwd=ROOT here, so a bare
  // state/cards/... would resolve against the framework, not the sandbox.
  const chain = bridge(sb, ['ask', '--card', card28, '--unattended', '--executor', executorCmd]);

  check('S28 the chain runs to completion with exit 0', chain.code === 0,
    `code=${chain.code} err=${chain.stderr.slice(0, 300)} OUT=${chain.stdout.slice(0, 200)}`);
  check('S28 every queued task was executed and reported',
    ['T-002', 'T-003'].every((t) => existsSync(join(sb.dir, 'state', 'cards', `${t}.result.json`))),
    'a task in the chain produced no card');
  check('S28 the chain did not run the tasks twice',
    stubCalls(sb).length === 4, `brain calls=${stubCalls(sb).length} expected 4 (1 plan + 3 verdicts)`);

  // stdout must be exactly ONE JSON document for whoever parses the command.
  const out28 = chain.stdout.trim();
  let parsed28 = null;
  try { parsed28 = JSON.parse(out28); } catch { /* reported below */ }
  check('S28 stdout is exactly one parseable JSON document', parsed28 !== null,
    `len=${out28.length} head=${out28.slice(0, 120)}`);
  check('S28 the final verdict is the brain\'s last answer', parsed28?.action === 'pass' && parsed28?.reason === 'ALL DONE',
    `action=${parsed28?.action} reason=${parsed28?.reason}`);
  check('S28 the run ends idle, not stopped', stateOf(sb)?.status === 'idle',
    `status=${stateOf(sb)?.status} reason=${stateOf(sb)?.stopReason}`);

  const kinds28 = readFileSync(join(sb.dir, 'state', 'decisions.jsonl'), 'utf8')
    .split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l).kind; } catch { return '?'; } });
  check('S28 the chain used the driver, not just one round',
    kinds28.filter((k) => k === 'executor_launch').length === 2,
    `launches=${kinds28.filter((k) => k === 'executor_launch').length}`);
  check('S28 the chain ended by the brain stopping it, not by failing',
    kinds28.includes('unattended_done') && !kinds28.includes('unattended_stop'),
    `kinds=${kinds28.join(',')}`);
  check('S28 the lock was released', !existsSync(join(sb.dir, 'state', 'lock.json')));

  /* --- S28b: a failing executor stops the chain and asks for a human ---- */
  writeSandboxConfig(sb, {
    compact: { auto: false, maxThreadTokens: 999999999 },
    maxExecutorRuns: 5,
  });
  resetRun(sb);
  stubScript(sb, [
    { message: ONE_TASK },
    verdict({
      action: 'next', reason: 'more work', feedbackForExecutor: 'none', reworkInstructions: null,
      nextTask: { taskId: 'T-002', title: 'second', prompt: 'p2', verification: 'v2' },
      summaryForRolling: 'n1',
    }),
  ]);
  bridge(sb, ['run', 'init']);
  card(sb, 'T-001.result', goodCard('T-001'));
  const broken = bridge(sb, ['ask', '--card', card(sb, 'T-001.result', goodCard('T-001')), '--executor', '"definitely-not-a-program" --nope']);
  check('S28b a broken executor stops the chain', broken.code === 5, `code=${broken.code}`);
  check('S28b it reports the executor failure', broken.json?.code === 'EXECUTOR_FAILED',
    JSON.stringify(broken.json).slice(0, 200));
  check('S28b it parks a handoff for a human',
    String(broken.json?.handoff ?? '').includes('executor-failed'),
    `handoff=${broken.json?.handoff}`);
  check('S28b it did not silently retry', stubCalls(sb).length === 2,
    `brain calls=${stubCalls(sb).length} expected 2 (plan + one verdict)`);

  /* --- S29: the queue mirror never breaks the loop ---------------------- */
  // The mirror is only exercised when configured, so offline the important
  // properties are: it is off by default, and the report it would send is bounded
  // and never invites a reply (the app runs a model turn per queued message).
  const cfg29 = loadConfig({ configPath: sb.configPath, rootOverride: sb.dir });
  check('S29 the mirror is off unless configured',
    cfg29.queueMirror?.enabled === false && cfg29.queueMirror?.thread === null,
    JSON.stringify(cfg29.queueMirror));
  check('S29 mirrorEnabled respects the flag', mirrorEnabled(cfg29) === false);
  check('S29 mirrorEnabled needs a thread',
    mirrorEnabled({ ...cfg29, queueMirror: { enabled: true, thread: null } }) === false);
  check('S29 mirrorEnabled turns on with both',
    mirrorEnabled({ ...cfg29, queueMirror: { enabled: true, thread: 'abc' } }) === true);
  // The flag alone must work: requiring the config too made `--mirror-thread` fail
  // silently, which is indistinguishable from "the mirror is broken".
  check('S29 --mirror-thread alone is enough',
    mirrorEnabled(cfg29, 'abc') === true,
    'a passed --mirror-thread must turn the mirror on without config changes');
  check('S29 an explicit flag overrides a configured thread',
    mirrorEnabled({ ...cfg29, queueMirror: { enabled: true, thread: 'from-config' } }, 'from-flag') === true);
  check('S29 no thread anywhere is still off', mirrorEnabled(cfg29, undefined) === false);

  const longReason = 'r'.repeat(2000);
  const report29 = renderVerdictReport({
    verdict: { action: 'rework', reason: longReason, feedbackForExecutor: 'f'.repeat(2000), reworkInstructions: 'i'.repeat(3000) },
    taskId: 'T-001',
    state: { rounds: 3, status: 'running' },
    usage: { total: 12345 },
    continuation: { taskId: 'T-002', launchCommand: 'x' },
  });
  check('S29 the report stays bounded even with long inputs',
    report29.length < 1600, `len=${report29.length}`);
  check('S29 the report names the action and task',
    report29.includes('REWORK') && report29.includes('T-001'));
  check('S29 the report says no reply is needed',
    /No reply needed/i.test(report29));
  check('S29 the report names the next task',
    report29.includes('T-002'));

  // A push with no target must fail safely rather than throw.
  const noTarget = pushToChat({ ...cfg29, queueMirror: { enabled: false, thread: null } }, 'x');
  check('S29 a push without a thread fails safely',
    noTarget.ok === false && /no chat thread/i.test(noTarget.reason), JSON.stringify(noTarget));

  /* --- S30: reasoning effort is a fresh-exec-only override ------------- */
  // It has no dedicated flag, so it goes through -c; and `codex exec resume` accepts
  // no -c at all, so it can only apply when the thread is created.
  const cfg30 = loadConfig({ configPath: sb.configPath, rootOverride: sb.dir });
  check('S30 reasoning effort defaults to unset',
    cfg30.codex.reasoningEffort === null, JSON.stringify(cfg30.codex.reasoningEffort));

  const { buildArgsForTest } = await import('./driver-exec.mjs');
  const fresh30 = buildArgsForTest(
    { ...cfg30, codex: { ...cfg30.codex, reasoningEffort: 'high' } },
    { threadId: null, schemaPath: 'S', lastMessagePath: 'L' },
  );
  const effIdx = fresh30.indexOf('-c');
  check('S30 a fresh call passes the effort override',
    effIdx >= 0 && fresh30[effIdx + 1] === 'model_reasoning_effort="high"',
    JSON.stringify(fresh30.join(' ')).slice(0, 240));

  const resumed30 = buildArgsForTest(
    { ...cfg30, codex: { ...cfg30.codex, reasoningEffort: 'high' } },
    { threadId: 'thread-x', schemaPath: 'S', lastMessagePath: 'L' },
  );
  check('S30 a resume does not try to pass it (resume takes no -c)',
    !resumed30.includes('-c') && resumed30.includes('resume'),
    JSON.stringify(resumed30.join(' ')).slice(0, 240));

  const off30 = buildArgsForTest(
    { ...cfg30, codex: { ...cfg30.codex, reasoningEffort: null } },
    { threadId: null, schemaPath: 'S', lastMessagePath: 'L' },
  );
  check('S30 unset effort adds nothing to argv',
    !off30.includes('model_reasoning_effort'), JSON.stringify(off30.join(' ')).slice(0, 200));

  /* --- S31: config migration ------------------------------------------- */
  // Why this exists: `init` and `install-bridge` never overwrite an existing config
  // (clobbering tuned limits would be worse than any drift), so a project created
  // before a key existed has no path to adopt it. `reasoningEffort` was the first
  // real case: a new config surface that silently did nothing in older projects.
  const legacyDir = join(sb.dir, 'legacy');
  rmSync(legacyDir, { recursive: true, force: true });
  mkdirSync(join(legacyDir, 'config'), { recursive: true });
  const legacyPath = join(legacyDir, 'config', 'run.config.json');
  writeFileSync(legacyPath, JSON.stringify({
    // Deliberately old schema: no configVersion, no reasoningEffort, no compact,
    // and hand-tuned values that MUST survive.
    project: { name: 'legacy', workspace: join(legacyDir, 'work') },
    codex: { exePath: null, model: null, sandbox: 'workspace-write', workdir: join(legacyDir, 'scratch') },
    budgets: { maxRounds: 7, maxRequestsPerDay: 42, maxTokensPerDay: 999 },
    summary: { oneLineMaxChars: 250 },
  }, null, 2), 'utf8');

  const dry = bridge(sb, ['upgrade-config', legacyDir, '--dry-run']);
  check('S31 a dry run reports the missing keys', dry.code === 0 && dry.json?.addedCount > 0,
    `code=${dry.code} added=${dry.json?.addedCount}`);
  check('S31 a dry run writes nothing',
    JSON.parse(readFileSync(legacyPath, 'utf8')).configVersion === undefined);

  const up = bridge(sb, ['upgrade-config', legacyDir]);
  check('S31 the upgrade runs', up.code === 0 && up.json?.written === true, JSON.stringify(up.json).slice(0, 200));

  const migrated = JSON.parse(readFileSync(legacyPath, 'utf8'));
  check('S31 the key that motivated this is added',
    Object.prototype.hasOwnProperty.call(migrated.codex, 'reasoningEffort'),
    `codex keys: ${Object.keys(migrated.codex).join(',')}`);
  check('S31 hand-tuned values are NOT overwritten',
    migrated.budgets.maxRounds === 7
    && migrated.budgets.maxRequestsPerDay === 42
    && migrated.budgets.maxTokensPerDay === 999
    && migrated.summary.oneLineMaxChars === 250,
    JSON.stringify(migrated.budgets) + JSON.stringify(migrated.summary));
  check('S31 new keys arrive with their defaults',
    migrated.budgets.maxReviseAttempts === 2 && migrated.compact?.auto === true,
    JSON.stringify(migrated.budgets));
  check('S31 the schema version is stamped',
    migrated.configVersion === 2, `configVersion=${migrated.configVersion}`);

  // Idempotent: a second run must find nothing to do.
  const again = bridge(sb, ['upgrade-config', legacyDir]);
  check('S31 a second upgrade is a no-op',
    again.code === 0 && again.json?.addedCount === 0 && again.json?.written === false,
    JSON.stringify(again.json).slice(0, 200));

  // And the migrated config must actually load and drive the bridge.
  const probe = bridge(sb, ['--project-root', legacyDir, '--config', legacyPath, 'status']);
  check('S31 the migrated config loads', probe.code === 0 && probe.json?.ok === true,
    `code=${probe.code} ${JSON.stringify(probe.json).slice(0, 200)}`);

  /* --- S32: configurable card limits ----------------------------------- */
  // `summary` used to hard-code the list cardinalities and the per-entry cap, so a
  // project that raised oneLineMaxChars to fit a full report still could not lengthen
  // findings -- the content had nowhere to go and got crammed into one field.
  writeSandboxConfig(sb, {
    summary: {
      oneLineMaxChars: 4000, rollingMaxChars: 60000, cardsKept: 12,
      compactOnOverflow: true,
      entryMaxChars: 1200, maxChangedEntries: 12, maxFindingsEntries: 8,
      maxBlockersEntries: 3, nextHintMaxChars: 900,
    },
  });
  resetRun(sb);
  const longFinding = 'F'.repeat(1200);
  const longHint = 'H'.repeat(900);
  const bigCard = card(sb, 'T-001.result', {
    taskId: 'T-001', status: 'completed',
    summaryOneLine: 'S'.repeat(4000),
    changed: Array.from({ length: 12 }, (_, i) => `f${i}.txt:1`),
    findings: Array.from({ length: 8 }, () => longFinding),
    blockers: ['b1', 'b2', 'b3'],
    verify: { command: 'true', exitCode: 0 },
    nextHint: longHint,
  });
  stubScript(sb, [verdict({ action: 'stop', reason: 'configurable limits ok', feedbackForExecutor: 'none', reworkInstructions: null, nextTask: null, summaryForRolling: 'ok' })]);
  const r32 = bridge(sb, ['ask', '--card', bigCard]);
  check('S32 the widened limits are accepted', r32.code === 30, `code=${r32.code} ${JSON.stringify(r32.json?.error ?? '').slice(0, 160)}`);

  const accepted32 = JSON.parse(readFileSync(join(sb.dir, 'state', 'cards', 'T-001.accepted.json'), 'utf8'));
  check('S32 an 8-entry findings list survives',
    accepted32.findings.length === 8, `got ${accepted32.findings.length}`);
  check('S32 a finding is no longer truncated at 300 chars',
    accepted32.findings[0].length === 1200, `got ${accepted32.findings[0].length} chars`);
  check('S32 the 4000-char summary is kept whole',
    accepted32.summaryOneLine.length === 4000, `got ${accepted32.summaryOneLine.length}`);
  check('S32 nextHint uses its own cap',
    accepted32.nextHint.length === 900, `got ${accepted32.nextHint.length}`);

  // The defaults must still bite, or widening one project silently loosened every other.
  writeSandboxConfig(sb, {});
  resetRun(sb);
  stubScript(sb, []);
  const tight = bridge(sb, ['ask', '--card', card(sb, 'T-001.result', {
    taskId: 'T-001', status: 'completed',
    summaryOneLine: 'ok',
    findings: Array.from({ length: 8 }, () => 'f'),
  })]);
  check('S32 the default caps still reject 8 findings',
    tight.code === 6 && tight.json?.code === 'CARD_INVALID',
    `code=${tight.code} json=${JSON.stringify(tight.json).slice(0, 160)}`);

  /* --- S33: archiving a run -------------------------------------------- */
  // Task ids restart at T-001 every run, so a previous run's cards sit exactly where
  // the next run writes and its rolling summary can adopt the old verdict as history.
  resetRun(sb);
  stubScript(sb, [{ message: PLAN }]);
  bridge(sb, ['run', 'init']);
  const runId33 = stateOf(sb)?.runId;
  card(sb, 'T-001.result', goodCard('T-001'));
  stubScript(sb, [verdict({ action: 'stop', reason: 'archived run', feedbackForExecutor: 'none', reworkInstructions: null, nextTask: null, summaryForRolling: 'ok' })]);
  bridge(sb, ['ask', '--card', join(sb.dir, 'state', 'cards', 'T-001.result.json')]);

  const dry33 = bridge(sb, ['archive-state', '--dry-run']);
  check('S33 a dry run reports what it would archive',
    dry33.code === 0 && dry33.json?.wouldArchive?.runId === runId33,
    JSON.stringify(dry33.json).slice(0, 200));
  check('S33 a dry run does not move anything',
    existsSync(join(sb.dir, 'state', 'state.json')));

  const arch33 = bridge(sb, ['archive-state', '--label', 'before-v2']);
  check('S33 the archive runs', arch33.code === 0 && arch33.json?.ok === true,
    JSON.stringify(arch33.json).slice(0, 200));
  check('S33 it reports the archived run id', arch33.json?.runId === runId33,
    `${arch33.json?.runId} vs ${runId33}`);
  check('S33 the label is part of the directory name',
    String(arch33.json?.archived).includes('before-v2'), arch33.json?.archived);

  const archDir = join(sb.dir, arch33.json.archived);
  check('S33 state was MOVED, not deleted',
    !existsSync(join(sb.dir, 'state', 'state.json'))
    && existsSync(join(archDir, 'state.json')),
    `live=${existsSync(join(sb.dir, 'state', 'state.json'))} archived=${existsSync(join(archDir, 'state.json'))}`);
  check('S33 the verdicts survive the move',
    existsSync(join(archDir, 'decisions.jsonl')) && existsSync(join(archDir, 'cards', 'T-001.accepted.json')));
  check('S33 a provenance README is written',
    existsSync(join(archDir, 'README.md'))
    && readFileSync(join(archDir, 'README.md'), 'utf8').includes(runId33),
    'README must name the run it describes');

  const twice33 = bridge(sb, ['archive-state']);
  check('S33 a second archive refuses an empty state',
    twice33.code === 0 && twice33.json?.ok === false, JSON.stringify(twice33.json).slice(0, 160));

  /* --- S34: run init warns about cross-run collisions ------------------- */
  // Same reason as S33, seen from the other side: the operator needs to be told
  // before the new run starts reading someone else's cards.
  resetRun(sb);
  stubScript(sb, [{ message: PLAN }]);
  bridge(sb, ['run', 'init']);
  const runB = stateOf(sb)?.runId;
  // Plant a card from a run that is not this one.
  card(sb, 'T-001.result', { ...goodCard('T-001'), runId: 'some-older-run' });

  stubScript(sb, [{ message: PLAN }]);
  const reinit = bridge(sb, ['run', 'init']);
  check('S34 a stale artifact is reported on stderr',
    /do not belong to run/.test(reinit.stderr ?? ''),
    (reinit.stderr ?? '').slice(0, 200));
  check('S34 the warning names the offending file',
    /T-001\.result\.json/.test(reinit.stderr ?? ''), (reinit.stderr ?? '').slice(0, 200));
  check('S34 the warning points at the fix',
    /archive-state/.test(reinit.stderr ?? ''), (reinit.stderr ?? '').slice(0, 300));
  check('S34 the run still starts (a warning, not a gate)',
    reinit.code === 0 && stateOf(sb)?.runId === runB,
    `code=${reinit.code} runId=${stateOf(sb)?.runId}`);

  /* --- S35: reasoning-tier discovery ------------------------------------ */
  // The valid tiers are model-specific and there is no CLI flag that lists them, so a
  // wrong value only failed on a real task and a tier ABOVE "high" stayed invisible.
  // The stub cannot emit reasoning tokens, so what is asserted here is the reporting
  // and exit-code contract, not the token counts (those were verified live).
  const { effortAdvice } = await import('./probe-effort.mjs');

  writeSandboxConfig(sb, {});
  resetRun(sb);
  stubScript(sb, [
    verdict({ action: 'stop', reason: 'low ok', feedbackForExecutor: 'x', reworkInstructions: null, nextTask: null, summaryForRolling: 'x' }),
    verdict({ action: 'stop', reason: 'high ok', feedbackForExecutor: 'x', reworkInstructions: null, nextTask: null, summaryForRolling: 'x' }),
  ]);
  const eff = bridge(sb, ['probe-effort', '--tiers', 'low,high']);
  check('S35 the sweep reports every tier it probed',
    eff.code === 0 && eff.json?.results?.length === 2,
    `code=${eff.code} results=${eff.json?.results?.length}`);
  check('S35 a rejected tier is reported as information, not a failure',
    eff.code === 0, `code=${eff.code}`);
  check('S35 it names the configured value for comparison',
    Object.prototype.hasOwnProperty.call(eff.json ?? {}, 'configured'),
    JSON.stringify(eff.json?.configured));
  check('S35 the note explains the compact requirement',
    /compact/.test(eff.json?.note ?? ''), (eff.json?.note ?? '').slice(0, 120));

  // Regression guard on the advice logic: the first version ranked tiers by measured
  // reasoning tokens and, when every tier measured 0 (a trivial prompt), confidently
  // reported "low" as the strongest. Advice must not rank what it could not measure.
  const flat = effortAdvice({
    results: [
      { tier: 'low', ok: true, reasoningTokens: 0, error: null },
      { tier: 'high', ok: true, reasoningTokens: 0, error: null },
    ],
    rejected: [],
  });
  check('S35 advice refuses to rank tiers it could not measure',
    !/highest tier/i.test(flat) && /not distinguishable|cost you accept/i.test(flat),
    flat);

  const scaled = effortAdvice({
    results: [
      { tier: 'low', ok: true, reasoningTokens: 133, error: null },
      { tier: 'xhigh', ok: true, reasoningTokens: 1502, error: null },
    ],
    rejected: [],
  });
  check('S35 advice ranks tiers that did differ',
    /xhigh/.test(scaled) && /1502/.test(scaled), scaled);

  const none = effortAdvice({
    results: [{ tier: 'minimal', ok: false, reasoningTokens: null, error: 'unsupported_value' }],
    rejected: [{ tier: 'minimal', error: 'unsupported_value' }],
  });
  check('S35 a universal rejection blames the model, not the tier',
    /model/i.test(none), none);

  /* --- S36: help and unknown verbs -------------------------------------- */
  // `printHelp` doubles as the "no command matched" signal, and `main` prints it again
  // on an unset exit code -- so a verb that printed it without setting a code emitted
  // the whole usage block twice, and an unknown verb exited 0.
  const help = bridge(sb, ['help']);
  check('S36 help exits 0', help.code === 0, `code=${help.code}`);
  check('S36 help prints exactly once',
    (help.stdout.match(/Codex brain <->/g) ?? []).length === 1,
    `occurrences=${(help.stdout.match(/Codex brain <->/g) ?? []).length}`);

  const bogus = bridge(sb, ['definitely-not-a-verb']);
  check('S36 an unknown verb fails rather than exiting 0',
    bogus.code === 5, `code=${bogus.code}`);
  check('S36 an unknown verb still shows usage',
    (bogus.stdout.match(/Codex brain <->/g) ?? []).length === 1,
    `occurrences=${(bogus.stdout.match(/Codex brain <->/g) ?? []).length}`);

  /* --- S37: value-taking flags ----------------------------------------- */
  // The parser used to hold a whitelist of flags that take a value, so every new one
  // silently became a boolean: `--label before-v2` set label=true and dropped the value
  // into the positional list, where it could be read as a verb.
  const labelled = bridge(sb, ['archive-state', '--label', 'before-v2']);
  // Nothing to archive in a fresh sandbox is fine; what matters is that the value was
  // not swallowed as a boolean and does not turn into a positional.
  check('S37 a flag value is not mistaken for a verb',
    labelled.json?.reason !== undefined || labelled.json?.ok === false || labelled.json?.archived !== undefined,
    JSON.stringify(labelled.json).slice(0, 200));

  /* --- S38: probing survives a missing workdir -------------------------- */
  // `.codex-scratch` is gitignored, so a fresh clone does NOT have it. Spawning with a
  // missing cwd fails ENOENT with status null, which resolveCodexExe read as "this
  // executable does not work" -- so a perfectly good codex.exe was reported as not
  // found, on the very first command a new user runs.
  const missingCwd = join(sb.dir, 'never-created-scratch');
  rmSync(missingCwd, { recursive: true, force: true });
  const { resolveCodexExe } = await import('./driver-exec.mjs');
  const probeCfg = {
    ...loadConfig({ configPath: sb.configPath, rootOverride: sb.dir }),
    __workdir: missingCwd,
  };
  let resolved = null;
  let resolveErr = null;
  try {
    resolved = resolveCodexExe(probeCfg, { fresh: true });
  } catch (err) {
    resolveErr = err;
  }
  check('S38 a missing codex.workdir does not break CLI resolution',
    resolveErr === null,
    resolveErr ? String(resolveErr.message).split('\n')[0] : '');
  check('S38 the workdir is created as a side effect',
    existsSync(missingCwd), missingCwd);

  /* --- S39: install-bridge refuses to eat local patches ---------------- */
  // A project that patched lib/prompt.mjs for its own environment lost the edit to a
  // framework upgrade with no warning and no backup. Silent, and only visible later as
  // changed behaviour.
  const ibDir = join(sb.dir, 'install-target');
  rmSync(ibDir, { recursive: true, force: true });
  mkdirSync(ibDir, { recursive: true });
  const installer = join(ROOT, 'tools', 'install-bridge.mjs');
  const runInstaller = (...args) => spawnSync(process.execPath, [installer, ibDir, ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  const parse = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };

  const ib1 = runInstaller();
  const ib1j = parse(ib1);
  check('S39 a first install copies the bridge',
    ib1.status === 0 && ib1j?.counts?.new > 0, `status=${ib1.status} ${JSON.stringify(ib1j?.counts)}`);
  check('S39 a first install records a manifest',
    existsSync(join(ibDir, '.codex-bridge-manifest.json')), 'manifest must exist for the next run');

  const ib2 = runInstaller();
  check('S39 re-installing an unmodified copy is a no-op',
    ib2.status === 0 && parse(ib2)?.counts?.same === parse(ib2)?.counts?.total,
    JSON.stringify(parse(ib2)?.counts));

  // The project patches a file, then the framework is upgraded (i.e. install runs again).
  const patched = join(ibDir, 'lib', 'prompt.mjs');
  const PATCH = '\n// LOCAL PATCH: this project needs it\n';
  writeFileSync(patched, readFileSync(patched, 'utf8') + PATCH, 'utf8');

  const ib3 = runInstaller();
  const ib3j = parse(ib3);
  check('S39 a locally modified file is refused, not overwritten',
    ib3.status === 3 && ib3j?.refused === true,
    `status=${ib3.status} refused=${ib3j?.refused}`);
  check('S39 the refusal names the file',
    ib3j?.locallyModified?.some((m) => m.file === 'lib/prompt.mjs'),
    JSON.stringify(ib3j?.locallyModified));
  check('S39 the refusal did NOT touch the file',
    readFileSync(patched, 'utf8').includes('LOCAL PATCH'));
  check('S39 the refusal explains both ways forward',
    /--backup/.test(ib3j?.hint ?? '') && /--force/.test(ib3j?.hint ?? ''),
    (ib3j?.hint ?? '').slice(0, 140));

  const ib4 = runInstaller('--dry-run');
  const ib4j = parse(ib4);
  check('S39 a dry run is reported as clean, not as a refusal',
    ib4.status === 0 && ib4j?.refused === undefined && ib4j?.dryRun === true,
    `status=${ib4.status} refused=${ib4j?.refused}`);
  check('S39 a dry run names what would change',
    ib4j?.wouldWrite?.some((w) => w.file === 'lib/prompt.mjs'),
    JSON.stringify(ib4j?.wouldWrite));

  const ib5 = runInstaller('--backup');
  const ib5j = parse(ib5);
  check('S39 --backup proceeds', ib5.status === 0 && ib5j?.ok === true, `status=${ib5.status}`);
  check('S39 --backup keeps the patch in a .bak file',
    (ib5j?.backedUp ?? []).some((b) => b.includes('prompt.mjs.bak-'))
    && readFileSync(join(ibDir, ib5j.backedUp.find((b) => b.includes('prompt.mjs'))), 'utf8').includes('LOCAL PATCH'),
    JSON.stringify(ib5j?.backedUp));
  check('S39 --backup does overwrite the working copy',
    !readFileSync(patched, 'utf8').includes('LOCAL PATCH'));

  // And the manifest now matches, so the next run is clean again.
  const ib6 = runInstaller();
  check('S39 the manifest is updated so the next run is clean',
    ib6.status === 0 && parse(ib6)?.counts?.locallyModified === 0,
    JSON.stringify(parse(ib6)?.counts));

  /* --- S40: a card on stdin ------------------------------------------- */
  // A sandboxed agent may be able to report but not to write a file. `--card -` must
  // work as well as a path, and must not be mistaken for a flag or a verb.
  writeSandboxConfig(sb, {});
  resetRun(sb);
  stubScript(sb, [{ message: PLAN }]);
  bridge(sb, ['run', 'init']);
  stubScript(sb, [verdict({ action: 'stop', reason: 'card arrived on stdin', feedbackForExecutor: 'x', reworkInstructions: null, nextTask: null, summaryForRolling: 'x' })]);
  const stdinCard = JSON.stringify(goodCard('T-001'), null, 2);
  const viaStdin = bridge(sb, ['ask', '--card', '-'], { input: stdinCard });
  check('S40 a card can be submitted on stdin',
    viaStdin.code === 30, `code=${viaStdin.code} ${JSON.stringify(viaStdin.json).slice(0, 200)}`);
  check('S40 the stdin card was actually parsed',
    viaStdin.json?.taskId === 'T-001', `taskId=${viaStdin.json?.taskId}`);

  // An invalid stdin card must be rejected the same way an invalid file is.
  stubScript(sb, []);
  const badStdin = bridge(sb, ['ask', '--card', '-'], { input: '{ not json' });
  check('S40 an invalid stdin card is rejected, not called through',
    badStdin.code === 6, `code=${badStdin.code} ${JSON.stringify(badStdin.json).slice(0, 160)}`);

  /* ---------------------------------------------------------------- report */
  const stateDir = join(sb.dir, 'state');
  writeFileSync(join(stateDir, 'selftest-report.txt'),
    [`selftest: ${passed} passed, ${failures.length} failed`, '', ...results, '', ...failures.map((f) => `FAILED: ${f}`)].join('\n'),
    'utf8');

  process.stdout.write([
    '',
    '================ bridge.mjs selftest ================',
    ...results,
    '',
    `${passed} passed, ${failures.length} failed`,
    `sandbox: ${sb.dir}`,
    `report:  ${join(stateDir, 'selftest-report.txt')}`,
    '',
  ].join('\n'));

  if (!keep) { /* keep the sandbox for inspection; `reset --yes` clears it */ }

  return failures.length === 0 ? 0 : 1;
}
