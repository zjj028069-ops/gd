# 演示光标与文字不一致（2026-10-20）

- 报告人：Allen / 交付实施经理验收
- 专题：`craft-process`（录入工艺）演示第 1 步
- 现场版本：SEDRIC01 v1.0.20（修前）→ **v1.0.21**（修后）
- feature：`demo-sidebar-find-bubble-follow`
- 截图（修前）：`2026-10-20-demo-cursor-mismatch-craft-process.png`
- 冒烟（修后）：`docs/ui-refs/2026-10-20-v121-demo-cursor-smoke.png`

## 现象
文字要求点左侧「生产管理」，提示「未找到：一级菜单「生产管理」」；光标/聚光灯落在表格「产线」列（回退坐标 `0.5,0.45`）。页面实际已在工序管理列表。

## 根因
`chat-shell/guide/demo-player.js` 的 `findInMes` 仍找 `.kgd-rail button` / `.kgd-sub`。统一毛玻璃侧栏后 DOM 为：

- 一级：`.kgd-sidebar-primary`（`aria-label` / `.kgd-sidebar-label`）
- 二级：`.kgd-sidebar-children .kgd-sidebar-item`（`data-label` / `.kgd-sidebar-label`）
- `hasMesShell` 也不应只认 `.kgd-rail`

## 修复（v1.0.21）
1. `find.rail` / `find.sub` 兼容旧 rail/sub + 新侧栏；优先 `.active`。
2. 找不到时停在侧栏区（x≈0.10），hint：「未找到：…可点下一步或请手动点侧栏」。
3. `updateBubble` + `positionBubble`：气泡跟随光标（优先右下/右上）；工具条仍底栏。
4. `hasMesShell` / 登录页检测同时认 `.kgd-sidebar` / `.kgd-sidebar-primary`。

## 状态
**已修并上公网 v1.0.21**，交交付实施经理复验。
