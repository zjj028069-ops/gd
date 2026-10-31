# 2026-10-20 聊天壳 · 无法加载真实 MES

- 时区：Asia/Shanghai
- 版本展示：对齐 **SEDRIC01 v1.0.14**（原 chat-shell 写死 v1.0.7）
- 范围：仅 `chat-shell`（`app.js` / `index.html` / `version.json` / guide 注释）
- **未动**帐套 / 库 / 密码 / garment-* / MES 源码 / dist 重建 / nginx（深链实测已 200）

## 现象

公网聊天壳点「进入 MES」后出现：

- 标题：`无法加载真实 MES`
- 副文：`MES 页面加载较慢。同站路径 /app/ · SEDRIC01 v1.0.7`

截图中的 **v1.0.7** 是聊天壳展示串，不是 MES dist 真版本（当时 MES 已 ≥ v1.0.13，现为 v1.0.14）。

## 根因

1. **`openMes()` 弱轮询 + 8s 超时**（`app.js`）  
   - 每 500ms 读 `contentDocument.location`；仍为 `about:blank` 超过 **8000ms** 就 `mes-fallback.hidden = false`。  
   - **没有** iframe `load` 成功回调去收起错误层 → 一旦误报/慢加载，错误页会一直盖住后面已渲染的 MES。  
   - **每次** `openMes()` 新开 `setInterval` 且不取消上一次 → 演示引擎/重复点击会叠多个 timer，导航瞬间 `about:blank` 时旧 timer 易误判。  
   - `catch` 跨域分支 `clearInterval` 后仍可能落到同轮超时逻辑，竞态脆弱。

2. **每次进入都强制 `iframe.src = /app/`**  
   - 已在 MES 内再点「进入 MES」/演示 `openMes` 会整页重载，出现短暂 blank，放大超时误报窗口。

3. **版本写死 v1.0.7**  
   - 与仓库 `VERSION` / `SEDRIC_VERSION.json`（v1.0.14）脱节；错误文案拼接该常量，看起来像「旧版 MES 挂了」。

### 已排除（本轮实测）

| 项 | 结果 |
|----|------|
| 公网 `GET /app/` | HTTP 200，HTML 引用 `/assets/index-*.js` |
| `X-Frame-Options` / CSP `frame-ancestors` | 响应头无限制 |
| iframe 内渲染 | Playwright：`/chat/` → `openMes()` 后 iframe `href=/app/`，`#root` 出登录壳，fallback `display:none` |
| SPA 深链 `/app/login` 等 | nginx `alias`+`try_files` 返回 200（本轮不改 nginx） |
| 帐套 / garment-* | 未触碰 |

## 改动

### `chat-shell/app.js`

- `VERSION` → `SEDRIC01 v1.0.14`（`let`，可被 `version.json` 覆盖）
- `MES_LOAD_TIMEOUT_MS = 20000`
- 新增 `watchMesIframeLoad`：`load` / `error` + 单例 interval；成功必 `hideMesFallback`；`mesLoadGen` 作废旧监听
- `openMes`：若 `mesIframeIsLive()` 已在真页则**不重置 src**
- `navigateMes`：同样走 watch，导航时先藏 fallback
- `closeMes`：bump gen + clear timer
- 启动时 `fetch('version.json')` 同步顶栏/登录卡/徽章文案

### 其它

- `index.html`：四处 `v1.0.7` → `v1.0.14`
- 新增 `chat-shell/version.json`（`display: SEDRIC01 v1.0.14`）
- `guide/demo-player.js` / `knowledge.js` 注释版本对齐

## 部署

| 项 | 路径 |
|----|------|
| Mac | `~/SEDRIC01-preview/chat-shell` |
| VPS 备份 | `/opt/sedric01/chat-shell.bak-mes-load-YYYYMMDD-HHMMSS` |
| 同步 | `rsync -av chat-shell/ root@129.204.53.109:/opt/sedric01/chat-shell/` |
| 公网 | `http://129.204.53.109/chat/` · MES `http://129.204.53.109/app/` |
| nginx / dist / API | **未改** |

本地编辑前备份：`chat-shell/app.js.bak-mes-load-*`、`index.html.bak-mes-load-*`。

## 冒烟

```bash
curl -sI http://129.204.53.109/chat/ | head -1
curl -sI http://129.204.53.109/chat/app.js | head -1
curl -sI http://129.204.53.109/chat/version.json | head -1
curl -s http://129.204.53.109/chat/version.json
curl -s http://129.204.53.109/chat/app.js | grep -E 'MES_LOAD_TIMEOUT_MS|watchMesIframeLoad|v1.0.14' | head
curl -sI http://129.204.53.109/app/ | head -1
```

浏览器：

1. 强刷 `http://129.204.53.109/chat/`（必要时清缓存）
2. 登录聊天壳 → 点「进入 MES」
3. **期望**：iframe 出赛德瑞科登录/工作台；**不应**再盖「无法加载真实 MES」；徽章为 **v1.0.14**
4. 返回聊天再进 MES：应复用已加载页（不闪 blank）
5. 可选：助手问「怎么新增商品」→「需要演示」→ live DOM 演示仍可用

Playwright 要点：`openMes()` 后 `mes-fallback` 保持 `hidden`，iframe `contentDocument.location` 含 `/app/`，`#root` 有内容。

## 成功标准

- [x] 定位超时/onerror/ready 触发条件
- [x] Playwright 验证 `/app/` 在 iframe 可渲染
- [x] 稳定进入真实 MES；错误层可被 load 成功收起
- [x] 版本展示与 SEDRIC v1.0.14 对齐
- [x] 只动聊天壳加载逻辑；帐套/密码/garment-* 不动
- [x] 公网同步（VPS 备份 `chat-shell.bak-mes-load-20261020-173400`）

## 回滚

```bash
ssh garment-lighthouse 'rm -rf /opt/sedric01/chat-shell && mv /opt/sedric01/chat-shell.bak-mes-load-TS /opt/sedric01/chat-shell'
```
