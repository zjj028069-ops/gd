#!/usr/bin/env node
/**
 * T32 总入口：seed → T28～T31 → 88 截图 → 第六～十轮回归。
 * 任一非 0 即整体失败。ALL.txt 最后一行「全部通过」。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const outDir = path.join(process.cwd(), 'docs/verification/round11');
mkdirSync(outDir, { recursive: true });
const lines = [`round11-accept ${new Date().toISOString()}`];
let failed = false;

function run(name, cmd, args) {
  console.log(`\n===== ${name} =====`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', env: process.env, cwd: process.cwd() });
  const ok = result.status === 0;
  lines.push(`${name} ${ok ? '通过' : '未通过'} exit=${result.status}`);
  if (!ok) failed = true;
  return ok;
}

run('seed-round11', 'node', ['scripts/seed-round11-demo.mjs']);

function ensureDev() {
  const ping = () => {
    const web = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:5173/'], { encoding: 'utf8' });
    const api = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:3001/api/auth/me'], { encoding: 'utf8' });
    return web.stdout === '200' && ['200', '401', '403', '429'].includes(api.stdout);
  };
  if (ping()) return;
  console.log('seed 后开发服务已停，重新拉起 npm run dev');
  const child = spawn('npm', ['run', 'dev'], { cwd: process.cwd(), detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 90; i += 1) {
    spawnSync('sleep', ['1']);
    if (ping()) return;
  }
  throw new Error('开发服务未起来');
}
ensureDev();

run('shots-88', 'node', ['scripts/round11/shots-88.mjs']);
run('menu-compare', 'node', ['scripts/round11/menu-compare.mjs']);
run('pages-compare', 'node', ['scripts/round11/pages-compare.mjs']);
run('forms-required', 'node', ['scripts/round11/forms-required.mjs']);
run('main-flow', 'node', ['scripts/round11/main-flow.mjs']);
run('round6-accept-items', 'node', ['scripts/round6-accept-items.mjs']);
run('round6-browser-accept', 'node', ['scripts/round6-browser-accept.mjs']);
run('round6-regression', 'node', ['scripts/round6-regression.mjs']);
run('round7-accept', 'node', ['scripts/round7-accept.mjs']);
run('round8-accept', 'node', ['scripts/round8-accept.mjs']);
run('round9-accept', 'node', ['scripts/round9-accept.mjs']);
run('round10-accept', 'node', ['scripts/round10-accept.mjs']);

if (!failed) lines.push('全部通过');
else lines.push('未通过');
writeFileSync(path.join(outDir, 'ALL.txt'), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));

const r10v44 = path.join(process.cwd(), 'docs/verification/round10/v44-regression.txt');
const r10all = path.join(process.cwd(), 'docs/verification/round10');
if (existsSync(r10v44)) copyFileSync(r10v44, path.join(outDir, 'v88-r10-accept-pass.txt'));
else {
  writeFileSync(path.join(outDir, 'v88-r10-accept-pass.txt'), readFileSync(path.join(outDir, 'ALL.txt'), 'utf8'));
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.setContent(`<pre style="font:14px/1.4 monospace;padding:24px;white-space:pre-wrap">${readFileSync(path.join(outDir, 'ALL.txt'), 'utf8').replace(/</g, '&lt;')}</pre>`);
await page.screenshot({ path: path.join(outDir, 'v60-all-pass.png') });
await browser.close();

if (failed) process.exit(1);
