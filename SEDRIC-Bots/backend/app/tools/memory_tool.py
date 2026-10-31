"""memory: the bot's durable notes (MEMORY.md) and user profile (USER.md).
Both are injected into every system prompt, so keep entries short."""
from __future__ import annotations

from typing import Any

from .. import bots
from ..events import bus
from . import Tool, ToolCtx, err, obj, ok, register


async def memory(ctx: ToolCtx, args: dict[str, Any]) -> str:
    action = args.get("action") or "add"
    target = "user" if args.get("target") == "user" else "memory"
    entries = bots.memory_entries(ctx.bot, target)
    content = (args.get("content") or "").strip()
    old = (args.get("old_text") or "").strip()
    limit = bots.memory_limit(target)
    if action == "add":
        if not content:
            return err("content 不能为空")
        if any(content == e for e in entries):
            return ok({"status": "duplicate", "note": "已经记过了"})
        entries.append(content)
    elif action in ("replace", "remove"):
        hits = [i for i, e in enumerate(entries) if old and old in e]
        if not hits:
            return err("old_text 没有匹配到任何条目")
        if len(hits) > 1:
            return err("old_text 匹配到多条，请写得更具体")
        if action == "replace":
            if not content:
                return err("replace 需要 content")
            entries[hits[0]] = content
        else:
            entries.pop(hits[0])
    else:
        return err("action 只能是 add / replace / remove")
    total = sum(len(e) for e in entries) + 3 * max(0, len(entries) - 1)
    if total > limit:
        return err(f"超出容量（{total}/{limit} 字符）。先用 replace/remove 合并或删除旧条目。")
    bots.set_memory_entries(ctx.bot, target, entries)
    bus.publish("bot_memory", bot=ctx.bot)
    return ok({"status": "saved", "target": target, "usage": f"{total}/{limit}", "entries": len(entries)})


register(Tool(
    "memory", "memory",
    "管理你的长期记忆。target=memory 记录你自己的笔记（环境、约定、经验教训），target=user 记录关于用户的信息（偏好、习惯、身份）。"
    "这些内容会出现在你以后每次对话的系统提示里。只记长期有用的事，每条简短。",
    obj({"action": {"type": "string", "enum": ["add", "replace", "remove"]},
         "target": {"type": "string", "enum": ["memory", "user"]},
         "content": {"type": "string", "description": "新条目内容（add/replace）"},
         "old_text": {"type": "string", "description": "用于定位旧条目的片段（replace/remove）"}}, ["action"]),
    memory,
))
