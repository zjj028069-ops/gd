"""HTTP gateway used only by the SEDRIC01 API (never by browsers directly).

Every request must carry the shared secret SBOT_GATEWAY_TOKEN plus the
identity of the logged-in MES user, which the SEDRIC01 API has already
checked. A user only ever sees and drives their own sessions."""
from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
from typing import Any
from urllib.parse import unquote

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import StreamingResponse

from .. import bots, sessions
from ..events import bus
from . import MES_BOT, client, memory
from .prompt import model_ready

router = APIRouter(prefix="/mes-gw")

OWNER_RE = re.compile(r"^[0-9a-fA-F-]{36}:[0-9a-fA-F-]{36}$")
MAX_TEXT = 2000
MAX_SESSIONS = 60
TOOL_PREVIEW = 2500


def ensure_bot() -> None:
    if bots.exists(MES_BOT):
        return
    bots.create({"name": MES_BOT, "title": "赛德瑞克业务助手",
                 "description": "MES 业务助手（只给赛德瑞克 MES 用户使用，不参与机器人协作）",
                 "tools": {t: False for t in bots.ALL_TOOLS}, "empty_skills": True,
                 "soul": "你是赛德瑞克业务助手。"})
    bots.update(MES_BOT, {"hidden": True})


def _auth(request: Request) -> str:
    token = os.environ.get("SBOT_GATEWAY_TOKEN", "")
    if not token:
        raise HTTPException(503, "Bot 网关未启用（没有设置 SBOT_GATEWAY_TOKEN）")
    given = request.headers.get("x-sbot-gateway") or ""
    if not secrets.compare_digest(given.encode(), token.encode()):
        raise HTTPException(403, "forbidden")
    owner = request.headers.get("x-sbot-owner") or ""
    if not OWNER_RE.match(owner):
        raise HTTPException(400, "缺少用户身份")
    cookie = request.headers.get("x-sbot-mes-cookie") or ""
    csrf = request.headers.get("x-sbot-mes-csrf") or ""
    if cookie and len(cookie) < 300 and re.match(r"^[A-Za-z0-9_\-]+=[A-Za-z0-9_\-.]+$", cookie) and 0 < len(csrf) < 200:
        name = unquote(request.headers.get("x-sbot-user-name") or "")
        client.set_creds(owner, cookie, csrf, name[:40], (request.headers.get("x-sbot-user-role") or "")[:20])
    return owner


def _own(sid: str, owner: str) -> dict[str, Any]:
    s = sessions.get(sid) if isinstance(sid, str) and len(sid) < 64 else None
    if not s or s.get("bot") != MES_BOT or not s.get("mes") or s.get("owner") != owner:
        raise HTTPException(404, "会话不存在")
    return s


def _owned_sids(owner: str) -> set[str]:
    return {s["id"] for s in sessions.list_for(MES_BOT, include_hidden=True) if s.get("owner") == owner and s.get("mes")}


MAX_FILES = 3
MAX_FILE_TEXT = 40000


def _files(raw: Any) -> list[dict[str, Any]]:
    """业务系统读好的附件文字。只收文字（不收文件本身、不收路径），交给模型当参考资料。"""
    if raw in (None, []):
        return []
    if not isinstance(raw, list) or len(raw) > MAX_FILES:
        raise HTTPException(400, f"一次最多 {MAX_FILES} 个附件")
    out = []
    for f in raw:
        if not isinstance(f, dict):
            raise HTTPException(400, "附件格式不对")
        name = re.sub(r"\s+", " ", str(f.get("name") or "附件"))[:120]
        text = str(f.get("text") or "")
        if not text.strip():
            raise HTTPException(400, f"附件「{name}」没有可读的文字")
        if len(text) > MAX_FILE_TEXT:
            raise HTTPException(400, f"附件「{name}」内容太长")
        size = f.get("size") if isinstance(f.get("size"), int) else len(text)
        out.append({"kind": "file", "name": name, "text": text, "size": size})
    return out


