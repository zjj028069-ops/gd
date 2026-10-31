# 新增视图弹窗「确定」点不了（v1.0.14 view-modal-confirm）

- 时间：2026-10-20 Asia/Shanghai
- 版本：SEDRIC01 **v1.0.14**（feature: `view-modal-confirm`）
- 反馈：Allen — 公网 `/app/` 合同报价单列表 → 右上角「＋」→「新增视图」弹窗里「确定」点不了
- 范围：**只修**交互/校验提示/一行错误样式；不改帐套、API、权限、路由、`menu.ts`、`garment-*`、库与密码
- 主色：`#4184F4`
- 截图：
  - `docs/bugs/2026-10-20-view-plus-list.png`（列表 + 号）
  - `docs/bugs/2026-10-20-view-modal-confirm.png`（视图名称* 为空）

## 根因

`ViewEditModal.submit()` 在 `!draft.name.trim()` 时 **静默 `return`**，底部「确定」仍为可点的 primary 蓝钮，无 `disabled`、无 `message`、无字段 error。用户感觉「点了没反应」。

排查排除项：

1. **非** CSS `pointer-events` / modal-glass 层级：`.ant-modal-wrap` / 确定钮均为 `pointer-events: auto`，按钮 `disabled=false`
2. Ant Design 按钮文案为「确 定」（中间空格），属正常中文按钮排版，不影响点击

对照：`ListFrame.saveView` / `saveViewEdit` 本就有 `message.warning('请填写视图名称')`，但 `ViewEditModal` 在空名称时根本不调用 `onOk`，故外层提示永远走不到。

## 修复意图（优先可点 + 明确提示）

1. 「确定」保持可点（不静默禁用）
2. 名称为空：`message.warning('请填写视图名称')` + 输入框 `status="error"` + 行内红字提示
3. 自动切回「基本信息」并 focus 名称输入
4. 用户开始输入后清除错误态；填妥后正常保存关窗

## 改动文件

| 文件 | 说明 |
|------|------|
| `apps/web/src/kgd/ViewEditModal.tsx` | 空名称校验提示 + error 态 + focus |
| `apps/web/src/kgd/kgd.css` | `.kgd-view-name-error` 一行样式 |
| `VERSION` / `SEDRIC_VERSION.json` / `package.json` / `apps/web/package.json` / `LAST_OVERLAY_TIP` | bump v1.0.14 +`view-modal-confirm` |
| `apps/web/dist/**` | 构建产物 |
| `docs/bugs/2026-10-20-view-modal-confirm.md` | 本说明 |

本地备份（改前）：

- `apps/web/src/kgd/ViewEditModal.tsx.bak-pre-view-modal-confirm-20261020-172543`

**未改**：业务 API、`.local/database`、凭据、`garment-*` pm2、帐套、`menu.ts`。

## 构建与部署

```bash
cd /Users/allen/SEDRIC01-preview
npm run build -w @gongdan/web
# SSH garment-lighthouse → 备份 /opt/sedric01/.bak-20261020-v114 + dist.bak-v114-*
# rsync 源码改动 + apps/web/dist/
```

公网 dist：`index-C0wuyz4P.css` / `index-BylzSco9.js`

## 验收要点

- [x] 合同报价单 → ＋ → 新增视图：名称空点「确定」→ toast + 行内「请填写视图名称」，弹窗不关
- [x] 输入框变红 error；输入后错误消失
- [x] 填名称再点「确定」→ 保存成功并出现视图页签
- [x] modal-glass / pointer-events 非根因；本轮未改玻璃样式语义
- [x] 公网 `/app/` 版本 v1.0.14；health 200
- [x] 库未重建；密码未改；garment-* 未动

## 冒烟记录（2026-10-20 Asia/Shanghai）

### 本地 Vite `http://127.0.0.1:5183`

- Playwright 登录 admin.local + demo-a → `/app/customer/quotation`
- 空名称：message + inline + modal stays + input error
- 填「冒烟视图7720」保存成功，页签出现
- 截图：`docs/ui-refs/2026-10-20-view-modal-confirm-empty-tip.png`、`...-smoke.png`
- JSON：`docs/ui-refs/2026-10-20-view-modal-confirm-smoke.json`

### 公网 `http://129.204.53.109/app/`

- `GET /app/` → **200**（新 dist：`index-C0wuyz4P.css` / `index-BylzSco9.js`）
- CSS 含 `kgd-view-name-error`；JS 含「请填写视图名称」
- Playwright：空名称 tip 通过；保存「公网冒烟1159」成功
- 截图：`docs/ui-refs/2026-10-20-view-modal-confirm-public-empty.png`、`...-public-smoke.png`
- pm2：`garment-*` pid 未变（369698/369772/369790/369826）；`sedric-api` 未因本轮重启；`sedric-web` 仍 stopped
- 凭据 md5 未变：`ed017133e6253947794123a9eeeb6c9e`
- VPS 备份：`/opt/sedric01/.bak-20261020-v114`；dist：`apps/web/dist.bak-v114-20261020-172808`
