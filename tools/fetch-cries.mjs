#!/usr/bin/env node
// 抓宝可梦叫声（PokeAPI/cries）。零依赖，走系统 curl.exe。
//
// 用法：
//   node tools/fetch-cries.mjs --max-id 151 --concurrency 8
//   node tools/fetch-cries.mjs --max-id 1025 --concurrency 16
//
// 注意：仓库里 latest 那批文件后缀写的是 .ogg，实际内容是 MP3。
// 所以这里按文件头判断真实格式，落盘时用对的扩展名，播放端才不会挑食。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'app', 'cries');

const MIRRORS = [
  'https://cdn.jsdelivr.net/gh/PokeAPI/cries@main/cries/pokemon/latest',
  'https://raw.githubusercontent.com/PokeAPI/cries/main/cries/pokemon/latest',
  'https://raw.gitmirror.com/PokeAPI/cries/main/cries/pokemon/latest',
];

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const MAX_ID = Number(arg('max-id', 1025));
const CONC = Number(arg('concurrency', 8));

function curl(url, dest) {
  return new Promise((resolve) => {
    const p = spawn('curl.exe', [
      '-sS', '-L', '--max-time', '30', '--retry', '2', '--retry-delay', '1',
      '-o', dest, url,
    ], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => resolve({ ok: code === 0, err }));
    p.on('error', (e) => resolve({ ok: false, err: String(e) }));
  });
}

/** 按文件头判断真实格式，返回正确扩展名；不是音频返回 null。 */
function sniff(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'ogg';
    if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3';
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function findExisting(id) {
  for (const ext of ['mp3', 'ogg']) {
    const f = path.join(OUT, `${String(id).padStart(3, '0')}.${ext}`);
    if (fs.existsSync(f) && fs.statSync(f).size > 512) return f;
  }
  return null;
}

async function one(id, tmpDir) {
  if (findExisting(id)) return { id, skipped: true };

  const name = String(id).padStart(3, '0');
  const tmp = path.join(tmpDir, `${name}.bin`);

  for (const base of MIRRORS) {
    const { ok } = await curl(`${base}/${id}.ogg`, tmp);
    if (!ok) continue;
    const ext = sniff(tmp);
    if (!ext) { try { fs.unlinkSync(tmp); } catch {} continue; }
    const dest = path.join(OUT, `${name}.${ext}`);
    fs.renameSync(tmp, dest);
    return { id, bytes: fs.statSync(dest).size, ext };
  }
  try { fs.unlinkSync(tmp); } catch {}
  return { id, failed: true };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const tmpDir = path.join(ROOT, 'data', 'cries-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const ids = [];
  for (let i = 1; i <= MAX_ID; i++) ids.push(i);

  let done = 0, skipped = 0, failed = 0, bytes = 0;
  const failedIds = [];
  const t0 = Date.now();

  const queue = [...ids];
  const workers = Array.from({ length: CONC }, async () => {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      const r = await one(id, tmpDir);
      done++;
      if (r.skipped) skipped++;
      else if (r.failed) { failed++; failedIds.push(id); }
      else bytes += r.bytes;
      if (done % 25 === 0 || done === ids.length) {
        const s = ((Date.now() - t0) / 1000).toFixed(0);
        process.stdout.write(`  ${done}/${ids.length}  新下 ${done - skipped - failed}  跳过 ${skipped}  失败 ${failed}  ${s}s\n`);
      }
    }
  });
  await Promise.all(workers);

  fs.rmSync(tmpDir, { recursive: true, force: true });

  const manifest = {
    set: 'cries-latest',
    count: ids.length - failed,
    failed: failedIds,
    newBytes: bytes,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(ROOT, 'assets', 'manifest-cries.json'), JSON.stringify(manifest, null, 1));

  const files = fs.readdirSync(OUT).filter((f) => /\.(mp3|ogg)$/.test(f));
  const total = files.reduce((s, f) => s + fs.statSync(path.join(OUT, f)).size, 0);
  console.log(`\n完成：${files.length} 个叫声，合计 ${(total / 1048576).toFixed(2)} MB，失败 ${failed} 个`);
  if (failedIds.length) console.log('失败编号：', failedIds.join(','));
}

main().catch((e) => { console.error(e); process.exit(1); });
