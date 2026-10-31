# SEDRIC01 v1.0.19 — 操作指引内联「创建工艺路线」简洁流程图

**日期**：2026-10-20（Asia/Shanghai）  
**版本**：SEDRIC01 v1.0.19  
**feature**：`guide-flowchart-craft-route`  
**主色**：`#4184F4`

## 需求

Allen 已确认：把「创建工艺路线」的**简洁流程图**做进聊天操作指引；不要跑马灯花哨动效。

- 问「怎么建工艺路线 / 创建工艺路线」等（topic `craft-route`）：卡片内联 `.guide-flow` 流程图（DOM/CSS），不要说明书截图。
- 遵守 v1.0.18：无 guide-shot、无「打开 MES 对照」、无底部 chips；可保留「需要 MES 演示吗」。
- 文字 steps 精简，以流程图为主。
- 本轮至少完成 craft-route。

## 设计稿

- `docs/ui-refs/2026-10-20-goal-prereq-craft-route-flowchart-v1.html`（及 `.png` / `.mmd`）
- 浅灰底、白卡片；蓝目标/必做、橙建议、绿验证；垂直箭头；无动画。

## 实现

### `chat-shell/guide/knowledge.js`

- `craft-route` 增加 `flowchart.nodes`（goal / must / rec / verify）与 `hint`。
- 关键词补：`创建工艺路线`、`怎么建工艺路线`、`怎么创建工艺路线`。
- `steps` 精简为 4 条（必做/建议/必做/验证），与流程图对齐。
- `images` 数据暂留不删（仍不渲染）。

### `chat-shell/app.js`

- 新增 `buildGuideFlow(flow)`：渲染 `.guide-flow` / `.guide-flow-box.kind-*` / 箭头 / 图例。
- `buildGuideCard`：有 `topic.flowchart` 时优先插入流程图；再渲染精简 steps；仍跳过 images / mes 对照 / chips；保留演示询问。

### `chat-shell/styles.css`

- 新增 `.guide-flow*` 样式，对齐设计稿（主色 `#4184F4`，无 `@keyframes`）。

### 版本标记

- `VERSION` / `SEDRIC_VERSION.json` / `LAST_OVERLAY_TIP` / `package.json` / `chat-shell/version.json` / `index.html` → **v1.0.19**
- overlay 追加 `+guide-flowchart-craft-route`

## 约束

- 不重建库、不改密码（md5 `ed017133e6253947794123a9eeeb6c9e`）、不触 garment-*、不启 sedric-web。
- 主要改 chat-shell；静态同步 VPS `/opt/sedric01/chat-shell/`。

## 备份

| 位置 | 备份名 |
|------|--------|
| Mac | `*.bak-pre-v119-20261020-193310` |
| VPS | `/opt/sedric01/.bak-20261020-v119`（VERSION 等）+ `/opt/sedric01/chat-shell.bak-20261020-v119` |

## 冒烟

1. 打开 `/chat/`，问「怎么建工艺路线」。
2. 应见简洁垂直流程图；无说明书截图、无「打开 MES 对照」、无底部胶囊。
3. 可保留「需要 MES 演示吗」。
4. 截图：`docs/ui-refs/2026-10-20-v119-flowchart-smoke.png`


## 扩展

同一版本已覆盖全部 17 个专题 flowchart，验收总表见 `docs/bugs/2026-10-20-guide-flowchart-all-topics.md`。
