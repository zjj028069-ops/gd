"""The agent runtime.

One Runner per session serialises turns (a message sent while a bot is busy is
queued). A turn = stream the model → run its tool calls → repeat until the
model answers without tools. Approvals and clarify questions park the turn on
a future the UI resolves. Bot-to-bot DMs, group rounds and routines all drive
bots through `Runtime.run`, which waits for the turn's final text."""
from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import bots, llm, mcp, prompt, sessions, settings
from .events import bus
from .storage import UPLOADS_DIR, new_id, now_ms, truncate
from .tools import REGISTRY, ToolCtx
from .mes import MES_BOT
from .mes import memory as mes_memory
from .mes import prompt as mes_prompt
from .mes.tools import MES_TOOLS
from .mes import tools_batch as _tools_batch  # noqa: F401  注册批量建资料工具
from .mes.ui_tools import UI_TOOLS

DEMO_READ_TOOLS = ("mes_memory", "mes_check_ready","mes_search_manual","mes_search_products", "mes_list_processes", "mes_list_routes", "mes_list_boms",
                   "mes_list_warehouses", "mes_list_customers", "mes_list_team_members", "mes_list_work_orders",
                   "mes_get_work_order")

TOOL_RESULT_CHARS = 16000
IMAGE_HISTORY = 3  # only the newest N image-bearing user messages carry pixels


@dataclass
class Job:
    content: str | None
    attachments: list[dict[str, Any]]
    meta: dict[str, Any]
    future: asyncio.Future


@dataclass
class Runner:
    sid: str
    bot: str
    queue: deque = field(default_factory=deque)
    task: asyncio.Task | None = None
    cancel: asyncio.Event = field(default_factory=asyncio.Event)
    running: bool = False
    phase: str = "idle"  # idle | think | work | wait


def _attachment_part(att: dict[str, Any]) -> dict[str, Any] | None:
    path = UPLOADS_DIR / Path(att.get("file") or "").name
    if not path.exists():
        return None
    mime = att.get("mime") or mimetypes.guess_type(path.name)[0] or "image/png"
    data = base64.b64encode(path.read_bytes()).decode()
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}}


def _user_text(m: dict[str, Any]) -> str:
    text = m.get("content") or ""
    extra = []
    for a in m.get("attachments") or []:
        if a.get("kind") == "image":
            continue
        if a.get("text"):
            extra.append(f"\n\n[附件：{a.get('name')}]\n```\n{truncate(a['text'], 30000)}\n```")
        else:
            extra.append(f"\n\n[附件：{a.get('name')}（{a.get('size', 0)} 字节，无法提取文本），保存在 {UPLOADS_DIR / Path(a.get('file') or '').name}]")
    return text + "".join(extra)


