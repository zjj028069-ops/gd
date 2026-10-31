# 赛德瑞克 MES · 样例3 快递约件热修报告（v1.0.30）

- **时间**：2026-10-21 11:33（Asia/Shanghai）
- **执行面**：VPS `root@129.204.53.109:/opt/sedric01`（未开云端 Cursor / CloudAgent）
- **基线**：v1.0.29 → **v1.0.30** · feature `ext-lite-express`
- **备份**：`/opt/sedric01/.bak-20261021-lite130/`（含 api-ai、chat-shell、VERSION；另 `apps/web/dist.bak-20261021-lite130`）
- **约束遵守**：不重建库、不改密码、不改毛玻璃风格、不 git push、不开 CloudAgent

## 合格句

`做一个快递约件：寄件人从客户带、货物从出库单带、填运单号回写出库，侧栏要有入口`

## 改动文件列表

| 路径 | 说明 |
|------|------|
| `apps/api/migrations/120_ai_lite_express.sql` | 新建 `ai_lite_records` + RLS + index `(tenant_id, app_id)` |
| `apps/api/migrations/down/120_ai_lite_express.down.sql` | 可选回滚脚本 |
| `apps/api/src/ai/ext-app.ts` | lite 意图解析 `create_lite` / `express_pickup`；planSummary；confirm 写 `ai_ext_apps`（entity=`sale_stock_out` + `spec.kind=lite_express`，menu_path=`/ai/lite/{id}`，建「运单号」字段）；rollback 删 records/字段/清 menu |
| `apps/api/src/ai/lite-app.ts` | **新增** records API 实现 + 运单号 upsert `entity_ext_values` + 审计 |
| `apps/api/src/ai/register.ts` | 挂 `GET/POST /api/ai/lite-apps/:appId/records`、`PATCH .../records/:id` |
| `apps/web/src/modules/ai/LiteExpressPage.tsx` | **新增** 列表/状态 chip/新建抽屉/运单号保存回写 |
| `apps/web/src/kgd/pages/round10/router.tsx` | 前缀 `/ai/lite/` → LiteExpressPage |
| `chat-shell/app.js` | `looksLikeS3` 覆盖约件说法；VERSION→1.0.30 |
| `chat-shell/index.html` | cache bust `app.js?v=20261021-lite130`；展示版本 1.0.30 |
| `chat-shell/version.json` / 根 `version.json` | → 1.0.30 · ext-lite-express |
| `VERSION` / `SEDRIC_VERSION.json` | → 1.0.30 · feature `ext-lite-express` |
| `apps/web/dist/*` | `npx vite build` 产物（跳过仓库既有 tsc 噪声） |

工作副本：`/workspace/ext-app-v130/`（本报告同目录）。

## Migrate 结果

```
npm run db:migrate -w @gongdan/api
→ 数据库迁移完成
```

确认：

- `schema_migrations` 含 `120_ai_lite_express.sql`
- 表 `ai_lite_records` 存在
- **仅增量**，未清业务数据

## 构建与重启

- Web：`npx vite build`（`npm run build` 因既有无关 TS6133/TS18049 失败，与本次改动无关；沿用现网热修习惯直接 vite）
- API：`pm2 restart sedric-api` → **online**
- `sedric-web` 保持 **stopped**（公网走 nginx 静态 `dist` + chat-shell，未改动）

## 冒烟（demo-a / admin.local）

| 项 | 结果 |
|----|------|
| `parseExtUtterance(合格句)` | `{op:'create_lite', template:'express_pickup', menu:true}` **非 null** |
| `POST /api/ai/s3/chat` | `handled=true`，`domain=ext_app`，出 **preview_id**；摘要含壳内应用/状态/侧栏/挂出库/运单回写/回退 |
| 确认写入 | `op=create_lite`，`menu_path=/ai/lite/{id}`，建运单号字段 |
| `GET /api/ai/ext-apps?status=enabled` | 含「快递约件」 |
| `GET /api/ai/lite-apps/:id/records` | **200**，`items=[]` |
| 回退该扩展 | records/字段清理，enabled 列表不再含快递约件（**测完已清，无脏数据**） |
| 公网 `http://129.204.53.109/chat/version.json` | **1.0.30** · `ext-lite-express` · hotfix `20261021-lite130` |

## 架构要点

1. **entity**：`ai_ext_apps.entity = sale_stock_out`（119 无 entity check；避免 `lite_app` 误走 ENTITY_KINDS）；`spec.kind = lite_express`。
2. **运单号**：挂 `entity_ext_fields(entity=sale_stock_out, name=运单号, field_type=快递单号, options.sedric_app_id)`；填 tracking_no 时 upsert `entity_ext_values`。
3. **出库/客户**：UI 复用 `GET /api/warehouse/shipments`、`GET /api/customers`。
4. **侧栏**：Shell 已拉 enabled ext-apps；`menu_path` 可 navigate。
5. **顶栏/毛玻璃**：未改 AppearanceSwitcher / kgd 玻璃样式；chat-shell 版本串经 version.json 更新。

## 已知限制

1. 无快递公司 API 连接器，运单号仅手工填（任务书允许）。
2. Web 全量 `tsc --noEmit` 仍有既有失败（WorkplacePage AppearanceSwitcher 未用、WorkOrderExtras null），与本热修无关；生产静态包以 vite build 为准。
3. 若库中已有同名「运单号」字段，confirm 会复用并打上 `sedric_app_id`；回退时按 `field_ids` 删除该字段。
4. 未做端到端浏览器点选客户/出库造单（避免现网脏数据）；API 链路与空列表已验。
5. API 以 `tsx` 开发模式常驻（start-api.sh），改源码 + pm2 restart 即生效。

## 失败点

- 初次用裸 `node` import `.ts` 做 parse 冒烟失败（缺 `.js` 解析）→ 改用 `npx tsx` 通过。
- 初次 curl 登录因密码特殊字符被 shell 吃掉 → 改用 Python urllib 通过。
- `npm run build -w @gongdan/web` 因既有 tsc 失败 → 改 `npx vite build` 成功。

## 回滚建议

1. 聊天「回退该扩展」或管理台回退（若已确认生成）。
2. 文件：从 `.bak-20261021-lite130` 还原对应源文件与 chat-shell；`dist.bak-20261021-lite130` 还原静态包；`pm2 restart sedric-api`。
3. 表：手动执行 `migrations/down/120_ai_lite_express.down.sql` 并删 `schema_migrations` 对应行（仅当确认无业务依赖）。
