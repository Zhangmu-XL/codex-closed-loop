// Verify the raised summary limits actually take effect, offline.
//
// Also asserts the rolling summary stays inside its own budget at the new limit:
// raising one number without the other would silently evict older cards.
//
// Probes and restores: it must be safe to run against a real project, and it writes
// its scratch cards to the OS temp dir rather than state/ so a published checkout
// never accumulates junk.
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../lib/config.mjs';
import { writeJsonAtomic, paths, ensureDirs, loadState, saveState, newRunId } from '../lib/state.mjs';
import { validateCard, CardError } from '../lib/card.mjs';
import { renderRollingSummary } from '../lib/summary.mjs';
import { buildAskPrompt } from '../lib/prompt.mjs';

const cfg = loadConfig({});
console.log('oneLineMaxChars :', cfg.summary.oneLineMaxChars);
console.log('rollingMaxChars :', cfg.summary.rollingMaxChars);
console.log('');

const scratch = join(tmpdir(), `codex-loop-limitcheck-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

const cardAt = (n) => {
  const p = join(scratch, `card-${n}.json`);
  writeFileSync(p, JSON.stringify({
    taskId: 'T-001', status: 'completed',
    summaryOneLine: 'x'.repeat(n),
    changed: [], findings: [], blockers: [],
    verify: { command: 'c', exitCode: 0 }, nextHint: '', metrics: {},
  }));
  return p;
};

// Boundary behaviour at the new limit.
for (const n of [399, 400, 401, 500]) {
  const accepted = (() => {
    try { validateCard(cardAt(n), cfg); return 'ACCEPTED'; } catch (err) {
      return err instanceof CardError ? err.code : `ERR:${err.message}`;
    }
  })();
  console.log(`  summaryOneLine=${String(n).padStart(3)} chars -> ${accepted}`);
}
console.log('');

// The rolling summary must stay bounded even with maximal cards.
ensureDirs(cfg);
const savedState = loadState(cfg);
const state = { ...savedState, runId: newRunId(), status: 'running' };
saveState(cfg, state);

const perCard = cfg.summary.oneLineMaxChars + 40; // line + task title
for (let i = 1; i <= cfg.summary.cardsKept; i++) {
  writeJsonAtomic(join(paths(cfg).cards, `T-${String(i).padStart(3, '0')}.accepted.json`), {
    taskId: `T-${String(i).padStart(3, '0')}`,
    status: 'completed',
    summaryOneLine: 'y'.repeat(cfg.summary.oneLineMaxChars),
    changed: [], findings: [], blockers: [],
  });
}
const rolling = renderRollingSummary(cfg, state);
console.log(`worst-case rolling summary : ${rolling.length} chars`);
console.log(`budget                     : ${cfg.summary.rollingMaxChars} chars`);
console.log(`within budget              : ${rolling.length <= cfg.summary.rollingMaxChars}`);
console.log(`theoretical floor (cards)  : ${(cfg.summary.cardsKept * perCard).toLocaleString()} chars`);

const prompt = buildAskPrompt({
  cfg, state, card: { taskId: 'T-001', status: 'completed', summaryOneLine: 'z'.repeat(400), changed: [], findings: [], blockers: [], verify: null, nextHint: null, metrics: null },
  task: null, queue: [],
});
console.log(`ask prompt at max card     : ${prompt.length} chars (~${Math.round(prompt.length / 3.6)} tok)`);

// Restore: this probe must not disturb a real run.
saveState(cfg, savedState);
rmSync(join(paths(cfg).cards), { recursive: true, force: true });
mkdirSync(join(paths(cfg).cards), { recursive: true });
rmSync(scratch, { recursive: true, force: true });
console.log('\nrestored.');
