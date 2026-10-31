# SEDRIC01 v1.0.21 — 演示侧栏 find + 气泡跟随光标

**日期**：2026-10-20（Asia/Shanghai）  
**版本**：SEDRIC01 v1.0.21  
**feature**：`demo-sidebar-find-bubble-follow`  
**主色**：`#4184F4`  
**承接**：交付实施经理验收 — craft-process 第1步光标甩到表格中央

## 改动文件
- `chat-shell/guide/demo-player.js` — findInMes / hasMesShell / positionBubble / 失败回退
- `chat-shell/styles.css` — `.demo-bubble` 跟随定位
- `chat-shell/guide/demos.js` — craft-process 第1步 hint 微调
- `VERSION` / `SEDRIC_VERSION.json` / `chat-shell/version.json` / `package.json`

## 约束
- 不重建库、不改密码（md5 `ed017133…`）、不触 garment-*、不启 sedric-web
- Mac 备份：`*.bak-pre-v121-20261020-194753`
- VPS：`.bak-20261020-v121` + `chat-shell.bak-20261020-v121`

## 冒烟
craft-process 第1–2 步：光标落在侧栏「生产管理」「工序管理」；气泡在光标旁。  
截图：`docs/ui-refs/2026-10-20-v121-demo-cursor-smoke.png`
