# AI-5 图纸拆单 · 验收清单

## 范围

- AI 中心「图纸拆单」卡片 → `/ai/drawing-split`
- 菜单：AI 中心 → 图纸拆单
- `POST /api/ai/drawing/parse|confirm|cancel`
- 解析 v0：无 key 返回服装/机加可编辑工序模板 +「请核对」；有 key 可辅助识别；落库以预览为准
- confirm 写工艺路线草案；`link_work_order` + `sync_work_order` 须前端二次确认；写 `ai_action_log`
- 不做拍照报工；不改 AI-1～4；不重建库改密码；禁止无预览写库

## 验收步骤

1. 登录后打开 `/ai/center`，可见「图纸拆单」并进入。
2. 上传 PDF/图片 → 得工序预览；确认前 `process_routes` count 不变。
3. 确认后工艺路线草案增加；取消后 preview 失效，再 confirm 失败。
4. `node --import tsx --test apps/api/test/ai-drawing.test.ts` 绿；AI-1～4 测仍绿。
5. `node scripts/ai5-drawing-smoke.mjs` 截图落 `docs/ai/shots/ai5-drawing.png`。

## 测命令

```bash
cd /Users/allen/SEDRIC01-preview
node --import tsx --test apps/api/test/ai-drawing.test.ts
node --import tsx --test apps/api/test/ai-assistant.test.ts apps/api/test/ai-factory.test.ts apps/api/test/ai-bom.test.ts apps/api/test/ai-quick-order.test.ts
npm run typecheck -w @gongdan/api
npm run typecheck -w @gongdan/web
node scripts/ai5-drawing-smoke.mjs
```
