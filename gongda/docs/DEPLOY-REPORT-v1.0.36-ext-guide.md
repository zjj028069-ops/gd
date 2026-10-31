# SEDRIC01 v1.0.36 部署报告 · 列表加扩展字段改 guide-only

- **时间**：2026-10-21（Asia/Shanghai）
- **主机**：腾讯云 `root@129.204.53.109:/opt/sedric01`
- **方式**：SSH 直改现网（**未开云端 Cursor / CloudAgent**）
- **约束**：不重建库、不改开发账号密码、主色仍 `#4184F4`
- **版本**：`SEDRIC01 v1.0.36` · feature `ext-guide-open-add` · hotfix `20261021-ext-guide`
- **本地镜像**：`/workspace/ext-app-v136/`

---

## Allen 纠正（产品意图）

**错误（图1）**：聊天「位置确认」→「字段属性」卡 → 写库预览。

**正确（图2）**：打开目标列表 → 演示点工具栏「扩展字段」→ 点弹窗「新增」→ **其余由用户在 MES 弹窗自行填写**。聊天只给短指引；不代填属性、不写库。

---

## 改了哪些文件

| 路径 | 改动 |
|------|------|
| `apps/api/src/ai/ext-app.ts` | `create`（非商品）改走 `guideOpenAddPayload`：`mode=guide` + `demo_id=ext-field-add` + `open_path`；**不再** `startLocationPending`。商品扩展仍走位置/属性/写库。新增 `entityExtListOpenPath`（加工单→列表 `/inside_produce_bill/list`，工序→`/public_craft/list`） |
| `chat-shell/app.js` | `askS3` 识别 `mode===guide` → `startExtFieldGuide`（`navigateMes` + `SedricDemo.play`）；**不渲染** `ext_ask` / 写库确认卡 |
| `chat-shell/guide/demos.js` | 新增剧本 `ext-field-add` |
| `chat-shell/guide/demo-player.js` | `play(demoId, opts)` 支持 `opts.mesPath` 注入首步 |
| `chat-shell/index.html` | `?v=20261021-ext-guide` |
| `chat-shell/version.json` / `VERSION` / `SEDRIC_VERSION.json` / 根 `version.json` | 升至 **1.0.36** · `ext-guide-open-add` |

备份后缀：`*.bak-20261021-ext-guide`

**未改**：商品扩展方案写库、快递约件 lite、回退/启停聊天流；旧 `locationAskPayload` / `attrsAskPayload` / `resolveExtAsk` 代码保留（商品等仍可能用）。

---

## 演示选择器（`ext-field-add`）

1. **工具栏「扩展字段」**  
   - text: `扩展字段`  
   - css: `.kgd-toolbar button,.kgd-toolbar .ant-btn,.kgd-main .kgd-toolbar button,.ant-pro-table-list-toolbar button,button.ant-btn`  
   - click: true（打开 `ExtensionModal`）

2. **弹窗「新增」**（限定在 modal，避免点到列表页「新增」单据）  
   - text: `新增`  
   - css: `.ant-modal-wrap button.ant-btn-primary,.ant-modal-wrap .ant-btn,.ant-modal button.ant-btn-primary,.ant-modal button,.ant-drawer …`  
   - click: true（打开「新增扩展字段」`ExtensionAddDialog`）

3. **指到「字段名」**  
   - text: `字段名` · click: **false**（用户自填；演示不点确定，避免写脏库）

`mesPath` 由 API `open_path` 经 chat-shell 注入（如联系人 `/app/linkman/list`）。

---

## 本机 API 验收（demo-a / admin.local，不改密码）

| 话术 | mode | open_path | demo_id | ask/confirm |
|------|------|-----------|---------|-------------|
| 帮我在客户联系人列表增加一个字段，字段名称为联系人婚姻状况 | `guide` | `/linkman/list` | `ext-field-add` | 无 |
| 给加工单增加一个紧急度字段 | `guide` | `/inside_produce_bill/list` | `ext-field-add` | 无 |

公网：`http://129.204.53.109/chat/version.json` → **1.0.36** · `ext-guide-open-add`  
静态：`app.js?v=20261021-ext-guide` / `demos.js?v=20261021-ext-guide`

---

## 手测步骤（需登录聊天壳 · 请强刷）

1. 强刷：`http://129.204.53.109/chat/`（Ctrl+F5；确认 `app.js?v=20261021-ext-guide`，版本 1.0.36）
2. 助手会话输入：`帮我在客户联系人列表增加一个字段，字段名称为联系人婚姻状况`
3. **期望**：
   - MES 打开客户联系人列表
   - 演示光标点「扩展字段」→ 再点弹窗「新增」
   - 聊天只有一句短指引（可含「建议字段名：联系人婚姻状况」）
   - **无**「扩展 · 位置确认」卡、**无**「字段属性」卡、**无**写库预览
4. 在 MES「新增扩展字段」弹窗自行填字段名等并确定
5. 对照：说「扩展应用有哪些」/「回退该扩展」仍走原列表或确认卡（非本需求）

---

## 已知限制

1. **实体列表页结构不同**：个别列表若工具栏无「扩展字段」、或管理窗不是 Ant Modal/`新增` 文案，演示会提示「未找到」；需按实体补 css/文案兜底。
2. **双「新增」**：第 2 步已限定 `.ant-modal-wrap`；若 Modal 打开慢，可能短暂找不到（可手动点「新增」）。
3. **加工单**：guide 已改为打开**列表** `/inside_produce_bill/list`（写库 aftercare 仍可走新建页，未动）。
4. **工序**：guide 用 `/public_craft/list`；若线上路由别名不同需再对齐 menu。
5. **商品扩展 / 快递 lite**：故意仍走写库预览，符合 Allen「本次不要动」。
6. 旧位置/属性卡代码仍在；仅列表 `create` 默认不再调用。若要彻底删入口可另开任务。

---

## 回滚

```bash
STAMP=20261021-ext-guide
cp -a /opt/sedric01/apps/api/src/ai/ext-app.ts.bak-$STAMP /opt/sedric01/apps/api/src/ai/ext-app.ts
cp -a /opt/sedric01/chat-shell/app.js.bak-$STAMP /opt/sedric01/chat-shell/app.js
cp -a /opt/sedric01/chat-shell/index.html.bak-$STAMP /opt/sedric01/chat-shell/index.html
cp -a /opt/sedric01/chat-shell/version.json.bak-$STAMP /opt/sedric01/chat-shell/version.json
cp -a /opt/sedric01/chat-shell/guide/demos.js.bak-$STAMP /opt/sedric01/chat-shell/guide/demos.js
cp -a /opt/sedric01/chat-shell/guide/demo-player.js.bak-$STAMP /opt/sedric01/chat-shell/guide/demo-player.js
cp -a /opt/sedric01/VERSION.bak-$STAMP /opt/sedric01/VERSION
cp -a /opt/sedric01/version.json.bak-$STAMP /opt/sedric01/version.json
# SEDRIC_VERSION.json 若有 bak 一并还原；tsx watch 会热加载 api
```
