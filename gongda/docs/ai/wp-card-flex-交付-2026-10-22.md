# SEDRIC01 v1.0.50 · wp-card-flex 交付说明

- **时间**：2026-10-22（Asia/Shanghai）
- **环境**：现网热修 `root@129.204.53.109`，路径 `/opt/sedric01/apps/web/`
- **入口**：http://129.204.53.109/app/（工作台）
- **约束**：不开云端、不重建库、不改密码；仅改 web 源码 + dist；**未重启** `sedric-api` / pm2
- **主色**：`#4184F4`

## 改动摘要

修复工作台卡片缩窄时「快捷入口」「待办事项」固定像素列宽导致的积压/左侧留白：

1. **快捷入口 `.wp-shortcuts`**
   - 去掉 `repeat(3, 92px)` + 固定 `column-gap: 52px` + button `width: 92px`
   - 改为 `repeat(3, minmax(0, 1fr))`，`column-gap/row-gap` 用 `clamp`，button `width: 100%; min-width: 0`
   - 图标 `.wp-dot` / `.wp-shortcuts .wp-shortcut-icon-img`：`clamp(28px, 42%, 40px)` + `max-width: 100%` + `object-fit: contain`

2. **待办 `.wp-todo-group`**
   - TSX：标题 `span` 仍在左侧；按钮外包 `.wp-todo-tiles`
   - CSS：group flex；tiles `grid` + `auto-fit minmax(96px, 1fr)`；`.wp-todo` 全宽弹性；数字字号 `clamp`

## 改动文件（现网）

| 文件 | 说明 |
|------|------|
| `apps/web/src/kgd/pages/round10/workplace/workplace.css` | 弹性 shortcuts / todo-tiles |
| `apps/web/src/kgd/pages/round10/workplace/WorkplacePage.tsx` | todo 外包 `.wp-todo-tiles` |
| `apps/web/dist/**` | `npx vite build` 产物（新 hash） |
| `VERSION` / `SEDRIC_VERSION.json` / `chat-shell/version.json` / `LAST_OVERLAY_TIP` | 1.0.50 · wp-card-flex |

**dist 新 hash**：CSS `index-DfK3ENlY.css`，JS `index-Q8AjPPE4.js`

## 备份

- `workplace.css.bak-20261022-wp-flex`
- `WorkplacePage.tsx.bak-20261022-wp-flex`
- `dist/assets/index-B2DVMnzp.css.bak-20261022-wp-flex`（旧 CSS）
- `dist/index.html.bak-20261022-wp-flex`

## 构建

```bash
cd /opt/sedric01/apps/web && npx vite build
# （跳过 `tsc --noEmit`，与既往热修一致；依赖在 monorepo 根 node_modules）
```

未动 nginx / api / pm2；nginx 已 alias `/app/` → `apps/web/dist/`，新 index.html 引用新 hash，强刷即可。

## 验收（已做）

1. 源码无 `repeat(3, 92px)`；有 `minmax(0, 1fr)` / `wp-todo-tiles`
2. `curl http://129.204.53.109/app/` → 200，引用 `index-DfK3ENlY.css` / `index-Q8AjPPE4.js`
3. 静态 CSS 含 `wp-todo-tiles`、`clamp(8px,3.5vw,40px)`、`repeat(3,minmax(0,1fr))`；无 `repeat(3,92px)`
4. VERSION = 1.0.50

## 强刷手测

1. 打开 http://129.204.53.109/app/ **Ctrl+Shift+R**
2. 进入工作台，缩窄「快捷入口」卡：三列图标随宽弹性，不溢出
3. 「待办事项」格子随卡宽均分，标题仍在左侧，无大片左侧留白/积压

## 诚实未做

- 未浏览器登录后拖拽缩窄卡片做 GUI 手测（仅 curl/静态特征抽查）
- 未改 API、未动 pm2、未重建库、未开云端
- banner / picker / 快捷编辑弹层等无关结构未改
