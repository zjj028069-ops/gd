"""演示模式的界面操作工具：Bot 在用户自己的浏览器里操作传统界面，用户看着它点。

这些工具本身不碰业务系统：每个调用都只是把一个动作交给用户的浏览器去执行
（作为 kind="ui" 的待办，经网关发给前端），再把页面的新样子拿回来。
真正的点击发生在用户自己的页面里、用的是用户自己的登录，所以权限和传统界面一样；
前端执行器还会拦掉删除类按钮，提交类按钮要用户点「允许」才会点下去。"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from ..tools import Tool, ToolCtx, obj
from .tools import _wrap  # owner check + error wrapping

UI_TOOLS: dict[str, Tool] = {}
UI_TIMEOUT = 300  # seconds; includes time the user takes to allow a submit click
MAX_STEPS = 20
STEP_KINDS = ("click", "fill", "select", "check", "uncheck")


async def _ui(ctx: ToolCtx, title: str, action: dict[str, Any]) -> str:
    rec = {"kind": "ui", "title": title, "action": action}
    try:
        res = await asyncio.wait_for(ctx.runtime._wait_pending(ctx, rec), UI_TIMEOUT)
    except asyncio.TimeoutError:
        return json.dumps({"error": "页面没有响应（用户可能关掉了演示面板或离开了页面）。停下来告诉用户。"}, ensure_ascii=False)
    if res is None:
        return json.dumps({"error": "操作被中断了。"}, ensure_ascii=False)
    return str(res)


async def ui_look(ctx, owner, args):
    return await _ui(ctx, "看页面", {"type": "look"})


async def ui_open(ctx, owner, args):
    menu = str(args.get("menu") or "").strip()[:60]
    if not menu:
        return json.dumps({"error": "menu 不能为空，写菜单名，如「加工单」或「生产管理/加工单」"}, ensure_ascii=False)
    return await _ui(ctx, f"打开「{menu}」", {"type": "open", "menu": menu})


async def ui_do(ctx, owner, args):
    raw = args.get("steps") or []
    if not isinstance(raw, list) or not raw:
        return json.dumps({"error": "steps 不能为空"}, ensure_ascii=False)
    steps = []
    for s in raw[:MAX_STEPS]:
        if not isinstance(s, dict) or s.get("do") not in STEP_KINDS:
            return json.dumps({"error": f"每一步的 do 只能是 {'/'.join(STEP_KINDS)}"}, ensure_ascii=False)
        target = str(s.get("target") if s.get("target") is not None else "").strip()[:80]
        if not target:
            return json.dumps({"error": "每一步都要有 target（元素编号或标签文字）"}, ensure_ascii=False)
        steps.append({"do": s["do"], "target": target, "value": str(s.get("value") or "")[:300]})
    title = "、".join(f"{ {'click': '点', 'fill': '填', 'select': '选', 'check': '勾选', 'uncheck': '取消勾选'}[s['do']] }{s['target']}" for s in steps)
    return await _ui(ctx, title[:120], {"type": "do", "steps": steps})


def _reg(name: str, description: str, parameters: dict[str, Any], handler) -> None:
    UI_TOOLS[name] = Tool(name, "ui", description, parameters, _wrap(handler))


S = {"type": "string"}
_reg("ui_look", "看当前页面：返回页面路径、弹窗、可操作元素清单（[编号] 类型「标签」= 当前值）和表格内容。", obj({}), ui_look)
_reg("ui_open", "通过左侧菜单打开一个页面（用户能看到光标去点菜单）。menu 写菜单名，如「加工单」「商品列表」「生产管理/报工记录」。返回打开后的页面。",
     obj({"menu": S}, ["menu"]), ui_open)
_reg("ui_do",
     "在当前页面上按顺序执行几步操作，用户能看到光标逐步操作。每步：do=click(点)/fill(输入框、日期填值)/select(下拉框选项)/check/uncheck(勾选框)，"
     "target=元素编号（来自最近一次页面清单）或标签/按钮文字，value=要填的值或要选的选项文字。"
     "遇到出错会停在那一步。返回操作后的页面清单。打开弹窗、切换页签后，新出现的元素要用返回的新编号。",
     obj({"steps": {"type": "array", "items": obj({"do": {"type": "string", "enum": list(STEP_KINDS)}, "target": S, "value": S},
                                                  ["do", "target"])}}, ["steps"]),
     ui_do)
