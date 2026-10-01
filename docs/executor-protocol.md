# Codex Executor Protocol

You are the **executor agent**. Codex is the **brain**. There is no orchestrator between
you and Codex: when you finish a task you call Codex yourself, you block until it answers,
and you act on what it says.

This document is the whole contract. Follow it exactly.

---

## 0. Hard rules

| Rule | Why |
|---|---|
| Never invent or re-scope tasks. | The brain decomposes and dispatches. |
| Never decide that your own work passed. | Only the brain accepts work. |
| Never poll, sleep-loop, or wait for files to change. | The brain answers synchronously inside `ask`. |
| Never send raw logs, stdout, stack traces or file dumps. | Only the card travels; its summary is capped by `summary.oneLineMaxChars` (400 by default). |
| Never edit `bridge.mjs`, `lib/`, `config/`. | You are a client of the bridge, not its maintainer. |
| Never retry `ask` on your own because you did not like the verdict. | Retries are budgeted by the brain's rules. |

---

## 1. Read your task

`run init` writes one brief per task. Read yours:

```
<project-root>/seeds/task-<TASKID>.txt
```

It contains the task prompt, the **verification** you must run, the constraints, and the
exact card shape. The machine-readable copy is `state/queue/<TASKID>.json`.

Do the work in the workspace named in the brief. Run the verification command for real —
do not describe what it would print.

## 2. Write the result card

Write exactly one JSON object to `<project-root>/state/cards/<TASKID>.result.json`:

```json
{
  "taskId": "T-001",
  "runId": "20261001-142300",
  "status": "completed",
  "summaryOneLine": "Added the retry guard and the suite passes locally.",
  "changed": ["lib/retry.mjs:12-40", "test/retry.test.mjs"],
  "findings": ["the guard also covers the abort path"],
  "blockers": [],
  "verify": { "command": "node --test", "exitCode": 0 },
  "nextHint": "",
  "metrics": { "turns": 6, "durationMs": 42000 }
}
```

- `status`: `completed` | `failed` | `blocked` | `partial`
- `summaryOneLine`: **at most `summary.oneLineMaxChars` characters (400 by default)**, one sentence, what is now true.
- `changed`: at most 10 paths. `findings`: at most 5. `blockers`: at most 5.
- `verify.exitCode`: the real exit code you observed.

A card with a long summary, more than the allowed entries, or a field named like a log
(`stdout`, `logs`, `raw`, ...) is **rejected before the brain is called**. You will get a
JSON error naming the problem and the fix — compress and resubmit. No tokens were spent.

## 3. Report to the brain and wait

From the project root:

```
node bridge.mjs ask --card state/cards/<TASKID>.result.json
```

This blocks until Codex answers. It is a single synchronous call, not a poll.

**Then read the `instruction` block and follow it. It is the single authority** — the
exit code, `nextTask`, the queue file and the brief all remain for compatibility and
diagnostics, but only this block is meant to be acted on:

```json
"instruction": {
  "do": "execute",
  "because": "evidence accepted",
  "taskId": "T-002",
  "readFirst": "seeds/task-T-002.txt",
  "authoritative": "state/queue/T-002.json",
  "thenRun": "node bridge.mjs ask --card state/cards/T-002.result.json",
  "launch": "dsh --profile headless \"Read ...task-T-002.txt and execute it.\"",
  "note": "The brief is the task; the queue file is the authority."
}
```

| `do` | What you do |
|---|---|
| `execute` | Do `taskId`. Read `readFirst`; `authoritative` wins if they disagree. |
| `rework` | Redo the work per `what`, rewrite the card at `rewriteCardAt`, then run `thenRun`. |
| `stop` | Stop. Report `because`. |

`thenRun` is paste-ready. **Never rebuild it yourself** — retry bookkeeping is the
bridge's business, and a hand-built command is how retries get miscounted.

| Exit | Action | What you do next |
|---|---|---|
| `0` | `pass` | Accepted. Follow `instruction`; it may still say `execute` if work is queued. |
| `10` | `rework` | Follow `instruction`: redo, rewrite the card there, run `thenRun`. |
| `20` | `next` | Accepted and a new task is queued. Follow `instruction`. |
| `30` | `stop` | Stop immediately. Report `reason` verbatim. |
| `3` | budget | A daily or per-run budget is spent. Stop and report the gate named in the JSON. |
| `4` | rounds | The round ceiling is reached. Stop and report. |
| `5` | infra | Transport or protocol failure. Report the JSON; retry only if it says `"retryable": true`. |
| `6` | bad card | Fix the card fields the JSON names, then call `ask` again. |

### A changed card is a new question

The replay cache is keyed on the card's **bytes**, not only its task and attempt:

- resubmitting an **identical** card replays the stored verdict and costs nothing
- editing the card and resubmitting **reaches the brain again**, even at the same attempt

That is what makes the rework loop work: fix the work, fix the card, resubmit. A card
you edited but never saved is still the same question.

## 4. Budget discipline

The bridge enforces every limit. Your job is only to not waste them:

- One `ask` per finished attempt. Do not call `ask` to ask what to do next.
- If `ask` reports `"retryable": true`, the bridge already retried the transport for you.
  Do not add retries of your own.

## 5. Context discipline (long runs)

You may work through many tasks in one session. When you do:

- **Keep the instruction, drop the history.** Once a task is accepted you no longer
  need its card text, its verdict, or your old reasoning.
- Do not re-read an old brief or an accepted card.
- Do not accumulate past verdicts "for context" — the rolling summary already carries
  what the brain decided, and it is bounded on purpose.

A session that drags every previous card forward will hit the context ceiling and get
compacted mid-task.


---

## 5. Quick reference

```
# where things are
state/queue/<TASKID>.json          task definition
seeds/task-<TASKID>.txt            task brief (read this first)
state/cards/<TASKID>.result.json   your result card (write this)
state/rolling-summary.md           read-only: what the brain knows so far
state/decisions.jsonl              read-only: append-only decision ledger
state/handoff/                     read-only: problems parked for a human

# the one command that matters
node bridge.mjs ask --card state/cards/<TASKID>.result.json

# read-only introspection
node bridge.mjs status
```
