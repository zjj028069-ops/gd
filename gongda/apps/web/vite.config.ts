import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // 云端 Agent 预览端口转发只能打到非 loopback；本机仍可用 127.0.0.1:5173
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // 理由：Cloudflare quick tunnel / 端口转发 Host 头不是 localhost，需放行
    allowedHosts: true,
    proxy: {
      // 冒烟可用 API_PROXY_TARGET=http://127.0.0.1:3011
      '/api': { target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3001', changeOrigin: false },
    },
  },
});
