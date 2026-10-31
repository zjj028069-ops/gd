# 侧栏一级折叠三角可收起（v1.0.13 sidebar-caret-toggle）

- 时间：2026-10-20 Asia/Shanghai
- 版本：SEDRIC01 **v1.0.13**（feature: `sidebar-caret-toggle`）
- 反馈：Allen / 交付实施经理 — 公网 `/app/` 统一侧栏方案 A 下，一级菜单右侧 ▾ 点了无法收起已展开二级（例：客户管理）
- 范围：**只修**侧栏展开/收起交互；不改 `menu.ts`、权限、路由 path、帐套、业务 TSX、API、`garment-*`、库与密码
- 主色：`#4184F4`
- 参考图：`docs/ui-refs/2026-10-20-sidebar-caret-bug.png`（或 `/workspace/saideruike/docs/ui-refs/` 附件）

## 根因

统一侧栏里一级子树是否展示绑死在 `isActive`（`item.key === primary`），整行 `onClick` 都走 `openPrimary`（设 primary + 导航）；三角只是装饰 span，无独立 `stopPropagation` / toggle。路由仍在该模块时 `primary` 无法关掉，故 ▾ 无效。

## 修复意图

1. 点三角：仅 toggle 该一级展开/收起，**不**导航
2. 点一级文案/图标：仍 `openPrimary`（选中 + 跳第一个可见 path + 展开）
3. 收起后子项隐藏；再点三角或一级可再展开
4. 嵌套 `SubTree` 分支行本身已是独立 `open` toggle（本轮未改坏）
5. 当前路由所在一级：刷新后仍展开；用户手动收起后尊重，直到再点三角/一级或换模块

## 技术要点

- `Shell.tsx`：新增 `expandedPrimary` + `manualCollapsedPrimary`（与 `primary` 高亮解耦）
  - 三角 `data-caret`：`stopPropagation` → `togglePrimaryExpand`
  - 子树渲染条件改为 `expandedPrimary === item.key`（不再用 `isActive`）
  - pathname/`current` effect：默认展开当前链；若用户刚手动收起同一一级则保持收起
- `kgd.css`：`.kgd-sidebar-chevron` 加大热区 + hover（仅交互命中，不改配色方案）

## 改动文件

| 文件 | 说明 |
|------|------|
| `apps/web/src/kgd/Shell.tsx` | 一级展开状态与三角独立 toggle |
| `apps/web/src/kgd/kgd.css` | caret 热区 |
| `VERSION` / `SEDRIC_VERSION.json` / `package.json` / `apps/web/package.json` / `LAST_OVERLAY_TIP` | bump v1.0.13 +`sidebar-caret-toggle` |
| `apps/web/dist/**` | 构建产物 |
| `docs/bugs/2026-10-20-sidebar-caret-toggle.md` | 本说明 |

本地备份（改前）：

- `apps/web/src/kgd/Shell.tsx.bak-pre-sidebar-caret-20261020-171610`

**未改**：`menu.ts`、业务页面 TSX、API、`.local/database`、凭据、`garment-*` pm2。

## 构建与部署

```bash
cd /Users/allen/SEDRIC01-preview
npm run build -w @gongdan/web
# SSH garment-lighthouse → 备份 /opt/sedric01/.bak-20261020-v113 + dist.bak
# rsync 源码改动 + apps/web/dist/
```

## 验收要点

- [ ] 客户管理已展开 → 点 ▾ → 子项消失；再点 ▾ 或点一级文案 → 再展开
- [ ] 点三角不改变当前路由（或可保留当前页）
- [ ] 点一级文案仍跳转首个可见 path 并展开
- [ ] 供应/采购同样可收起/展开
- [ ] 刷新后当前模块一级仍展开
- [ ] 公网 `/app/` 版本 v1.0.13；health 200
- [ ] 库未重建；密码未改；garment-* 未动

## 冒烟记录（2026-10-20 Asia/Shanghai）

- `GET http://129.204.53.109/app/` → **200**（新 dist：`index-CcupERmE.css` / `index-DzaB66oh.js`）
- Playwright 登录 admin.local + demo-a：
  - **客户管理**：一级展开 → 点 ▾ 子项消失（URL 不变）→ 再点 ▾ 展开 → 点一级文案进 `/app/customer/list` 并展开
  - **供应/采购**：同上可收起/展开；一级文案进 `/app/supplier/list`
  - 嵌套分支（如采购）：点分支行可收起/再展开 nest
- 截图：`docs/ui-refs/2026-10-20-sidebar-caret-toggle-smoke.png`
- pm2：`garment-*` pid 未变（369698/369772/369790/369826）；`sedric-api` 未因本轮重启；`sedric-web` 仍 stopped
- 凭据 md5 未变：`ed017133e6253947794123a9eeeb6c9e`（部署后复核）
- VPS 备份：`/opt/sedric01/.bak-20261020-v113`；dist：`apps/web/dist.bak-v113-20261020-171717`
- Mac 改前 bak：`Shell.tsx.bak-pre-sidebar-caret-20261020-171610`
