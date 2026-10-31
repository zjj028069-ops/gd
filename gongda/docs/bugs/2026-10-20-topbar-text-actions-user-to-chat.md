# SEDRIC01 v1.0.17 — 顶栏文字链 + 用户菜单迁聊天壳

**日期**：2026-10-20（Asia/Shanghai）  
**版本**：SEDRIC01 v1.0.17  
**feature**：`topbar-text-actions+user-to-chat`  
**主色**：`#4184F4`

## 需求

1. 工作台工具条「外观 / 全屏 / 刷新 / 配置工作台」迁到 MES 顶栏 `.kgd-top-right`，样式为与原「帮助文档」同级的文字链（不要 Ant Button / 实心主按钮）。
2. 顶栏与工作台不要各留一个 AppearanceSwitcher；只留顶栏。
3. 隐藏顶栏「帮助文档」。
4. 嵌入聊天壳时隐藏 MES 顶栏用户头像 Dropdown；个人中心 / 企业设置 / 退出登录及帐套角色信息迁到聊天壳左下角 `.user-chip` 菜单。
5. 非嵌入直接打开 `/app/` 时仍保留原用户 Dropdown。

## 实现

### MES `Shell.tsx` + `kgd.css`

- 始终：`AppearanceSwitcher`、`MessageBell`；iframe 时 `← 返回聊天`。
- 仅工作台路由 `/staging/area`：追加文字链 `全屏`/`退出全屏`、`刷新`、`配置工作台`（`.kgd-top-action`）。
- 隐藏帮助文档；`inChatShell` 时隐藏用户 Dropdown。
- 经 `window` 自定义事件 `sedric-workplace-action`（fullscreen|refresh|configure）驱动工作台。
- 监听 `sedric-mes-navigate` postMessage 并 `navigate`。

### 工作台 `WorkplacePage.tsx`

- 非编辑态：不再渲染原 `.wp-toolbar` 四按钮。
- 编辑态：保留添加组件 / 保存 / 取消；去掉 AppearanceSwitcher。
- 监听顶栏事件，行为与原按钮一致。

### 聊天壳

- `.user-chip` 点击弹出菜单：显示名·角色 / 帐套；个人中心 → `/account`；企业设置 → `/setting/enterprise/setting`；退出登录。
- 已打开 MES 时优先 postMessage；否则 `navigateMes`。
- 旁侧「退出」按钮保留。

## 约束

- 不重建库、不改密码/帐套；不触碰 garment-*；不启动 sedric-web。
- 不改 menu.ts 权限 path / 业务 API 语义。

## 验收截图

- `docs/ui-refs/2026-10-20-v117-topbar-smoke.png`
