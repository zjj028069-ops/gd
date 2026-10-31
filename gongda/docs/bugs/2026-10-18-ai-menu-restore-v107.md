# AI 六叶菜单恢复 v1.0.7（2026-10-18）

Allen 批准立刻发版：默认恢复 AI 智能体六叶侧栏；**保留** v1.0.6 handbook-uat-fixes。版本升至 **v1.0.7**，overlay 追加 `+ai-menu-restore`。

## 改了什么

| 项 | 状态 | 改动 |
|---|---|---|
| AI 六叶默认显示 | 已修 | `menu.ts`：`showAiExtraMenus()` 恒为 `true`，侧栏默认显示训练中心、赛德瑞克小助手、工厂助理、AI 导入 BOM、极速下单、图纸拆单 |
| 设备维保 / 智能设备 | 保留 | v1.0.6：`device_module` 开关；iot 默认隐藏 |
| 角色补种 | 保留 | v1.0.6：`GET /api/system/roles` 幂等补种 |
| work-orders 分页 | 保留 | v1.0.6：白名单 `page`/`page_size` |
| 进度圆圈 | 保留 | v1.0.6：`ProgressCell` circle / ProcessRings |

## 改动文件

- `apps/web/src/kgd/menu.ts`
- `VERSION` / `SEDRIC_VERSION.json` / `package.json` / `LAST_OVERLAY_TIP`
- 本文档

## 如何验

1. **菜单**：demo-a 登录后 AI智能体下可见 6 叶（训练中心、赛德瑞克小助手、工厂助理、AI导入BOM、极速下单、图纸拆单）。
2. **路由**：`/ai/drawing-split` → 200（页面可打开）。
3. **版本**：`VERSION` / `SEDRIC_VERSION.json` → v1.0.7；overlay 含 `+ai-menu-restore`。
4. **回归**：`GET /api/system/roles` ≥10；`GET /api/work-orders?page=1&page_size=10` → 200；一级仍无默认「智能设备」。

## 未做

- **未** push 远程 git（仅本地 commit）。
- **未**重建库、未改开发账号密码、未动服装 pm2。
