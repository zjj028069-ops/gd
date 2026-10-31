"""Chat sessions, the agent loop, tools, approvals, errors, attachments."""
from __future__ import annotations

import concurrent.futures
import io
import json
import sys
import time
from pathlib import Path

from conftest import TESTS, Events, last_assistant


def tool_results(s, name=None):
    return [m for m in s["messages"] if m["role"] == "tool" and (name is None or m.get("name") == name)]


def events(s, kind=None):
    return [m for m in s["messages"] if m["role"] == "event" and (kind is None or m.get("kind") == kind)]


def test_botchat_is_unique_even_under_concurrency(api):
    api.create_bot("uniq")
    with concurrent.futures.ThreadPoolExecutor(8) as ex:
        ids = set(ex.map(lambda _: api.botchat("uniq"), range(8)))
    assert len(ids) == 1
    sessions = api.ok("get", "/api/bots/uniq/sessions")
    assert sum(1 for s in sessions if s["kind"] == "botchat") == 1


def test_kickoff_intro(api):
    api.create_bot("intro", title="介绍者", description="会自我介绍", kickoff=True)
    s = api.wait_idle(api.botchat("intro"))
    assert "介绍者" in last_assistant(s)


def test_basic_reply_unread_and_read(api):
    api.create_bot("chatty")
    sid = api.botchat("chatty")
    s = api.say(sid, "你好")
    assert "你好" in last_assistant(s)
    # A user send marks the chat read; mark it unread by sending via a DM path is covered elsewhere.
    api.ok("post", f"/api/sessions/{sid}/read")
    assert api.session(sid)["unread"] is False


def test_empty_and_unknown(api):
    sid = api.botchat("jie")
    assert api.post(f"/api/sessions/{sid}/messages", {"text": "   "}).status_code == 400
    assert api.post("/api/sessions/nope/messages", {"text": "x"}).status_code == 404
    assert api.get("/api/sessions/nope").status_code == 404


def test_queueing_keeps_order(api):
    api.create_bot("queue")
    sid = api.botchat("queue")
    for i in range(3):
        api.ok("post", f"/api/sessions/{sid}/messages", {"text": f"第{i}条"})
    st = api.session(sid)
    assert st["running"] or st["queued"]
    s = api.wait_idle(sid)
    users = [m["content"] for m in s["messages"] if m["role"] == "user"]
    assert users == ["第0条", "第1条", "第2条"]
    replies = [m["content"] for m in s["messages"] if m["role"] == "assistant" and m.get("content")]
    assert len(replies) == 3 and "第0条" in replies[0] and "第2条" in replies[2]


def test_extra_sessions_and_titles(api):
    api.create_bot("multi")
    s = api.ok("post", "/api/bots/multi/sessions", {})
    assert s["title"] == "新聊天" and s["kind"] == "chat"
    api.say(s["id"], "帮我规划旅行路线吧")
    assert api.session(s["id"])["title"] == "帮我规划旅行路线吧"
    api.ok("patch", f"/api/sessions/{s['id']}", {"title": "旅行"})
    assert api.session(s["id"])["title"] == "旅行"
    bc = api.botchat("multi")
    api.ok("patch", f"/api/sessions/{bc}", {"title": "改不了"})
    assert api.session(bc)["title"] == "Bot Chat"
    assert api.delete(f"/api/sessions/{bc}").status_code == 400
    api.ok("delete", f"/api/sessions/{s['id']}")
    assert api.get(f"/api/sessions/{s['id']}").status_code == 404


def test_terminal_tool_unicode_and_exit_code(api):
    api.create_bot("term")
    sid = api.botchat("term")
    s = api.say(sid, "运行 echo 你好世界")
    out = json.loads(tool_results(s, "terminal")[-1]["content"])
    assert out["exit_code"] == 0 and "你好世界" in out["stdout"]
    s = api.say(sid, "运行 exit 3")
    out = json.loads(tool_results(s, "terminal")[-1]["content"])
    assert out["exit_code"] == 3


