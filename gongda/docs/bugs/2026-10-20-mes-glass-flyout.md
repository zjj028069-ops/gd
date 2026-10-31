# MES 深蓝毛玻璃 + 浮层二级菜单（v1.0.9）

- 时间：2026-10-20 Asia/Shanghai
- 版本：SEDRIC01 **v1.0.9**（feature: `mes-glass-flyout`）
- 范围：只改壳层样式与二级菜单呈现；不改业务字段、API、权限、帐套、路由 path、`menu.ts` 结构、`garment-*`、库与密码
- 主色：`#4184F4`
- 参考图：`docs/ui-refs/2026-10-20-mes-glass-full-demo.png`、`docs/ui-refs/2026-10-20-mes-glass-menu-panel.png`

## 相对 v1.0.8 / 既有浅毛玻璃的增量

1. **背景加深**：全屏深海蓝 → 浅蓝渐变（替代原先偏浅灰蓝径向）
2. **浮层二级**：`Shell.tsx` 将固定 `<aside className="kgd-sub">` 改为相对 rail 右侧浮出的毛玻璃卡片
   - 标题 = 一级菜单名；副标题 = 本地 `primarySubtitle` map（不改业务字段）
   - 关闭 × / 顶栏折叠按钮 / 遮罩点击 → 关闭浮层
   - 条目：左图标 + 文案 + 右 ›；选中项 `#4184F4` 系深蓝底；hover 高亮
   - 有 children 的节点在浮层内嵌套展开（保留原 SubTree 逻辑）
   - `openPrimary`：打开浮层 + 仍跳转第一个可见 path（路由/权限不回归）
3. **权限与动态 children**：`filterSidebarMenus` / `menuVisible` / `allowed` / 大屏动态 children 原样保留

## 改动文件

| 文件 | 说明 |
|------|------|
| `apps/web/src/kgd/Shell.tsx` | 浮层二级交互；副标题 map；rail 品牌角标 |
| `apps/web/src/kgd/kgd.css` | 深蓝渐变 + 浮层卡片 + 顶栏/内容卡玻璃加深 |
| `apps/web/src/styles.css` | 旧壳 body 渐变轻量对齐 |
| `VERSION` / `SEDRIC_VERSION.json` / `package.json` / `LAST_OVERLAY_TIP` | bump v1.0.9 +`mes-glass-flyout` |
| `apps/web/dist/**` | 构建产物 |
| `docs/ui-refs/*.png` | 定稿参考图备查 |
| `docs/bugs/2026-10-20-mes-glass-flyout.md` | 本说明 |

本地备份（改前）：

- `apps/web/src/kgd/kgd.css.bak-pre-flyout-20261020-*`
- `apps/web/src/kgd/Shell.tsx.bak-pre-flyout-20261020-*`
- 既有 `kgd.css.bak-pre-glass-20261020`

**未改**：`menu.ts`、业务页面 TSX、API、`.local/database`、凭据、`garment-*` pm2。

## 构建与部署

```bash
cd /Users/allen/SEDRIC01-preview
npm run build -w @gongdan/web
# SSH garment-lighthouse → 备份 /opt/sedric01/.bak-20261020-v109
# rsync 源码改动 + apps/web/dist/
```

## 验收要点

- [ ] 视觉贴近图1（深蓝渐变 + 毛玻璃）
- [ ] 点一级出现图2式浮层二级（标题/副标题/×/图标/›/选中深蓝）
- [ ] 点叶子仍 navigate 原 path；权限过滤正常
- [ ] 公网 `/app/` 新壳；版本 v1.0.9；health 200；无 500
- [ ] 库未重建；密码未改；garment-* 未动

## 已知视觉差距

- 参考图「商品管理」下含「工序」等示意条目；真实 `menu.ts` 商品子项为「商品列表 / BOM管理 / 商品设置」——本轮**不改菜单数据**，浮层只呈现真实 children
- KPI 四卡与生产看板插画若业务页未用统一 `.kgd-card` 类，个别页面内联样式可能仍偏白底，需按页再补（本轮不改业务 TSX）


## 冒烟记录（2026-10-20 Asia/Shanghai）

- `GET http://129.204.53.109/app/` → **200**（新 dist：`index-B4Vws5JX.css` / `index-CSGU-u5E.js`）
- CSS 含 `kgd-flyout*` 与深蓝 `#071428`、主色 `#4184F4`
- `POST /api/auth/login` admin.local / demo-a → **200**（角色 admin）
- `GET /api/system/enterprise`（登录后）→ 200
- `GET /app/goods/list`、`/app/bom/list` SPA → 200
- 本地 `5183` 预览在跑（硬刷新可见新壳）
- pm2：`garment-*` pid 未变；`sedric-api` 未因本轮重启；`sedric-web` 仍 stopped（nginx 静态 dist）
- 凭据文件 md5 与改前一致（未改写）
- VPS 备份：`/opt/sedric01/.bak-20261020-v109`；dist：`/opt/sedric01/apps/web/dist.bak-v109-20261020-162346`