def _public_message(m: dict[str, Any]) -> dict[str, Any] | None:
    role = m.get("role")
    if role == "user":
        files = [{"name": a.get("name"), "size": a.get("size")} for a in m.get("attachments") or [] if a.get("kind") == "file"]
        return {"id": m.get("id"), "role": "user", "content": m.get("content") or "", "at": m.get("at"),
                **({"files": files} if files else {})}
    if role == "assistant":
        return {"id": m.get("id"), "role": "assistant", "content": m.get("content") or "", "at": m.get("at"),
                "stream": m.get("stream"),
                "reasoning": (m.get("reasoning") or "")[:4000] or None,
                "tool_calls": [{"id": c.get("id"), "name": c["function"]["name"],
                                "arguments": (c["function"].get("arguments") or "")[:3000]}
                               for c in m.get("tool_calls") or []]}
    if role == "tool":
        return {"id": m.get("id"), "role": "tool", "name": m.get("name"), "tool_call_id": m.get("tool_call_id"),
                "content": (m.get("content") or "")[:TOOL_PREVIEW], "at": m.get("at")}
    if role == "event":
        return {"id": m.get("id"), "role": "event", "kind": m.get("kind"), "content": m.get("content") or "",
                "at": m.get("at")}
    return None


def _pending_for(sids: set[str]) -> list[dict[str, Any]]:
    from ..agent import runtime
    out = []
    for r in runtime.pending_list():
        if r.get("sid") not in sids:
            continue
        s = sessions.get(r["sid"]) or {}
        out.append({"id": r["id"], "sid": r["sid"], "kind": r["kind"], "title": r.get("title"), "detail": r.get("detail"),
                    "choices": r.get("choices") or [], "action": r.get("action"), "driver_tab": s.get("driver_tab")})
    return out


@router.get("/info")
async def info(request: Request):
    _auth(request)
    return {"ready": model_ready(), "name": "赛德瑞克业务助手"}


@router.get("/sessions")
async def list_sessions(request: Request):
    owner = _auth(request)
    rows = [{**sessions.preview(s), "mode": s.get("mode") or "chat"} for s in sessions.list_for(MES_BOT, include_hidden=True)
            if s.get("owner") == owner and s.get("mes")]
    rows.sort(key=lambda r: -(r.get("updated") or 0))
    return {"items": rows}


@router.post("/sessions")
async def create_session(request: Request, data: dict = Body(default={})):
    owner = _auth(request)
    ensure_bot()
    if len(_owned_sids(owner)) >= MAX_SESSIONS:
        raise HTTPException(400, f"对话太多了（最多 {MAX_SESSIONS} 个），请先删除一些旧对话。")
    mode = "demo" if (data or {}).get("mode") == "demo" else "chat"
    s = sessions.create(MES_BOT, "新对话", kind="chat", hidden=True, mes=True, owner=owner, mode=mode)
    return {**sessions.preview(s), "mode": mode}


@router.get("/sessions/{sid}")
async def get_session(sid: str, request: Request):
    from ..agent import runtime
    owner = _auth(request)
    s = _own(sid, owner)
    msgs = [p for m in s.get("messages", []) if (p := _public_message(m))]
    return {**sessions.preview(s), "mode": s.get("mode") or "chat", "messages": msgs, "state": runtime.session_state(sid),
            "pending": _pending_for({sid})}


@router.delete("/sessions/{sid}")
async def delete_session(sid: str, request: Request):
    from ..agent import runtime
    owner = _auth(request)
    _own(sid, owner)
    runtime.interrupt(sid)
    sessions.delete(sid)
    return {"ok": True}


@router.post("/sessions/{sid}/messages")
async def send(sid: str, request: Request, data: dict = Body(...)):
    from ..agent import runtime
    owner = _auth(request)
    s = _own(sid, owner)
    text = str(data.get("text") or "").strip()
    files = _files(data.get("files"))
    if not text and files:
        text = "请读取附件，按内容在系统里办好。"
    if not text:
        raise HTTPException(400, "消息不能为空")
    if len(text) > MAX_TEXT:
        raise HTTPException(400, f"消息太长（最多 {MAX_TEXT} 字）")
    if not model_ready():
        raise HTTPException(503, "业务助手还没有配置大模型，请联系管理员。")
    # 代操作：记住是哪个浏览器标签页发的消息，界面动作只交给它执行（同一账号开了多个窗口时不会重复执行）
    tab = str(data.get("tab") or "")
    if re.match(r"^[a-z0-9]{6,40}$", tab) and s.get("driver_tab") != tab:
        s["driver_tab"] = tab
        sessions.save(s)
    # 代操作每点一下就是一步，一张单从建资料到提交往往要几十步
    steps = 60 if s.get("mode") == "demo" else 16
    runtime.submit(MES_BOT, sid, text, files, {"from": {"kind": "user"}, "mes_owner": owner, "max_iterations": steps})
    if s.get("title") == "新对话":
        s["title"] = text[:30]
        sessions.save(s)
    return {"ok": True, **runtime.session_state(sid)}