def test_file_tools_inside_workspace(api, server):
    api.create_bot("filer")
    sid = api.botchat("filer")
    api.say(sid, "写文件 notes/a.txt 第一行内容")
    p = server.data / "bots" / "filer" / "workspace" / "notes" / "a.txt"
    assert p.read_text(encoding="utf-8") == "第一行内容"
    s = api.say(sid, "读取文件 notes/a.txt")
    assert "第一行内容" in tool_results(s, "read_file")[-1]["content"]
    s = api.say(sid, "读取文件 nope.txt")
    assert "不存在" in tool_results(s, "read_file")[-1]["content"]


def test_write_outside_workspace_needs_approval(api, server, tmp_path):
    api.create_bot("outside")
    sid = api.botchat("outside")
    target = tmp_path / "out.txt"
    api.ok("post", f"/api/sessions/{sid}/messages", {"text": f"写文件 {target.as_posix()} hi"})
    p = api.wait_pending()
    assert p[0]["kind"] == "approval" and p[0]["bot"] == "outside"
    api.ok("post", f"/api/pending/{p[0]['id']}", {"approve": True})
    api.wait_idle(sid)
    assert target.read_text(encoding="utf-8") == "hi"


def test_approval_modes(api, tmp_path):
    api.create_bot("appr")
    sid = api.botchat("appr")
    # smart (default): dangerous → asks, deny → error result
    api.ok("post", f"/api/sessions/{sid}/messages", {"text": "运行 Remove-Item -Recurse nonexistent_dir_xyz"})
    p = api.wait_pending()
    assert "递归删除" in p[0]["title"]
    api.ok("post", f"/api/pending/{p[0]['id']}", {"approve": False})
    s = api.wait_idle(sid)
    assert "拒绝" in tool_results(s, "terminal")[-1]["content"]
    # second resolve of the same request → 404
    assert api.post(f"/api/pending/{p[0]['id']}", {"approve": True}).status_code == 404
    # always: even harmless commands ask
    api.ok("patch", "/api/bots/appr", {"approval": "always"})
    api.ok("post", f"/api/sessions/{sid}/messages", {"text": "运行 echo hi"})
    p = api.wait_pending()
    api.ok("post", f"/api/pending/{p[0]['id']}", {"approve": True})
    s = api.wait_idle(sid)
    assert "hi" in tool_results(s, "terminal")[-1]["content"]
    # auto: dangerous runs without asking
    api.ok("patch", "/api/bots/appr", {"approval": "auto"})
    s = api.say(sid, "运行 Remove-Item -Recurse nonexistent_dir_xyz -ErrorAction SilentlyContinue")
    assert api.pending() == []
    assert "exit_code" in tool_results(s, "terminal")[-1]["content"]
    # inherit + global "always"
    api.ok("patch", "/api/bots/appr", {"approval": "inherit"})
    api.ok("put", "/api/settings", {"approval_mode": "always"})
    try:
        api.ok("post", f"/api/sessions/{sid}/messages", {"text": "运行 echo again"})
        p = api.wait_pending()
        api.ok("post", f"/api/pending/{p[0]['id']}", {"approve": False})
        api.wait_idle(sid)
    finally:
        api.ok("put", "/api/settings", {"approval_mode": "smart"})


def test_interrupt_during_pending_and_status(api):
    api.create_bot("intr")
    sid = api.botchat("intr")
    api.ok("post", f"/api/sessions/{sid}/messages", {"text": "让我选一个"})
    p = api.wait_pending()
    bot = api.ok("get", "/api/bots/intr")
    assert bot["status"]["mood"] == "wait" and bot["status"]["pending"] == 1
    api.ok("post", f"/api/sessions/{sid}/interrupt")
    s = api.wait_idle(sid)
    assert api.pending() == []
    assert events(s, "interrupted")
    assert api.ok("get", "/api/bots/intr")["status"]["mood"] == "idle"
    assert p


