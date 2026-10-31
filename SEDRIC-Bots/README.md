# SEDRIC Bots

复刻自 Nous Research [hermes-agent](https://github.com/NousResearch/hermes-agent) 桌面端的 **Bot Mode**：
一个机器人就是一个独立的智能体，有自己的人格、记忆、技能和聊天记录；机器人之间可以互发消息、在群里按轮次协作，也能按计划自动执行任务。

## 快速开始

需要 Python 3.10+ 和 Node.js 18+（只在第一次构建前端时用到）。

```bash
python run.py
```

第一次运行会自动安装后端依赖并构建前端，然后打开 http://127.0.0.1:8765 。

一开始是**演示模式**：机器人按固定规则模拟回复，不需要 API Key，可以把所有功能点一遍。
在左下角 **设置 → 模型** 里添加一个提供商（DeepSeek、通义千问、Kimi、智谱、MiniMax、硅基流动、OpenRouter、OpenAI、Ollama，或任何 OpenAI 兼容接口），并把它设为默认，机器人就会用真实模型思考。
API Key 可以直接填，也可以只填环境变量名（例如 `DEEPSEEK_API_KEY`），程序启动时从环境变量读取。

**安装为桌面应用**：用 Edge 或 Chrome 打开后，点地址栏右侧的“安装”图标（或菜单 → 应用 → 将此站点作为应用安装），SEDRIC Bots 会以独立窗口运行，桌面和任务栏上会显示它的图标。

常用参数：

```bash
python run.py --port 9000          # 换端口
python run.py --data D:/my-bots    # 换数据目录（默认 ./data）
python run.py --no-browser         # 不自动打开浏览器
```

## 功能

| 功能 | 说明 |
|---|---|
| 机器人列表 | 搜索、按机器人/群聊筛选、置顶、隐藏、自定义分区（拖拽归类）、右键菜单、未读与“需要你处理”提示 |
| 动态头像 | 9 种形状 × 任意颜色，或上传图片；空闲时眨眼，思考时转头，干活时显示跳动的点 |
| Bot Chat | 每个机器人有一个固定的永久对话，另外可以开任意多个普通聊天 |
| Agent 能力 | 终端命令（Windows 下是 PowerShell）、读写文件、联网搜索和抓取、长期记忆、技能、定时任务、向你提问、MCP 工具 |
| 安全审批 | 删除、关机、改注册表、强推等危险命令会先问你；可以按机器人设成“每次都问”或“全自动” |
| 机器人互发 | `message_agent` 工具：异步把消息投递到对方的 Bot Chat，对方回复后自动通知发送方；转发链有深度上限，防止互相踢皮球 |
| 群聊 | 一份共享消息记录，按轮次依次发言；@名字 点名，@all 叫所有人；没话说回复 `(pass)`；被点名不能跳过；@交接会多给一轮；有轮数/条数上限；“@某某 停”可暂停某个成员；支持讨论串、活动面板、停止按钮 |
| 定时任务 | 每隔 N 分钟/小时/天、每天、工作日、每周、一次性、Cron 表达式；到点在独立会话里执行，结果发到 Bot Chat；有执行历史和次数上限。机器人也能自己创建定时任务 |
| 技能 | SKILL.md 格式；自带 4 个内置技能；可以新建、编辑、禁用、从其他机器人复制；机器人完成复杂任务后也会自己沉淀技能 |
| 上下文管理 | 超过预算自动把较早的对话压缩成摘要，也可以手动 `/compress` |
| 其他 | 深色模式、手机布局、附件（图片/文本/PDF）、思考过程展示、排队发送、中断 |

聊天输入框里的命令：`/new` 新聊天，`/compress` 压缩历史，`/stop` 停止，`/edit` 编辑机器人。

## 数据都存在哪

全部保存在本机的 `data/` 目录，都是普通文件：

```
data/
  settings.json            模型提供商、默认模型、审批策略
  ui.json                  分区
  bots/<名字>/
    profile.json           显示名称、头像、模型、工具开关、MCP
    SOUL.md                人格设定
    memories/MEMORY.md     它自己的笔记
    memories/USER.md       它对你的了解
    skills/<id>/SKILL.md   技能
    sessions/*.json        聊天记录
    cron.json              定时任务
    workspace/             它执行命令、读写文件的默认目录
  groups/*.json            群聊
  uploads/                 上传的附件
```

## 开发

```bash
# 后端（自动重载）
cd backend && python -m uvicorn app.main:app --port 8765 --reload
# 前端（热更新，/api 代理到 8765）
cd frontend && npm install && npm run dev
# 测试（会启动独立的临时服务器和假模型，不会碰你的数据）
pip install pytest && python -m pytest tests -q
```

目录结构：

- `backend/app/agent.py` Agent 运行时：工具循环、排队、审批与提问、机器人互发、上下文压缩
- `backend/app/groups.py` 群聊引擎
- `backend/app/cron.py` 定时任务
- `backend/app/llm.py` OpenAI 兼容流式接口 + 演示模型
- `backend/app/tools/` 各个工具
- `backend/app/mcp.py` MCP 客户端（stdio 和 HTTP）
- `frontend/src/` React 界面（`styles.css` 是整套毛玻璃设计）
- `frontend/public/icon.svg` 应用图标，`icon-small.svg` 是 16–48px 用的简化版；改完运行 `python scripts/render-icons.py public`（在 frontend 目录下）重新生成 PNG 和 favicon.ico

## 安全说明

- 服务默认只监听 `127.0.0.1`，并拒绝 Host 不是本机的请求（防 DNS 重绑定）。如果要在局域网里用，设置环境变量 `HB_ALLOWED_HOSTS=你的IP` 再用 `--host 0.0.0.0` 启动——注意这样局域网里的人都能让机器人执行命令。
- 机器人能在你的电脑上执行命令和读写文件。默认只有危险命令和工作目录外的写入需要你批准；如果不放心，可以在设置里改成“每次都问”，或者在机器人的“能力”页关掉终端和文件工具。

## 许可

本项目参考了 hermes-agent 的设计（MIT 许可，见 `LICENSE-hermes-agent`）。代码为重新实现。
