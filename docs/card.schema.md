# Card and verdict schemas

Two JSON contracts cross the bridge. Both are validated; neither carries raw logs.

## Result card — executor → brain

Written by the executor to `state/cards/<TASKID>.result.json`, validated by `lib/card.mjs`
**before** any token is spent.

| Field | Type | Required | Limit |
|---|---|---|---|
| `taskId` | string | yes | must match a task in `state/queue/` |
| `runId` | string | no | recorded for traceability |
| `status` | enum | yes | `completed` \| `failed` \| `blocked` \| `partial` |
| `summaryOneLine` | string | yes | **≤ `summary.oneLineMaxChars` (400 by default)** |
| `changed` | string[] | no | ≤ 10 entries, ≤ 300 chars each |
| `findings` | string[] | no | ≤ 5 entries |
| `blockers` | string[] | no | ≤ 5 entries |
| `verify` | object | no | `{ command, exitCode }` |
| `nextHint` | string | no | ≤ 300 chars |
| `metrics` | object | no | `{ turns, durationMs }` |

Rejected with exit code `6` and a fixable hint:

| Code | Cause |
|---|---|
| `CARD_MISSING` | file not found |
| `CARD_INVALID_JSON` | not parseable as a single JSON object |
| `CARD_TOO_LARGE` | `summaryOneLine` over the limit |
| `CARD_HAS_RAW_LOG` | a top-level field named `stdout`, `stderr`, `logs`, `raw`, `transcript`, `dump`, ... |
| `CARD_INVALID` | missing required field, wrong type, or too many entries |

## Verdict — brain → executor

Produced by Codex under `config/verdict.schema.json`, normalized by `lib/verdict.mjs`.

| Field | Required when | Notes |
|---|---|---|
| `action` | always | `pass` \| `rework` \| `next` \| `stop` |
| `reason` | always | why this decision |
| `feedbackForExecutor` | always | short actionable message, `"none"` when there is nothing to add |
| `summaryForRolling` | always | ≤ `summary.oneLineMaxChars`; the only text that survives into the next round |
| `reworkInstructions` | `action: rework` | exactly what to change and how to verify |
| `nextTask` | `action: next` | full task object, self-contained |
| `additionalTasks` | no | appended to the queue, not executed now |
| `tokensEstimate` | no | ignored; the bridge uses measured usage |

The bridge rejects a verdict that breaks these rules and spends one bounded **repair
round** handing the validation error back to the brain:

- `action: next` without `nextTask`
- `action: rework` after the per-task rework budget is spent (the repair round cannot undo this)

If the repair round also fails, the run stops, exit code `5`, and the raw reply is parked
in `state/handoff/` for a human.

## Exit codes

| Exit | Meaning |
|---|---|
| `0` | `pass` |
| `10` | `rework` |
| `20` | `next` |
| `30` | `stop` |
| `3` | a budget gate refused the call |
| `4` | round / turn ceiling reached |
| `5` | transport, config, protocol or lock failure |
| `6` | result card rejected (no brain call was made) |
