"""HTTP API + SSE event stream + static frontend."""
from __future__ import annotations

import asyncio
import json
import os
import mimetypes
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import bots, cron, groups, llm, mcp, sessions, settings, tools
from .agent import runtime
from .events import bus
from .mes import gateway as mes_gateway
from .storage import ROOT, UPLOADS_DIR, new_id

FRONTEND = ROOT / "frontend" / "dist"
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("image/svg+xml", ".svg")


# SBOT_MES_ONLY=1 (use this on servers): only the MES gateway is served. The
# normal SEDRIC Bots UI/API — which can run terminal commands, write files and
# start MCP processes — is switched off, and scheduled jobs never run.
MES_ONLY = os.environ.get("SBOT_MES_ONLY", "").strip() in ("1", "true", "yes")


@asynccontextmanager
async def lifespan(app: FastAPI):
    tools.load_all()
    bots.ensure_default()
    mes_gateway.ensure_bot()
    sessions.rebuild_index()
    cron.set_runtime(runtime)
    groups.set_runtime(runtime)
    task = None if MES_ONLY else asyncio.create_task(cron.scheduler_loop())
    yield
    if task:
        task.cancel()
    mcp.shutdown()


app = FastAPI(title="SEDRIC Bots", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.include_router(mes_gateway.router)

ALLOWED_HOSTS = {"127.0.0.1", "localhost", "[::1]", *[h.strip() for h in os.environ.get("HB_ALLOWED_HOSTS", "").split(",") if h.strip()]}


@app.middleware("http")
async def host_guard(request: Request, call_next):
    # Blocks DNS-rebinding: a web page on another origin cannot reach this
    # local API through a hostname it controls.
    host = (request.headers.get("host") or "").rsplit(":", 1)[0].lower()
    if host and host not in ALLOWED_HOSTS and not host.endswith(".localhost"):
        return JSONResponse({"error": "host not allowed"}, status_code=403)
    if MES_ONLY and not request.url.path.startswith("/mes-gw/"):
        return JSONResponse({"error": "not found"}, status_code=404)
    return await call_next(request)


@app.exception_handler(bots.BotError)
@app.exception_handler(groups.GroupError)
@app.exception_handler(cron.CronError)
async def _user_error(_: Request, exc: Exception):
    return JSONResponse({"error": str(exc)}, status_code=400)


def _404(what: str = "不存在"):
    raise HTTPException(404, what)


# ── state & events ───────────────────────────────────────────────────────────


def roster_row(name: str) -> dict[str, Any] | None:
    p = bots.load(name)
    if p is None:
        return None
    chat = sessions.canonical(name, create_missing=False)
    jobs = cron.list_jobs(name)
    return {**p, "status": runtime.bot_status(name), "chat": sessions.preview(chat) if chat else None,
            "routines": sum(1 for j in jobs if j.get("enabled"))}


@app.get("/api/state")
async def state():
    return {
        "settings": settings.public(),
        "bots": [r for n in bots.names() if (r := roster_row(n))],
        "groups": [groups.summary(g) for g in groups.all_rooms()],
        "ui": bots.ui_state(),
        "pending": runtime.pending_list(),
        "tool_labels": bots.TOOL_LABELS,
    }


@app.get("/api/events")
async def events(request: Request):
    q = bus.subscribe()

    async def gen():
        try:
            yield "data: " + json.dumps({"type": "hello"}) + "\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    item = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {item}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            bus.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream; charset=utf-8",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── settings & providers ─────────────────────────────────────────────────────


@app.get("/api/settings")
async def get_settings():
    return settings.public()


@app.put("/api/settings")
async def put_settings(data: dict = Body(...)):
    settings.save(data)
    pub = settings.public()
    bus.publish("settings", settings=pub)
    return pub


@app.post("/api/providers/models")
async def provider_models(data: dict = Body(...)):
    prov = dict(data)
    stored = settings.get_provider(prov.get("id")) if prov.get("id") else None
    if prov.get("api_key") in (None, "", "__keep__") and stored:
        prov["api_key"] = stored.get("api_key", "")
    prov.setdefault("id", "tmp")
    prov["base_url"] = (prov.get("base_url") or "").rstrip("/")
    try:
        return {"ok": True, "models": await llm.list_models(prov)}
    except llm.LLMError as e:
        return {"ok": False, "error": e.message}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


# ── bots ─────────────────────────────────────────────────────────────────────


def _publish_bot(name: str) -> None:
    row = roster_row(name)
    if row:
        bus.publish("bot", bot=row)


@app.get("/api/bots")
async def list_bots():
    return [r for n in bots.names() if (r := roster_row(n))]


@app.post("/api/bots")
async def create_bot(data: dict = Body(...)):
    prof = bots.create(data)
    chat = sessions.canonical(prof["name"])
    _publish_bot(prof["name"])
    if data.get("kickoff", True):
        runtime.submit(prof["name"], chat["id"], "你好，介绍一下你自己吧！")
    return roster_row(prof["name"])


@app.get("/api/bots/{name}")
async def bot_detail(name: str):
    row = roster_row(name)
    if not row:
        _404("机器人不存在")
    return {
        **row,
        "soul": bots.get_soul(name),
        "memory": {"memory": bots.memory_entries(name, "memory"), "user": bots.memory_entries(name, "user"),
                   "limits": {"memory": bots.MEMORY_LIMIT, "user": bots.USER_LIMIT}},
        "skills": bots.list_skills(name),
        "sessions": [sessions.preview(s) for s in sessions.list_for(name)],
        "workspace": str(bots.bot_dir(name) / "workspace"),
        "groups": [g["id"] for g in groups.all_rooms() if name in g["members"]],
    }


@app.patch("/api/bots/{name}")
async def patch_bot(name: str, data: dict = Body(...)):
    bots.update(name, data)
    _publish_bot(name)
    return roster_row(name)


@app.post("/api/bots/{name}/rename")
async def rename_bot(name: str, data: dict = Body(...)):
    if runtime.bot_status(name)["running"]:
        raise bots.BotError("机器人正在工作，等它停下再改名。")
    new = data.get("name", "")
    prof = bots.rename(name, new)
    sessions.rebuild_index()
    groups.on_bot_renamed(name, prof["name"])
    cron.rename_bot(name, prof["name"])
    bus.publish("bot_removed", bot=name)
    _publish_bot(prof["name"])
    return roster_row(prof["name"])


@app.delete("/api/bots/{name}")
async def delete_bot(name: str):
    for s in sessions.list_for(name, include_hidden=True):
        runtime.interrupt(s["id"])
    groups.on_bot_deleted(name)
    sessions.drop_bot(name)
    bots.delete(name)
    bus.publish("bot_removed", bot=name)
    return {"ok": True}


@app.post("/api/bots/{name}/duplicate")
async def duplicate_bot(name: str):
    prof = bots.duplicate(name)
    sessions.canonical(prof["name"])
    _publish_bot(prof["name"])
    return roster_row(prof["name"])


@app.put("/api/bots/{name}/soul")
async def put_soul(name: str, data: dict = Body(...)):
    if not bots.exists(name):
        _404()
    bots.set_soul(name, data.get("soul", ""))
    return {"ok": True}


@app.put("/api/bots/{name}/memory")
async def put_memory(name: str, data: dict = Body(...)):
    if not bots.exists(name):
        _404()
    for t in ("memory", "user"):
        if t in data:
            bots.set_memory_entries(name, t, list(data[t]))
    return {"ok": True}


@app.post("/api/soul/generate")
async def generate_soul(data: dict = Body(...)):
    name = data.get("name") or "bot"
    title, desc, help_ = data.get("title", ""), data.get("description", ""), data.get("help_prompt", "")
    base = bots.compose_soul(name, title, desc, help_)
    provider, model = settings.resolve_model(data.get("model"))
    if not provider or provider["id"] == "mock":
        return {"soul": base}
    instr = ("你是一个擅长写 AI 角色设定的助手。根据给出的名字、显示名称、描述和用户需求，写一份 SOUL.md（中文 Markdown）："
             "包含一级标题、身份与使命、职责范围、工作方式、说话风格、边界。300-600 字。只输出 SOUL.md 正文。")
    try:
        res = await llm.chat(provider, model, [{"role": "system", "content": instr},
                                               {"role": "user", "content": f"名字：{name}\n显示名称：{title}\n描述：{desc}\n用户希望它帮忙：{help_}"}])
        text = re.sub(r"^```(?:markdown|md)?\s*|\s*```$", "", res.content.strip())
        return {"soul": text or base}
    except llm.LLMError as e:
        return {"soul": base, "error": e.message}


# skills


@app.get("/api/skills/bundled")
async def bundled():
    return bots.bundled_skills()


@app.put("/api/bots/{name}/skills/{sid}")
async def put_skill(name: str, sid: str, data: dict = Body(...)):
    s = bots.put_skill(name, sid, data.get("name") or sid, data.get("description", ""), data.get("body", ""))
    return s


@app.get("/api/bots/{name}/skills/{sid}")
async def get_skill(name: str, sid: str):
    s = bots.get_skill(name, sid)
    if not s:
        _404()
    return s


@app.delete("/api/bots/{name}/skills/{sid}")
async def del_skill(name: str, sid: str):
    return {"ok": bots.delete_skill(name, sid)}


@app.post("/api/bots/{name}/skills/install")
async def install_skills(name: str, data: dict = Body(...)):
    src = data.get("from_bot")
    for sid in data.get("ids", []):
        if src:
            s = bots.get_skill(src, sid)
            if s:
                bots.put_skill(name, sid, s["name"], s["description"], s["body"])
        else:
            bots.install_bundled(name, [sid])
    return bots.list_skills(name)


# MCP


@app.post("/api/bots/{name}/mcp/test")
async def mcp_test(name: str, data: dict = Body(...)):
    return await mcp.test_server(name, data, str(bots.bot_dir(name) / "workspace"))


# ── sessions ─────────────────────────────────────────────────────────────────


@app.post("/api/bots/{name}/botchat")
async def open_botchat(name: str):
    if not bots.exists(name):
        _404("机器人不存在")
    s = sessions.canonical(name)
    return {**sessions.public(s), **runtime.session_state(s["id"])}


@app.get("/api/bots/{name}/sessions")
async def bot_sessions(name: str):
    return [sessions.preview(s) for s in sessions.list_for(name)]


@app.post("/api/bots/{name}/sessions")
async def new_session(name: str, data: dict = Body(default={})):
    if not bots.exists(name):
        _404()
    s = sessions.create(name, data.get("title") or "新聊天")
    bus.publish("session_meta", bot=name, session=sessions.preview(s))
    return sessions.public(s)


@app.get("/api/sessions/{sid}")
async def get_session(sid: str):
    s = sessions.get(sid)
    if not s:
        _404("会话不存在")
    return {**sessions.public(s), **runtime.session_state(sid)}


@app.patch("/api/sessions/{sid}")
async def patch_session(sid: str, data: dict = Body(...)):
    s = sessions.get(sid)
    if not s:
        _404()
    if data.get("title") and s.get("kind") != "botchat":
        s["title"] = data["title"][:80]
    sessions.save(s)
    bus.publish("session_meta", bot=s["bot"], session=sessions.preview(s))
    return sessions.preview(s)


@app.delete("/api/sessions/{sid}")
async def delete_session(sid: str):
    s = sessions.get(sid)
    if not s:
        _404()
    if s.get("kind") == "botchat":
        raise bots.BotError("Bot Chat 不能删除。")
    runtime.interrupt(sid)
    bot = s["bot"]
    sessions.delete(sid)
    bus.publish("session_deleted", bot=bot, sid=sid)
    return {"ok": True}


@app.post("/api/sessions/{sid}/messages")
async def send_message(sid: str, data: dict = Body(...)):
    s = sessions.get(sid)
    if not s:
        _404("会话不存在")
    text = (data.get("text") or "").strip()
    atts = data.get("attachments") or []
    if not text and not atts:
        raise bots.BotError("消息不能为空")
    if text == "/compress":
        return await runtime.compress(s["bot"], sid)
    if text == "/stop":
        runtime.interrupt(sid)
        return {"ok": True}
    runtime.submit(s["bot"], sid, text, atts, {"from": {"kind": "user", "name": settings.load().get("user_name")}})
    if s.get("title") == "新聊天" and s.get("kind") == "chat":
        s["title"] = text[:30] or "新聊天"
        sessions.save(s)
    return {"ok": True, **runtime.session_state(sid)}


@app.post("/api/sessions/{sid}/interrupt")
async def interrupt(sid: str):
    runtime.interrupt(sid)
    return {"ok": True}


@app.post("/api/sessions/{sid}/compress")
async def compress_session(sid: str):
    s = sessions.get(sid)
    if not s:
        _404()
    return await runtime.compress(s["bot"], sid)


@app.post("/api/sessions/{sid}/read")
async def read_session(sid: str):
    s = sessions.get(sid)
    if s:
        from .storage import now_ms
        s["last_read"] = now_ms()
        sessions.save(s)
        bus.publish("session_meta", bot=s["bot"], session=sessions.preview(s))
    return {"ok": True}


# ── pending approvals / clarify ──────────────────────────────────────────────


@app.post("/api/pending/{pid}")
async def resolve_pending(pid: str, data: dict = Body(...)):
    value = data.get("answer") if "answer" in data else bool(data.get("approve"))
    if not runtime.resolve_pending(pid, value):
        _404("这个请求已经处理过了")
    return {"ok": True}


# ── groups ───────────────────────────────────────────────────────────────────


@app.get("/api/groups")
async def list_groups():
    return [groups.summary(g) for g in groups.all_rooms()]


@app.post("/api/groups")
async def create_group(data: dict = Body(...)):
    room = groups.create(data.get("name", ""), data.get("members") or [], data.get("image"))
    return groups.public(room)


@app.get("/api/groups/{gid}")
async def get_group(gid: str):
    room = groups.load(gid)
    if not room:
        _404("群聊不存在")
    return groups.public(room)


@app.patch("/api/groups/{gid}")
async def patch_group(gid: str, data: dict = Body(...)):
    return groups.public(groups.update(gid, data))


@app.delete("/api/groups/{gid}")
async def delete_group(gid: str):
    groups.delete(gid)
    return {"ok": True}


@app.post("/api/groups/{gid}/messages")
async def group_send(gid: str, data: dict = Body(...)):
    return groups.send(gid, data.get("text", ""), data.get("thread"), data.get("attachments"),
                       settings.load().get("user_name") or "你")


@app.post("/api/groups/{gid}/stop")
async def group_stop(gid: str, data: dict = Body(default={})):
    groups.stop(gid, data.get("thread"))
    return {"ok": True}


@app.post("/api/groups/{gid}/read")
async def group_read(gid: str):
    groups.mark_read(gid)
    return {"ok": True}


@app.post("/api/groups/{gid}/compress")
async def group_compress(gid: str):
    return await groups.compress(gid)


# ── routines ─────────────────────────────────────────────────────────────────


def _jobs_public(bot: str):
    return [{**j, "running": cron.is_running(bot, j["id"])} for j in cron.list_jobs(bot)]


@app.get("/api/bots/{name}/cron")
async def list_cron(name: str):
    return _jobs_public(name)


@app.post("/api/bots/{name}/cron")
async def create_cron(name: str, data: dict = Body(...)):
    cron.create_job(name, data)
    return _jobs_public(name)


@app.patch("/api/bots/{name}/cron/{jid}")
async def patch_cron(name: str, jid: str, data: dict = Body(...)):
    cron.update_job(name, jid, data)
    return _jobs_public(name)


@app.delete("/api/bots/{name}/cron/{jid}")
async def delete_cron(name: str, jid: str):
    cron.delete_job(name, jid)
    return _jobs_public(name)


@app.post("/api/bots/{name}/cron/{jid}/run")
async def run_cron(name: str, jid: str):
    cron.trigger(name, jid)
    return {"ok": True}


@app.post("/api/cron/parse")
async def parse_cron(data: dict = Body(...)):
    try:
        sch = cron.parse_schedule(data.get("schedule", ""))
        nxt = cron.next_run({"schedule": sch, "runs": 0, "created": None})
        return {"ok": True, "schedule": sch, "next_run": nxt}
    except cron.CronError as e:
        return {"ok": False, "error": str(e)}


# ── roster UI state ──────────────────────────────────────────────────────────


@app.put("/api/ui")
async def put_ui(data: dict = Body(...)):
    st = bots.save_ui_state(data)
    bus.publish("ui", ui=st)
    return st


# ── uploads ──────────────────────────────────────────────────────────────────

TEXT_EXT = {".txt", ".md", ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".csv", ".yaml", ".yml", ".toml", ".ini",
            ".html", ".css", ".java", ".c", ".cpp", ".h", ".go", ".rs", ".sh", ".ps1", ".bat", ".sql", ".log", ".xml"}


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    raw = await file.read()
    if len(raw) > 25 * 1024 * 1024:
        raise bots.BotError("文件过大（最大 25MB）")
    safe = re.sub(r"[^\w.\-一-鿿]", "_", file.filename or "file")[-80:]
    safe = re.sub(r"\.{2,}", ".", safe).strip(".") or "file"
    fname = f"{new_id('u')}_{safe}"
    (UPLOADS_DIR / fname).write_bytes(raw)
    mime = file.content_type or mimetypes.guess_type(safe)[0] or "application/octet-stream"
    ext = Path(safe).suffix.lower()
    kind = "image" if mime.startswith("image/") else "pdf" if ext == ".pdf" else "file"
    text = None
    if kind == "file" and (ext in TEXT_EXT or mime.startswith("text/")):
        text = raw[:400_000].decode("utf-8", "replace")
    elif kind == "pdf":
        try:
            import io

            from pypdf import PdfReader  # optional dependency
            text = "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(raw)).pages[:80])[:400_000]
        except Exception:  # noqa: BLE001
            text = None
    return {"kind": kind, "name": file.filename, "file": fname, "url": f"/uploads/{fname}", "mime": mime,
            "size": len(raw), "text": text}


app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")


# ── frontend ─────────────────────────────────────────────────────────────────


CACHE_IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable"}
CACHE_REVALIDATE = {"Cache-Control": "no-cache"}
CACHE_NONE = {"Cache-Control": "no-store, must-revalidate"}


@app.get("/{path:path}")
async def spa(path: str):
    if path == "api" or path.startswith("api/"):
        _404()
    target = (FRONTEND / path).resolve()
    if path and target.is_file() and FRONTEND.resolve() in target.parents:
        # Vite's hashed bundles never change → cache forever; everything else
        # (icons, manifest) must be revalidated so updates show up.
        immutable = path.startswith("assets/")
        return FileResponse(target, headers=CACHE_IMMUTABLE if immutable else CACHE_REVALIDATE)
    index = FRONTEND / "index.html"
    if index.exists():
        # Never serve a stale shell: it would point at old bundles after an update.
        return FileResponse(index, headers=CACHE_NONE)
    return JSONResponse({"error": "前端还没有构建。请在 frontend 目录运行 npm install && npm run build。"}, status_code=503)
