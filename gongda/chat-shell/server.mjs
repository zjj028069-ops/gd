#!/usr/bin/env node
/**
 * 赛德瑞克聊天壳 · 本地同域代理
 * - 静态：本目录 HTML/JS/CSS
 * - /api → 本地 API（默认 3011）
 * - /mes、/app → 本地 Vite MES（默认 5183）
 * 生产公网用 nginx；本文件仅供本地冒烟与开发。
 */
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5180);
const API_ORIGIN = process.env.API_ORIGIN || 'http://127.0.0.1:3011';
const MES_ORIGIN = process.env.MES_ORIGIN || 'http://127.0.0.1:5183';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function proxy(req, res, targetOrigin) {
  const incoming = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const target = new URL(incoming.pathname + incoming.search, targetOrigin);
  const headers = { ...req.headers, host: target.host };
  delete headers['accept-encoding'];

  const upstream = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end(`代理失败 ${targetOrigin}: ${err.message}`);
  });
  req.pipe(upstream);
}

function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url || '/', 'http://local').pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(root, pathname));
  if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  res.writeHead(200, { 'content-type': contentType(filePath) });
  createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url.startsWith('/api/') || url === '/api' || url.startsWith('/health/')) {
    proxy(req, res, API_ORIGIN);
    return;
  }
  if (
    url.startsWith('/mes/') ||
    url === '/mes' ||
    url.startsWith('/app/') ||
    url === '/app' ||
    url.startsWith('/@') ||
    url.startsWith('/src/') ||
    url.startsWith('/node_modules/') ||
    url.startsWith('/assets/') ||
    url.startsWith('/vite.svg')
  ) {
    proxy(req, res, MES_ORIGIN);
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`chat-shell http://127.0.0.1:${PORT}/`);
  console.log(`  API_ORIGIN=${API_ORIGIN}`);
  console.log(`  MES_ORIGIN=${MES_ORIGIN}`);
});
