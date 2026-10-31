# 交付说明 · plan-detail-left-card（v1.0.74）

- **时间**：2026-10-27（Asia/Shanghai）
- **现网**：`root@129.204.53.109:/opt/sedric01`
- **前置**：v1.0.73 `mrp-scale-fix`
- **约束**：未开云端 Cursor；未重建库、未改密码；garment-* 未动；不算料/SCALE/BOM 分行

## 1. 结论（一句话）

生产计划详情已改回原版**左侧竖卡信息区** + 右侧页签；进度条轨道补足 `width:100%` / `min-width:64px`，彩色条与百分比可见。业务与 MRP 算料未改。

## 2. 版本

| 项 | 值 |
|----|-----|
| 版本 | **1.0.74** |
| feature / tag | `plan-detail-left-card` |
| hotfix | `20261027-plan-detail-v174` |
| dist JS | **index-BxsRLap0.js** |
| dist CSS | **index-CqEvOEpH.css** |
| 备份 | `/opt/sedric01/.bak-20261027-plan-detail-v174/` |
| 公网入口 | `http://129.204.53.109/app/`（nginx alias → `apps/web/dist`） |
| 开发入口 | `:5184` → vite `:5183`（源码热更已含同改动） |

## 3. 根因核实

| 现象 | 核实 |
|------|------|
| 信息区为顶栏三列 `.kgd-detail-grid` | `ProductionPlanDetail` 用三列 grid，非原版左卡；原版对照见 `mrp-retest-screenshots/original-left-card-垫片.png` |
| 进度条轨道约 0×6px | `.kgd-progress-track` 仅有 `height:6px`、无宽度；在窄/空内容时塌成不可见，只剩百分比文字 |

## 4. 改动文件

| 路径 | 改动 |
|------|------|
| `apps/web/src/kgd/pages/progress/productionPlans.tsx` | 详情改为 `.plan-detail` 左右布局：左 `.plan-kv` 竖卡字段，右 Tabs 不变 |
| `apps/web/src/kgd/pages/progress/progress.css` | track `width:100%; min-width:64px; background:#e8e8e8`；新增 `.plan-detail` / `.plan-kv`；caption `.blue` |
| `apps/web/src/kgd/pages/progress/ProgressCell.tsx` | 未满 100% 的 caption 用蓝色（对齐原版） |
| `VERSION` / `SEDRIC_VERSION.json` / `dist/VERSION` | → 1.0.74 |

## 5. 冒烟

见 `docs/ai/plan-detail-left-card-20261027/`：

| 步骤 | 结果 |
|------|------|
| `/app/` 入口 HTML | 引用 `index-BxsRLap0.js` + `index-CqEvOEpH.css` ✅ |
| 公网 CSS | `.plan-detail{…340px…}`、`.kgd-progress-track{width:100%;min-width:64px;height:6px;background:#e8e8e8}` ✅ |
| UI DOM（JH20261027004） | `.plan-detail`/`.plan-kv` 存在；`.kgd-detail-grid`=0；3 条 track ≈191×6px；左卡截图见证据目录 ✅ |
| API 登录 demo-a / admin.local | OK（密码未改） |
| JH20261027004 详情 | 已分析；加工进度 `0/10`；外协/采购 `0/0`；字段齐全；`lines`/`analysis_lines`/`work_orders` 键仍在 ✅ |

## 6. 部署动作

1. 备份源文件 + 旧 dist → `.bak-20261027-plan-detail-v174/`
2. 覆盖上述三个前端文件 + VERSION
3. `npx vite build`（apps/web）产出新 bundle
4. nginx `/app/` 已指向 dist，无需改 nginx；API 未改、未重启 pm2

## 7. 现网可复验（请强刷）

路径：生产管理 → 生产计划MRP → 打开 **JH20261027004**（或同类）：

1. 左侧应为竖卡（计划名标题 + 边框 KV），**不是**顶部三列横排。
2. 加工/外协/采购三行可见浅灰轨道；有进度时蓝/绿填充与下方百分比一致。
3. 右侧页签仍为：商品明细 / 物料分析 / 加工单 / 外协工单 / 采购单。
4. 顶栏/壳角标若走 `/app/` 可读 `dist/VERSION` = v1.0.74；vite 开发壳角标可能仍旧（API-only 场景下正常，本次前端已更）。

## 8. 禁止项核对

- 未开云端 Cursor
- 未重建库、未改密码
- 未改 material-analysis / SCALE / BOM 物料分行列
