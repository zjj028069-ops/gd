# 2026-10-20 聊天壳 · Live MES 演示（真 iframe DOM）

- 时区：Asia/Shanghai
- 版本：**SEDRIC01 v1.0.7**（未 bump）
- 范围：仅 `chat-shell`（`guide/demo-player.js`、`guide/demos.js`、`styles.css`）
- **未动**帐套 / 库 / 密码 / garment-* / MES 源码 / dist 重建

## 背景（Allen 反馈）

上一版演示主画面叠在**操作手册截图**（`.demo-shot-layer`）上。Allen 不要这条主路径：点「需要演示」后必须在**真实 MES 界面**内移动光标、放大、真实点击侧栏/按钮。

文字说明书 + 截图指引仍保留在聊天区；仅演示播放器改为 live DOM。

## 引擎改动要点（`demo-player.js`）

1. `SedricDemo.play(id)` → `SedricChat.openMes()` 显示真实 `#mes-iframe`（`/app/...`）
2. **隐藏** `.demo-shot-layer`（overlay 创建时 `hidden`，CSS `display:none !important`）；不再走 `has-shot` 主路径
3. Overlay：半透明遮罩 + 聚光洞 + 光标 + **圆环放大镜**（不再用截图 img 放大）+ 涟漪 + 气泡 + 工具条
4. 每步：`findInMes(doc, find)` 在 iframe `contentDocument` 定位元素 → `getBoundingClientRect` + iframe/wrap 偏移换算为 wrap 内 0–1 → `setCursor` → 特效 → `element.click()` / MouseEvent
5. 点击后 `waitMs`（默认约 550–800ms）再自动下一步；找不到元素时气泡报「未找到：…」，光标停中部，**不退回截图**，可点「下一步」跳过
6. 未登录（iframe 有密码框且无 `.kgd-rail`）：气泡提示「请先在 MES 登录后再点演示」

### `findInMes` 规则

| 字段 | 行为 |
|------|------|
| `rail` | `.kgd-rail button` 的 aria-label / `.kgd-rail-label` 包含匹配 |
| `sub` | `.kgd-sub .kgd-sub-item` / button 文本或 `data-label` 包含匹配 |
| `text` | 在 `css` 候选（默认 `button,.ant-btn,a,[role=button]`）精确或包含可见文本 |
| `css` | `querySelector`（可与 text 组合限定候选） |

## demos 如何表示 find

步骤示例：

```js
{
  mesPath: "/app/goods/list",   // 可选：先 navigate
  find: { rail: "商品管理" },    // 或 sub / text / css
  label: "左侧点「商品管理」",
  ops: ["商品管理"],
  click: true,                  // 默认 true
  waitMs: 600
}
```

- 路径对照 `apps/web/src/kgd/menu.ts`（例：合同订单 `/customer_contract/list`，工序 `/public_craft/list`，工资报表 `/payroll_statement/list`，工作台 `/staging/area`）
- 17 专题均已改为 live find；每专题约 3～8 步：一级 → 二级 → 列表按钮（新增/查询等）

## 写库安全策略

- 可真 click：导航、一级/二级菜单、查询、展开、「新增」打开弹窗
- **默认不自动点**：`确定` / `保存` / `删除` / `审核` / `结算` / `收款` / `入库` 等 → `click: false` + 文案「请自行确认后保存」
- 不自动填表，避免污染演示数据

## 部署

| 项 | 路径 |
|----|------|
| Mac | `~/SEDRIC01-preview/chat-shell` |
| VPS 备份 | `/opt/sedric01/chat-shell.bak-live-demo-20261020-150657` |
| 同步 | `rsync -av chat-shell/ root@129.204.53.109:/opt/sedric01/chat-shell/` |
| 公网 | `http://129.204.53.109/chat/` · MES `/app/` |
| dist | **未** rebuild（未改 MES 源码） |

## 如何试

1. 打开 `http://129.204.53.109/chat/` 登录聊天壳
2. 在 MES iframe 内先登录业务帐号（与 chat 同 host，才可读 DOM）
3. 聊天问「怎么新增商品」→ 文字指引 → 点「需要演示」
4. **应看到**：真侧栏「商品管理」被光标点中、进入真商品列表、「新增」弹窗打开；**不应再**盖一层旧快工单/手册截图当主画面
5. 提交类按钮只高亮说明，不会自动确定

## 冒烟

```bash
curl -sI -H 'Host: 129.204.53.109' http://127.0.0.1/chat/ | head -1
curl -sI -H 'Host: 129.204.53.109' http://127.0.0.1/chat/guide/demo-player.js | head -1
curl -sI -H 'Host: 129.204.53.109' http://127.0.0.1/chat/guide/demos.js | head -1
# 或公网
curl -sI http://129.204.53.109/chat/guide/demos.js | head -1
```

期望均为 HTTP 200；`demos.js` 含 `live-mes-demo-r1`；`demo-player.js` 含 `findInMes`。

## 已知限制

1. **未登录**：iframe 停在登录页 → 气泡提示，不点截图层；需先登录 MES
2. **权限菜单缺失**：角色无某菜单时 `find` 失败 → 「未找到」+ 可跳过
3. **弹窗/下拉异步**：部分「直接创建」等下拉项需等动画；超时可手动下一步
4. **同域依赖**：`/chat/` 与 `/app/` 同 host 才能读 `contentDocument`；跨域会提示无法读取
5. **openMes 重置**：`openMes()` 会把 iframe 拉回 `/app/`，再按步骤 `mesPath`/点击导航
6. 列表行内「报工」等依赖是否有数据行；无数据时可能找不到，允许跳过

## 成功标准

- 演示主画面 = 真实 MES，而非 handbook 截图 ✓（引擎已切）
- 光标对准真 DOM 并 click 菜单/新增 ✓
- 不自动点确定/保存 ✓
- v1.0.7；库未动 ✓
