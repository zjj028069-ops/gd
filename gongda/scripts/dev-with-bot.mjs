// 同时启动 MES（API + 前端）和 SEDRIC Bots 业务助手。
// 配置放在 .local/sbot.env（不进 git），第一次运行自动生成网关密钥。
//   SBOT_DIR            SEDRIC-Bots 仓库目录（默认 ../SEDRIC-Bots）
//   SBOT_LLM_BASE_URL   大模型接口，如 https://api.deepseek.com/v1
//   SBOT_LLM_API_KEY    大模型密钥（或 SBOT_LLM_API_KEY_ENV=DEEPSEEK_API_KEY，从该环境变量读取）
//   SBOT_LLM_MODEL      模型名，如 deepseek-chat
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(root, '.local/sbot.env');
mkdirSync(dirname(envFile), { recursive: true });
if (!existsSync(envFile)) {
  writeFileSync(envFile, [
    '# SEDRIC Bots 业务助手配置（只在本机，不要提交）',
    `SBOT_GATEWAY_TOKEN=${randomBytes(32).toString('hex')}`,
    'SBOT_URL=http://127.0.0.1:8765',
    '# 大模型：密钥从环境变量 DEEPSEEK_API_KEY 读取（也可以改用 SBOT_LLM_API_KEY= 直接填）',
    'SBOT_LLM_BASE_URL=https://api.deepseek.com/v1',
    'SBOT_LLM_API_KEY_ENV=DEEPSEEK_API_KEY',
    'SBOT_LLM_MODEL=deepseek-chat',
    '',
  ].join('\n'), { mode: 0o600 });
  console.log('已生成 .local/sbot.env');
}
const fileEnv = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/)
  .filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line))
  .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]));
const env = { ...process.env, ...Object.fromEntries(Object.entries(fileEnv).filter(([, v]) => v !== '')) };
env.PORT ??= '3001';
env.PUBLIC_ORIGIN ??= 'http://127.0.0.1:5173';
// 手机扫码：找本机的局域网地址，放行它并写进二维码（同一 WiFi 下的手机才能打开）
const lan = Object.values(networkInterfaces()).flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address))
  .map((n) => n.address);
if (lan.length && !env.MOBILE_BASE_URL) env.MOBILE_BASE_URL = `http://${lan[0]}:5173`;
env.EXTRA_ORIGINS = [...new Set([...(env.EXTRA_ORIGINS ?? '').split(',').filter(Boolean), ...lan.map((ip) => `http://${ip}:5173`)])].join(',');
if (env.MOBILE_BASE_URL) console.log(`手机访问地址（手机和电脑连同一个 WiFi）：${env.MOBILE_BASE_URL}/m`);

const botDir = resolve(root, env.SBOT_DIR ?? '../SEDRIC-Bots');
const port = new URL(env.SBOT_URL ?? 'http://127.0.0.1:8765').port || '8765';
const windows = process.platform === 'win32';
const children = [];
if (existsSync(resolve(botDir, 'run.py'))) {
  children.push(spawn(windows ? 'python' : 'python3', [resolve(botDir, 'run.py'), '--no-browser', '--port', port], {
    cwd: botDir, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
    env: { ...env, SBOT_MES_URL: `http://127.0.0.1:${env.PORT}`, PYTHONIOENCODING: 'utf-8' },
  }));
} else {
  console.warn(`找不到 SEDRIC-Bots（${botDir}），Bot 模式不可用；传统模式照常。`);
}
children.push(spawn(windows ? 'npm.cmd' : 'npm', ['run', 'dev'], { cwd: root, stdio: 'inherit', shell: windows, windowsHide: true, env }));

let stopping = false;
function stop(code = 0) {
  if (stopping) return; stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of children) child.on('exit', (code) => { if (!stopping) stop(code ?? 1); });
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
