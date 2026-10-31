# 2026-10-20 聊天壳 · 全手册 MES 演示（光标/放大镜）

- 时区：Asia/Shanghai
- 版本：**SEDRIC01 v1.0.7**（未 bump）
- 范围：`chat-shell` 演示引擎 + 全专题剧本；MES 仅 **BrowserRouter basename** 最小修复（子路径托管）
- **未动**帐套 / 库 / 密码 / garment-* / 业务逻辑

## 准稿

- `/workspace/saideruike/赛德瑞克完整操作说明书-合并版.md`
- `手册/00–12`、`截图/`
- 示意动画：`chat-shell-demo/storyboard/`

## 架构落地

### A. 演示引擎
- `chat-shell/guide/demo-player.js` → `window.SedricDemo.play(demoId)` / `stop()` / `hasDemo()`
- 打开已有 `#mes-page`（经 `window.SedricChat.openMes`）
- `#demo-overlay`：截图层 + 半透明遮罩 + 聚光洞 + 大光标缓动 + 圆形放大镜 + 黄涟漪 + 步骤气泡 + 下一步/跳过/结束

### B. 剧本
- `chat-shell/guide/demos.js` → **17** 个 demo（与 topic.id 同名）
- 覆盖：login, ui-layout, list-page, onboard, goods-create, **craft-process**, **craft-route**, contract, purchase, warehouse, work-order, report-work, wage, money, progress, roles-daily, faq
- 步骤字段：`shot` / `x,y(0–1)` / `label` / `ops` / `mesPath` / `hint`

### C. 真实 MES 跳转（basename）
- `apps/web/src/App.tsx`：`getMesBasename()` — 当 pathname 以 `/app` 开头时 `basename="/app"`
- **未改** `vite.config` 的 `base`（保持 `/`），避免打碎现有公网 `/assets/*` 绝对路径
- 构建：`npx vite build`（跳过 tsc）→ dist；iframe `mesPath` 形如 `/app/public_craft/list`
- 冒烟：`/app/public_craft/list` → 200（SPA try_files）；bundle 含 `startsWith("/app`

### D. 聊天 UX
- guide 卡片文末：「需要我打开 MES 演示给你看吗？」→「需要演示」/「先看文字」
- 欢迎语说明可演示；关键词含「录入工艺」「工序」「工艺路线」等
- `knowledge.js` 新增 craft-process / craft-route（摘自说明书第 03 章）；catalog 17 专题

### E. 路径说明（示意 vs 真菜单）
- 示意动画写「商品管理 → 工序」；**真系统菜单为「生产管理 → 工序管理」**（`/public_craft/list`）
- 文字指引与演示标签按真菜单：**生产管理 → 工序管理**
- 工艺路线：`/process_routing/list`（专图待补，暂用工序/商品详情/BOM 图讲解）

## 部署

| 项 | 路径 |
|----|------|
| Mac | `~/SEDRIC01-preview/chat-shell`、`apps/web/dist` |
| VPS chat 备份 | `/opt/sedric01/chat-shell.bak-demo-20261020-145629` |
| VPS dist 备份 | `/opt/sedric01/apps/web/dist.bak-demo-20261020-145629` |
| 同步 | rsync → `/opt/sedric01/chat-shell/`、`/opt/sedric01/apps/web/dist/` |
| 公网 | `http://129.204.53.109/chat/` · MES `/app/` |

## 冒烟（Host: 129.204.53.109）

- `/chat/` `/chat/guide/demo-player.js` `/chat/guide/demos.js` `/chat/guide/img/03-07-新增工序.png` → 200
- `/app/` `/app/public_craft/list` `/assets/index-BYPHafFK.js` → 200
- 帐套 mtime 仍 `2026-10-18 14:32:22 +0800`；VERSION 1.0.7

## 风险 / 待微调

1. **点击坐标**为说明书截图估算（右上新增≈0.85,0.12；左侧菜单≈0.06,0.35），不同分辨率 object-fit 下可能偏移，可按实机改 `demos.js`
2. **工艺路线无专图**；FAQ/roles 为多步截图讲解非逐按钮像素级
3. iframe 深链依赖登录态与 basename；未登录时对照以截图层为主
4. 企业信息等 `mesPath` 若与现网菜单别名不完全一致，仍以截图为准
5. 示意「商品管理→工序」与真菜单「生产管理→工序管理」不一致，已按真菜单落地

## 成功标准对照

- 问「如何录入工艺」→ 文字 + 询问演示 → 光标放大走「生产管理→工序→新增」✓（剧本已就绪）
- 登录/报工/合同/仓库/进度等均有 demo ✓
- v1.0.7；库未动 ✓
