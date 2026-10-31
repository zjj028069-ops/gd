# SEDRIC01（赛德瑞克）

通用制造业轻量 MES。当前快照版本：**v1.0.74**（`plan-detail-left-card`，2026-10-27）。

## 目录

- `apps/api`：Fastify API
- `apps/web`：React/Vite 前端（MES）
- `chat-shell`：聊天壳
- `docs`：说明与热修交付记录
- `scripts`：运维/开发脚本

## 说明

- 本仓库为可分享源码快照，**不含** `.env`、数据库、账号密码、`node_modules`。
- 现网部署目录为腾讯云 `/opt/sedric01`；本地预览请自行配置环境变量与数据库。
- 主色：`#4184F4`。

## 本地开发（概要）

需要 Node.js（建议 20+）与 PostgreSQL/PGlite（以项目脚本为准）。

```sh
npm ci
# 按 DEPLOY.txt / docs 配置环境后
npm run dev
```

团队分享用仓库：https://github.com/zjj028069-ops/gongda
