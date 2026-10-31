# Bot 模式（SEDRIC Bots 业务助手）整合说明

顶栏有三种模式可切换：

| 模式 | 效果 |
|---|---|
| 传统操作 | 原来的界面，自己点 |
| **Bot 代操作** | 左侧停靠 Bot 面板，Bot 在右边**真实界面**上替用户操作：光标移动、点菜单、填表、选下拉、勾选、开弹窗。人能在界面上做的工单操作它都能做（开单、开工、报工、改资料……），用户看着学。提交/保存/确定类按钮先请用户点「允许」，删除/作废类按钮一律不点 |
| Bot 对话 | 全屏聊天，Bot 直接调用系统接口完成（更快），写操作弹确认卡片 |

界面设计与 SEDRIC Bots 一致：`apps/web/src/modules/sbot/ui/sbx.css` 由 `scripts/sync-sbot-styles.py` 从 SEDRIC-Bots 的 `styles.css` 自动生成（全部加 `.sbx` 作用域，不影响 MES 原有页面）；头像、图标组件直接复用。改了 SEDRIC Bots 的设计后，运行 `python scripts/sync-sbot-styles.py` 即可同步。

### Bot 代操作是怎么工作的

- Bot 端工具（SEDRIC-Bots `backend/app/mes/ui_tools.py`）：`ui_open`（按菜单名打开页面）、`ui_look`（看页面）、`ui_do`（点/填/选/勾选，一次可多步），另有 `mes_search_manual` 查说明书、`clarify` 提问。
- 每个界面动作作为待办发给用户浏览器，由 `apps/web/src/modules/sbot/driver.ts` 执行：把页面整理成「[编号] 类型「标签」= 当前值」清单（含弹窗、下拉浮层、表格、页面提示）交给模型，按模型指令带动画地操作，再把新页面回传。
- 所有点击都发生在用户自己的页面里、用用户自己的登录，权限与传统操作完全一致。
- 一站式流程：开工前先调用 `mes_check_ready`（代码逐项检查商品/工序/生产人员/仓库/工单状态），把缺的前置资料和用户没说的必填项合成一个问题、带建议值一次问完；用户确认后先补前置资料，再做主任务，每轮最多 60 步。
- 执行器支持：输入框、下拉框（含远程搜索、多选）、树形下拉、级联选择（省/市/区）、日期和日期范围、勾选框、单选、开关、页签、下拉浮层菜单、弹窗、表格行按钮。开发环境可在浏览器控制台用 `__sbotDriver.look()` / `__sbotDriver.run({...})` 调试。
- 执行器的限制：不碰 Bot 面板和顶栏；外部链接不点；删除/作废/清空/退出登录等按钮拒绝；创建/保存/确定/提交/审核/开始/完成/取消等按钮、以及弹窗里的主按钮，先在面板里请用户「允许」。

> 与右下角原有的 AI 小助手（`apps/web/src/modules/ai`、`apps/api/src/ai`）是两套东西，原有代码未改动。

## 结构

```
浏览器 ──/api/sbot/*──> MES API（sbot.ts，先校验登录 + CSRF）
                         │  带网关密钥 + 当前用户身份 + 用户自己的会话
                         ▼
               SEDRIC Bots（只监听 127.0.0.1:8765）/mes-gw/*
                         │  白名单工具，固定接口路径
                         ▼
               MES API（用该用户自己的会话调用，权限与传统界面一致）
```

| 位置 | 文件 |
|---|---|
| MES 后端转发 | `apps/api/src/sbot.ts`（`app.ts` 里加了 1 行注册） |
| MES 前端 | `apps/web/src/modules/sbot/`（`App.tsx` 加路由 `/sbot`，`Shell.tsx` 顶栏加切换） |
| Bot 网关与工具 | SEDRIC-Bots 仓库 `backend/app/mes/`（`agent.py` / `main.py` 有少量改动） |
| 本机一键启动 | `start-windows.cmd` → `scripts/dev-with-bot.mjs` |

## 安全边界（为什么用户不能借 Bot 操作服务器）

1. **工具白名单写死在代码里**：MES 会话只有 `clarify` + 15 个 `mes_*` 工具。终端、读写文件、联网、MCP、技能、记忆、定时任务、机器人互发一律不提供，和机器人设置无关。
2. **模型不能指定网址或接口路径**：每个工具只调用一个固定的 MES 接口；ID 先校验是 UUID 才拼进路径；MES 地址只来自环境变量。
3. **用用户自己的身份**：Bot 调 MES 时用的是该用户的登录会话，MES 原有的角色权限、数据范围照常生效（工人开不了加工单）。凭证只在内存里，不落盘。
4. **写操作必须用户确认**：确认卡片上的内容是工具从系统里重新查出来的，不是模型自己写的。本版没有任何删除类工具。
5. **网关只认 MES 后端**：需要共享密钥 `SBOT_GATEWAY_TOKEN`；每个用户只能看到、操作自己的对话和确认卡片；事件流按用户过滤。
6. **服务器上开 `SBOT_MES_ONLY=1`**：SEDRIC Bots 原本的界面和接口（能跑命令的那部分）整个关闭，只剩 `/mes-gw/*`，定时任务也不运行。

