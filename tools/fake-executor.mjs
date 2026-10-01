// Test-only executor: stands in for a real agent so the unattended chain can be
// exercised without spending tokens. Writes a valid result card for {taskId} and
// exits 0 -- nothing more. A real executor would do the task and then call `ask`.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const taskId = process.argv[2] ?? 'T-999';
const projectRoot = process.argv[3] ?? process.cwd();
const dir = join(projectRoot, 'state', 'cards');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${taskId}.result.json`), JSON.stringify({
  taskId,
  runId: 'fake',
  status: 'completed',
  summaryOneLine: `${taskId} handled by the fake executor`,
  changed: [`work/${taskId}.txt`],
  findings: ['fake executor: no real work was done'],
  blockers: [],
  verify: { command: 'noop', exitCode: 0 },
  nextHint: '',
  metrics: { turns: 1, durationMs: 5 },
}, null, 2));
process.stdout.write(`[fake-executor] wrote a card for ${taskId}\n`);
process.exit(0);
