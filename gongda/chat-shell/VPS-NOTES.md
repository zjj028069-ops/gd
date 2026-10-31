# VPS 卡顿排查笔记（2026-10-20）

## 当前实测

- SSH 上看 load 约 **0.07**，API 响应毫秒级。
- **主因不是 CPU 打满**。

## 卡的主因

1. **公网前端仍是 Vite 开发模式**（`vite --port 5183`）经 nginx 反代。浏览器要拉大量源码模块，外网体感卡。
2. **`sedric-web` 历史重启约 53 次**；日志里有扫描器打 `/etc/passwd`、`/proc/self/environ` 等（噪声，非业务主因）。
3. **Swap 已用约 800MB**，磁盘约 **71%**。

## 本轮部署边界（chat-shell）

- **不动**帐套 / 库 / 密码；**不重建** `.local/database`；**不改** `dev-credentials.txt`。
- **不触碰** garment-*。
- **不为治卡强制改 MES 构建方式**；建议下一轮再做 production build（替换 `vite --port 5183` 为静态产物）。

## 公网入口

- 聊天壳：`http://129.204.53.109/chat/`（静态三文件 + nginx `alias`）
- MES 首页与 `/api` 仍走原路径；chat 页「进入MES」同站根 `/`。

## 本轮已上线（2026-10-20 Asia/Shanghai）

- 公网：`http://129.204.53.109/chat/`（静态 `alias`，未启动 `server.mjs`）
- nginx：`sedric01-80.conf` 在 `location /api/` 前增加 `/chat/` + `/chat`→301；备份 `sedric01-80.conf.bak-chat-20261020-131331`
- 帐套未动：`.local/database` mtime 仍为 `2026-10-18 14:32:22 +0800`；`dev-credentials.txt` md5 未变
- 说明：裸 `curl http://127.0.0.1/chat/` 可能落到宝塔 `phpfpm_status`（同听 80）；用公网 IP 或带 `Host: 129.204.53.109` 测为 200

## 2026-10-20 公网 MES 静态化（治卡顿）
- 版本保持 SEDRIC01 v1.0.7
- VPS 上 `npx vite build`（tsc 因 WorkOrderExtras TS18049 失败已跳过）→ `/opt/sedric01/apps/web/dist`
- nginx `location /` → root+try_files；保留 `/chat/` `/api/` `/health/`
- 备份：`sedric01-80.conf.bak-20261020-131910`
- `pm2 stop sedric-web`；sedric-api / garment-* 未动
- 公网 `/` 200 无 `/@vite/client`；`/api/auth/me` 401；帐套 md5/mtime 不变
- 回滚：恢复 nginx bak + `pm2 start sedric-web`
- 详记：Mac `docs/bugs/2026-10-20-vps-static-web.md` 与 VPS 同路径

## 2026-10-20 入口切换：毛玻璃登录 → 聊天壳；MES → /app/
- 产品约定：图1毛玻璃登录 → 图2聊天壳；「进入MES」再进 MES
- 公网入口：`http://129.204.53.109/` → 302 `/chat/`（毛玻璃登录）
- 聊天壳：`http://129.204.53.109/chat/`（欢迎回来 · MES · SEDRIC01 v1.0.7）
- MES 新路径：`http://129.204.53.109/app/`（静态 dist，无 @vite/client）；绝对资源 `/assets/*` 仍 200
- chat-shell `app.js`：生产入口（`/`、`/index.html`、`/chat*`）iframe → `/app/`；VERSION 仍 SEDRIC01 v1.0.7
- nginx：备份 `sedric01-80.conf.bak-entry-20261020-132459`；`/` 302→`/chat/`；`/app/` alias dist；保留 `/api` `/health`；未 start sedric-web
- 帐套未动：`.local/database` mtime `2026-10-18 14:32:22 +0800`；`dev-credentials.txt` md5 `ed017133e6253947794123a9eeeb6c9e`
- garment-* / sedric-api 未动；sedric-web 保持 stopped

