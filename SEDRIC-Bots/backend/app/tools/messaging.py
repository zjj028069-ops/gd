"""message_agent: fire-and-forget DM to a teammate's canonical Bot Chat.
The reply comes back later as a notification that starts a new turn."""
from __future__ import annotations

from typing import Any

from .. import bots
from . import Tool, ToolCtx, err, obj, ok, register

MAX_CHARS = 16000
MAX_DEPTH = 4


def _available(ctx: ToolCtx) -> bool:
    # Group rooms coordinate by @mention, not DMs (same containment as Hermes).
    return ctx.kind != "group"


async def message_agent(ctx: ToolCtx, args: dict[str, Any]) -> str:
    target = (args.get("target") or "").strip().lstrip("@").lower()
    message = (args.get("message") or "").strip()
    if not target or not message:
        return err("target 和 message 都不能为空")
    if len(message) > MAX_CHARS:
        return err(f"消息过长（{len(message)} > {MAX_CHARS} 字符）")
    if target == ctx.bot:
        return err("不能给自己发消息")
    resolved = None
    from ..mes import MES_BOT
    for name in [n for n in bots.names() if n != MES_BOT]:
        p = bots.load(name) or {}
        if target in (name, (p.get("title") or "").lower(), *p.get("previous_names", [])):
            resolved = name
            break
    if not resolved:
        return err(f"队友「{target}」不存在。当前队友：" + ", ".join(n for n in bots.names() if n != ctx.bot))
    depth = int(ctx.meta.get("dm_depth") or 0)
    if depth >= MAX_DEPTH:
        return err("这条对话链已经转了太多手，请直接回答，不要再转发。")
    delivery_id = ctx.runtime.dm_send(ctx.bot, ctx.session["id"], resolved, message, depth + 1)
    return ok({"status": "queued", "delivery_id": delivery_id, "target": resolved,
               "note": "消息已排队投递。不要等待或轮询——现在结束你的回合；对方回复后会以通知的形式唤醒你。"})


register(Tool(
    "message_agent", "message_agent",
    "给另一个 AI 队友发消息（像发短信一样，异步）。消息会投递到对方的 Bot Chat 并自动加上你的署名，"
    "工具立即返回，不会返回对方的回复——发完就结束本回合，对方回复后系统会通知你。"
    "消息要你自己组织：开门见山，写清楚要对方做什么或你要告诉对方的结果；不要原样转贴用户的话，"
    "也不要泄露和用户私聊的隐私内容。只在确实有帮助时联系一个最相关的队友。",
    obj({"target": {"type": "string", "description": "队友的名字（roster 里的 name）"},
         "message": {"type": "string", "description": "你写给对方的消息，不要带「Message from」前缀"}},
        ["target", "message"]),
    message_agent,
    available=_available,
))
