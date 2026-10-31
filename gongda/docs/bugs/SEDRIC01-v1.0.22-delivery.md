# SEDRIC01 v1.0.22 交付报告

**时间**：2026-10-20 Asia/Shanghai  
**版本**：SEDRIC01 **v1.0.22**  
**feature**：`demo-wait-shell-ready`  
**公网**：`http://129.204.53.109/chat/`

## 验收问题
一点「演示」就撞上 AuthGate「正在确认登录状态…」：文案已是第1步「左侧点生产管理」+「未找到」，界面还在登录确认（时间差导致光标/文字跟不上）。

## 根因
`waitForMesReady` 有 1200ms 无 shell 提前放行；`runStep` 一进来就 `updateBubble(step)`；AuthGate 无密码框 → `isMesLoginPage` 常为 false。

## 改动摘要
| 文件 | 内容 |
|------|------|
| `chat-shell/guide/demo-player.js` | 去 1200ms 放行；AuthGate/加载中不算就绪；就绪前「正在等待 MES 加载…」；shell 后 400ms 缓冲；findWaitMs 默认 6000；play 由 runStep 内 wait |
| `chat-shell/index.html` / `app.js` / `version.json` | 展示版本 → v1.0.22 |
| `VERSION` / `SEDRIC_VERSION.json` / `package.json` / `LAST_OVERLAY_TIP` | → v1.0.22 |

## 冒烟（2026-10-20 Asia/Shanghai）
- 公网 `version.json` → **1.0.22**；demo-player 含 `demo-wait-shell-ready`，无 `> 1200` 提前放行
- **冷启动**（注入 AuthGate「正在确认登录状态…」）：气泡为「正在等待 MES 加载…」/准备中，光标 x=0.1 侧栏区；**不出现**步骤文案与「未找到」；侧栏出现后第1步「左侧点「生产管理」」
- **热启动**（已登录侧栏）：第1步光标 `x≈0.093 y≈0.337` 落「生产管理」，气泡 follow 贴光标，无「未找到」
- 截图：`docs/ui-refs/2026-10-20-v122-demo-wait-ready-smoke.png`
- 详记：`docs/bugs/2026-10-20-demo-auth-race.md`
- 产物：`artifacts/uat-2026-10-20-v122/`（20 pass / 0 fail）

## 约束核对
- 库未重建；密码 md5 仍 `ed017133…`；未触 garment-*；`sedric-web` 保持 stopped
- Mac bak：`*.bak-pre-v122-20261020-202024`
- VPS bak：`.bak-20261020-v122` + `chat-shell.bak-20261020-v122`
