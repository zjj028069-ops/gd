# SEDRIC01 v1.0.22 — 演示 AuthGate 竞态（demo-wait-shell-ready）

**日期**：2026-10-20（Asia/Shanghai）  
**版本**：SEDRIC01 v1.0.22  
**feature**：`demo-wait-shell-ready`  
**主色**：`#4184F4`  
**承接**：Allen 反馈一点「演示」就出现「正在确认登录状态…」，文案已是第1步「左侧点生产管理」+未找到，界面还在登录确认。

## 根因
`chat-shell/guide/demo-player.js`：
1. `waitForMesReady` 有 `Date.now() - start > 1200` 提前 resolve——无 shell 也放行，AuthGate「正在确认登录状态」时就开始 find。
2. `runStep` 一进来就 `updateBubble(step…)`，未等就绪就显示第1步文案。
3. AuthGate 不是带密码框的登录页 → `isMesLoginPage` 常为 false；无侧栏 → find 失败。

## 改动
| 文件 | 内容 |
|------|------|
| `chat-shell/guide/demo-player.js` | 去掉 1200ms 放行；AuthGate/加载中不算就绪；就绪前过渡气泡；shell 后短缓冲；findWaitMs 默认 6000；play 先等文案 |
| `VERSION` / `SEDRIC_VERSION.json` / `chat-shell/version.json` / `package.json` / `LAST_OVERLAY_TIP` | → v1.0.22 |

## 行为约定
- **就绪**：`hasMesShell(doc)`；或明确登录页（密码框且无侧栏）→ resolve，上层提示先登录。
- **不算就绪**：body 含「确认登录」「正在登录」「加载中」等；或仅居中 logo+spinner、无 `.kgd-sidebar-primary`。
- **气泡**：就绪前「正在等待 MES 加载…」，光标 x≈0.10 侧栏区；就绪后再写步骤 label/hint 并 find。
- **首步 timeout**：约 18s；侧栏步骤 shell 后缓冲 400ms。
- **失败**：仍侧栏 fallback，禁止甩表格中央。

## 约束
- 不重建库、不改密码（md5 `ed017133…`）、不触 garment-*、不启 sedric-web
- Mac 备份：`*.bak-pre-v122-20261020-202024`
- VPS：`.bak-20261020-v122` + `chat-shell.bak-20261020-v122`

## 冒烟
- 冷启动 iframe（模拟刚开 MES / 仍 AuthGate）→ 演示：等侧栏出现后第1步光标落「生产管理」、气泡贴光标；等待期间文案为「正在等待 MES…」而非步骤文案。
- 已登录热态仍正常。
- 截图：`docs/ui-refs/2026-10-20-v122-demo-wait-ready-smoke.png`

## 冒烟实测（2026-10-20 ~20:24 Asia/Shanghai）
- 公网 `version.json` → **1.0.22**；UI 展示 SEDRIC01 v1.0.22
- 冷启动（iframe 注入「正在确认登录状态…」）：气泡「正在等待 MES 加载…」/准备中，光标 x=0.1；AuthGate 期间无步骤文案、无「未找到」；侧栏出现后第1步「左侧点「生产管理」」
- 热启动：光标 `x≈0.093 y≈0.337` 落「生产管理」，气泡 follow；无「未找到」
- 脚本：`artifacts/uat-2026-10-20-v122/demo-wait-ready-smoke.mjs` → **20 pass / 0 fail**
- 截图：`docs/ui-refs/2026-10-20-v122-demo-wait-ready-smoke.png`