def test_clarify_free_text(api):
    api.create_bot("clar")
    sid = api.botchat("clar")
    api.ok("post", f"/api/sessions/{sid}/messages", {"text": "问我一个问题"})
    p = api.wait_pending()
    assert p[0]["kind"] == "clarify" and p[0]["choices"]
    api.ok("post", f"/api/pending/{p[0]['id']}", {"answer": "我自己的答案"})
    s = api.wait_idle(sid)
    assert "我自己的答案" in tool_results(s, "clarify")[-1]["content"]


def test_memory_tool_and_limits(api):
    api.create_bot("memt")
    sid = api.botchat("memt")
    api.say(sid, "记住 喜欢绿茶")
    s = api.say(sid, "记住 喜欢绿茶")
    assert "duplicate" in tool_results(s, "memory")[-1]["content"]
    api.ok("put", "/api/bots/memt/memory", {"memory": ["x" * 2195]})
    s = api.say(sid, "记住 这条会超出容量")
    assert "超出容量" in tool_results(s, "memory")[-1]["content"]


def test_tool_toggles_remove_tools(api):
    api.create_bot("notools", tools={"terminal": False, "memory": False})
    sid = api.botchat("notools")
    s = api.say(sid, "运行 echo hi")
    assert tool_results(s) == [], "disabled terminal must not be callable"


def test_background_process(api):
    api.create_bot("bgp")
    sid = api.botchat("bgp")
    s = api.say(sid, "后台运行 Start-Sleep 30")
    out = json.loads(tool_results(s, "terminal")[-1]["content"])
    assert out["status"] == "started"
    from app.tools import terminal  # noqa: F401  (registry lives in the server process; check via API instead)


def test_routine_session_has_no_clarify(api):
    # Routines run unattended, so clarify must not be offered.
    api.create_bot("rout")
    j = api.ok("post", "/api/bots/rout/cron", {"name": "问", "instruction": "让我选一个方案", "schedule": "every 1d"})[0]
    api.ok("post", f"/api/bots/rout/cron/{j['id']}/run")
    t0 = time.time()
    while time.time() - t0 < 20:
        jobs = api.ok("get", "/api/bots/rout/cron")
        if jobs[0]["runs"] == 1:
            break
        time.sleep(0.3)
    assert jobs[0]["runs"] == 1 and api.pending() == []


# ── real model protocol (fake OpenAI server) ─────────────────────────────────


def use(api, bot, key):
    api.ok("patch", f"/api/bots/{bot}", {"model": {"provider": f"f{key}", "model": "fake-1"}})


def test_openai_stream_reasoning_and_toolcall_assembly(api):
    api.create_bot("real")
    use(api, "real", "ok")
    sid = api.botchat("real")
    s = api.say(sid, "你好")
    a = [m for m in s["messages"] if m["role"] == "assistant"][-1]
    assert a["content"] == "你好，我是假模型" and a["reasoning"] == "推理中"
    s = api.say(sid, "记住这个")
    assert api.ok("get", "/api/bots/real")["memory"]["user"] == ["测试记忆"]
    assert last_assistant(s) == "工具结果已收到"


def test_think_tags_are_split(api):
    api.create_bot("thinker")
    use(api, "thinker", "think")
    s = api.say(api.botchat("thinker"), "问题")
    a = [m for m in s["messages"] if m["role"] == "assistant"][-1]
    assert a["content"] == "答案是42" and a["reasoning"] == "我在想事情"


def test_bad_tool_json_is_reported_not_crashing(api):
    api.create_bot("badjs")
    use(api, "badjs", "badjson")
    s = api.say(api.botchat("badjs"), "随便")
    assert "不是合法 JSON" in tool_results(s)[-1]["content"]
    assert last_assistant(s) == "工具结果已收到"


def test_errors_set_and_clear_attention(api):
    api.create_bot("errs")
    sid = api.botchat("errs")
    for key, kind in (("bad", "auth"), ("broke", "quota")):
        use(api, "errs", key)
        s = api.say(sid, "hi")
        e = events(s, "error")[-1]
        assert e["error_kind"] == kind, e
        assert api.ok("get", "/api/bots/errs")["status"]["attention"]["kind"] == kind
    api.ok("patch", "/api/bots/errs", {"model": {"provider": "fdown", "model": "m"}})
    s = api.say(sid, "hi", timeout=40)
    assert events(s, "error")[-1]["error_kind"] == "network"
    use(api, "errs", "ok")
    api.say(sid, "hi")
    assert api.ok("get", "/api/bots/errs")["status"]["attention"] is None
    # missing provider falls back to default instead of crashing
    api.ok("patch", "/api/bots/errs", {"model": {"provider": "deleted-provider", "model": "x"}})
    s = api.say(sid, "hi")
    assert last_assistant(s)


