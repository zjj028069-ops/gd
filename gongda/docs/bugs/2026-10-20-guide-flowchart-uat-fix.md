# SEDRIC01 v1.0.20 — 交付实施经理公网验收 FAQ 流程图标签修复

**日期**：2026-10-20（Asia/Shanghai）  
**版本**：SEDRIC01 v1.0.20  
**feature**：`guide-flowchart-uat-fix`  
**主色**：`#4184F4`  
**承接**：v1.0.19 公网验收 16 通过 / 1 不通过（`faq`）

## 不通过项（已修）

`chat-shell/guide/knowledge.js` · topic `faq` flowchart：

| 节点 | kind | 修复前 k | 修复后 k | t（保留） |
|------|------|----------|----------|-----------|
| 1 | goal | 目标 | 目标 | 解开常见问题 |
| 2 | must | ① 问题 | ① 必做 | 登不进去 |
| 3 | must | ② 问题 | ② 必做 | 菜单看不到 |
| 4 | rec | ③ 问题 | ③ 建议 | 批量操作是灰的 |
| 5 | rec | ④ 问题 | ④ 建议 | 界面写「快工单」 |
| 6 | verify | ⑤ 验证 | ⑤ 验证 | 问题消失或有管理员跟进 |

图例与其它专题一致：必做 / 建议。

## 顺手文案对齐（现网）

- `login`：退出路径改为聊天壳左下角用户菜单（MES 非嵌入仍写头像菜单）。
- `ui-layout`：二级当前项改为主色蓝 #4184F4；嵌入时头像在聊天左下、MES 顶栏无头像。
- `list-page` / `goods-create` / `work-order` / `progress`（及报工一步）：「绿单号 / 绿色商品名」→「可点单号 / 可点商品名」。

## 约束

- 不重建库、不改密码、不触 garment-*、不启 sedric-web。
- Mac 备份：`*.bak-pre-v120-20261020-*`；VPS：`.bak-20261020-v120` + `chat-shell.bak-20261020-v120`。

## 冒烟

公网 `/chat/` 问「常见问题」或「FAQ」：流程图中间节点标签为「必做」「建议」，不为「问题」。  
截图：`docs/ui-refs/2026-10-20-v120-faq-flow-smoke.png`
