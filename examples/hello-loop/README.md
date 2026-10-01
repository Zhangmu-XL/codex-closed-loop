# hello-loop

A self-contained project whose task queue is **seeded**, so `run init` costs
**zero Codex calls**. It exists so you can watch the loop work — and verify your
setup — before pointing it at anything real.

`work/hello.txt` is already in place, and a result card for it is already accepted,
so this example is fully runnable offline except for the actual verdict call.

## Run it

```bash
cd examples/hello-loop
node bridge.mjs status        # zero tokens
```

Then, from a clean slate, you can watch the whole loop:

```bash
# reseed the queue (zero calls: the plan comes from seeds/run-plan.seed.json)
node bridge.mjs run init

# OPTIONAL: do the work for real. Delete work/hello.txt first if you want to see it
# created. This is your own agent; there is no required one.
rm work/hello.txt

# report and get the verdict (one real Codex call)
node bridge.mjs ask --card state/cards/T-001.result.json
```

You should get `action: "pass"` and exit code `0`.

## Run the loop unattended, with no model calls at all

`--executor` normally launches a real agent. For a pure plumbing check, point it at
the bundled fake executor, which just writes a valid card:

```bash
node bridge.mjs ask --card state/cards/T-001.result.json \
  --executor '"$(command -v node)" ../../tools/fake-executor.mjs {taskId} {root}'
```

The bridge will run the executor for each queued task and report back, until Codex
stops asking for more. With a one-task queue, that is one verdict and one stop.

## What to look at afterwards

```
state/queue/T-001.json            the task, in machine-readable form
state/cards/T-001.result.json     the executor's own card (never overwritten)
state/cards/T-001.accepted.json   the normalized copy the brain judged
state/calls/*.json                the EXACT prompt sent, and the verdict returned
state/decisions.jsonl             the ledger: plan → verdict
state/rolling-summary.md          the bounded history the brain carries forward
state/runs/<ts>/codex-stdout-*.jsonl   the raw event stream (forensics only)
```

`state/calls/*.json` is the interesting one: it contains the verbatim prompt, so you
can confirm for yourself that no log ever reaches the brain.

## Reset

```bash
node bridge.mjs reset --yes
```