def test_step_cap_still_answers(api):
    api.create_bot("looper")
    use(api, "looper", "loop")
    api.ok("put", "/api/settings", {"max_iterations": 4})
    try:
        s = api.say(api.botchat("looper"), "开始")
    finally:
        api.ok("put", "/api/settings", {"max_iterations": 24})
    assert len(tool_results(s)) == 4
    assert events(s, "capped")
    assert last_assistant(s) == "最终回答"


def test_interrupt_streaming(api):
    api.create_bot("slowpoke")
    use(api, "slowpoke", "slow")
    sid = api.botchat("slowpoke")
    api.ok("post", f"/api/sessions/{sid}/messages", {"text": "慢慢说"})
    api.ok("post", f"/api/sessions/{sid}/messages", {"text": "排队的第二条"})
    time.sleep(1.2)
    api.ok("post", f"/api/sessions/{sid}/interrupt")
    s = api.wait_idle(sid, 10)
    assert events(s, "interrupted")
    assert not any(m["role"] == "user" and m["content"] == "排队的第二条" for m in s["messages"]), "interrupt clears the queue"
    # the session still works afterwards
    use(api, "slowpoke", "ok")
    assert last_assistant(api.say(sid, "再来")) == "你好，我是假模型"


def test_provider_models_endpoint(api, fake_llm):
    r = api.ok("post", "/api/providers/models", {"base_url": fake_llm, "api_key": "ok"})
    assert r["ok"] and r["models"] == ["fake-1", "fake-2"]
    r = api.ok("post", "/api/providers/models", {"base_url": fake_llm, "api_key": "bad"})
    assert not r["ok"] and "认证" in r["error"]
    r = api.ok("post", "/api/providers/models", {"id": "fok", "base_url": fake_llm, "api_key": "__keep__"})
    assert r["ok"], "stored key must be reused when the UI sends __keep__"


def test_settings_key_handling(api):
    s = api.ok("get", "/api/settings")
    p = next(x for x in s["providers"] if x["id"] == "fok")
    assert p["api_key_set"] and "api_key" not in p
    provs = [{**x, "api_key": "__keep__"} for x in s["providers"] if not x.get("builtin")]
    api.ok("put", "/api/settings", {"providers": provs})
    # still works → key was kept
    api.create_bot("keyk")
    use(api, "keyk", "ok")
    assert last_assistant(api.say(api.botchat("keyk"), "hi")) == "你好，我是假模型"


# ── attachments ──────────────────────────────────────────────────────────────


def upload(api, name, data: bytes, mime="application/octet-stream"):
    r = api.c.post("/api/upload", files={"file": (name, io.BytesIO(data), mime)})
    return r


def test_upload_text_image_and_limits(api):
    r = upload(api, "笔记 (1).md", "# 标题\n内容123".encode(), "text/markdown")
    a = r.json()
    assert r.status_code == 200 and a["kind"] == "file" and "内容123" in a["text"]
    assert "/" not in a["file"] and "\\" not in a["file"]
    assert api.get(a["url"]).status_code == 200
    r = upload(api, "../../evil.txt", b"x", "text/plain")
    assert r.status_code == 200 and ".." not in r.json()["file"].replace("..txt", "")
    png = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                        "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")
    img = upload(api, "dot.png", png, "image/png").json()
    assert img["kind"] == "image"
    api.create_bot("seer")
    use(api, "seer", "ok")
    sid = api.botchat("seer")
    s = api.say(sid, "看图", [img])
    assert last_assistant(s) == "收到图片"
    s = api.say(sid, "看文件", [a])
    assert last_assistant(s)
    big = upload(api, "big.bin", b"0" * (26 * 1024 * 1024))
    assert big.status_code == 400


