# 赛德瑞克 · 独立 AI 模块 SPEC

> 日期：2026-10-20（Asia/Shanghai）  
> 入库副本（实现以本仓库为准）

## 钉死 5 项

| 序 | 代号 | 本轮 |
|---|---|---|
| 1 | AI-1 智能客服 | **本刀已实现** |
| 2 | AI-2 工厂助理 | **本刀已实现** |
| 3 | AI-3 AI导入BOM | **本刀已实现** |
| 4 | AI-4 极速下单 | **本刀已实现** |
| 5 | AI-5 图纸拆单 | **本刀已实现** |

## S0 可信执行底座（v1.0.24）

详见 `S0-验收说明.md` 与交互规格 `AI四能力-交互规格-2026-10-20.md`。

- 统一写库：`/api/ai/writes/confirm|cancel` + 审计表 `ai_action_audit`
- 附件认型：`/api/ai/intake/classify`（名片→联系人确认卡）
- 聊天 S1 挂钩：进度/钱/工资 → `/api/ai/factory/ask`

## 落点

- API：`apps/api/src/ai/` → assistant / factory / bom / quick-order / drawing / writes / intake / audit
- Web：`apps/web/src/modules/ai/`（`AiShell` 挂在 kgd `Shell`；确认走统一 writes）
- chat-shell：工厂助理只读问数 + 附件认型确认卡
- 知识：`docs/ai/kb/*.md`
- 配置：`AI_PROVIDER=mock|openai`，无 `AI_API_KEY` 时 mock
