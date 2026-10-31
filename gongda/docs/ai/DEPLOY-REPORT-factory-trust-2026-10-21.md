# DEPLOY-REPORT · factory-trust-harden（阶段 2 + 3）

- 时间：2026-10-21 16:45（Asia/Shanghai）
- 现网：`root@129.204.53.109:/opt/sedric01`
- 版本：**SEDRIC01 v1.0.44** · feature `factory-trust-harden`
- 主色：`#4184F4`
- 备份：`/opt/sedric01/.bak-20261021-factory`
- 约束：不开云端；不重建库；不改密码；**未改** `shell-tool.ts` / `shell-tool-runtime.js` / `looksLikeS3`

## 1. 现网摸底（加固前）

| 能力 | 状态 | 缺口 |
|------|------|------|
| `POST /api/ai/factory/ask` | 已有进度/钱/工资/三本账 + 「去处理」深链 | 口语偏窄；回复无「核心结论」字段；三本账无一屏异常 |
| 聊天工具栏「三本账」 | 已有，走 factory ask | `looksLikeFactoryAsk` 与服务端口语不完全对齐 |
| Generate / 扩展确认 | `ext-app` 预览卡 → `/api/ai/writes/confirm` → `ai_action_audit` | 确认卡风险文案偏弱；审计 meta 缺信任字段；方案卡权限摘要未单独暴露 |
| 壳内工具 network | Spec 已强制 `network:false`（shell-tool 内） | 本热修不改 shell-tool；在确认卡文案侧强化 |
| 任意代码执行 | 计算器走 `safeEvalExpression` | **未引入**任意代码执行 |

## 2. 本热修改动文件

| 文件 | 改动要点 |
|------|----------|
| `apps/api/src/ai/factory.ts` | 口语加宽；`conclusion`；`queryAnomalies`（延期/未收/待审）；三本账+单本账挂 anomalies；回复「核心结论+详情」 |
| `apps/api/src/ai/writes.ts` | `WRITE_KIND_LABELS` / `writeTrustMeta`；确认/取消审计 meta 强化；回传 `confirm_notice` |
| `apps/api/src/ai/audit.ts` | `normalizeAuditMeta`（默认 `network_default:false` 等） |
| `apps/api/src/ai/ext-app.ts` | 确认卡 `permissions_summary` + 更强 risk 文案（壳内强调禁外网/禁写 MES） |
| `chat-shell/app.js` | **仅**确认卡权限行、`buildFactoryAnomalies`、`buildFactoryReply`、扩展 `looksLikeFactoryAsk`；**保留**对方 `looksLikeS3` 原样 |
| `chat-shell/styles.css` | 异常一屏 / 核心结论样式（主色边） |
| `apps/api/test/ai-factory.test.ts` | 口语与 anomalies 断言加厚 |

## 3. 阶段 3 验收

现网 `demo-a` / `admin.local` 冒烟（2026-10-21 Asia/Shanghai）：**12/12 + 拒写 + 重登 OK**

### 进度（≥3）
- 产线忙不忙 → progress + 去处理 `/inside_produce_bill/list`
- 有没有延期 → progress
- 在产多少 → progress

### 应收（≥3）
- 客户欠我们多少 → money + `/customer_financier/list`
- 催款情况 → money
- 超应收有没有 → money（**诚实**：库无信用额字段，异常项标题为「未收余额」并提示无法判定超信用）

### 工资（≥3）
- 报工待审几笔 → wage + `/work_repoty_record/list`
- 工资结了没 → wage
- 工资有没有待审 → wage

### 三本账 / 异常一屏
- 查一下三本账 / 厂长看板 / 今天有啥异常 → `intent=triple`，`books.length=3`，`anomalies.length=3`，含 `conclusion`

登录：冒烟前后 `/api/auth/login` 均 200，**未改密码**。

## 4. 阶段 2 缺口清单（信任）

| 项 | 现网结论 | 本热修 | 待下一版 |
|----|----------|--------|----------|
| Generate 强制预览卡 | 扩展/壳内走 preview→confirm | 确认卡文案+权限摘要 | shell 意图门/方案卡商用文案由并行 agent |
| 写 MES 二次确认+审计 | `writes/confirm` + `ai_action_audit` | meta 带 `confirm_gate`/`network_default:false`/`kind_label` | 旧专用 confirm 路由（bom/quick-order 等）统一迁完可再扫一遍 |
| 禁止默认 network | Spec 侧已有；本热修不改 shell-tool | 确认卡明文 | Runtime 侧再断言（若并行未做） |
| 禁止任意代码 | 已有 safeEval | 未引入 codegen | — |
| 审计可查 | `GET /api/ai/writes/audit` 已有 | meta 更可检索 | 聊天「追问审计」UI 未做 |

## 5. 与 shell 意图改动的冲突规避

- **未改**：`shell-tool.ts`、`shell-tool-runtime.js`、`app.js` 内 `looksLikeS3` 整段。
- `app.js` 在对方热修后 **基于最新现网再打补丁**（确认卡 / 三本账 / `looksLikeFactoryAsk`），打补丁前后比对 `looksLikeS3` 字节一致。
- 版本：并行占用 1.0.40~43 后，本号升 **1.0.44**。

## 6. 未完成 / 诚实说明

1. 「超应收」无客户信用额字段 → 只报「未收余额」风险，不声称超限。
2. 晨报推送仍为 stub（`factory/briefing`）。
3. 受控建议执行（阶段 3.3）未做。
4. 壳内工具写路径确认管线深改留给并行 shell 意图版；本热修只加固确认卡/审计侧。
5. 冒烟期间曾被并行 `intake.ts` 热重载打断 API，复测已全绿。

## 7. 回滚

```bash
cp -a /opt/sedric01/.bak-20261021-factory/api-ai/*.ts /opt/sedric01/apps/api/src/ai/
cp -a /opt/sedric01/.bak-20261021-factory/chat-shell/app.js.pre-v42 /opt/sedric01/chat-shell/app.js
# styles / VERSION 按需从 bak 恢复
pm2 restart sedric-api
```
