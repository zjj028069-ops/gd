# MES 苹果毛玻璃视觉皮肤（与聊天壳统一）

- 时间：2026-10-20 14:15 Asia/Shanghai
- 版本：SEDRIC01 **v1.0.7**（未 bump VERSION / package.json / SEDRIC_VERSION.json）
- 范围：只改风格（CSS）；不改功能 / 路由 / API / 库 / 密码 / 菜单 / 权限
- 主色：`#4184F4`（与聊天壳一致）

## 改了哪些文件

| 文件 | 说明 |
|------|------|
| `apps/web/src/kgd/kgd.css` | **主战场**：壳背景、一级 rail、二级 sub、顶栏、卡片、chip、登录卡、趋势/精益工作台表面、以及 `.kgd-app` 作用域内有限 Ant Design 覆盖 |
| `apps/web/src/styles.css` | 旧壳轻量对齐：body 渐变、登录卡、侧栏、顶栏、panel/metric-card、modal（文末 appendix，非大重构） |
| `apps/web/dist/**` | 前端构建产物（公网 nginx 静态） |

本地备份（改前）：

- `apps/web/src/kgd/kgd.css.bak-pre-glass-20261020`
- `apps/web/src/styles.css.bak-pre-glass-20261020`

**未改**：`menu.ts`、`Shell.tsx`、页面 TSX 业务、API、帐套、`.local/database`、密码、`garment-*`、VERSION。

## 视觉原则（与 chat-shell/styles.css 对齐）

1. **背景**：柔和蓝白多重径向渐变 + 浅蓝线性底，不要纯灰死底
2. **玻璃**：`rgba(255,255,255,0.72~0.88)` + `backdrop-filter: saturate(180%) blur(20~28px)` + 细白边 + 轻阴影
3. **侧栏分层**：一级 rail 更深半透明深蓝毛玻璃；二级 sub 略浅；active 用 accent 柔光（非廉价纯黑）
4. **顶栏 / 内容卡**：半透明白玻璃，圆角 12~16px
5. **字体**：系统 / PingFang / SF Pro 栈；主色仍 `#4184F4`
6. **Ant Design**：仅在 `.kgd-app` 下覆盖 Table/Card/Modal/Button primary，避免污染聊天壳

## 构建

```bash
cd /Users/allen/SEDRIC01-preview
npm run build -w @gongdan/web
# = tsc --noEmit && vite build
```

- Node：本机当时为 v20.19.2（nvm 24.13.0 未加载到 shell，但不影响产出）
- **未跳过 tsc**：`tsc --noEmit` 通过，随后 `vite build` 成功
- 产物：`apps/web/dist/`，CSS hash `index-DWaG-XfZ.css`，JS `index-CEPVEK7p.js`

## 部署（VPS）

- Host：`garment-lighthouse` → `129.204.53.109`
- **备份路径**：`/opt/sedric01/apps/web/dist.bak-glass-20261020-141434`
- 同步：`rsync -avz --delete` 整目录 → `/opt/sedric01/apps/web/dist/`
- 源码 CSS 同步：`/opt/sedric01/apps/web/src/kgd/kgd.css`、`.../src/styles.css`（便于以后 rebuild）
- **未**重启 / 改 pm2 `sedric-api`；`sedric-web` 保持 stopped；nginx 继续吃静态 dist
- 冒烟：
  - `GET /` → 302 → `/chat/`
  - `GET /chat/` → 200
  - `GET /assets/index-DWaG-XfZ.css` → 200，含 `backdrop-filter`（约 36 处）

## 未覆盖 / 风险

- **打印工作室**（`.print-studio`）仍为功能色顶栏/灰底，未强行玻璃化（避免干扰打印预览对比）
- **移动端壳**（`.kgd-phone`）仅继承整体背景，未单独重做
- **iframe 内旧壳页面**：已做 `styles.css` 轻量对齐；若个别遗留白底，属 Ant/页面内联样式，需按页再补（本次不改 TSX）
- 浏览器强缓存：CSS 已换 hash，一般无感；若仍见旧皮，硬刷新即可
- Safari 以外部分浏览器对 `backdrop-filter` 支持差异：无滤镜时仍有半透明色与圆角，可读

## 成功标准核对

- [x] 侧栏 / 顶栏 / 内容卡毛玻璃语言，主色蓝
- [x] 菜单结构与功能未改（仅 CSS）
- [x] VERSION = v1.0.7
- [x] 库与凭据未动；garment-* / sedric-api 未动
