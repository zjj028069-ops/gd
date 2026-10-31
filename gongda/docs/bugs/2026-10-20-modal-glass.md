# 弹窗/抽屉毛玻璃（v1.0.10 modal-glass）

- 时间：2026-10-20 Asia/Shanghai
- 版本：SEDRIC01 **v1.0.10**（feature: `modal-glass`）
- 范围：只改弹窗/抽屉样式；不改业务字段、校验、按钮文案、API、权限、帐套、路由、`menu.ts`、`garment-*`、库与密码
- 主色：`#4184F4`
- 设计稿：`docs/ui-refs/2026-10-20-modal-glass-design-v1.jpg`（附件1）；现状对照为白底 ant Modal（附件2）

## 设计意图

1. 弹窗面板：半透明乳白 `rgba(255,255,255,0.72~0.88)` + `backdrop-filter: saturate(180%) blur(20~28px)`，圆角 16–20px，细白边，轻阴影
2. 遮罩/scrim：深蓝半透明 + 模糊（勿纯死灰 flat mask）
3. 输入框/下拉：浅玻璃条（半透明白底 + 细边）
4. 标题栏：略实一点的玻璃 + 发丝分割线；关闭 × 柔和
5. 分区标题（基础信息/首要联系人）保持可读深色字
6. **字段布局、校验、按钮文案、业务逻辑一律不动**

## 技术要点

- Ant Design Modal/Drawer 默认 **portal 到 `document.body`**，原先 `.kgd-app .ant-modal-content` 选择器对大多数弹窗无效（故公网仍见死白底）
- 本轮用 `body:has(.kgd-app) .ant-modal-*` / `.ant-drawer-*` 命中登录后 MES 壳下的弹层
- **Ant Design 6.6.x** 面板根节点为 `.ant-modal-container`（旧 `.ant-modal-content` 选择器一并保留兼容）
- 同时保留 `.kgd-app .ant-modal-*`（如 goods-editor `getContainer` 挂在 `.kgd-main` 内）
- 覆盖：Modal 面板/遮罩/头/底/关闭钮、Modal.confirm、Drawer、弹层内 Input/Select/Picker、Select 下拉浮层

## 改动文件

| 文件 | 说明 |
|------|------|
| `apps/web/src/kgd/kgd.css` | Modal/Drawer/Confirm 毛玻璃 + 输入玻璃条 + 深蓝模糊遮罩 |
| `apps/web/src/styles.css` | 旧壳 `.modal` / `.modal-backdrop` 轻量对齐 |
| `VERSION` / `SEDRIC_VERSION.json` / `package.json` / `apps/web/package.json` / `LAST_OVERLAY_TIP` | bump v1.0.10 +`modal-glass` |
| `apps/web/dist/**` | 构建产物 |
| `docs/ui-refs/2026-10-20-modal-glass-design-v1.jpg` | 定稿设计稿备查 |
| `docs/bugs/2026-10-20-modal-glass.md` | 本说明 |

本地备份（改前）：

- `apps/web/src/kgd/kgd.css.bak-pre-modal-glass-20261020-163514`
- `apps/web/src/styles.css.bak-pre-modal-glass-20261020-163514`

**未改**：业务页面 TSX、API、`.local/database`、凭据、`garment-*` pm2、`menu.ts`。

## 关键 CSS 选择器（摘要）

- `body:has(.kgd-app) .ant-modal-mask` / `.ant-drawer-mask` — 深蓝半透明 + blur
- `body:has(.kgd-app) .ant-modal-content` — 乳白玻璃面板
- `body:has(.kgd-app) .ant-modal-header` / `.ant-modal-footer` — 略实玻璃 + 发丝线
- `body:has(.kgd-app) .ant-modal-close` — 柔和 ×
- `body:has(.kgd-app) .ant-drawer-content` 等同风格
- `body:has(.kgd-app) .ant-modal .ant-input` / `.ant-select-selector` 等 — 浅玻璃条
- `body:has(.kgd-app) .ant-select-dropdown` — 下拉轻玻璃

## 构建与部署

```bash
cd /Users/allen/SEDRIC01-preview
npm run build -w @gongdan/web
# SSH garment-lighthouse → 备份 /opt/sedric01/.bak-20261020-v110
# rsync 源码改动 + apps/web/dist/
```

## 验收要点

- [ ] 客户管理 → 新增客户：弹窗呈毛玻璃，贴近设计稿
- [ ] Drawer（如配置查询条件）同风格玻璃化
- [ ] 业务字段/逻辑未改；v1.0.10 已上公网
- [ ] 库/密码/garment-* 未动

## 已知差距

- 极个别完全自定义、不用 ant-modal/Drawer、也不走旧壳 `.modal` 的白底浮层，可能未吃到本轮样式
- Select/Cascader 下拉仍略偏实（约 0.92 不透明度），为可读性刻意保留
- 首轮曾只写 `.ant-modal-content`；Ant Design 6 实际节点为 `.ant-modal-container`，已补齐双选择器


## 冒烟记录（2026-10-20 Asia/Shanghai）

- `GET http://129.204.53.109/app/` → **200**（新 dist：`index-ohOXT2VB.css` / `index-B83wXxS0.js`）
- 公网 CSS 含 `body:has(.kgd-app)`、`ant-modal-container`、深蓝遮罩 `#07142885` + `blur(10px)`、面板 `blur(24px)`
- `POST /api/auth/login` admin.local + demo-a → **200**（admin）
- `GET /api/money/customers` → 200；`GET /api/system/enterprise` → 200
- Playwright「客户管理 → 新 增 → 新增客户」计算样式：
  - 面板 `rgba(255,255,255,0.78)` + `saturate(1.8) blur(24px)` + radius `18px`
  - 遮罩 `rgba(7,20,40,0.52)` + `blur(10px)`
  - 标题栏 `rgba(255,255,255,0.88)` + 发丝底边
  - 输入 `rgba(255,255,255,0.55)` + 细白边
- 截图：`docs/ui-refs/2026-10-20-modal-glass-smoke.png`
- pm2：`garment-*` pid 未变（369698/369772/369790/369826）；`sedric-api` 未重启；`sedric-web` 仍 stopped
- 凭据 md5 未变：`ed017133e6253947794123a9eeeb6c9e`
- VPS 备份：`/opt/sedric01/.bak-20261020-v110`；dist：`dist.bak-v110-20261020-163626`（及 redeploy 备份）
- Mac 改前 bak：`kgd.css.bak-pre-modal-glass-20261020-163514`、`styles.css.bak-pre-modal-glass-20261020-163514`
