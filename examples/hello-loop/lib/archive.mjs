// Archive one run's state so a new run starts clean.
//
// Why this is needed rather than "just delete state/": task ids restart at T-001 every
// run, so a second run's cards collide with the first run's by NAME. Nothing in the
// bridge prevents that -- `state/cards/T-001.accepted.json` is simply overwritten.
// Deleting loses the only audit trail of what the brain actually decided, so the
// workable answer is to move the old state aside and say why.
//
// Nothing is ever deleted here. The archive is a move plus a README.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ARCHIVE_SUBDIR = join('work', 'run-archives');

/** Read state.json defensively: an archive must work even on a damaged run. */
function readStateSafe(stateDir) {
  try {
    return JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
  } catch {
    return {};
  }
}

function readLedgerSafe(stateDir) {
  try {
    return readFileSync(join(stateDir, 'decisions.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).reduce((n, name) => {
    const p = join(dir, name);
    return n + (statSync(p).isDirectory() ? countFiles(p) : 1);
  }, 0);
}

/**
 * Describe what is about to be archived, without changing anything.
 *
 * Used by `run init` to warn about a previous run and by `archive-state --dry-run`.
 */
export function inspectState(cfg) {
  const stateDir = cfg.__stateDir;
  if (!existsSync(stateDir)) return { present: false, files: 0 };
  const state = readStateSafe(stateDir);

  // Only count the cheap, meaningful things -- this runs before an expensive verb.
  const decisions = readLedgerSafe(stateDir);
  const verdicts = decisions.filter((d) => d.kind === 'verdict');
  const byAction = {};
  for (const v of verdicts) byAction[v.action] = (byAction[v.action] ?? 0) + 1;

  return {
    present: true,
    runId: state.runId ?? null,
    status: state.status ?? null,
    stopReason: state.stopReason ?? null,
    currentTaskId: state.currentTaskId ?? null,
    createdAt: state.createdAt ?? null,
    rounds: state.rounds ?? 0,
    verdicts: verdicts.length,
    verdictsByAction: byAction,
    files: countFiles(stateDir),
    cards: existsSync(join(stateDir, 'cards')) ? readdirSync(join(stateDir, 'cards')).length : 0,
    calls: existsSync(join(stateDir, 'calls')) ? readdirSync(join(stateDir, 'calls')).length : 0,
    handoffs: existsSync(join(stateDir, 'handoff')) ? readdirSync(join(stateDir, 'handoff')).length : 0,
    decisions: decisions.length,
  };
}

/**
 * True when the directory holds nothing worth preserving.
 *
 * `files > 0` is NOT a sufficient test. After an archive the directory is not empty:
 * `ensureDirs` plus the `state_archived` ledger entry leave a decisions.jsonl behind,
 * so an emptiness check on the file count would archive that and report success.
 */
export function isEmptyState(manifest) {
  if (!manifest?.present) return true;
  return manifest.cards === 0
    && manifest.calls === 0
    && manifest.handoffs === 0
    && (manifest.rounds ?? 0) === 0
    && (manifest.verdicts ?? 0) === 0
    && manifest.runId === null;
}

/**
 * Task ids that exist on disk but do not belong to the CURRENT run.
 *
 * This is the collision the archive exists to prevent. `run init` renumbers from
 * T-001, so a stale `cards/T-001.accepted.json` from the previous run sits exactly
 * where the new run will write -- and the new run would silently adopt the old
 * verdict into its rolling summary.
 */
export function staleArtifacts(cfg) {
  const stateDir = cfg.__stateDir;
  const currentRunId = readStateSafe(stateDir).runId ?? null;
  const stale = [];

  const scan = (sub, suffix) => {
    const dir = join(stateDir, sub);
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (suffix && !name.endsWith(suffix)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) continue;
      let runId = null;
      try {
        runId = JSON.parse(readFileSync(p, 'utf8')).runId ?? null;
      } catch {
        // A card without a parseable runId is exactly the case worth flagging: we
        // cannot prove it belongs to this run.
      }
      if (runId !== currentRunId) stale.push({ file: join(sub, name), runId });
    }
  };

  scan('cards', '.result.json');
  scan('queue', '.json');
  return { currentRunId, stale, count: stale.length };
}

/**
 * Move the current state aside and write a README explaining what it was.
 *
 * @returns {{ok, archiveDir, moved, manifest}}
 */
