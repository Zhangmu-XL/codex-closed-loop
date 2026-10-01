# codex-closed-loop

English | [中文](README.zh.md)

**Codex is the brain. Your agent does the work. There is no orchestrator in between.**

An executor agent finishes a task, writes a structured result card, and calls Codex
itself — blocking until Codex answers. Codex decides `pass` / `rework` / `next` /
`stop`, and the executor acts on that. Nobody plans the work except Codex; nobody
sits in the middle pretending to.

```
you
 └─(1) node bridge.mjs run init        ← once. Not an orchestrator.
        └─ bridge calls the Codex CLI
             Codex decomposes the project → state/queue/*.json
                  ↓ bridge prints the launch command
 └─(2) <your agent> reads the task brief and does the work
        └─ writes state/cards/<id>.result.json
             └─(3) node bridge.mjs ask --card <path>    ★ the agent calls Codex itself
                    └─ bridge = transport. Spawns Codex, blocks, returns.
                         Codex answers pass | rework | next | stop
                    ↑ process exit code 0 / 10 / 20 / 30 = the verdict
             ← your agent branches on the exit code and continues
```

Zero runtime dependencies. Node ≥ 20. No `npm install`.

---

## Why this shape

Three properties drive every design decision here:

**1. No orchestrator.** The bridge assembles a summary, calls Codex, charges the
budget, writes state, and returns an exit code. It does not choose tasks, approve
work, or route anything. Splitting decisions from transport is what makes the loop
auditable — every decision in `state/decisions.jsonl` came from Codex.

**2. Summaries only.** The brain never sees a log, a diff, or your filesystem. A
result card is capped (400 chars per summary by default) and the bridge *refuses
oversized cards before spending a token*. Raw event streams land in `state/runs/`
for forensics and never enter a prompt.

**3. Unattended by default.** Nothing requires a human between rounds. Codex is told
explicitly when it may stop and ask for one, and when it may not.

---

## Install

```bash
git clone https://github.com/Zhangmu-XL/codex-closed-loop
cd codex-closed-loop
node bridge.mjs selftest     # 160 offline assertions, no network, no tokens
```

Requirements:

- **Node.js ≥ 20**
- **Codex CLI** installed and logged in (`codex --version`; auth in `~/.codex/auth.json`)
- nothing else

## ⚠️ Read before running it on real work

This tool drives an agent that **runs commands and edits files on your machine**, and
it spends your Codex quota. Before pointing it at anything you care about:

- Read `bridge.mjs` and `lib/`. It is ~1300 lines and has no dependencies — it is meant
  to be audited, not trusted.
- Start with `examples/hello-loop/`, then a throwaway repo. Not your main branch.
- Set `project.workspace` and `codex.workdir` to directories you are willing to lose.
  The default `sandbox: "workspace-write"` is there for a reason; do not reach for
  `danger-full-access` until you trust the setup.
- Check `budgets.*` before an unattended run. They are local gates, not a billing
  control — also set a hard limit in your OpenAI account.
- Look at `state/calls/*.json` after a run. It holds every prompt actually sent, so you
  can verify the "summaries only" claim rather than taking my word for it.

