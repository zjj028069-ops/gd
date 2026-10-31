# 统一侧栏导航（v1.0.11 nav-unified-sidebar）

- 时间：2026-10-20 Asia/Shanghai
- 版本：SEDRIC01 **v1.0.11**（feature: `nav-unified-sidebar`）
- 范围：只改壳层导航呈现/交互；不改业务字段、API、权限、帐套、路由 path、`menu.ts` 的 key/path/permission/point/children、`garment-*`、库与密码
- 主色：`#4184F4`
- 设计稿：`docs/ui-refs/2026-10-20-nav-opt-a-unified-sidebar.jpg`（方案 A）
- 现状（要消灭）：窄深色 rail + 浮层二级卡片挡表格（v1.0.9 `mes-glass-flyout`）

## 设计意图（Allen 已确认方案 A）

1. **一条**左侧统一侧栏（约 220–260px，本轮 248px），深色半透明毛玻璃，与内容区同属一套材质语言
2. **不要**独立窄 rail + 浮层 flyout / scrim
3. 侧栏列出全部一级菜单（图标+文案）；当前一级高亮 `#4184F4`
4. 点一级：在同一侧栏 **内联展开** 其子项（可嵌套 children）
5. 可保留折叠按钮；折叠后为仅图标窄栏（64px）；折叠态仍不使用挡内容的浮层
6. 顶栏品牌/logo 放侧栏顶部
7. 点叶子仍 `navigate`；`openPrimary` 仍跳第一个可见 path

## 技术要点

- `Shell.tsx`：去掉 `kgd-flyout` / `kgd-flyout-scrim` / `flyoutOpen`；新建 `kgd-sidebar` 树
  - 一级按钮 `kgd-sidebar-primary`；选中后同栏内渲染 `SubTree`
  - 大屏动态 children：`childrenFor(item)` 仍合并 `screenMenuNodes`
  - 权限：`filterSidebarMenus` / `menuVisible` / `allowed` 原样保留
- `kgd.css`：统一侧栏玻璃、行高亮、缩进子项；旧 `.kgd-rail` / `.kgd-flyout*` 默认 `display:none` 兼容
- 弹窗毛玻璃（v1.0.10）样式保留

## 改动文件

| 文件 | 说明 |
|------|------|
| `apps/web/src/kgd/Shell.tsx` | 统一侧栏交互；去掉浮层 |
| `apps/web/src/kgd/kgd.css` | 统一侧栏玻璃 + 清理/兼容 flyout |
| `VERSION` / `SEDRIC_VERSION.json` / `package.json` / `apps/web/package.json` / `LAST_OVERLAY_TIP` | bump v1.0.11 +`nav-unified-sidebar` |
| `apps/web/dist/**` | 构建产物 |
| `docs/ui-refs/2026-10-20-nav-opt-a-unified-sidebar.jpg` | 方案 A 设计稿备查 |
| `docs/bugs/2026-10-20-nav-unified-sidebar.md` | 本说明 |

本地备份（改前）：

- `apps/web/src/kgd/Shell.tsx.bak-pre-nav-unified-20261020-165534`
- `apps/web/src/kgd/kgd.css.bak-pre-nav-unified-20261020-165534`

**未改**：`menu.ts`、业务页面 TSX、API、`.local/database`、凭据、`garment-*` pm2。

## 构建与部署

```bash
cd /Users/allen/SEDRIC01-preview
npm run build -w @gongdan/web
# SSH garment-lighthouse → 备份 /opt/sedric01/.bak-20261020-v111 + dist.bak
# rsync 源码改动 + apps/web/dist/
```

## 验收要点

- [ ] 点「供应/采购」：侧栏内联展开子项，**无浮层挡表**
- [ ] 点子项进页；一级高亮 `#4184F4`
- [ ] 折叠侧栏后为图标窄栏，仍无挡内容浮层
- [ ] 公网 `/app/` 新壳；版本 v1.0.11；health 200
- [ ] 库未重建；密码未改；garment-* 未动

## 已知视觉差距

- 设计稿示意侧栏略浮起、圆角窗控点为装饰；本轮侧栏贴左 margin 10px + 圆角 18px，无 macOS 红黄绿窗控（Web 壳无需）
- 设计稿子项图标为示意空心方块；真实子项仍用既有 SVG/Ant 图标映射，不改 menu 数据
- 一级数量较多时侧栏需滚动；折叠态未做 hover 轻量面板（规格允许，默认展开态已是统一侧栏）

## 冒烟记录（2026-10-20 Asia/Shanghai）

- `GET http://129.204.53.109/app/` → **200**（新 dist：`index-YNEjM3gz.css` / `index-CMPfynjQ.js`）
- CSS 含 `kgd-sidebar*`；一级选中 `background:#4184f4`；旧 flyout 仅 `display:none` 兼容残留
- `POST /api/auth/login` admin.local + demo-a 企业 → **200**（角色 admin）
- Playwright：
  - `.kgd-sidebar` 存在；`.kgd-flyout` / `.kgd-flyout-scrim` = 0
  - 点「供应/采购」：侧栏内联展开（供应商管理/采购/采购检验/采购设置）；无浮层
  - 一级选中计算色 `rgb(65, 132, 244)` = `#4184F4`
  - 点子项「供应商管理」→ `/app/supplier/list`
  - 内容区 `x=258` 在侧栏 `x=10,w=248` 右侧，**无遮挡**
- 截图：`docs/ui-refs/2026-10-20-nav-unified-sidebar-smoke.png`
- pm2：`garment-*` pid 未变（369698/369772/369790/369826）；`sedric-api` 未因本轮重启；`sedric-web` 仍 stopped（nginx 静态 dist）
- 凭据 md5 未变：`ed017133e6253947794123a9eeeb6c9e`（dev-credentials.txt）
- VPS 备份：`/opt/sedric01/.bak-20261020-v111`；dist：`apps/web/dist.bak-v111-20261020-165732`
- Mac 改前 bak：`Shell.tsx.bak-pre-nav-unified-20261020-165534`、`kgd.css.bak-pre-nav-unified-20261020-165534`
