#!/usr/bin/env node
// tools/install-bridge.mjs -- make a project root self-contained.
//
// The generated task brief tells the executor to run `<project-root>/bridge.mjs`.
// That is only true once the bridge actually lives there. Keeping one framework
// checkout driving many projects is a valid layout too, but then the brief has to
// carry --project-root/--config, and an executor should not have to reason about
// that. Copying is the simpler contract: the project root is self-contained.
//
// Usage:
//   node tools/install-bridge.mjs <project-root>
import { cpSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRAMEWORK = dirname(dirname(fileURLToPath(import.meta.url)));

const target = process.argv[2];
if (!target) {
  process.stderr.write('usage: node tools/install-bridge.mjs <project-root>\n');
  process.exit(2);
}

const root = resolve(target);
if (!existsSync(root)) {
  process.stderr.write(`install-bridge: project root does not exist: ${root}\n`);
  process.exit(2);
}

// bridge.mjs, the whole lib/ it imports, and the JSON schemas it loads by path.
const files = ['bridge.mjs'];
const dirs = ['lib'];

for (const d of ['config', 'state', 'seeds', '.codex-scratch']) {
  mkdirSync(join(root, d), { recursive: true });
}

for (const f of files) {
  cpSync(join(FRAMEWORK, f), join(root, f), { force: true });
}
for (const d of dirs) {
  cpSync(join(FRAMEWORK, d), join(root, d), { recursive: true, force: true });
}

// Config must exist for the bridge to start; copy the template only when absent so
// a tuned config is never clobbered.
const cfgPath = join(root, 'config', 'run.config.json');
if (!existsSync(cfgPath)) {
  cpSync(join(FRAMEWORK, 'config', 'run.config.json'), cfgPath, { force: true });
  process.stdout.write(`wrote template config: ${cfgPath}  (edit codex.workdir / project.workspace)\n`);
}
for (const schema of readdirSync(join(FRAMEWORK, 'config')).filter((f) => f.endsWith('.schema.json'))) {
  cpSync(join(FRAMEWORK, 'config', schema), join(root, 'config', schema), { force: true });
}

process.stdout.write([
  `installed bridge into ${root}`,
  '  bridge.mjs, lib/, config/*.schema.json',
  '',
  'Next:',
  `  1. edit ${cfgPath}  (project.workspace and codex.workdir must point inside this project)`,
  '  2. write seeds/PROJECT.md',
  `  3. cd "${root}" && node bridge.mjs doctor && node bridge.mjs run init`,
  '',
].join('\n'));
