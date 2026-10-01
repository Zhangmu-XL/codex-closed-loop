// Strip UTF-8 BOMs from source files.
//
// PowerShell's `Set-Content -Encoding utf8` prepends a BOM, which is invisible but
// fatal to Node (shebang) and to JSON.parse. The config loader already tolerates it;
// source files cannot. Run this after any shell-based rewrite.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const EXTS = new Set(['.mjs', '.js', '.json', '.md', '.txt', '.jsonl']);
const SKIP = new Set(['state', 'node_modules', '.git', '.codex-scratch']);

let fixed = 0;
let scanned = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (!EXTS.has(extname(name))) continue;
    scanned++;
    const buf = readFileSync(p);
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      writeFileSync(p, buf.subarray(3));
      console.log('stripped BOM:', p.replace(`${ROOT}\\`, ''));
      fixed++;
    }
  }
}

walk(ROOT);
console.log(`\nscanned ${scanned} files, stripped ${fixed} BOM(s)`);
