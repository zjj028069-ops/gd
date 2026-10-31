# 2026-10-20 聊天壳接入操作说明书（handbook-r1）

- 时区：Asia/Shanghai
- 版本：**SEDRIC01 v1.0.7**（未 bump）
- 范围：仅 `chat-shell` 静态；**未动**帐套/库/密码/garment-*/MES 业务代码

## 准稿来源

- `/workspace/saideruike/赛德瑞克完整操作说明书-合并版.md`
- 分章 `手册/00–12`（与合并版同源）
- 截图 `/workspace/saideruike/截图/`
- 创建商品专项可参考 `操作说明-创建商品.md`

## 做了什么

1. 知识包 `chat-shell/guide/knowledge.js`：15 个专题（登录、界面、列表、开户、商品、合同、采购、仓库、加工单、报工、工资、钱、进度、角色日常、FAQ）
2. 截图 26 张拷入 `guide/img/`
3. `app.js`：去掉助手演示回声主路径；`matchGuide` 关键词打分；`guide` 卡片（步骤+操作词高亮+截图 callouts+芯片+打开 MES）
4. `styles.css`：`.guide-card` / `.ops` / `.guide-callouts` / `.guide-chips`
5. `index.html`：先加载 `guide/knowledge.js`

## 部署

- Mac：`~/SEDRIC01-preview/chat-shell`
- VPS 备份：`/opt/sedric01/chat-shell.bak-guide-20261020-144057`
- 同步至：`/opt/sedric01/chat-shell/`（含 `guide/`）
- 公网：`http://129.204.53.109/chat/`

## 冒烟（Host: 129.204.53.109）

- `/chat/` → 200
- `/chat/guide/knowledge.js` → 200
- `/chat/guide/img/*.png` → 200
- `/chat/app.js` 含 `replyFromGuide`，无「演示回声」

## 已知缺口（后续轮次）

- 第 02 章编号规则/部门团队细节未单独成专题（并入开户）
- 第 03 工序/BOM/工艺路线未单独深讲
- 第 04 报价单审核、第 05 采购计划、第 06 调拨盘点细节未全覆盖截图
- 第 07 质检/岗位安排、第 08 绩效工资、第 09 对账单/批量收款、第 10 MRP/大屏未独立专题
- 尚无像素级红框叠图，当前为图下红色序号 callout 列表
- 未对接真实 MES 查询 API（进度/工资/欠款仍为说明书指引，非实时数据）
