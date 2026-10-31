"""clarify: pause the turn and ask the user a question (optionally multiple choice)."""
from __future__ import annotations

from typing import Any

from . import Tool, ToolCtx, err, obj, register


async def clarify(ctx: ToolCtx, args: dict[str, Any]) -> str:
    q = (args.get("question") or "").strip()
    if not q:
        return err("question 不能为空")
    choices = [str(c) for c in (args.get("choices") or []) if str(c).strip()][:6]
    answer = await ctx.clarify(q, choices)
    return answer or "(用户没有回答)"


register(Tool(
    "clarify", "clarify",
    "向用户提一个问题并等待回答。只在确实需要用户做决定、信息不足以继续时使用。可以给 2-6 个选项。",
    obj({"question": {"type": "string"}, "choices": {"type": "array", "items": {"type": "string"}}}, ["question"]),
    clarify,
))
