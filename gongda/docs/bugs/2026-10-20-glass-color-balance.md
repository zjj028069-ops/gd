# 毛玻璃配色平衡（v1.0.12 glass-color-balance）

- 时间：2026-10-20 Asia/Shanghai
- 版本：SEDRIC01 **v1.0.12**（feature: `glass-color-balance`）
- 范围：**只调颜色/材质透明度**；不改导航交互结构（统一侧栏内联展开保留）、路由、权限、帐套、API、业务 TSX、`menu.ts`、`garment-*`、库与密码
- 主色：`#4184F4`（不变）
- 设计稿：`docs/ui-refs/2026-10-20-nav-opt-a-unified-sidebar.jpg`（图1 / 方案 A）
- 反馈：公网 v1.0.11 统一侧栏「颜色过于深了」，期待图1更透、更亮、更协调

## 配色方向（对齐图1）

1. **背景**：蓝渐变保留，去掉 `#071428` 死黑；中段与中心光晕提亮
2. **侧栏**：仍是深色玻璃，但更通透——降低不透明度、提亮蓝调（勿纯黑）；选中仍 `#4184F4` 胶囊；白字可读
3. **内容区**：浅乳白 / 浅灰蓝玻璃大面板（更亮，对比侧栏更清晰）；表格头/筛选区不暗
4. **顶栏/卡片**：跟浅内容区一致
5. **弹窗毛玻璃**（v1.0.10）：遮罩与面板略提亮协调，不推翻

## CSS 关键值对照

| Token / 选择器 | v1.0.11（偏深） | v1.0.12（对齐图1） |
|----------------|-----------------|-------------------|
| `--kgd-sidebar-bg` | `rgba(6, 22, 48, 0.62)` | `rgba(18, 52, 98, 0.42)` |
| `--kgd-glass-strong` | `rgba(255,255,255,0.78)` | `rgba(255,255,255,0.86)` |
| `--kgd-glass-border` | `rgba(255,255,255,0.28)` | `rgba(255,255,255,0.42)` |
| `--kgd-shadow` | 深蓝黑阴影 0.28 | 蓝调阴影 0.18 |
| `.kgd-app` 线性底 | `#071428 → #0c2a56 → #1a4f8c → #5a9ad4` | `#0b1f44 → #134a88 → #2a6fb8 → #6ab0e0` + 中心光晕加强 |
| `.kgd-top` | `rgba(255,255,255,0.55)` | `rgba(248,250,255,0.72)` |
| `.kgd-card` / `.ant-card` | `rgba(255,255,255,0.72)` | `rgba(248,250,255,0.86)` |
| `.ant-table-thead th` | `rgba(255,255,255,0.55)` | `rgba(236,242,252,0.78)` |
| Modal mask | `rgba(7,20,40,0.52)` | `rgba(12,40,78,0.42)` |
| Modal/Drawer content | `rgba(255,255,255,0.78)` | `rgba(248,250,255,0.88)` |
| `.kgd-sidebar-children` | 仅左边线 | 轻白玻璃口袋 `rgba(255,255,255,0.06)` |

`styles.css` 旧壳 body 渐变 / `.sidebar` / `.modal*` 同步提亮，避免双壳不一致。

## 改动文件

| 文件 | 说明 |
|------|------|
| `apps/web/src/kgd/kgd.css` | 主战场：变量、背景、侧栏、顶栏、内容卡、表格头、弹窗微调 |
| `apps/web/src/styles.css` | 旧壳玻璃附录对齐 |
| `VERSION` / `SEDRIC_VERSION.json` / `package.json` / `apps/web/package.json` / `LAST_OVERLAY_TIP` | bump v1.0.12 +`glass-color-balance` |
| `apps/web/dist/**` | 构建产物 |
| `docs/bugs/2026-10-20-glass-color-balance.md` | 本说明 |

本地备份（改前）：

- `apps/web/src/kgd/kgd.css.bak-pre-color-balance-20261020-170520`
- `apps/web/src/styles.css.bak-pre-color-balance-20261020-170520`

**未改**：`Shell.tsx`、`menu.ts`、业务页面 TSX、API、`.local/database`、凭据、`garment-*` pm2。

## 构建与部署

```bash
cd /Users/allen/SEDRIC01-preview
npm run build -w @gongdan/web
# SSH garment-lighthouse → 备份 /opt/sedric01/.bak-20261020-v112 + dist.bak
# rsync 源码 CSS + VERSION* + apps/web/dist/
```

## 验收要点

- [ ] 侧栏相对 v1.0.11 更透、蓝调更亮，非纯黑；选中仍 `#4184F4`
- [ ] 内容大面板乳白/浅灰蓝，对比侧栏清晰；表格/筛选不暗
- [ ] 背景无死黑 `#071428` 感；中段更亮
- [ ] 导航交互未变（内联展开）；无浮层挡表
- [ ] 公网 `/app/` 新壳；版本 v1.0.12；health 200
- [ ] 库未重建；密码未改；garment-* 未动

## 已知视觉差距（相对图1）

- 设计稿示意 macOS 红黄绿窗控为装饰；Web 壳仍不画窗控
- 设计稿侧栏子项图标为示意空心方块；真实图标映射不变
- 真实数据行/列数与稿不同；本轮只调材质配色
- 个别 Ant 组件内联白底可能仍略实，需按页再补时另开任务（本轮不改 TSX）

## 冒烟记录（2026-10-20 Asia/Shanghai）

- `GET http://129.204.53.109/app/` → **200**（新 dist：`index-fRYqwHa3.css` / `index-x49q-1uc.js`）
- CSS 含 `--kgd-sidebar-bg: rgba(18, 52, 98, .42)`、`#0b1f44` 渐变起点；**无** `#071428`
- Playwright 登录 admin.local + demo-a：
  - `.kgd-sidebar` 计算色 `rgba(18, 52, 98, 0.42)`
  - `.kgd-card` `rgba(248, 250, 255, 0.86)`；`.kgd-top` `rgba(248, 250, 255, 0.72)`
  - 一级选中 `rgb(65, 132, 244)` = `#4184F4`
  - 点「供应/采购」内联展开；进「供应商管理」→ `/app/supplier/list`；浮层 flyout 可见数 = 0
- 截图：`docs/ui-refs/2026-10-20-glass-color-balance-smoke.png`
- pm2：`garment-*` pid 未变（369698/369772/369790/369826）；`sedric-api` 未因本轮重启；`sedric-web` 仍 stopped
- 凭据 md5 未变：`ed017133e6253947794123a9eeeb6c9e`
- VPS 备份：`/opt/sedric01/.bak-20261020-v112`；dist：`apps/web/dist.bak-v112-20261020-170651`
- Mac 改前 bak：`kgd.css.bak-pre-color-balance-20261020-170520`、`styles.css.bak-pre-color-balance-20261020-170520`
