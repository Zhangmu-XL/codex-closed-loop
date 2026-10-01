#!/usr/bin/env node
// tools/codex-stub.mjs -- an offline stand-in for `codex exec`.
//
// It speaks the same surface the driver depends on: reads the prompt from stdin,
// prints `codex exec --json` shaped JSONL on stdout, writes the final message to
// the file named after -o/--output-last-message, and exits with a scripted code.
//
// Answers come from .codex-scratch/stub-script.json (relative to the cwd the
// driver spawns from). Each entry is consumed in order; the last entry repeats.
// An entry can be a plain object (used as the final message) or:
//   { "raw": "text", "exitCode": 2, "stderr": "...", "delayMs": 1000,
//     "usage": {...}, "threadId": "uuid", "threadNewEachCall": true, "omitThread": true }
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const here = process.cwd();
const scriptPath = join(here, 'stub-script.json');
const countPath = join(here, 'stub-count.json');
const logPath = join(here, 'stub-calls.jsonl');

// A liveness probe must not consume a scripted answer or touch the call log.
if (process.argv.includes('--version')) {
  process.stdout.write('codex-stub 1.0.0\n');
  process.exit(0);
}

function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

const script = readJson(scriptPath, [{ note: 'no script found', action: 'stop', reason: 'stub has no script' }]);
const count = readJson(countPath, { n: 0 });
const entry = script[Math.min(count.n, script.length - 1)];
const callIndex = count.n;
mkdirSync(here, { recursive: true });
writeFileSync(countPath, JSON.stringify({ n: count.n + 1, lastAt: new Date().toISOString() }), 'utf8');

// Read the prompt from stdin so the stub exercises the same path as the real CLI.
let prompt = '';
try { prompt = readFileSync(0, 'utf8'); } catch { /* no stdin attached */ }

const args = process.argv.slice(2);
const isResume = args.includes('resume');
const oIndex = args.findIndex((a) => a === '-o' || a === '--output-last-message');
const lastMessagePath = oIndex >= 0 ? args[oIndex + 1] : null;

writeFileSync(logPath, `${JSON.stringify({
  at: new Date().toISOString(), callIndex, isResume, promptChars: prompt.length,
  promptHead: prompt.slice(0, 80000),
})}\n`, { encoding: 'utf8', flag: 'a' });

if (entry.delayMs) await new Promise((r) => setTimeout(r, entry.delayMs));

if (entry.stderr) process.stderr.write(entry.stderr);

if (entry.transport === 'crash') {
  // Simulate the CLI being killed mid-flight: writes partial JSONL then dies.
  process.stdout.write('{"type":"thread.started","thread_id":"stub-crashed"}\n');
  process.exit(entry.exitCode ?? 1);
}

const threadId = entry.threadNewEachCall ? `stub-thread-${callIndex + 1}` : (entry.threadId ?? 'stub-thread-1');
if (!entry.omitThread) {
  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n`);
}
process.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`);

const text = entry.raw !== undefined
  ? String(entry.raw)
  : JSON.stringify(entry.message ?? { action: 'stop', reason: 'stub default' });

process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } })}\n`);
process.stdout.write(`${JSON.stringify({
  type: 'turn.completed',
  usage: entry.usage ?? { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0 },
})}\n`);

if (lastMessagePath) writeFileSync(lastMessagePath, text, 'utf8');

process.exit(entry.exitCode ?? 0);
