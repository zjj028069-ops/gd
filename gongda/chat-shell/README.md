# 赛德瑞科 · 聊天壳（对接真实 MES）

桌面端可点 HTML 壳 + 同域 Node 反代，登录 **SEDRIC01 v1.0.7** 公网 MES。

## 启动

在本目录执行：

```bash
node server.mjs
```

浏览器打开控制台打印的地址（默认 `http://127.0.0.1:8875/`）。

可选环境变量：

- `PORT` — 监听端口（默认 `8875`）
- `MES_ORIGIN` — MES 源站（默认 `http://129.204.53.109`）

## 版本

界面常显 **SEDRIC01 v1.0.7**（登录卡、顶栏、侧栏底、进入 MES 顶栏）。

## 登录

- 企业标识默认预填 `demo-a`
- 账号 / 密码由你输入；**壳不附带、不写死密码**
- 开发凭据在 MES 服务器 `.local/dev-credentials.txt`（勿把真实密码写进本仓库或 README）
- 登录：`POST /api/auth/login`（经本机代理，带 Cookie）
- 退出：`POST /api/auth/logout`
- 启动时可 `GET /api/auth/me` 恢复会话

## 进入 MES

顶栏「进入MES」同窗打开 iframe，地址 `/mes/`（反代真实 MES，剥前缀）。可「返回聊天」。

## 定稿 UI

- **两栏**：左会话列表 / 右对话区
- 左顶：搜索框 + 圆形「+」
- 右顶：会话名 + 轻按钮「进入MES」
- 视觉：苹果毛玻璃，主色 `#4184F4`

## 说明

不可直接用 `file://` 或纯静态服务跨域打公网 API（无可用 CORS，Cookie 也无法给进入 MES 用）。必须用 `node server.mjs` 同域代理。