@router.post("/sessions/{sid}/interrupt")
async def interrupt(sid: str, request: Request):
    from ..agent import runtime
    owner = _auth(request)
    _own(sid, owner)
    runtime.interrupt(sid)
    return {"ok": True}


@router.post("/pending/{pid}")
async def resolve(pid: str, request: Request, data: dict = Body(...)):
    from ..agent import runtime
    owner = _auth(request)
    item = runtime.pending.get(pid)
    if not item:
        raise HTTPException(404, "这个请求已经处理过了")
    _own(item[0].get("sid"), owner)
    if item[0].get("kind") == "clarify":
        value: Any = str(data.get("answer") or "")[:500]
    elif item[0].get("kind") == "ui":
        # 浏览器执行完界面动作后回传的页面清单/结果（是数据，模型按工具结果对待）
        value = str(data.get("result") or "(页面没有返回内容)")[:12000]
    else:
        value = bool(data.get("approve"))
    runtime.resolve_pending(pid, value)
    return {"ok": True}


# ── 企业经验库：本企业所有人可看，管理员可改 ─────────────────────────────


def _memory_ctx(request: Request) -> tuple[str, str, bool]:
    owner = _auth(request)
    info = client.user_info(owner)
    return memory.tenant_of(owner), info.get("name") or "用户", info.get("role") == "admin"


@router.get("/memory")
async def memory_list(request: Request):
    tenant, _, admin = _memory_ctx(request)
    items = sorted(memory.load(tenant), key=lambda i: -(i.get("updated") or 0))
    return {"items": items, "can_edit": admin}


def _need_admin(admin: bool) -> None:
    if not admin:
        raise HTTPException(403, "只有管理员可以修改经验库")


@router.post("/memory")
async def memory_add(request: Request, data: dict = Body(...)):
    tenant, name, admin = _memory_ctx(request)
    _need_admin(admin)
    try:
        e = memory.add(tenant, data.get("text"), name, source="manual")
    except memory.MemoryError as err:
        raise HTTPException(400, str(err))
    if not e:
        raise HTTPException(400, "已经有一样的经验了")
    return e


@router.put("/memory/{mid}")
async def memory_edit(mid: str, request: Request, data: dict = Body(...)):
    tenant, name, admin = _memory_ctx(request)
    _need_admin(admin)
    try:
        return memory.update(tenant, mid, data.get("text"), name)
    except memory.MemoryError as err:
        raise HTTPException(404 if "不存在" in str(err) else 400, str(err))


@router.delete("/memory/{mid}")
async def memory_delete(mid: str, request: Request):
    tenant, _, admin = _memory_ctx(request)
    _need_admin(admin)
    try:
        memory.remove(tenant, mid)
    except memory.MemoryError as err:
        raise HTTPException(404, str(err))
    return {"ok": True}


@router.get("/events")
async def events(request: Request):
    owner = _auth(request)
    q = bus.subscribe()

    def visible(evt: dict[str, Any]) -> dict[str, Any] | None:
        t = evt.get("type")
        if t in ("delta", "tool", "turn", "message"):
            sid = evt.get("sid")
            try:
                _own(sid, owner)
            except HTTPException:
                return None
            if t == "message":
                pm = _public_message(evt.get("message") or {})
                return {"type": "message", "sid": sid, "message": pm} if pm else None
            if t == "tool":
                return {"type": "tool", "sid": sid, "phase": evt.get("phase"), "name": evt.get("name"),
                        "call_id": evt.get("call_id")}
            return {k: v for k, v in evt.items() if k != "bot"}
        if t == "pending":
            return {"type": "pending", "items": _pending_for(_owned_sids(owner))}
        if t == "mes_memory":
            return {"type": "mes_memory"} if evt.get("tenant") == owner.split(":")[0] else None
        if t == "session_meta":
            sess = evt.get("session") or {}
            try:
                _own(sess.get("id"), owner)
            except HTTPException:
                return None
            return {"type": "session_meta", "session": sess}
        return None

    async def gen():
        try:
            yield "data: " + json.dumps({"type": "hello"}) + "\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    item = await asyncio.wait_for(q.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                try:
                    out = visible(json.loads(item))
                except (ValueError, TypeError):
                    out = None
                if out:
                    yield "data: " + json.dumps(out, ensure_ascii=False, default=str) + "\n\n"
        finally:
            bus.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream; charset=utf-8",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
