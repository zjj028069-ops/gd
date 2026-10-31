# 去掉聊天壳 MES 白顶栏，返回聊天并入 MES 顶栏（v1.0.16）

- 时间：2026-10-20 Asia/Shanghai
- 版本：SEDRIC01 **v1.0.16**（feature: `mes-back-to-chat-top`）
- 反馈：Allen — 现状截图上方白条「← 返回聊天 / MES 生产执行 / SEDRIC01 v1.0.14」占高，要求去掉整行并增加 MES 可视面积
- 范围：只动聊天壳壳层 + MES 顶栏呈现；**不改** `menu.ts` 权限 path、业务 API、帐套、密码、`garment-*`；不启 `sedric-web`
- 主色：`#4184F4`

## 根因

聊天壳 `#mes-page` 内 `<header class="mes-header">` 单独占一行垂直高度，包着下方 MES iframe，导致可视面积被白条吃掉，且与 MES 自有顶栏重复。

## 做法

### A) 聊天壳
- 移除可见 `mes-header`（标题 / 版本 badge / 大「返回聊天」）；保留隐藏 `#btn-mes-back` 备用。
- `.mes-frame-shell` / `.mes-frame-wrap` / iframe 铺满视口。
- `app.js` 监听 `message`：同源 `{ type: 'sedric-close-mes' }` → 现有 `closeMes()`。
- `version.json` / 壳内展示升至 **v1.0.16**。

### B) MES
- `Shell.tsx`：`.kgd-top-right` **最右侧**（头像 Dropdown 之后）增加「← 返回聊天」。
- 仅当 `window.parent !== window`（嵌入 iframe）时显示；直接打开 `/app/` 不显示。
- 样式 `kgd-back-chat`：胶囊描边、主色 `#4184F4`、约 13px（对齐壳层 `.btn-mes`）。
- 点击：`window.parent.postMessage({ type: 'sedric-close-mes' }, window.location.origin)`。

## 文件

| 文件 | 说明 |
|------|------|
| `chat-shell/index.html` | 去掉 mes-header；隐藏备用返回钮 |
| `chat-shell/styles.css` | header 零高；iframe 铺满 |
| `chat-shell/app.js` | postMessage → closeMes；版本 1.0.16 |
| `chat-shell/version.json` | 1.0.16 |
| `apps/web/src/kgd/Shell.tsx` | iframe 内顶栏「返回聊天」 |
| `apps/web/src/kgd/kgd.css` | `.kgd-back-chat` |
| `VERSION` / `SEDRIC_VERSION.json` / `LAST_OVERLAY_TIP` / `package.json` | v1.0.16 + overlay |

## 版本与备份

- Mac 改前 bak：`*.bak-pre-v116-20261020-175955`
- VPS：`/opt/sedric01/.bak-20261020-v116`；dist / chat-shell 另 bak
- 凭据 md5 须仍为：`ed017133e6253947794123a9eeeb6c9e`
- pm2：`garment-*` 不动；`sedric-web` 保持 stopped

## 验收要点

- [ ] 公网 `/chat/`、`/app/` 200
- [ ] 登录后「进入 MES」：**无**「MES 生产执行」白条；MES 顶栏右侧可见「返回聊天」；点击回到聊天壳
- [ ] 硬刷新后仍正确
- [ ] 直接打开 `/app/` **无**「返回聊天」
- [ ] 截图：`docs/ui-refs/2026-10-20-v116-back-chat-smoke.png`