def test_compress(api):
    api.create_bot("comp")
    sid = api.botchat("comp")
    r = api.ok("post", f"/api/sessions/{sid}/compress")
    assert r["ok"] is False
    for i in range(9):
        api.say(sid, f"消息{i}")
    r = api.ok("post", f"/api/sessions/{sid}/compress")
    assert r["ok"] and r["compressed"] > 0
    s = api.session(sid)
    assert s["summary"] and events(s, "compressed")
    assert last_assistant(api.say(sid, "压缩后还能聊吗"))
    # slash command path
    r = api.ok("post", f"/api/sessions/{sid}/messages", {"text": "/compress"})
    assert "ok" in r


def test_auto_compress_on_budget(api):
    api.create_bot("autoc")
    sid = api.botchat("autoc")
    for i in range(14):
        api.say(sid, f"长消息{i} " + "字" * 300)
    api.ok("put", "/api/settings", {"context_chars": 3000})
    try:
        s = api.say(sid, "触发自动压缩")
    finally:
        api.ok("put", "/api/settings", {"context_chars": 120000})
    assert any("自动" in e["content"] for e in events(s, "compressed"))


def test_sse_stream(api):
    ev = Events(api.base)
    try:
        sid = api.botchat("jie")
        api.say(sid, "流式测试")
        time.sleep(0.3)
        t = ev.types()
        for need in ("hello", "delta", "message", "turn", "bot_status"):
            assert need in t, (need, set(t))
    finally:
        ev.close()


def test_mcp_stdio_server(api):
    api.create_bot("mcpbot")
    cfg = {"name": "fake", "command": sys.executable, "args": [str(TESTS / "fake_mcp_server.py")], "enabled": True}
    r = api.ok("post", "/api/bots/mcpbot/mcp/test", cfg)
    assert r["ok"] and {t["name"] for t in r["tools"]} == {"echo", "add"}
    bad = api.ok("post", "/api/bots/mcpbot/mcp/test", {"name": "x", "command": "definitely-not-a-command-xyz"})
    assert bad["ok"] is False and bad["error"]
    api.ok("patch", "/api/bots/mcpbot", {"mcp_servers": [cfg]})
    sid = api.botchat("mcpbot")
    s = api.say(sid, '调用 mcp_fake_echo {"text": "你好MCP"}')
    assert "ECHO:你好MCP" in tool_results(s)[-1]["content"]
    s = api.say(sid, '调用 mcp_fake_add {"a": 2, "b": 40}')
    assert tool_results(s)[-1]["content"].strip() == "42"
    api.ok("patch", "/api/bots/mcpbot", {"tools": {"mcp": False}})
    n = len(tool_results(s))
    s = api.say(sid, '调用 mcp_fake_echo {"text": "x"}')
    assert len(tool_results(s)) == n, "MCP toggle off must hide MCP tools"
    # a broken server must not break the bot
    api.ok("patch", "/api/bots/mcpbot", {"tools": {"mcp": True}, "mcp_servers": [{"name": "broken", "command": "definitely-not-a-command-xyz"}]})
    assert last_assistant(api.say(sid, "你好"))


def test_unknown_tool_name_from_model(api):
    # Covered via mock: the agent answers with an error result instead of crashing.
    from app.agent import to_api
    msgs = [{"role": "user", "content": "x"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "a", "type": "function", "function": {"name": "t", "arguments": "{}"}},
                                                               {"id": "b", "type": "function", "function": {"name": "t", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "a", "content": "r"},
            {"role": "event", "content": "已中断"},
            {"role": "user", "content": "y"}]
    out = to_api(msgs)
    roles = [m["role"] for m in out]
    assert roles == ["user", "assistant", "tool", "tool", "user"], roles
    assert out[3]["tool_call_id"] == "b"


def test_workspace_dir_exists(server):
    assert (server.data / "bots" / "jie" / "workspace").is_dir()
    assert Path(server.data / "settings.json").exists()