## 2026-10-20 根路径旧 MES 深链收拢（Asia/Shanghai ~13:33）
- 问题：`/` 已 302→`/chat/`，但 `/screen_management/list`、`/login` 等仍经 `location /` try_files 出 MES dist（图2）
- 改动：`location /` 改为 `return 302 /chat/`；保留 `/chat/` `/app/` `/assets/` `/api/` `/health/`；`location = /` 仍 302→`/chat/`
- 备份：`/www/server/panel/vhost/nginx/sedric01-80.conf.bak-deeplink-20261020-133305`
- 冒烟：`/` `/screen_management/list` `/login` → 302 `/chat/`；`/chat/` 聊天壳；`/app/` 与 `/app/screen_management/list` MES；`/assets/*.js` 200
- 帐套未动：database mtime `2026-10-18 14:32:22 +0800`；creds md5 `ed017133e6253947794123a9eeeb6c9e`；未 start sedric-web；garment-* 未动
- 推荐登录：`http://129.204.53.109/chat/`（或打开 `/` 自动跳转）；不必死记旧 MES 深链，旧根路径会收拢到聊天壳

## 2026-10-20 聊天壳/MES iframe 铺满全屏
- 改 styles.css：`.app` / `.mes-page` / `.mes-frame-shell` 去掉 max-width:1280 与外边距；侧栏与聊天区圆角贴边
- 已同步：Mac ~/SEDRIC01-preview/chat-shell + VPS /opt/sedric01/chat-shell/styles.css
- 版本仍 SEDRIC01 v1.0.7；未动库/密码/garment-*
- 验证：强刷 http://129.204.53.109/chat/ 与「进入MES」


## 2026-10-20 聊天壳接入操作说明书 handbook-r1（Asia/Shanghai）
- 版本仍 SEDRIC01 v1.0.7；只动 chat-shell
- 新增 `guide/knowledge.js` + `guide/img/`（15 专题 / 26 图）
- 助手主路径改为说明书匹配，去掉演示回声
- VPS 备份：`/opt/sedric01/chat-shell.bak-guide-20261020-144057`
- 冒烟：`/chat/`、`/chat/guide/knowledge.js`、png → 200
- 详记：`docs/bugs/2026-10-20-chat-guide-handbook-r1.md`

## 2026-10-20 全手册演示（光标/放大镜 · Asia/Shanghai ~14:56）
- 版本仍 SEDRIC01 v1.0.7；库/密码/garment-* 未动
- 新增 `guide/demo-player.js` + `guide/demos.js`（17 专题）；knowledge 补 craft-process / craft-route
- MES：`App.tsx` 运行时 basename=`/app`（未改 vite base，/assets 仍根路径）
- 备份：`chat-shell.bak-demo-20261020-145629`、`apps/web/dist.bak-demo-20261020-145629`
- 详记：`docs/bugs/2026-10-20-chat-handbook-demo-full.md`

## 2026-10-20 Live MES 演示（真 iframe DOM · Asia/Shanghai）
- 版本仍 SEDRIC01 v1.0.7；只动 chat-shell
- `guide/demo-player.js` + `demos.js`：截图层不再作主画面；findInMes + 真 click
- 备份：`/opt/sedric01/chat-shell.bak-live-demo-20261020-150657`
- 未 rebuild dist；库/密码/garment-* 未动
- 详记：`docs/bugs/2026-10-20-chat-live-mes-demo.md`


## 2026-10-20 聊天壳加载真实 MES 修复（Asia/Shanghai ~17:34）
- 根因：openMes 8s about:blank 轮询误报且无 load 收起；版本写死 v1.0.7
- 改动：watchMesIframeLoad（load/error/20s）、已 live 不重置 src、VERSION→v1.0.14 + version.json
- 备份：`/opt/sedric01/chat-shell.bak-mes-load-20261020-173400`
- 未动 nginx/dist/帐套/garment-*；详记 `docs/bugs/2026-10-20-chat-mes-load.md`
