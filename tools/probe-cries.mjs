// 探测 PokeAPI/cries 里 1..1025 到底有没有叫声文件（只发 HEAD，不下载）
// 用法: node tools/probe-cries.mjs [--max 1025] [--conc 16]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : Number(process.argv[i + 1]);
};

const MAX = arg('max', 1025);
const CONC = arg('conc', 16);

const MIRRORS = [
  (id) => `https://cdn.jsdelivr.net/gh/PokeAPI/cries@main/cries/pokemon/latest/${id}.ogg`,
  (id) => `https://cdn.jsdelivr.net/gh/PokeAPI/cries@main/cries/pokemon/legacy/${id}.ogg`,
];

async function head(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return r.status;
  } catch {
    return 0;
  }
}

const ids = Array.from({ length: MAX }, (_, i) => i + 1);
const have = [];
const legacyOnly = [];
const missing = [];
let cursor = 0;

async function worker() {
  for (;;) {
    const k = cursor++;
    if (k >= ids.length) return;
    const id = ids[k];
    let st = await head(MIRRORS[0](id));
    if (st === 200) { have.push(id); continue; }
    st = await head(MIRRORS[1](id));
    if (st === 200) { legacyOnly.push(id); continue; }
    missing.push({ id, st });
  }
}

const t0 = Date.now();
await Promise.all(Array.from({ length: CONC }, worker));
have.sort((a, b) => a - b);
legacyOnly.sort((a, b) => a - b);
missing.sort((a, b) => a.id - b.id);

const out = { max: MAX, latest: have, legacyOnly, missing: missing.map((m) => m.id), ms: Date.now() - t0 };
fs.writeFileSync(path.join(ROOT, 'data', 'cry-probe.json'), JSON.stringify(out, null, 1), 'utf8');

console.log(`探测 1..${MAX}：latest ${have.length} / 只有 legacy ${legacyOnly.length} / 都没有 ${missing.length}，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (missing.length) console.log('都没有的 id：', missing.map((m) => m.id).join(','));
if (legacyOnly.length) console.log('只有 legacy 的 id：', legacyOnly.join(','));
