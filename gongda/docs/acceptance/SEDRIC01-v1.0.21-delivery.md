# SEDRIC01 v1.0.21 交付报告

**时间**：2026-10-20 Asia/Shanghai  
**版本**：SEDRIC01 **v1.0.21**  
**feature**：`demo-sidebar-find-bubble-follow`  
**公网**：`http://129.204.53.109/chat/`

## 验收问题
MES 演示操作与光标不一致（craft-process 第1步文案「左侧点生产管理」，光标却在表格「产线」列）。并要求文字步骤气泡跟随光标。

## 改动摘要
| 文件 | 内容 |
|------|------|
| `chat-shell/guide/demo-player.js` | find 兼容新侧栏；失败停侧栏；气泡跟随 |
| `chat-shell/styles.css` | `.demo-bubble-follow` 绝对定位 |
| `chat-shell/guide/demos.js` | craft-process hint 微调 |
| 版本标记 | → v1.0.21 |

## 冒烟
- 单元：mock `.kgd-sidebar-primary` / `.kgd-sidebar-item` 可被 findInMes 命中
- 公网：craft-process 第1–2 步光标在侧栏「生产管理」「工序管理」，气泡在光标旁
- 截图：`docs/ui-refs/2026-10-20-v121-demo-cursor-smoke.png`

## 约束核对
- 库未重建；密码 md5 仍 `ed017133…`；未触 garment-*；未启 sedric-web

## 冒烟实测（2026-10-20 19:51 Asia/Shanghai）
- 公网 `version.json` → **1.0.21**
- mock DOM：`find.rail=生产管理` / `find.sub=工序管理` 命中 `.kgd-sidebar-primary.active` / `.kgd-sidebar-item.active`
- Playwright 公网 craft-process 第1步：`cursorX≈0.093`（侧栏）、文案「左侧点「生产管理」」、`demo-bubble-follow=true`，气泡在光标旁
- 第2步曾测：`cursorX≈0.097`，文案「二级菜单点「工序管理」」
- 密码 md5 仍 `ed017133…`；`sedric-web` stopped；库 mtime 未动；未触 garment-*
