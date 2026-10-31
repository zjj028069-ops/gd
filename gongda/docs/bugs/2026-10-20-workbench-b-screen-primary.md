# 工作台方案 B + 数据大屏闪退 + 一级整行折叠（v1.0.15）

- 时间：2026-10-20 Asia/Shanghai
- 版本：SEDRIC01 **v1.0.15**（feature: `workbench-canvas-b+screen-nav-fix+primary-toggle`）
- 反馈：Allen 一次三点，都要上公网
- 范围：只动壳层/样式/工作台呈现/导航交互；**不改** `menu.ts` 权限 path、业务字段与 API 语义、帐套、密码、`garment-*`
- 主色：`#4184F4`
- 设计稿：`docs/ui-refs/2026-10-20-workbench-opt-b-grouped-glass.jpg`

## 1) 工作台方案 B + 苹果式可调渐变

### 根因 / 做法
- 原工作台 `wp-root` 灰底 + 各 widget 独立白块，碎块感强。
- 改为右侧 **一块浅玻璃大壳**（`.wp-canvas-shell`），快捷入口/未读/待办/公告/设备等嵌在壳内；卡片改为半透明玻璃圆角，少死白。
- 全站背景改为 CSS 变量多段渐变（`--kgd-bg-1/2/3`、`--kgd-bg-base-*`、`--kgd-bg-angle`、光晕位置）。
- 顶栏「外观」+ 工作台工具栏：预设 **浅蓝 / 暮蓝 / 石墨** + 可改主渐变色（`--kgd-bg-tint`）；`localStorage` 键 `kgd-appearance-theme` / `kgd-appearance-tint`，刷新仍在。

### 文件
| 文件 | 说明 |
|------|------|
| `apps/web/src/kgd/pages/round10/workplace/workplace.css` | Option B 大壳 + 嵌套玻璃卡 |
| `apps/web/src/kgd/pages/round10/workplace/WorkplacePage.tsx` | `wp-canvas-shell` 包裹 + AppearanceSwitcher |
| `apps/web/src/kgd/kgd.css` | 渐变变量 + 主题预设 + 外观按钮 |
| `apps/web/src/kgd/appearance.tsx` | 预设切换 / tint / 持久化 |
| `apps/web/src/styles.css` | body 渐变跟变量 |
| `apps/web/src/App.tsx` | 启动时 `applyStoredAppearance` |

## 2) 数据大屏二级菜单闪退

### 根因
公网 MES 挂在 `/app/`。二级「动态大屏」与「查看/设计」使用 `window.open('/_screen/pd/...')`（无 basename）。  
nginx：`/_screen/*` → **302 `/chat/`**（像闪退回登录）；正确路径 `/app/_screen/pd/:id` → 200 SPA。

### 修复
- 新增 `mesBase.ts`：`getMesBasename()` / `mesAbsPath()`
- `Shell.tsx` SubTree：`window.open(mesAbsPath('/_screen/pd/...'))`
- `ScreenManage.tsx`：`screenLink` / 设计按钮同样补 basename
- `App.tsx` 复用 `getMesBasename`（Router basename）

「大屏管理」本身走 `navigate('/screen_management/list')`（Router 已带 basename），路径正确；本轮一并回归。

## 3) 一级菜单整行点击可折叠

### 根因
v1.0.13 仅 ▾ 三角可 toggle；点一级文案始终 `openPrimary`（展开+导航），已展开时无法点文案收起。

### 修复
`openPrimary`：若当前一级 **已展开** 再点文案区 → `togglePrimaryExpand` 收起；若未展开 → 展开并导航。三角仍 `stopPropagation` 独立 toggle。权限/`menu.ts` 未动。

## 版本与备份

- Mac 改前 bak：`*.bak-pre-v115-20261020-174133`
- VPS：`/opt/sedric01/.bak-20261020-v115`；dist：`apps/web/dist.bak-v115-20261020-174407`
- 构建：`cd apps/web && npx vite build` → `index-03w6Okmk.css` / `index-XmMdVcbS.js`
- 凭据 md5（部署后）：`ed017133e6253947794123a9eeeb6c9e`
- pm2：`garment-*` pid 未变；`sedric-web` 仍 stopped；`sedric-api` 未因本轮重启

## 验收要点

- [ ] 工作台呈大画布玻璃壳；外观预设切换立即生效，刷新仍在
- [ ] 数据大屏 → 大屏管理可进；动态大屏新开 `/app/_screen/...` 不跳 `/chat/`
- [ ] 已展开一级点文案可收起；点其他一级正常展开导航；三角仍可用
- [ ] 合同报价/客户等回归不炸
- [ ] 公网 `/app/` 200；版本 v1.0.15；库未重建；密码未改；garment-* 未动


## 冒烟记录（2026-10-20 Asia/Shanghai ~17:45）

Playwright 公网 `http://129.204.53.109/app/`，账号 admin.local / demo-a：

1. **工作台大壳**：`[data-testid=wp-canvas-shell]` count=1；截图 `docs/ui-refs/2026-10-20-workbench-b-smoke.png`
2. **渐变持久化**：外观 → 暮蓝 → `data-kgd-theme=dusk`；刷新后仍为 `dusk`
3. **大屏管理**：进 `/app/screen_management/list`，仍在 `/app`，未进 `/chat`
4. **动态大屏**：popup = `http://129.204.53.109/app/_screen/pd/<id>`（含 `/app/_screen`，非 `/chat`）
5. **一级折叠**：客户管理展开后点文案 → children 容器 count=0（已收起）；再点进 `/app/customer/list` 正常
6. **回归**：客户列表 URL `/app/customer/list`，壳层仍在

公网 `/app/` → **200**（dist：`index-03w6Okmk.css` / `index-XmMdVcbS.js`）  
凭据 md5 未变：`ed017133e6253947794123a9eeeb6c9e`  
pm2：`garment-*` pid 未变；`sedric-web` stopped；`sedric-api` 未因本轮专为静态重启