No warranty, MIT licensed, and the [known limits](#known-limits) are real.

## Quick start

```bash
# 1. scaffold a project — one step. Writes the config with a probed codex.exePath,
#    drops in a PROJECT.md template, and copies the bridge in so it is self-contained.
node bridge.mjs init ~/my-project

# 2. edit two files
#    ~/my-project/config/run.config.json  -> point project.workspace at your real code
#    ~/my-project/seeds/PROJECT.md        -> the brain reads this and nothing else

# 3. verify (no tokens)
cd ~/my-project && node bridge.mjs doctor

# 4. let Codex decompose it (one call)
node bridge.mjs run init
```

### Why the copy matters

`init` copies `bridge.mjs` and `lib/` into the project on purpose. The generated task
brief tells the executor to run `<project-root>/bridge.mjs`, so a project without one
produces `MODULE_NOT_FOUND` from a confused agent that then has to guess. If you would
rather keep one checkout driving several projects, re-run
`node tools/install-bridge.mjs <dir>` after updating the framework, or pass
`--project-root` and `--config` explicitly everywhere.

`run init` prints a `launchCommand`. Run it, or point your own agent at the brief.
When the agent has a card, `node bridge.mjs ask --card <path>` closes the round.

### Unattended

```bash
node bridge.mjs ask --card state/cards/T-001.result.json \
  --unattended \
  --executor 'dsh --profile headless "Read {brief} and execute it."'
```

With `--executor` the bridge runs each next task itself and reports the result back
to Codex, repeating until Codex stops asking for more. **Every task prompt still
comes from Codex** — the bridge only walks the loop. That is the difference between
this and an orchestrator.

Placeholders: `{taskId}` `{brief}` `{card}` `{root}`.

### Watch it in the Codex desktop app

A headless `codex exec` thread is real but the app will not show it as a
conversation you can watch. Use **two threads** — the app holds a writer lock on its
own conversations, so they cannot be the same one:

```bash
node bridge.mjs ask --card state/cards/T-001.result.json \
  --mirror-thread "<name or UUID of a chat you opened in the app>"
```

Each verdict is pushed into that conversation with `codex queue`, so you see
`PASS` / `REWORK` / `NEXT` appear while the loop runs. The app runs a small model
turn per pushed message, so the message says "no reply needed" — and you can turn
the mirror off when you are not watching.

---

## Commands

| Command | What it does | Codex calls |
|---|---|---|
| `node bridge.mjs init [dir]` | Scaffold a project: config + `PROJECT.md` template, with a probed `codex.exePath` | 0 |
| `node bridge.mjs doctor [--live]` | Probe CLI, auth, paths. `--live` does one real round-trip | 0 / 1 |
| `node bridge.mjs run init` | Decompose `seeds/PROJECT.md` into a task queue | 1 (0 with a seeded queue) |
| `node bridge.mjs ask --card <path>` | Submit a result card; block for the verdict | 1 |
| `node bridge.mjs status` | Budget, queue, last verdict | 0 |
| `node bridge.mjs compact` | Roll the thread onto a fresh one, reseeded from the summary | 1 |
| `node bridge.mjs selftest` | Offline run of the whole state machine (stub brain) | 0 |
| `node bridge.mjs reset --yes` | Delete all run state | 0 |

`ask` flags: `--note "<msg>"` (≤1000 chars, not a log), `--unattended`,
`--executor "<cmd>"`, `--mirror-thread <id>`, `--no-mirror`.

### Exit codes of `ask`

| Exit | Action | Meaning |
|---|---|---|
| `0` | `pass` | Accepted |
| `10` | `rework` | Not accepted; `instruction.what` says what to change |
| `20` | `next` | Accepted, continue with the next task |
| `30` | `stop` | Halt — Codex is asking for a human |
| `3` | budget | A configured limit was reached |
| `4` | rounds | Round / turn ceiling reached |
| `5` | infra | Transport, config or lock failure |
| `6` | bad card | Card rejected; **no tokens were spent** |

Machine-readable output is one JSON document. The `instruction` block is the single
authority on what to do next:

```json
"instruction": {
  "do": "execute",
  "because": "evidence accepted",
  "taskId": "T-002",
  "readFirst": "seeds/task-T-002.txt",
  "authoritative": "state/queue/T-002.json",
  "thenRun": "node bridge.mjs ask --card state/cards/T-002.result.json",
  "launch": "dsh --profile headless \"Read ...task-T-002.txt and execute it.\""
}
```

`do` is `execute`, `rework` or `stop`. `thenRun` is paste-ready — retry bookkeeping
is the bridge's, so an executor should never rebuild that command.

---

## Configuration

Everything lives in `config/run.config.json`.

### The brain

```jsonc
"codex": {
  "exePath": null,               // null = resolve from PATH / CODEX_CLI_PATH / known install dirs
  "model": null,                 // null = whatever ~/.codex/config.toml says
  "reasoningEffort": null,       // null = inherit; see below
  "sandbox": "workspace-write",  // the brain should not get full access by default
  "workdir": ".codex-scratch"    // where the brain runs, so it cannot touch your code
}
```

### Reasoning effort

There is no `--reasoning-effort` flag on `codex exec` — it is a config key, so the
bridge overrides it with `-c model_reasoning_effort="..."`. Leaving it `null` means
the brain inherits whatever your interactive sessions use, which is often tuned for
chat rather than for judging work.

Measured here (`gpt-5.6-luna`, trivial prompt): `low` produced **0 reasoning tokens**,
`high` produced 18. The value is **model-specific** — that model rejects `minimal`
outright — so a bad value fails on the first call with `unsupported_value` naming the
parameter, rather than degrading quietly.

Only applies to a **fresh** `codex exec`: `resume` accepts no `-c`, so a thread keeps
the effort it was created with, exactly like `--sandbox` and `-m`. Change it, then
`compact` to start a new thread with the new value.

### Limits

```jsonc
"budgets": {
  "maxRounds": 40,               // total Codex round-trips per run
  "maxCodexCallsPerTask": 6,
  "maxReviseAttempts": 2,        // reworks allowed before it must pass or stop
  "maxRepairAttempts": 1,        // repair rounds for a malformed verdict
  "maxTurnsTotal": 200,
  "maxRequestsPerDay": 60,
  "maxTokensPerDay": 1500000
},
"timeouts": {
  "codexCallMs": 900000,         // hard per-call timeout
  "maxRunDurationMs": 21600000   // wall-clock ceiling for a whole run
},
"maxExecutorRuns": 25,           // how many executors one --executor chain may launch
"compact": {
  "auto": true,
  "maxThreadTokens": 150000        // roll the thread over before context grows unbounded
}
```

Token usage is **measured from Codex's own event stream**, not self-reported. Counters
roll over on the `Asia/Shanghai` calendar day. These are local accounting gates, not a
billing control — set a hard limit in your OpenAI account too.

### Summaries

```jsonc
"summary": {
  "oneLineMaxChars": 400,   // per-card cap; oversized cards are refused, free
  "rollingMaxChars": 12288, // total budget for the rolling summary
  "cardsKept": 12
}
```

The rolling summary is assembled **only** from structured fields
(`card.summaryOneLine`, `verdict.summaryForRolling`) by `lib/summary.mjs`. Raw logs
are structurally incapable of reaching a prompt. Compaction is plain string trimming,
so it costs nothing and is reproducible.

If you raise `oneLineMaxChars`, raise `rollingMaxChars` with it or older cards get
evicted sooner. `node tools/check-limits.mjs` verifies both after a change.

---

## Human in the loop

`--unattended` tells the brain to keep the run alive and to **ask for a human only
when**:

- it needs a permission or credential it does not have
- the action is irreversible, destructive, or reaches outside the workspace
- the task is genuinely ambiguous and guessing would waste real work
- the goal is reached, or it can no longer make progress

When it asks, it returns `stop` and the bridge writes
`state/handoff/needs-human-<taskId>.md` with the reason, what it needs, the last
accepted card, and how to resume:

```bash
node bridge.mjs ask --card <card> --note "<your answer>"
```

`stop` is sticky on purpose: the run will not silently restart itself behind your back.

---

## State on disk

```
state/
├─ run-plan.json                 what Codex decomposed
├─ queue/<taskId>.json           task queue; state = pending|in_progress|submitted|accepted
├─ cards/<id>.result.json        the executor's working card (never overwritten by the bridge)
├─ cards/<id>.accepted.json      the bridge's normalized copy (what the brain judged)
├─ calls/                        one archive per round-trip: the exact prompt, the verdict
├─ decisions.jsonl               append-only ledger: plan, verdict, rework, retries, budget stops
├─ budget.json                   daily counters
├─ rolling-summary.md            the only history the brain sees
├─ lock.json                     concurrency lock (the Codex thread is a shared resource)
├─ handoff/                      problems parked for a human
└─ runs/<timestamp>/             raw JSONL event streams — forensics only, never a prompt
```

`state/` is disposable. `node bridge.mjs reset --yes` clears it.

---

## Try it without spending anything

```bash
node bridge.mjs selftest
```

160 assertions, **zero network calls**, driven by a stub brain
(`tools/codex-stub.mjs`) that speaks the real CLI surface. It covers:

- decomposition and dispatch; five classes of card rejection
- every branch of `pass` / `rework` / `next` / `stop`
- idempotent replay, and that a **changed** card really reaches the brain again
- malformed verdict → bounded repair round; rework ceiling
- four budget gates: daily requests, daily tokens, rounds, turns; plus the wall clock
- transport-crash retry; timeout kill; denied spawn not billed
- thread continuity, auto-compact, stateless fallback when no thread id comes back
- the rolling summary staying within budget and containing no raw logs
- stale-lock reclamation; a live lock failing fast
- the full unattended chain, end to end, with a fake executor
- the Codex-app mirror being off by default and never able to break the loop

There is also `examples/hello-loop/`, a self-contained project whose queue is seeded,
so `run init` costs zero calls. Full walkthrough in
[examples/hello-loop/README.md](examples/hello-loop/README.md).

---

## Known limits

Read this before trusting it with something that matters.

- **Concurrency is designed but not stress-tested.** The lock has unit coverage and a
  synthetic stale-lock test; nobody has run two agents against one thread at load.
- **Verified on Windows with `codex-cli 0.159.2` only.** Paths assume Windows in
  places. The macOS/Linux paths are plausible, not proven.
- **The `codex exec --json` event schema is an internal detail**, not a public
  contract. It was reverse-engineered from the binary and pinned by tests against
  one version. A Codex upgrade can break token accounting, thread-id capture or
  usage parsing — the loop degrades to stateless mode rather than failing, but check
  `state/runs/` after upgrading.
- **The brain needs a runtime that can spawn processes.** `codex exec` is driven as a
  child process with piped stdio. In a sandbox that blocks that (DSH's `workspace-write`
  does), `ask` fails with `spawn EPERM`. That is reported as infrastructure failure and
  is **not charged against the budget**, but the loop cannot complete.
- **No real rework cycle has been exercised** — the `rework → pass` path is tested by
  editing a card, never by making an executor genuinely redo work.
- **The MCP transport is not implemented.** Requirements mention
  `codex-controller-mcp` and the Codex API; both are stubs with a documented
  degradation path, not working adapters.
- **`codex exec resume` accepts far fewer flags than a fresh `exec`** — no `-C`, `-s`
  or `-m`. Working directory is therefore the child's cwd, and sandbox/model only
  apply on the first call of a thread. Handled, but surprising.

## How this was built

Most of the bugs this survived were only findable by running it for real:

- a stale `createdAt` meant every re-`init` of a long-lived project tripped the
  wall-clock deadline, so it could never run
- `--mirror-thread` was silently ignored unless the config also said `enabled: true`
- an idempotency key without the card's bytes served stale verdicts for edited cards
- `process.exit()` truncated piped stdout, so a chained round's verdict vanished
- every nested round suppressed its own output, so the chain read nothing
- a denied spawn was charged against the budget even though the model was never reached

They are now regression-tested. The habit worth copying: three layers of testing —
offline assertions, real round-trips, and a real executor — because each layer missed
things the other two caught.

## License

MIT
