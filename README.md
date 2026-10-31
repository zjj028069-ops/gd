# 赛德瑞克 SEDRIC01 · 全套系统

| 目录 | 内容 |
|---|---|
| `gongda/` | 赛德瑞克 MES（工单系统）：Fastify API + React 前端 + PGlite 嵌入数据库 |
| `SEDRIC-Bots/` | SEDRIC Bots 业务助手（Bot 模式 / 代操作 / 拖拽上传文件），只开放业务系统白名单工具 |

两个目录必须并排放（MES 启动时默认在 `../SEDRIC-Bots` 找 Bot）。

## 本机启动（Windows）

1. 装好 Node.js 20+ 和 Python 3.11+。
2. `cd gongda` 后运行 `npm install`；运行 `pip install -r SEDRIC-Bots/backend/requirements.txt`（Bot 前端会在第一次启动时自动构建）。
3. 设置环境变量 `DEEPSEEK_API_KEY`（Bot 用的大模型密钥，不在仓库里）。
4. 双击 `gongda/start-windows.cmd`。第一次运行会在 `gongda/.local/sbot.env` 自动生成 Bot 网关密钥。
5. 浏览器打开 http://127.0.0.1:5173 ；手机和电脑连同一个 WiFi，打开命令行窗口里打印的「手机访问地址」。

## 数据

仓库里带了一份测试数据：
- `gongda/.local/database`：MES 数据库（演示企业 demo-a / demo-b / demo-c / demo-d）；
- `SEDRIC-Bots/data`：Bot 会话和企业经验库。

账号密码文件（`.local/*-credentials.txt`、`mobile-test-accounts.txt`）和 Bot 网关密钥（`.local/sbot.env`）**没有上传**。
需要登录时：
- 平台账号：在 `gongda` 下停掉服务后运行 `npm run platform:operator -w @gongdan/api -- <账号> <姓名>`，会生成新密码；
- 企业账号：用平台后台（`/platform`）给企业账号「重置密码」。

## 说明文档

- `gongda/docs/Bot模式-SEDRIC-Bots整合说明.md`：Bot 模式、代操作、经验库、拖拽上传
- `gongda/docs/平台管理后台说明.md`：平台后台（开企业、配额、账号）
- `gongda/docs/手机版说明.md`：手机扫码报工、加工单
