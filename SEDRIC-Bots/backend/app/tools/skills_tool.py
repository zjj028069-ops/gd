"""Skills: SKILL.md playbooks. The system prompt lists name + description; the
bot loads the full body on demand with skill_view, and can write new ones."""
from __future__ import annotations

from typing import Any

from .. import bots
from ..events import bus
from . import Tool, ToolCtx, err, obj, ok, register


async def skill_view(ctx: ToolCtx, args: dict[str, Any]) -> str:
    key = (args.get("name") or "").strip()
    for s in bots.list_skills(ctx.bot):
        if key in (s["id"], s["name"]):
            return f"# 技能：{s['name']}\n{s['description']}\n\n{s['body']}"
    return err(f"没有名为「{key}」的技能")


async def skill_manage(ctx: ToolCtx, args: dict[str, Any]) -> str:
    action = args.get("action")
    name = (args.get("name") or "").strip()
    if not name:
        return err("name 不能为空")
    if action == "delete":
        sid = bots.slug(name)
        ok_ = bots.delete_skill(ctx.bot, sid)
        bus.publish("bot_skills", bot=ctx.bot)
        return ok({"status": "deleted" if ok_ else "not_found"})
    if action in ("create", "update"):
        body = args.get("content") or ""
        if not body.strip():
            return err("content 不能为空")
        s = bots.put_skill(ctx.bot, name, name, args.get("description") or "", body)
        bus.publish("bot_skills", bot=ctx.bot)
        return ok({"status": "saved", "id": s["id"]})
    return err("action 只能是 create / update / delete")


register(Tool("skill_view", "skills", "加载一个技能的完整内容。系统提示里列出了你拥有的技能；任务匹配时先加载再照做。",
              obj({"name": {"type": "string"}}, ["name"]), skill_view))
register(Tool("skill_manage", "skills",
              "创建、更新或删除你的技能。完成了一个以后会重复用到的复杂流程后，把步骤沉淀成技能。",
              obj({"action": {"type": "string", "enum": ["create", "update", "delete"]},
                   "name": {"type": "string"}, "description": {"type": "string", "description": "一句话说明何时使用"},
                   "content": {"type": "string", "description": "Markdown 步骤正文"}}, ["action", "name"]),
              skill_manage))
