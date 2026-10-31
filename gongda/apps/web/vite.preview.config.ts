// 预览目录专用：避开原项目 5173/3001。不要提交。
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1', port: 5183, strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3011', changeOrigin: false, headers: { origin: 'http://localhost:5183' } } },
  },
});
