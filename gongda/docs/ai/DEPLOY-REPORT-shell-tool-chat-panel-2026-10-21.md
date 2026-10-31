# DEPLOY-REPORT · shell-tool-chat-panel（v1.0.47）

- 时间：2026-10-21（Asia/Shanghai）
- 现网：`root@129.204.53.109:/opt/sedric01`
- 版本：**SEDRIC01 v1.0.47** · feature `shell-tool-chat-panel`
- 主色：`#4184F4`
- 备份：`/opt/sedric01/.bak-20261021-tool-panel`
- 镜像：`/workspace/ext-app-v147/`
- 约束：不开云端；不重建库；不改密码

## 问题

点「我的工具→图片字段提取」同时出现完整 MES（生产管理侧栏+主区 iframe）与右下角壳内浮层。

## 根因

`chat-shell/app.js` 对 shell_tool 在 `openShellToolPanel` 之后，若 `menu_path` 存在且 placement≠chat_panel，会再 `navigateMes`；默认 placement=sidebar，故双开。

## 改动文件

| 路径 | 要点 |
|------|------|
| `chat-shell/app.js` | shell_tool **只** `openShellToolPanel`；lite_express 仍 `navigateMes` |
| `chat-shell/shell-tool-runtime.js` | file_picker 文案按 accept 区分图片/PDF |
| `chat-shell/index.html` | cache bust `?v=20261021-tool-panel` |
| `apps/api/src/ai/shell-tool.ts` | 默认 placement=`chat_panel`；识图强制 chat_panel；显式「侧栏/生产侧栏」才 sidebar |
| `apps/api/src/ai/ext-app.ts` | chat_panel → menu:false、menu_path 空；方案卡「聊天壳打开，不进 MES」 |
| `apps/web/src/modules/ai/ShellToolPage.tsx` | 去掉硬编码「仅 PDF」，按 accept 显示图片/PDF 限额文案 |
| `apps/web/dist/assets/index-*.js` | 顺手弱化硬编码「仅 PDF」文案（sedric-web 停用、nginx 仍可能吃 dist） |
| 版本三件套 + chat-shell/version.json | 升 **1.0.47** |
| PGlite `ai_ext_apps` | 已启用 shell_tool：placement=chat_panel、menu=false、menu_path 清空 |

## 冒烟（demo-a / admin.local，未改密码）

| 项 | 结果 |
|----|------|
| 已启用「图片字段提取」placement/menu_path | chat_panel / 空 |
| 已启用 accept | image/png,jpeg,webp,gif |
| 许愿「写一个提取图片字段的工具」方案卡 | can_do/summary 含「聊天壳打开，不进 MES」 |
| 许愿「写一个计算器」 | chat_panel 文案 |
| 许愿「做一个挂到生产侧栏的计时器」 | can_do 含「MES 侧栏」 |
| app.js 轨点击 | shell_tool 无 navigateMes；lite_express 仍有 |
| pm2 restart sedric-api | online |
| 浏览器点轨手测 MES 不展开 | **未在本机开浏览器点轨**（静态+API 已验；需 Allen 强刷 cache） |

## 诚实未做

- 未开浏览器 UI 手点「我的工具→图片字段提取」截图验收（无登录态桌面自动化本轮）。
- 未重建/重启 sedric-web（仍 stopped）；MES 源码已改，完整 dist 未重新 vite build，仅替换了「仅 PDF」硬编码片段。
- 未启用/未回归真实「快递约件」实例（库中无 enabled lite_express）；代码路径保留 navigateMes。
- 落单接线仍未做（与 v1.0.46 相同）。
