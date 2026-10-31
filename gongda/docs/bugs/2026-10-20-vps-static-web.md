# 2026-10-20 公网 MES：Vite 开发模式 → 生产静态构建（治卡顿）

**版本**：SEDRIC01 v1.0.7（未升版）  
**时间**：2026-10-20 Asia/Shanghai（约 13:18–13:20）  
**范围**：仅 web 静态服务 + nginx；未动库 / 密码 / garment-* / sedric-api

## 做了什么

1. **构建位置**：在 VPS `/opt/sedric01` 构建（Mac 本机构建未产出 dist；按总设计师最短路径改走 VPS）。
2. **`npm run build -w @gongdan/web`**：`tsc --noEmit` **失败**  
   - `WorkOrderExtras.tsx(132)`：`row.process_progress` possibly null/undefined（TS18049×2）  
   - 改用 `cd apps/web && npx vite build` **成功**（~14s，vite 7.3.6），产物：
     - `/opt/sedric01/apps/web/dist/index.html`
     - `assets/index-Sja45Hrd.js`、`index-D4hpCG4I.css` 等  
   - 构建前无旧 `dist`，无需 `dist.bak-*`。
3. **nginx**：备份  
   `/www/server/panel/vhost/nginx/sedric01-80.conf.bak-20261020-131910`  
   `location /` 从 `proxy_pass http://127.0.0.1:5183` 改为：
   ```nginx
   location / {
       root /opt/sedric01/apps/web/dist;
       try_files $uri $uri/ /index.html;
   }
   ```
   **保留** `/chat/`、`/api/`、`/health/`。`nginx -t` 通过后 `nginx -s reload`。
4. **pm2**：冒烟通过后 `pm2 stop sedric-web`（未 delete）。`sedric-api` 保持 online。garment-* 未动。

## 冒烟（公网 http://129.204.53.109）

| 路径 | 结果 |
|------|------|
| `/` | 200，构建产物 HTML，**无** `/@vite/client` |
| `/assets/index-Sja45Hrd.js` | 200 |
| `/api/auth/me` | 401 |
| `/chat/` | 200 |
| `/health/live` | 200 `{"status":"ok"}` |

## 帐套未动证明

| 项 | 部署前 = 部署后 |
|----|----------------|
| `.local/dev-credentials.txt` md5 | `ed017133e6253947794123a9eeeb6c9e` |
| creds mtime | `2026-10-13 22:19:31.893685755 +0800` |
| `.local/database` mtime | `2026-10-18 14:32:22.268992054 +0800` |
| database 目录 listing | diff 无变化 |

## 回滚

```bash
# 1) 恢复 nginx 反代 5183
cp /www/server/panel/vhost/nginx/sedric01-80.conf.bak-20261020-131910 \
   /www/server/panel/vhost/nginx/sedric01-80.conf
nginx -t && nginx -s reload

# 2) 重启 Vite 开发服
pm2 start sedric-web
```

勿对 garment-* 或 sedric-api 做无关操作。
