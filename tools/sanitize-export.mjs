// Sanitize the export: remove every machine-specific value.
//
// A shipped `exePath` is worse than useless -- the Codex install directory contains
// a per-install hash, so someone else's path is guaranteed wrong AND looks
// deliberate. Null means "resolve from PATH or CODEX_CLI_PATH at runtime".
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK = dirname(HERE);

// Default to <framework>-github, unless we are already inside it, so the tool works
// from either checkout. Pass a directory to override.
const DEFAULT_ROOT = FRAMEWORK.endsWith('-github') ? FRAMEWORK : `${FRAMEWORK}-github`;
const ROOT = resolve(process.argv[2] ?? DEFAULT_ROOT);

if (!existsSync(ROOT)) {
  process.stderr.write(`sanitize-export: no such directory: ${ROOT}\n`);
  process.exit(2);
}

const targets = [
  join(ROOT, 'config', 'run.config.json'),
  join(ROOT, 'examples', 'hello-loop', 'config', 'run.config.json'),
];

for (const p of targets) {
  const j = JSON.parse(readFileSync(p, 'utf8'));
  j.codex.exePath = null;
  j.$comment = 'Reference config. Easiest path: run `node bridge.mjs init <dir>`, '
    + 'which writes this file with a probed codex.exePath. See README.';
  if (p.includes('examples')) {
    j.project.name = 'hello-loop';
    j.project.workspace = '.';
    j.codex.workdir = '.codex-scratch';
  }
  writeFileSync(p, `${JSON.stringify(j, null, 2)}\n`, 'utf8');
  console.log('sanitized:', p.replace(ROOT, '.'));
}

// Scan the whole export for anything machine-specific.
// Scanned for anywhere in the export.
//
// This file is excluded from its own scan: a scanner necessarily names the patterns
// it looks for, and a permanent false positive is how a real leak gets ignored. The
// values are still assembled at runtime as a second line of defence.
const SELF = fileURLToPath(import.meta.url);
const PATTERNS = [
  new RegExp(['ZI', 'RUN'].join(''), 'i'),                       // the local user name
  new RegExp(['C:', '\\\\Users\\\\'].join(''), 'i'),              // absolute home paths
  new RegExp(['c6fe824d725f02d7', '56d1c54034a4a372'].join('|'), 'i'), // this install's hashes
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,                               // timestamps from a real run
];

// `.git` holds reflogs with the local committer identity. Those never leave the
// machine, so scanning them produces false alarms that hide real leaks.
const SKIP = new Set(['.git', 'node_modules']);
let problems = 0;
let scanned = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    // Skip by BASE NAME. Matching the full path here silently failed to exclude
    // .git, whose reflogs carry the local committer identity -- false alarms that
    // can hide a real leak.
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (p === SELF) continue;
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (extname(name) === '.png' || extname(name) === '.jpg') continue;
    scanned++;
    let text;
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    for (const pat of PATTERNS) {
      const m = pat.exec(text);
      if (m) {
        console.log(`  LEAK ${p.replace(ROOT, '.')}  <- ${JSON.stringify(m[0])}`);
        problems++;
        break;
      }
    }
  }
}

console.log('');
walk(ROOT);
console.log(`\nscanned ${scanned} files, ${problems} leak(s)`);
process.exit(problems === 0 ? 0 : 1);
