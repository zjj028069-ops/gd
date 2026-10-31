# DEPLOY-REPORT · shell-codegen-vision（v1.0.46）

- 时间：2026-10-21（Asia/Shanghai）
- 现网：`root@129.204.53.109:/opt/sedric01`
- 版本：**SEDRIC01 v1.0.46** · feature `shell-codegen-vision`
- 主色：`#4184F4`
- 备份：`/opt/sedric01/.bak-20261021-codegen`
- 约束：不开云端；不重建库；不改密码

## 改动文件

| 路径 | 要点 |
|------|------|
| `apps/api/src/ai/config.ts` | `AI_VISION_MODEL` / visionModel |
| `apps/api/src/ai/shell-tool-vision.ts` | DeepSeek-flash 识图抽字段 |
| `apps/api/src/ai/shell-tool.ts` | image.extract_fields Spec + 沙箱 codegen |
| `apps/api/src/ai/ext-nlu.ts` | 盖不住 → Spec/识图/沙箱 → 诚实说明 |
| `apps/api/src/ai/ext-app.ts` | 方案卡沙箱/识图文案 |
| `apps/api/src/ai/register.ts` | `POST /api/ai/shell-tools/vision/extract` |
| `chat-shell/shell-tool-runtime.js` | 识图 + sandbox Bridge |
| `chat-shell/app.js` / `index.html` | 话题词 + cache `?v=20261021-codegen` |
| `.env.ai` | 追加 `AI_VISION_MODEL=deepseek-flash` |

## 冒烟

许愿识图方案卡 / 确认启用 / list 可见 / vision fields 非空 / write_mes_entities=[] / 计算器回归 / version 1.0.46 → 全绿。

## 诚实

- 落单接线未做；沙箱为 Spec 失败兜底；主验收句走规则 Spec。
