#!/usr/bin/env node
// tools/install-bridge.mjs -- make a project root self-contained.
//
// The generated task brief tells the executor to run `<project-root>/bridge.mjs`.
// That is only true once the bridge actually lives there. Keeping one framework
// checkout driving many projects is a valid layout too, but then the brief has to
// carry --project-root/--config, and an executor should not have to reason about
// that. Copying is the simpler contract: the project root is self-contained.
//
// This refuses to silently overwrite a file the project has changed. A project that
// patched lib/prompt.mjs or lib/driver-exec.mjs for its own environment used to lose
// those edits to an upgrade with no warning and no backup -- the worst kind of
// regression, because it only shows up later as changed behaviour.
//
// Local changes are detected against the last installed manifest, not against the
// framework: a file that differs from the framework but matches what was installed is
// simply an unchanged copy from an older version, and replacing it is the point.
//
// Usage:
//   node tools/install-bridge.mjs <project-root> [--dry-run] [--force] [--backup]
//
//   --dry-run  report what would change, write nothing
//   --force    overwrite locally modified files anyway
//   --backup   move locally modified files to <file>.bak-<stamp> instead of refusing
import { cpSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const FRAMEWORK = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST = '.codex-bridge-manifest.json';

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith('-'));
const dryRun = argv.includes('--dry-run');
const force = argv.includes('--force');
const backup = argv.includes('--backup');

if (!target) {
  process.stderr.write('usage: node tools/install-bridge.mjs <project-root> [--dry-run] [--force] [--backup]\n');
  process.exit(2);
}

const root = resolve(target);
if (!existsSync(root)) {
  process.stderr.write(`install-bridge: project root does not exist: ${root}\n`);
  process.exit(2);
}

const hash = (buf) => createHash('sha256').update(buf).digest('hex');
const hashFile = (p) => hash(readFileSync(p));
const rel = (p) => relative(root, p).split('\\').join('/');

/** Every file this tool owns: bridge.mjs plus everything under lib/. */
function ownedFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      out.push(p);
    }
  };
  out.push(join(FRAMEWORK, 'bridge.mjs'));
  walk(join(FRAMEWORK, 'lib'));
  return out;
}

/** What this tool installed last time, if it recorded it. */
function loadManifest() {
  const p = join(root, MANIFEST);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

for (const d of ['config', 'state', 'seeds', '.codex-scratch']) {
  mkdirSync(join(root, d), { recursive: true });
}

const previous = loadManifest();
const files = ownedFiles();

// Classify every file before touching anything, so --dry-run and the refusal path
// report the same thing.
const plan = files.map((src) => {
  const dest = join(root, relative(FRAMEWORK, src));
  const srcHash = hashFile(src);
  const entry = { src, dest, relPath: rel(dest), srcHash, state: 'new' };
  if (!existsSync(dest)) return entry;

  const destHash = hashFile(dest);
  if (destHash === srcHash) { entry.state = 'same'; return entry; }

  const installedHash = previous?.files?.[entry.relPath];
  if (installedHash && installedHash === destHash) {
    // An untouched copy from an older install: replacing it is the upgrade.
    entry.state = 'upgrade';
    return entry;
  }
  // Either the project edited it, or there is no manifest to prove otherwise.
  entry.state = installedHash ? 'modified' : 'modified-no-manifest';
  return entry;
});

const modified = plan.filter((e) => e.state === 'modified' || e.state === 'modified-no-manifest');
const changed = plan.filter((e) => e.state !== 'same');

const report = {
  ok: modified.length === 0 || force || backup || dryRun,
  projectRoot: root,
  dryRun,
  manifestFound: previous !== null,
  counts: {
    total: plan.length,
    new: plan.filter((e) => e.state === 'new').length,
    same: plan.filter((e) => e.state === 'same').length,
    upgrade: plan.filter((e) => e.state === 'upgrade').length,
    locallyModified: modified.length,
  },
  locallyModified: modified.map((e) => ({
    file: e.relPath,
    why: e.state === 'modified-no-manifest'
      ? 'differs from the framework and no manifest exists to prove it is unedited'
      : 'differs from what was installed',
  })),
};

if (dryRun) {
  report.wouldWrite = changed.map((e) => ({ file: e.relPath, from: e.state }));
  report.note = modified.length
    ? 'dry run: nothing written. A real run would refuse until --backup or --force.'
    : 'dry run: nothing written';
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

if (modified.length && !force && !backup) {
  report.refused = true;
  report.hint = 'These files were changed in this project. Re-run with --backup to keep a '
    + `copy as <file>.bak-<stamp>, or --force to discard the changes. Inspect first with --dry-run.`;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(3);
}

// Back up before overwriting, so a mistake is recoverable even with --backup.
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
if (backup && modified.length) {
  report.backedUp = [];
  for (const e of modified) {
    const bak = `${e.dest}.bak-${stamp}`;
    cpSync(e.dest, bak, { force: true });
    report.backedUp.push(rel(bak));
  }
}

for (const e of plan) {
  mkdirSync(dirname(e.dest), { recursive: true });
  cpSync(e.src, e.dest, { force: true });
}

// Record what was installed so the NEXT run can tell a local edit from a stale copy.
const manifest = {
  installedAt: new Date().toISOString(),
  framework: FRAMEWORK,
  files: {},
};
for (const e of plan) manifest.files[e.relPath] = hashFile(e.dest);
if (previous?.files) {
  // Keep entries for files this version no longer ships, so a project that still has
  // one is not suddenly reported as "modified with no manifest".
  for (const [k, v] of Object.entries(previous.files)) {
    if (!(k in manifest.files)) manifest.files[k] = v;
  }
}
writeFileSync(join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
report.manifest = MANIFEST;

// Config must exist for the bridge to start; copy the template only when absent so
// a tuned config is never clobbered.
const cfgPath = join(root, 'config', 'run.config.json');
if (!existsSync(cfgPath)) {
  cpSync(join(FRAMEWORK, 'config', 'run.config.json'), cfgPath, { force: true });
  report.wroteTemplateConfig = cfgPath;
}
for (const schema of readdirSync(join(FRAMEWORK, 'config')).filter((f) => f.endsWith('.schema.json'))) {
  cpSync(join(FRAMEWORK, 'config', schema), join(root, 'config', schema), { force: true });
}

report.installed = true;
report.next = [
  `edit ${cfgPath}  (project.workspace and codex.workdir must point inside this project)`,
  'write seeds/PROJECT.md',
  `cd "${root}" && node bridge.mjs doctor && node bridge.mjs run init`,
  // A project copy carrying local patches is exactly the case where running the suite
  // against THAT copy matters: 175/175 in the framework directory proves nothing here.
  'verify the copy you actually run: node bridge.mjs selftest',
];
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