## 配置（`.local/sbot.env`，不进 git）

第一次运行 `scripts/dev-with-bot.mjs` 会自动生成，并随机生成网关密钥。大模型默认用 DeepSeek，密钥从环境变量 `DEEPSEEK_API_KEY` 读取（不会复制进文件）：

```
SBOT_LLM_BASE_URL=https://api.deepseek.com/v1
SBOT_LLM_API_KEY_ENV=DEEPSEEK_API_KEY   # 或 SBOT_LLM_API_KEY=直接填密钥
SBOT_LLM_MODEL=deepseek-chat
```

没填时 Bot 页面会提示「还没有配置大模型」，传统模式不受影响。

## 服务器部署（/opt/sedric01，参考）

1. 把 SEDRIC-Bots 放到 `/opt/sedric-bots`，`pip install -r backend/requirements.txt`。
2. 在 `start-api.sh` 里追加：`export SBOT_GATEWAY_TOKEN=<随机长串>`、`export SBOT_URL=http://127.0.0.1:8765`。
3. 新增 PM2 进程 `sedric-bot`，环境变量：
   `SBOT_MES_ONLY=1`、`SBOT_GATEWAY_TOKEN=<同上>`、`SBOT_MES_URL=http://127.0.0.1:3011`、`SBOT_LLM_*`、`HB_DATA=/opt/sedric-bots/data`，
   命令：`python3 run.py --no-browser --host 127.0.0.1 --port 8765`。
4. nginx **不要**给 8765 开任何转发；只有 `/api/sbot/*` 经 MES API 进来。nginx 对 `/api/` 需要关闭缓冲以支持事件流：`proxy_buffering off;`（或依赖已返回的 `X-Accel-Buffering: no`）。

## 企业经验库（Bot 的记忆）

- Bot 每做完一件事，如果过程中出过错、被系统拦过，会在后台自动回顾，把可复用的经验记成「现象 → 正确做法」（最多 3 条，重复的合并、错的改正，不记单号数量等一次性信息），对话里会出现「📝 记住了 N 条经验」。
- 用户说「记住……」时 Bot 也会用 `mes_memory` 主动记。
- 按企业保存（`SEDRIC-Bots/data/mes_memory/<企业ID>.json`），全企业共享：一个人踩过的坑，别人用 Bot 时自动避开。每次开工都放进 Bot 的提示词（作为参考数据，和页面不符时以页面为准并改正）。
- 查看/修改：Bot 面板顶部的「经验」按钮（大脑图标）。所有人可看；新增、修改、删除只有管理员（防止有人往里写奇怪的指令影响别人的 Bot）。

## 现有业务工具

查询：商品、工序、工艺路线、BOM、仓库、客户、成员、加工单列表、加工单详情。
写入（需确认）：创建加工单、修改加工单（交货日期/计划开始/计划结束/优先级/备注，与传统界面「修改」一致，计划数不可改）、改加工单状态（开始/暂停/恢复/完成/取消）、新建工序、新建仓库、新建客户、报工。

新增工具：在 SEDRIC-Bots `backend/app/mes/tools.py` 里照现有写法加，写操作务必走 `_confirm`，并在 `apps/web/src/modules/sbot/SbotPage.tsx` 的 `TOOL_LABEL` 里补中文名。

## 拖拽上传文件（图纸 / BOM 表 / 下单表）

把文件拖进 Bot 聊天框（或点回形针），Bot 读完会按内容在系统里办好，每一步写入都先请你确认。

- 支持 PDF（带文字的，扫描件不行）、Excel（xlsx/xls）、CSV、TXT；单个最大 10MB，一次最多 3 个。图片、Word 会提示另存为 PDF。
- 文件在**业务系统**里读成文字（`POST /api/sbot/files`，`apps/api/src/sbot-files.ts`），只把文字交给 Bot；原文件不保存、不转给 Bot，Bot 拿不到任何文件路径。
- 文件里的内容只当资料，里面写的「忽略规则」「删除」「发到某网址」之类不会照做。
- 新增 Bot 工具（`SEDRIC-Bots/backend/app/mes/tools_batch.py`）：批量建商品/物料（按编号查重，单位缺了一起建；同名不同编号时先问你）、批量建工序、建工艺路线、建 BOM。
- 实测：工艺图纸 PDF → 商品 + 6 道工序 + 工艺路线 + BOM（约 30 秒）；下单表 → 开加工单；BOM 表 → 建物料 + 问挂哪个成品后建 BOM。