def to_api(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    img_budget = IMAGE_HISTORY
    image_ok: set[int] = set()
    for i in range(len(messages) - 1, -1, -1):
        m = messages[i]
        if m.get("role") == "user" and any(a.get("kind") == "image" for a in m.get("attachments") or []):
            if img_budget > 0:
                image_ok.add(i)
                img_budget -= 1
    open_calls: list[str] = []

    def close_open():
        for cid in open_calls:
            out.append({"role": "tool", "tool_call_id": cid, "content": "(未执行：回合被中断)"})
        open_calls.clear()

    for i, m in enumerate(messages):
        role = m.get("role")
        if role == "user":
            close_open()
            text = _user_text(m)
            imgs = [a for a in m.get("attachments") or [] if a.get("kind") == "image"]
            if imgs and i in image_ok:
                parts: list[dict[str, Any]] = [{"type": "text", "text": text or "(图片)"}]
                for a in imgs:
                    p = _attachment_part(a)
                    if p:
                        parts.append(p)
                out.append({"role": "user", "content": parts})
            else:
                if imgs:
                    text += "".join(f"\n[图片：{a.get('name')}]" for a in imgs)
                out.append({"role": "user", "content": text})
        elif role == "assistant":
            close_open()
            msg: dict[str, Any] = {"role": "assistant", "content": m.get("content") or ""}
            if m.get("tool_calls"):
                msg["tool_calls"] = m["tool_calls"]
                open_calls.extend(c["id"] for c in m["tool_calls"])
            out.append(msg)
        elif role == "tool":
            cid = m.get("tool_call_id")
            if cid in open_calls:
                open_calls.remove(cid)
                out.append({"role": "tool", "tool_call_id": cid, "content": m.get("content") or ""})
    close_open()
    return out


def _chars(msgs: list[dict[str, Any]]) -> int:
    n = 0
    for m in msgs:
        c = m.get("content")
        n += len(c) if isinstance(c, str) else sum(len(p.get("text", "")) + 1000 for p in c or [])
        n += len(json.dumps(m.get("tool_calls"))) if m.get("tool_calls") else 0
    return n


class Runtime:
    def __init__(self) -> None:
        self.runners: dict[str, Runner] = {}
        self.pending: dict[str, tuple[dict[str, Any], asyncio.Future]] = {}
        self.attention: dict[str, dict[str, Any]] = {}
        self.deliveries: dict[str, dict[str, Any]] = {}

    # ── status ───────────────────────────────────────────────────────────────

    def bot_status(self, bot: str) -> dict[str, Any]:
        phases = [r.phase for r in self.runners.values() if r.bot == bot and r.running]
        mood = "work" if "work" in phases else "think" if "think" in phases else "wait" if "wait" in phases else "idle"
        pend = [p for p, _ in self.pending.values() if p["bot"] == bot]
        att = self.attention.get(bot)
        if pend and not att:
            att = {"kind": "input", "text": "需要你输入"}
        return {"mood": mood, "attention": att, "pending": len(pend),
                "running": [r.sid for r in self.runners.values() if r.bot == bot and r.running]}

    def _publish_status(self, bot: str) -> None:
        bus.publish("bot_status", bot=bot, status=self.bot_status(bot))

    def session_state(self, sid: str) -> dict[str, Any]:
        r = self.runners.get(sid)
        return {"running": bool(r and r.running), "queued": len(r.queue) if r else 0, "phase": r.phase if r else "idle"}

    def _set_phase(self, r: Runner, phase: str) -> None:
        if r.phase != phase:
            r.phase = phase
            bus.publish("turn", sid=r.sid, bot=r.bot, **self.session_state(r.sid))
            self._publish_status(r.bot)

    # ── submission ───────────────────────────────────────────────────────────

    def submit(self, bot: str, sid: str, content: str | None, attachments: list[dict[str, Any]] | None = None,
               meta: dict[str, Any] | None = None) -> asyncio.Future:
        loop = asyncio.get_running_loop()
        r = self.runners.get(sid)
        if r is None:
            r = self.runners[sid] = Runner(sid=sid, bot=bot)
        elif r.bot != bot and not r.running:
            r.bot = bot  # the bot was renamed since this runner was made
        fut = loop.create_future()
        r.queue.append(Job(content, attachments or [], meta or {}, fut))
        if r.task is None or r.task.done():
            r.task = loop.create_task(self._drain(r))
        else:
            bus.publish("turn", sid=sid, bot=bot, **self.session_state(sid))
        return fut

    async def run(self, bot: str, sid: str, content: str | None, meta: dict[str, Any] | None = None,
                  attachments: list[dict[str, Any]] | None = None, timeout: float | None = None) -> str:
        fut = self.submit(bot, sid, content, attachments, meta)
        if timeout:
            return await asyncio.wait_for(asyncio.shield(fut), timeout)
        return await fut

    def interrupt(self, sid: str, clear_queue: bool = True) -> None:
        r = self.runners.get(sid)
        if not r:
            return
        if clear_queue:
            while r.queue:
                job = r.queue.popleft()
                if not job.future.done():
                    job.future.set_result("")
        r.cancel.set()
        for pid, (rec, fut) in list(self.pending.items()):
            if rec["sid"] == sid and not fut.done():
                fut.set_result(None)

    async def _drain(self, r: Runner) -> None:
        while r.queue:
            job = r.queue.popleft()
            r.cancel = asyncio.Event()
            r.running = True
            bus.publish("turn", sid=r.sid, bot=r.bot, **self.session_state(r.sid))
            self._publish_status(r.bot)
            try:
                text = await self._turn(r, job)
                if not job.future.done():
                    job.future.set_result(text)
            except Exception as e:  # noqa: BLE001
                import traceback
                traceback.print_exc()
                s = sessions.get(r.sid)
                if s:
                    m = sessions.append(s, {"role": "event", "kind": "error", "content": f"内部错误：{e}"})
                    bus.publish("message", sid=r.sid, bot=r.bot, message=m)
                if not job.future.done():
                    job.future.set_exception(e)
            finally:
                r.running = False
                r.phase = "idle"
                bus.publish("turn", sid=r.sid, bot=r.bot, **self.session_state(r.sid))
                self._publish_status(r.bot)

    # ── the turn ─────────────────────────────────────────────────────────────

    def _tools_for(self, ctx: ToolCtx) -> list[Any]:
        enabled = ctx.profile.get("tools") or {}
        out = []
        for t in REGISTRY.values():
            if not enabled.get(t.toolset, True):
                continue
            if ctx.kind == "routine" and t.name == "clarify":
                continue
            if t.available and not t.available(ctx):
                continue
            out.append(t)
        return out

    async def _turn(self, r: Runner, job: Job) -> str:
        s = sessions.get(r.sid)
        if s is not None and s["bot"] != r.bot:
            r.bot = s["bot"]  # the session index is the source of truth after a rename
        prof = bots.load(r.bot) if s is not None else None
        if s is None or prof is None:
            return ""
        mes_mode = bool(s.get("mes"))
        if r.bot == MES_BOT and not mes_mode:
            return ""  # the MES bot never runs outside MES sessions (e.g. a DM from another bot)
        turn_start = len(s["messages"])
        if job.content is not None:
            um = {"role": "user", "content": job.content, "attachments": job.attachments,
                  "from": job.meta.get("from") or {"kind": "user"}}
            if job.meta.get("display"):
                um["display"] = job.meta["display"]
            m = sessions.append(s, um)
            if job.meta.get("from", {}).get("kind", "user") == "user":
                s["last_read"] = now_ms()
            bus.publish("message", sid=r.sid, bot=r.bot, message=m)
        provider, model = mes_prompt.resolve_model() if mes_mode else settings.resolve_model(prof.get("model"))
        cfg = settings.load()
        ctx = ToolCtx(bot=r.bot, profile=prof, session=s, meta=job.meta, runtime=self, cancel=r.cancel)
        # MES sessions get a fixed whitelist, never the profile's toolsets or MCP.
        if mes_mode and s.get("mode") == "demo":
            # 代操作模式：写操作只通过用户浏览器的界面完成；另给只读查询（做前置检查）、说明书、提问。
            local_tools = [REGISTRY["clarify"], *(MES_TOOLS[n] for n in DEMO_READ_TOOLS), *UI_TOOLS.values()]
        elif mes_mode:
            local_tools = [REGISTRY["clarify"], *MES_TOOLS.values()]
        else:
            local_tools = self._tools_for(ctx)
        schemas = [t.schema() for t in local_tools]
        by_name = {t.name: t for t in local_tools}
        mcp_map: dict[str, tuple[Any, str]] = {}
        if not mes_mode and (prof.get("tools") or {}).get("mcp", True) and prof.get("mcp_servers"):
            try:
                for schema, srv, orig in await mcp.tools_for(r.bot, prof["mcp_servers"], str(bots.bot_dir(r.bot) / "workspace")):
                    schemas.append(schema)
                    mcp_map[schema["function"]["name"]] = (srv, orig)
            except Exception as e:  # noqa: BLE001
                print("[mcp]", e)
        tool_names = set(by_name) | set(mcp_map)
        final = ""
        max_iter = int(job.meta.get("max_iterations") or cfg.get("max_iterations") or 24)
        hit_cap = True
        for _ in range(max_iter):
            if r.cancel.is_set():
                hit_cap = False
                break
            history = s["messages"][s.get("compressed_upto", 0):]
            api_msgs = to_api(history)
            if _chars(api_msgs) > int(cfg.get("context_chars") or 120000) * 0.85 and len(history) > 12:
                await self.compress(r.bot, r.sid, auto=True)
                history = s["messages"][s.get("compressed_upto", 0):]
                api_msgs = to_api(history)
            system = mes_prompt.build_system(s) if mes_mode else prompt.build_system(r.bot, prof, s, tool_names)
            self._set_phase(r, "think")
            stream_id = new_id("st")

            async def on_event(kind: str, text: str, _sid=stream_id) -> None:
                bus.publish("delta", sid=r.sid, bot=r.bot, stream=_sid, kind=kind, text=text)

            try:
                res = await llm.chat(provider, model, [{"role": "system", "content": system}, *api_msgs],
                                     schemas or None, on_event, r.cancel)
            except llm.LLMError as e:
                if e.kind in ("auth", "quota", "config"):
                    self.attention[r.bot] = {"kind": e.kind, "text": {"auth": "请检查 API Key", "quota": "额度或余额已用尽",
                                                                      "config": "未配置可用的模型"}[e.kind]}
                m = sessions.append(s, {"role": "event", "kind": "error", "error_kind": e.kind, "content": e.message})
                bus.publish("message", sid=r.sid, bot=r.bot, message=m)
                self._publish_status(r.bot)
                hit_cap = False
                break
            self.attention.pop(r.bot, None)
            am: dict[str, Any] = {"role": "assistant", "content": res.content, "model": model,
                                  "provider": provider["id"] if provider else None, "stream": stream_id}
            if res.reasoning:
                am["reasoning"] = res.reasoning
            calls = [] if res.cancelled else res.tool_calls
            if calls:
                am["tool_calls"] = calls
            if res.content or calls or res.reasoning:
                m = sessions.append(s, am)
                bus.publish("message", sid=r.sid, bot=r.bot, message=m)
            if res.cancelled or r.cancel.is_set():
                hit_cap = False
                break
            if not calls:
                final = res.content
                hit_cap = False
                break
            self._set_phase(r, "work")
            for call in calls:
                if r.cancel.is_set():
                    break
                name = call["function"]["name"]
                raw = call["function"].get("arguments") or "{}"
                bus.publish("tool", sid=r.sid, bot=r.bot, phase="start", call_id=call["id"], name=name, args=raw)
                try:
                    args = json.loads(raw) if raw.strip() else {}
                    if not isinstance(args, dict):
                        raise ValueError("参数必须是 JSON 对象")
                except (json.JSONDecodeError, ValueError) as e:
                    result = json.dumps({"error": f"参数不是合法 JSON：{e}"}, ensure_ascii=False)
                else:
                    ctx.call_id = call["id"]
                    try:
                        if name in by_name:
                            result = await by_name[name].handler(ctx, args)
                        elif name in mcp_map:
                            srv, orig = mcp_map[name]
                            result = await srv.call(orig, args)
                        else:
                            result = json.dumps({"error": f"没有这个工具：{name}"}, ensure_ascii=False)
                    except Exception as e:  # noqa: BLE001
                        result = json.dumps({"error": f"{type(e).__name__}: {e}"}, ensure_ascii=False)
                    if r.phase != "work":
                        self._set_phase(r, "work")
                tm = sessions.append(s, {"role": "tool", "tool_call_id": call["id"], "name": name,
                                         "content": truncate(str(result), TOOL_RESULT_CHARS)})
                bus.publish("message", sid=r.sid, bot=r.bot, message=tm)
            if r.cancel.is_set():
                hit_cap = False
                break
        if r.cancel.is_set():
            m = sessions.append(s, {"role": "event", "kind": "interrupted", "content": "已中断"})
            bus.publish("message", sid=r.sid, bot=r.bot, message=m)
        elif hit_cap:
            m = sessions.append(s, {"role": "event", "kind": "capped",
                                    "content": f"已用完本回合的 {max_iter} 步工具预算，让它基于已有信息作答。"})
            bus.publish("message", sid=r.sid, bot=r.bot, message=m)
            final = await self._final_answer(r, s, prof, provider, model)
        bus.publish("session_meta", bot=r.bot, session=sessions.preview(s))
        if mes_mode and s.get("owner") and job.meta.get("mes_owner") == s.get("owner"):
            # 回合结束后在后台回顾：踩过坑就把经验写进企业经验库
            asyncio.get_running_loop().create_task(
                self._remember(r, s, s["messages"][turn_start:], provider, model))
        return (final or "").strip()

    async def _remember(self, r: Runner, s: dict[str, Any], turn_msgs: list[dict[str, Any]], provider, model) -> None:
        try:
            learned = await mes_memory.reflect(s["owner"], s["id"], list(turn_msgs), provider, model)
        except Exception as e:  # noqa: BLE001
            print("[mes memory]", e)
            return
        if learned:
            m = sessions.append(s, {"role": "event", "kind": "memory",
                                    "content": f"📝 记住了 {len(learned)} 条经验，下次会避开：\n" + "\n".join(f"· {t}" for t in learned)})
            bus.publish("message", sid=s["id"], bot=r.bot, message=m)

    async def _final_answer(self, r: Runner, s: dict[str, Any], prof: dict[str, Any], provider, model) -> str:
        """Tool budget spent: one last tool-less call so the turn still ends
        with an answer instead of silence."""
        history = to_api(s["messages"][s.get("compressed_upto", 0):])
        system = mes_prompt.build_system(s) if s.get("mes") else prompt.build_system(r.bot, prof, s, set())
        nudge = {"role": "user", "content": "[系统提示] 本回合的工具步数已经用完。不要再调用任何工具，"
                                            "直接根据目前已经掌握的信息给出最终回答；没查完的部分如实说明。"}
        self._set_phase(r, "think")
        stream_id = new_id("st")

        async def on_event(kind: str, text: str) -> None:
            bus.publish("delta", sid=r.sid, bot=r.bot, stream=stream_id, kind=kind, text=text)

        try:
            res = await llm.chat(provider, model, [{"role": "system", "content": system}, *history, nudge], None,
                                 on_event, r.cancel)
        except llm.LLMError as e:
            m = sessions.append(s, {"role": "event", "kind": "error", "error_kind": e.kind, "content": e.message})
            bus.publish("message", sid=r.sid, bot=r.bot, message=m)
            return ""
        if res.content or res.reasoning:
            m = sessions.append(s, {"role": "assistant", "content": res.content, "reasoning": res.reasoning or None,
                                    "model": model, "stream": stream_id})
            bus.publish("message", sid=r.sid, bot=r.bot, message=m)
        return res.content

    # ── approvals & clarify ──────────────────────────────────────────────────

    async def _wait_pending(self, ctx: ToolCtx, rec: dict[str, Any]) -> Any:
        fut = asyncio.get_running_loop().create_future()
        rec.update({"id": new_id("pend"), "bot": ctx.bot, "sid": ctx.session["id"], "at": now_ms(),
                    "group_id": ctx.session.get("group_id"), "thread": ctx.session.get("thread"), "bot_title": ctx.profile.get("title") or ctx.bot})
        self.pending[rec["id"]] = (rec, fut)
        runner = self.runners.get(ctx.session["id"])
        prev = runner.phase if runner else "work"
        if runner:
            self._set_phase(runner, "wait")
        bus.publish("pending", items=self.pending_list())
        self._publish_status(ctx.bot)
        cancel_wait = asyncio.ensure_future(ctx.cancel.wait())
        try:
            await asyncio.wait({fut, cancel_wait}, return_when=asyncio.FIRST_COMPLETED)
            return fut.result() if fut.done() else None
        finally:
            cancel_wait.cancel()
            self.pending.pop(rec["id"], None)
            if runner and runner.running:
                self._set_phase(runner, prev)
            bus.publish("pending", items=self.pending_list())
            self._publish_status(ctx.bot)

    async def request_approval(self, ctx: ToolCtx, title: str, detail: str) -> bool:
        res = await self._wait_pending(ctx, {"kind": "approval", "title": title, "detail": detail})
        s = ctx.session
        m = sessions.append(s, {"role": "event", "kind": "approval",
                                "content": f"{'✅ 已批准' if res else '⛔ 已拒绝'}：{title}\n{detail}"})
        bus.publish("message", sid=s["id"], bot=ctx.bot, message=m)
        return bool(res)

    async def request_clarify(self, ctx: ToolCtx, question: str, choices: list[str]) -> str:
        res = await self._wait_pending(ctx, {"kind": "clarify", "title": question, "choices": choices})
        return str(res) if res else ""

    def resolve_pending(self, pid: str, value: Any) -> bool:
        item = self.pending.get(pid)
        if not item:
            return False
        rec, fut = item
        if not fut.done():
            fut.set_result(value)
        return True

    def pending_list(self) -> list[dict[str, Any]]:
        return [rec for rec, _ in self.pending.values()]

    # ── bot-to-bot DMs ───────────────────────────────────────────────────────

    def dm_send(self, sender: str, origin_sid: str, target: str, message: str, depth: int) -> str:
        did = new_id("dm")
        self.deliveries[did] = {"id": did, "from": sender, "to": target, "message": message, "status": "queued",
                                "at": now_ms()}
        asyncio.get_running_loop().create_task(self._deliver(did, sender, origin_sid, target, message, depth))
        return did

    async def _deliver(self, did: str, sender: str, origin_sid: str, target: str, message: str, depth: int) -> None:
        sp = bots.load(sender) or {}
        tp = bots.load(target) or {}
        s_title = sp.get("title") or sender
        t_title = tp.get("title") or target
        bus.publish("dm", id=did, sender=sender, target=target, phase="sent", text=message[:200])
        tchat = sessions.canonical(target)
        text = f"Message from 🤖 {s_title} (@{sender}): {message}"
        ok = True
        try:
            reply = await self.run(target, tchat["id"], text, {"from": {"kind": "bot", "name": sender}, "dm_depth": depth},
                                   timeout=1800)
        except Exception as e:  # noqa: BLE001
            ok, reply = False, str(e)
        if ok and not reply:
            reply = "（对方没有给出文字回复，可能被中断或出错了。）"
        self.deliveries[did]["status"] = "replied" if ok else "failed"
        bus.publish("dm", id=did, sender=target, target=sender, phase="reply", text=(reply or "")[:200])
        origin = sessions.get(origin_sid) or sessions.canonical(sender)
        if ok:
            note = f"[message_agent 回执] 🤖 {t_title} (@{target}) 回复了你：\n{reply}"
        else:
            note = f"[message_agent 回执] 给 🤖 {t_title} (@{target}) 的消息投递失败：{reply}"
        self.submit(sender, origin["id"], note, meta={"from": {"kind": "bot", "name": target, "dm_reply": True},
                                                      "dm_depth": depth})

    # ── compression ──────────────────────────────────────────────────────────

    async def compress(self, bot: str, sid: str, auto: bool = False, keep: int = 6) -> dict[str, Any]:
        s = sessions.get(sid)
        prof = bots.load(bot)
        if not s or not prof:
            return {"ok": False, "error": "会话不存在"}
        msgs = s["messages"]
        start = s.get("compressed_upto", 0)
        user_idx = [i for i in range(start, len(msgs)) if msgs[i].get("role") == "user"]
        if len(user_idx) <= keep:
            return {"ok": False, "error": "消息还不多，不需要压缩"}
        cut = user_idx[-keep]
        lines = []
        for m in msgs[start:cut]:
            role = m.get("role")
            if role == "user":
                lines.append(f"[用户/来信] {truncate(_user_text(m), 3000)}")
            elif role == "assistant":
                if m.get("content"):
                    lines.append(f"[{prof.get('title') or bot}] {truncate(m['content'], 3000)}")
                for c in m.get("tool_calls") or []:
                    lines.append(f"[调用工具 {c['function']['name']}] {truncate(c['function'].get('arguments', ''), 300)}")
            elif role == "tool":
                lines.append(f"[工具结果 {m.get('name')}] {truncate(m.get('content') or '', 600)}")
        transcript = truncate("\n".join(lines), 80000)
        provider, model = mes_prompt.resolve_model() if s.get("mes") else settings.resolve_model(prof.get("model"))
        instr =("请把下面这段对话压缩成一份供你自己日后参考的摘要（中文，Markdown 要点）。保留：用户的目标和偏好、已做出的决定、"
                 "已完成和未完成的事项、重要的事实/路径/数字、未解决的问题。去掉寒暄和重复。")
        prev = s.get("summary")
        body = (f"已有的更早摘要：\n{prev}\n\n" if prev else "") + f"需要压缩的对话：\n{transcript}"
        try:
            if provider and provider["id"] == "mock":
                summary = ((prev + "\n") if prev else "") + "\n".join(f"- {ln[:120]}" for ln in lines[-30:])
            else:
                res = await llm.chat(provider, model, [{"role": "system", "content": instr}, {"role": "user", "content": body}])
                summary = res.content.strip()
        except llm.LLMError as e:
            return {"ok": False, "error": e.message}
        s["summary"] = summary
        s["compressed_upto"] = cut
        m = sessions.append(s, {"role": "event", "kind": "compressed",
                                "content": f"{'自动' if auto else ''}压缩了 {cut - start} 条较早的消息，摘要会作为背景保留。"})
        bus.publish("message", sid=sid, bot=bot, message=m)
        return {"ok": True, "compressed": cut - start}


runtime = Runtime()