export function archiveState(cfg, { label = null, now = new Date() } = {}) {
  const stateDir = cfg.__stateDir;
  if (!existsSync(stateDir)) {
    return { ok: false, reason: `no state directory at ${stateDir}` };
  }

  const manifest = inspectState(cfg);
  if (isEmptyState(manifest)) {
    return {
      ok: false,
      reason: manifest.present
        ? 'nothing to archive: no cards, calls, handoffs, rounds or run in this state'
        : `no state directory at ${stateDir}`,
      manifest,
    };
  }

  // Name it after the run so a directory listing reads as a timeline. A caller-supplied
  // label wins, because "why this run happened" is the part only a human knows.
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = label
    ? `${stamp}-${label}`
    : (manifest.runId ? `${stamp}-${manifest.runId}` : stamp);

  const archivesRoot = join(cfg.__root, ARCHIVE_SUBDIR);
  mkdirSync(archivesRoot, { recursive: true });

  let archiveDir = join(archivesRoot, name);
  if (existsSync(archiveDir)) {
    // Never merge into an existing archive: that would make the README lie about
    // which run it describes.
    let i = 2;
    while (existsSync(`${archiveDir}-${i}`)) i++;
    archiveDir = `${archiveDir}-${i}`;
  }

  // Copy then remove, rather than rename: a cross-device rename (state on one volume,
  // work on another) would otherwise fail halfway and leave neither intact.
  cpSync(stateDir, archiveDir, { recursive: true });
  if (!existsSync(archiveDir)) {
    return { ok: false, reason: `copy to ${archiveDir} did not produce a directory` };
  }
  for (const entry of readdirSync(stateDir)) {
    rmSync(join(stateDir, entry), { recursive: true, force: true });
  }

  const rel = (p) => p.replace(`${cfg.__root}\\`, '').replace(`${cfg.__root}/`, '');

  writeFileSync(join(archiveDir, 'README.md'), archiveReadme(manifest, {
    archiveDir: rel(archiveDir),
    stateDir: rel(stateDir),
    label,
    now,
  }), 'utf8');

  return {
    ok: true,
    archiveDir,
    archiveDirRelative: rel(archiveDir),
    manifest,
  };
}

/** Human-readable provenance. Written for someone reading this in six months. */
export function archiveReadme(m, { archiveDir, stateDir, label = null, now = new Date() } = {}) {
  const span = m.createdAt
    ? `${String(m.createdAt).replace('T', ' ').slice(0, 16)} → ${now.toISOString().replace('T', ' ').slice(0, 16)}`
    : `archived ${now.toISOString().replace('T', ' ').slice(0, 16)}`;

  const acted = Object.entries(m.verdictsByAction ?? {})
    .map(([k, v]) => `${k}×${v}`)
    .join(', ');

  return `# 闭环运行态归档

- runId：\`${m.runId ?? '(未知)'}\`
- 时间：${span}
- 归档时的状态：\`${m.status ?? '(未知)'}\`${m.stopReason ? `（stopReason: \`${m.stopReason}\`）` : ''}
- 当前任务：\`${m.currentTaskId ?? '(无)'}\`　已完成轮次：${m.rounds ?? 0}
- 裁决：${m.verdicts ?? 0} 条${acted ? `（${acted}）` : ''}
- 内容：\`${stateDir}\` 的 ${m.files} 个文件 —— decisions/calls/cards/queue/runs/
  rolling-summary/budget/state${m.handoffs ? `，另有 ${m.handoffs} 份待人工处理` : ''}
${label ? `- 标签：\`${label}\`\n` : ''}
## 归档原因

开始新一轮运行。**任务编号每轮从 T-001 重新开始**，所以旧运行的
\`cards/T-001.accepted.json\` 会落在新一轮将要写入的同一个位置 —— 不归档的话，
新一轮的滚动摘要可能把旧裁决当成自己的历史。

## 未删除任何内容

这里是原 \`${stateDir}\` 的完整副本。判据、原始往返存档（\`calls/\`）、
原始事件流（\`runs/\`）都还在，可以复查任何一次裁决的依据。

## 相关文件

- \`calls/\` —— 每次往返发出的**确切 prompt** 和返回的裁决；想验证"只传摘要"就看这里
- \`decisions.jsonl\` —— 只追加的台账
- \`rolling-summary.md\` —— 当时大脑唯一能看到的历史
- \`runs/\` —— 原始 JSONL 事件流（仅取证，永不进 prompt）

归档目录：\`${archiveDir}\`
`;
}
