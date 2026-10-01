// lib/queue-mirror.mjs -- push the loop's progress into a Codex conversation that
// is visible in the desktop app.
//
// WHY THIS EXISTS
//
// `codex exec` drives a thread from a headless process. That thread is real (it has
// a rollout file, a stable id, and the app can read it), but the app does not show
// it in a conversation you can watch while it runs.
//
// The app's own conversations are different: the app-server owns them, and
// `codex queue --thread <ID> --message <TEXT>` appends a message that the running
// app processes and renders. So the two roles are split:
//
//   work thread   -- owned by `codex exec` via this bridge. Nobody else may write
//                    it: the app holds a writer lock on its own conversations, and
//                    a resume against an app-held thread fails with
//                    "thread-store conflict: already has an active writer".
//   chat thread   -- owned by the app and visible in the UI. The bridge only ever
//                    queued messages into it; it never resumes it.
//
// One message per verdict is deliberate: the app treats each queued message as a
// prompt and would run a turn for it, so the text asks for no reply. Still cheap
// (no tools, tiny context) but not free -- raise `queueMirror.enabled` to false when
// you do not need to watch.
import { execFileSync } from 'node:child_process';
import { resolveCodexExe } from './driver-exec.mjs';

/**
 * True when this run should mirror into a chat thread.
 *
 * `thread` may come from either source: the `queueMirror.thread` config value, or an
 * explicit `--mirror-thread <id>` on this invocation. The flag alone must be enough
 * to turn the mirror on -- an earlier version also required `enabled: true` in the
 * config, so passing `--mirror-thread` silently did nothing and there was no way to
 * tell why.
 */
export function mirrorEnabled(cfg, overrideThread) {
  const thread = overrideThread ?? cfg.queueMirror?.thread;
  if (!thread) return false;
  return overrideThread ? true : cfg.queueMirror?.enabled === true;
}

/**
 * Append one message to a chat thread. Never throws.
 *
 * @returns {{ok: boolean, reason?: string, messageId?: string}}
 */
export function pushToChat(cfg, text, { thread } = {}) {
  const target = thread ?? cfg.queueMirror?.thread;
  if (!target) return { ok: false, reason: 'no chat thread configured' };

  let exe;
  try {
    ({ exe } = resolveCodexExe(cfg));
  } catch (err) {
    return { ok: false, reason: `codex not resolvable: ${err.message?.slice(0, 120)}` };
  }

  try {
    const out = execFileSync(exe, [
      ...(cfg.codex.nodeArgs ?? []), // keeps the stub usable in offline tests
      'queue',
      '--thread', target,
      '--message', text,
    ], {
      encoding: 'utf8',
      timeout: cfg.queueMirror?.timeoutMs ?? 30000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const messageId = /Queued message (\S+)/.exec(out ?? '')?.[1] ?? null;
    return { ok: true, messageId, raw: (out ?? '').trim() };
  } catch (err) {
    // A mirror failure must never fail the loop: the verdict is already durable in
    // the ledger and the call store.
    const detail = (err.stderr || err.message || '').toString().trim().slice(0, 200);
    return { ok: false, reason: detail };
  }
}

/**
 * Render one verdict as a short report for a human reading the chat.
 *
 * Deliberately does NOT invite a reply. The app runs a model turn for every queued
 * message, so asking for an answer would double the cost of every round, and the
 * loop already has its decision. This is a progress feed, not a conversation.
 */
export function renderVerdictReport({ verdict, taskId, state, usage, continuation }) {
  const lines = [];
  const icon = { pass: 'PASS', rework: 'REWORK', next: 'NEXT', stop: 'STOP' }[verdict.action] ?? verdict.action.toUpperCase();

  lines.push(`[bridge] ${icon} — ${taskId} (round ${state.rounds}, ${state.status})`);
  lines.push('');
  lines.push(`reason: ${truncate(verdict.reason, 300)}`);
  if (verdict.feedbackForExecutor && verdict.feedbackForExecutor !== 'none') {
    lines.push(`feedback: ${truncate(verdict.feedbackForExecutor, 300)}`);
  }
  if (verdict.action === 'rework' && verdict.reworkInstructions) {
    lines.push(`rework: ${truncate(verdict.reworkInstructions, 400)}`);
  }
  if (continuation) {
    lines.push('');
    lines.push(`next: ${continuation.taskId}  (${continuation.launchCommand ? 'auto-chained' : 'manual'})`);
  } else {
    lines.push('');
    lines.push('next: nothing queued');
  }
  if (usage?.total) {
    lines.push(`tokens this round: ${usage.total.toLocaleString()}`);
  }
  lines.push('');
  lines.push('Automated progress report from the closed loop. No reply needed.');

  return lines.join('\n');
}

function truncate(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
}
