"""Bot-to-bot DMs, group chats, routines, persistence across restarts."""
from __future__ import annotations

import asyncio
import json
import time

import pytest

from conftest import last_assistant


@pytest.fixture(scope="module", autouse=True)
def group_bots(api):
    """ga/gb/gc exist for every test here, so each test can also run alone."""
    for n, t in (("ga", "阿尔法"), ("gb", "贝塔"), ("gc", "伽马")):
        if api.get(f"/api/bots/{n}").status_code != 200:
            api.create_bot(n, title=t)


def wait_for(fn, timeout=30, every=0.25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return v
        time.sleep(every)
    raise AssertionError("condition not met in time")


# ── DMs ──────────────────────────────────────────────────────────────────────


def test_dm_roundtrip(api):
    api.create_bot("dma", title="甲")
    api.create_bot("dmb", title="乙")
    sa, sb = api.botchat("dma"), api.botchat("dmb")
    api.say(sa, "告诉 @dmb 下午三点开会")
    s = wait_for(lambda: (x := api.session(sa)) and any("回执" in (m.get("content") or "") for m in x["messages"]) and not x["running"] and x)
    b = api.wait_idle(sb)
    dm = [m for m in b["messages"] if m["role"] == "user" and m.get("from", {}).get("kind") == "bot"]
    assert dm and dm[0]["content"].startswith("Message from 🤖 甲 (@dma): 下午三点开会")
    assert "下午三点开会" in last_assistant(api.wait_idle(sa))
    # the target got an unread reply
    assert api.ok("get", "/api/bots/dmb")["chat"]["preview"]
    assert s


def test_dm_errors(api):
    api.create_bot("dmc")
    sid = api.botchat("dmc")
    s = api.say(sid, "告诉 @nobody 你好")
    assert "不存在" in [m for m in s["messages"] if m["role"] == "tool"][-1]["content"]
    s = api.say(sid, "告诉 @dmc 自己")
    assert "自己" in [m for m in s["messages"] if m["role"] == "tool"][-1]["content"]


def test_dm_by_title_and_depth_limit(server, api):
    # unit-level: run the tool directly inside this process against the same data dir
    from app.tools import ToolCtx, load_all, REGISTRY  # noqa: E402
    load_all()

    class RT:
        sent = []

        def dm_send(self, *a):
            self.sent.append(a)
            return "dm1"

    rt = RT()
    ctx = ToolCtx(bot="dma", profile={}, session={"id": "s", "kind": "botchat"}, meta={}, runtime=rt, cancel=asyncio.Event())
    out = json.loads(asyncio.run(REGISTRY["message_agent"].handler(ctx, {"target": "乙", "message": "hi"})))
    assert out["status"] == "queued" and rt.sent[-1][2] == "dmb"
    ctx.meta = {"dm_depth": 4}
    out = json.loads(asyncio.run(REGISTRY["message_agent"].handler(ctx, {"target": "dmb", "message": "hi"})))
    assert "太多手" in out["error"]
    out = json.loads(asyncio.run(REGISTRY["message_agent"].handler(ctx, {"target": "dmb", "message": "x" * 16001})))
    assert "过长" in out["error"]
    gctx = ToolCtx(bot="dma", profile={}, session={"id": "s", "kind": "group"}, meta={}, runtime=rt, cancel=asyncio.Event())
    assert REGISTRY["message_agent"].available(gctx) is False


def test_dm_to_bot_deleted_midflight(api):
    api.create_bot("dmd")
    api.create_bot("dme")
    api.ok("patch", "/api/bots/dme", {"model": {"provider": "fslow", "model": "fake-1"}})
    sid = api.botchat("dmd")
    api.say(sid, "告诉 @dme 你好")
    time.sleep(0.8)
    api.ok("delete", "/api/bots/dme")
    s = wait_for(lambda: (x := api.session(sid)) and any("回执" in (m.get("content") or "") for m in x["messages"]) and x, 20)
    assert s  # sender is told, no crash
    api.wait_idle(sid)


# ── groups ───────────────────────────────────────────────────────────────────


def entries(g, kind="member", thread="main"):
    return [e for e in g["log"] if e["from"]["kind"] == kind and (thread is None or e["thread"] == thread)]


def send(api, gid, text, thread=None):
    return api.post(f"/api/groups/{gid}/messages", {"text": text, "thread": thread})


def test_group_validation(api):
    assert api.post("/api/groups", {"name": "x", "members": []}).status_code == 400
    assert api.post("/api/groups", {"name": "x", "members": ["nobody"]}).status_code == 400
    g = api.ok("post", "/api/groups", {"name": "", "members": ["jie", "nobody", "jie"]})
    assert g["members"] == ["jie"] and g["name"] == "新群聊"
    assert send(api, g["id"], "").status_code == 400
    assert send(api, g["id"], "/help").status_code == 400
    assert send(api, g["id"], "hi", "e-not-a-thread").status_code == 400
    assert api.patch(f"/api/groups/{g['id']}", {"members": []}).status_code == 400


def test_group_round_and_pass(api):
    g = api.ok("post", "/api/groups", {"name": "三人组", "members": ["ga", "gb", "gc"]})
    send(api, g["id"], "大家好")
    room = api.wait_group(g["id"])
    spoke = [e["from"]["name"] for e in entries(room)]
    assert spoke == ["ga"], spoke  # first speaks, others have nothing new → pass
    kinds = [a["kind"] for a in room["activity"]]
    assert kinds.count("pass") >= 2 and kinds[-1] == "settled"
    # each member has its own hidden session, not visible in its chat list
    assert all(s["kind"] != "group" for s in api.ok("get", "/api/bots/ga/sessions"))


def test_group_mentions_title_prefix_and_all(api):
    g = api.ok("post", "/api/groups", {"name": "点名", "members": ["ga", "gb", "gc"]})
    send(api, g["id"], "@gb 你说")
    room = api.wait_group(g["id"])
    assert [e["from"]["name"] for e in entries(room)] == ["gb"]
    send(api, g["id"], "@伽马你怎么看")  # Chinese title + no space
    room = api.wait_group(g["id"])
    assert entries(room)[-1]["from"]["name"] == "gc"
    send(api, g["id"], "@ga @gc 你们俩呢")
    room = api.wait_group(g["id"])
    assert [e["from"]["name"] for e in entries(room)[-2:]] in (["ga", "gc"], ["gc", "ga"])


def test_group_holds(api):
    g = api.ok("post", "/api/groups", {"name": "暂停", "members": ["ga", "gb"]})
    send(api, g["id"], "@ga 停")
    room = api.wait_group(g["id"])
    assert room["holds"] == ["ga"]
    assert all(e["from"]["name"] != "ga" for e in entries(room))
    send(api, g["id"], "大家说说")
    room = api.wait_group(g["id"])
    assert all(e["from"]["name"] != "ga" for e in entries(room))
    send(api, g["id"], "@ga 继续说吧")
    room = api.wait_group(g["id"])
    assert room["holds"] == [] and entries(room)[-1]["from"]["name"] == "ga"
    send(api, g["id"], "@all stop")
    room = api.wait_group(g["id"])
    assert sorted(room["holds"]) == ["ga", "gb"]
    send(api, g["id"], "@all resume")
    room = api.wait_group(g["id"])
    assert room["holds"] == []
    api.ok("patch", f"/api/groups/{g['id']}", {"hold_detection": False})
    send(api, g["id"], "@ga 停")
    assert api.wait_group(g["id"])["holds"] == []


def test_group_threads_are_separate(api):
    g = api.ok("post", "/api/groups", {"name": "帖子", "members": ["ga", "gb"]})
    send(api, g["id"], "主话题")
    room = api.wait_group(g["id"])
    root = entries(room)[0]["id"]
    r = send(api, g["id"], "@gb 展开讲讲", root)
    assert r.status_code == 200
    room = api.wait_group(g["id"])
    thread = [e for e in room["log"] if e["thread"] == root]
    assert [e["from"]["kind"] for e in thread] == ["user", "member"] and thread[1]["from"]["name"] == "gb"
    assert len(entries(room)) == 1, "thread replies stay out of the main room"


def test_group_send_while_running_and_stop(api):
    api.create_bot("gslow")
    api.ok("patch", "/api/bots/gslow", {"model": {"provider": "fslow", "model": "fake-1"}})
    g = api.ok("post", "/api/groups", {"name": "慢群", "members": ["gslow", "ga"]})
    send(api, g["id"], "第一条")
    time.sleep(0.6)
    assert api.ok("get", f"/api/groups/{g['id']}")["running"] == ["main"]
    send(api, g["id"], "第二条")  # queued as a re-run
    time.sleep(0.3)
    api.ok("post", f"/api/groups/{g['id']}/stop", {})
    room = api.wait_group(g["id"], 15)
    assert any(a["kind"] == "stopped" for a in room["activity"])
    n = len(room["log"])
    time.sleep(2)
    assert len(api.ok("get", f"/api/groups/{g['id']}")["log"]) == n, "nothing may post after stop"
    # room still usable
    api.ok("patch", "/api/bots/gslow", {"model": None})
    send(api, g["id"], "@ga 还在吗")
    assert entries(api.wait_group(g["id"]))[-1]["from"]["name"] == "ga"


def test_group_rerun_processes_late_message(api):
    api.create_bot("gslow2")
    api.ok("patch", "/api/bots/gslow2", {"model": {"provider": "fslow", "model": "fake-1"}})
    g = api.ok("post", "/api/groups", {"name": "补发", "members": ["gslow2", "gb"]})
    send(api, g["id"], "@gslow2 先说")
    time.sleep(0.5)
    send(api, g["id"], "@gb 你也说")
    room = api.wait_group(g["id"], 40)
    names = [e["from"]["name"] for e in entries(room)]
    assert "gb" in names, names


def test_group_member_changes(api):
    api.create_bot("gnew")
    g = api.ok("post", "/api/groups", {"name": "进出", "members": ["ga"]})
    for i in range(3):
        send(api, g["id"], f"旧消息{i}")
        api.wait_group(g["id"])
    api.ok("patch", f"/api/groups/{g['id']}", {"members": ["ga", "gnew"]})
    room = api.ok("get", f"/api/groups/{g['id']}")
    assert any("加入" in e["text"] for e in entries(room, "system", None))
    send(api, g["id"], "@gnew 你好")
    room = api.wait_group(g["id"])
    # newcomer only saw messages since joining
    sess = [s for s in api.ok("get", "/api/bots/gnew/sessions")]
    assert entries(room)[-1]["from"]["name"] == "gnew" and sess is not None
    api.ok("patch", f"/api/groups/{g['id']}", {"members": ["gnew"]})
    assert any("离开" in e["text"] for e in entries(api.ok("get", f"/api/groups/{g['id']}"), "system", None))


def test_group_message_cap(api):
    names = [f"cap{i}" for i in range(12)]
    for n in names:
        api.create_bot(n)
    g = api.ok("post", "/api/groups", {"name": "大群", "members": names})
    send(api, g["id"], " ".join(f"@{n}" for n in names) + " 每人说一句")
    room = api.wait_group(g["id"], 90)
    assert len(entries(room)) == 10
    assert room["activity"][-1]["kind"] == "capped"


def test_group_delete_removes_member_sessions(api, server):
    g = api.ok("post", "/api/groups", {"name": "将散", "members": ["ga"]})
    send(api, g["id"], "hi")
    api.wait_group(g["id"])
    before = len(list((server.data / "bots" / "ga" / "sessions").glob("*.json")))
    api.ok("delete", f"/api/groups/{g['id']}")
    after = len(list((server.data / "bots" / "ga" / "sessions").glob("*.json")))
    assert after == before - 1
    assert api.get(f"/api/groups/{g['id']}").status_code == 404
    assert send(api, g["id"], "hi").status_code == 400


def test_group_pending_marks_group(api):
    api.create_bot("gask")
    g = api.ok("post", "/api/groups", {"name": "提问群", "members": ["gask"]})
    send(api, g["id"], "让我选")
    p = api.wait_pending()
    assert p[0]["group_id"] == g["id"]
    api.ok("post", f"/api/pending/{p[0]['id']}", {"answer": "方案 A"})
    room = api.wait_group(g["id"])
    assert entries(room)


def test_group_compress_and_read(api):
    g = api.ok("post", "/api/groups", {"name": "压缩群", "members": ["ga"]})
    for i in range(4):
        send(api, g["id"], f"m{i}")
        api.wait_group(g["id"])
    assert api.ok("post", f"/api/groups/{g['id']}/compress")["ok"]
    api.ok("post", f"/api/groups/{g['id']}/read")
    assert api.ok("get", f"/api/groups/{g['id']}")["unread"] is False


# ── group engine units (fake runtime) ────────────────────────────────────────


def test_nudge_when_addressed_member_passes(server):
    from app import groups

    class RT:
        calls = []

        async def run(self, bot, sid, content, meta=None, attachments=None, timeout=None):
            self.calls.append(content)
            return "(pass)" if len(self.calls) == 1 else "被点名了，我来回答"

        def interrupt(self, sid):
            pass

    rt = RT()
    groups.set_runtime(rt)
    room = groups.create("nudge", ["ga", "gb"])

    async def go():
        groups.send(room["id"], "@ga 请回答", None, None, "你")
        while groups.running_threads(room["id"]):
            await asyncio.sleep(0.05)

    asyncio.run(go())
    r = groups.load(room["id"])
    assert "不能 pass" in rt.calls[1]
    assert [e["text"] for e in r["log"] if e["from"]["kind"] == "member"] == ["被点名了，我来回答"]
    groups.delete(room["id"])


def test_continuation_for_handoff(server):
    from app import groups

    class RT:
        async def run(self, bot, sid, content, meta=None, attachments=None, timeout=None):
            if bot == "ga" and "交给" not in content:
                return "这个问题 @gb 更擅长，交给你"
            if bot == "gb":
                return "好的，我来"
            return "(pass)"

        def interrupt(self, sid):
            pass

    groups.set_runtime(RT())
    room = groups.create("handoff", ["ga", "gb"])

    async def go():
        groups.send(room["id"], "@ga 帮忙", None, None, "你")
        while groups.running_threads(room["id"]):
            await asyncio.sleep(0.05)

    asyncio.run(go())
    r = groups.load(room["id"])
    assert [e["from"]["name"] for e in r["log"] if e["from"]["kind"] == "member"] == ["ga", "gb"]
    groups.delete(room["id"])


# ── routines ─────────────────────────────────────────────────────────────────


def test_cron_api_lifecycle(api, server):
    api.create_bot("cr")
    assert api.post("/api/bots/cr/cron", {"name": "x", "instruction": "", "schedule": "1h"}).status_code == 400
    assert api.post("/api/bots/cr/cron", {"name": "x", "instruction": "做事", "schedule": "明天下午"}).status_code == 400
    assert api.post("/api/bots/nobody/cron", {"instruction": "x", "schedule": "1h"}).status_code == 400
    jobs = api.ok("post", "/api/bots/cr/cron", {"name": "喝水", "instruction": "提醒喝水", "schedule": "every 30m", "max_runs": 2})
    j = jobs[0]
    assert j["schedule"]["display"] == "每 30 分钟" and j["next_run"] > time.time() * 1000
    j = api.ok("patch", f"/api/bots/cr/cron/{j['id']}", {"enabled": False})[0]
    assert j["enabled"] is False and j["next_run"] is None
    j = api.ok("patch", f"/api/bots/cr/cron/{j['id']}", {"enabled": True, "schedule": "weekdays at 9:30"})[0]
    assert j["schedule"]["display"] == "工作日 09:30" and j["next_run"]
    for _ in range(2):
        api.ok("post", f"/api/bots/cr/cron/{j['id']}/run")
        time.sleep(0.2)
        wait_for(lambda: not api.ok("get", "/api/bots/cr/cron")[0]["running"])
    j = api.ok("get", "/api/bots/cr/cron")[0]
    assert j["runs"] == 2 and j["enabled"] is False, "max_runs reached → disabled"
    assert len(j["history"]) == 2 and j["history"][0]["status"] == "ok"
    chat = api.session(api.botchat("cr"))
    routine_msgs = [m for m in chat["messages"] if (m.get("meta") or {}).get("kind") == "routine"]
    assert len(routine_msgs) == 2
    assert api.post(f"/api/bots/cr/cron/nope/run").status_code == 400
    api.ok("delete", f"/api/bots/cr/cron/{j['id']}")
    assert api.ok("get", "/api/bots/cr/cron") == []


def test_cron_scheduler_fires_and_once_disables(api, server):
    api.create_bot("tick")
    j = api.ok("post", "/api/bots/tick/cron", {"name": "一次", "instruction": "报个到", "schedule": "in 10m"})[0]
    assert j["schedule"]["kind"] == "once"
    # pull the due time into the past directly on disk, as if time passed
    path = server.data / "bots" / "tick" / "cron.json"
    jobs = json.loads(path.read_text(encoding="utf-8"))
    jobs[0]["next_run"] = int(time.time() * 1000) - 1000
    path.write_text(json.dumps(jobs), encoding="utf-8")
    j = wait_for(lambda: (x := api.ok("get", "/api/bots/tick/cron")[0]) and x["runs"] == 1 and not x["running"] and x, 30)
    assert j["enabled"] is False and j["next_run"] is None


def test_cron_parse_endpoint(api):
    cases = {"30m": "每 30 分钟", "every 2h": "每 2 小时", "every 1d": "每 1 天", "每天 8点": "每天 08:00",
             "every monday 9am": "每周一 09:00", "周五 18:00": "每周五 18:00", "weekend 10:00": "周末 10:00",
             "0 9 * * *": "每天 09:00", "*/15 * * * *": "cron */15 * * * *", "下午3点": "每天 15:00"}
    for text, display in cases.items():
        r = api.ok("post", "/api/cron/parse", {"schedule": text})
        assert r["ok"] and r["schedule"]["display"] == display, (text, r)
    for bad in ["", "随便", "61 25 * * *", "every 0m", "in -5m"]:
        assert api.ok("post", "/api/cron/parse", {"schedule": bad})["ok"] is False, bad


# ── persistence ──────────────────────────────────────────────────────────────


def test_restart_persists_everything(api, server):
    api.create_bot("persist", title="持久")
    sid = api.botchat("persist")
    api.say(sid, "记住 重启测试")
    g = api.ok("post", "/api/groups", {"name": "持久群", "members": ["persist"]})
    send(api, g["id"], "hi")
    api.wait_group(g["id"])
    api.ok("post", "/api/bots/persist/cron", {"name": "j", "instruction": "x", "schedule": "every 3h"})
    api.ok("put", "/api/ui", {"sections": [{"id": "keep", "name": "保留"}]})
    server.restart()
    assert api.botchat("persist") == sid
    assert any("重启测试" in (m.get("content") or "") for m in api.session(sid)["messages"])
    assert api.ok("get", "/api/bots/persist")["memory"]["memory"] == ["重启测试"]
    assert len(api.ok("get", f"/api/groups/{g['id']}")["log"]) >= 2
    assert len(api.ok("get", "/api/bots/persist/cron")) == 1
    assert api.ok("get", "/api/state")["ui"]["sections"][0]["id"] == "keep"
    assert last_assistant(api.say(sid, "还在吗"))
    # settings file never contains masked placeholders
    raw = (server.data / "settings.json").read_text(encoding="utf-8")
    assert "__keep__" not in raw


def test_corrupted_files_do_not_crash(api, server):
    api.create_bot("corrupt")
    sid = api.botchat("corrupt")
    api.say(sid, "hi")
    (server.data / "bots" / "corrupt" / "cron.json").write_text("{broken", encoding="utf-8")
    (server.data / "groups" / "g0000000000broken.json").write_text("{broken", encoding="utf-8")
    server.restart()
    assert api.ok("get", "/api/bots/corrupt/cron") == []
    assert api.ok("get", "/api/state")["bots"]


def test_renamed_bot_still_speaks_in_group(api):
    api.create_bot("pre")
    g = api.ok("post", "/api/groups", {"name": "改名后", "members": ["pre"]})
    send(api, g["id"], "@pre 先说一句")
    assert entries(api.wait_group(g["id"]))[-1]["from"]["name"] == "pre"
    sid = api.botchat("pre")
    api.say(sid, "你好")  # make sure a runner exists for the Bot Chat too
    api.ok("post", "/api/bots/pre/rename", {"name": "post"})
    send(api, g["id"], "@post 改名后还在吗")
    room = api.wait_group(g["id"])
    assert entries(room)[-1]["from"]["name"] == "post", [a for a in room["activity"][-3:]]
    assert last_assistant(api.say(sid, "改名后私聊")), "Bot Chat still answers after a rename"


def test_member_join_emits_live_entry(api):
    from conftest import Events
    ev = Events(api.base)
    try:
        api.create_bot("joiner")
        g = api.ok("post", "/api/groups", {"name": "加人", "members": ["jie"]})
        api.ok("patch", f"/api/groups/{g['id']}", {"members": ["jie", "joiner"]})
        time.sleep(0.5)
        live = [e for e in ev.items if e["type"] == "group_entry" and e["id"] == g["id"]]
        assert live and "加入" in live[0]["entry"]["text"], [(e["type"], str(e)[:120]) for e in ev.items]
    finally:
        ev.close()


def test_pending_in_thread_carries_thread(api):
    api.create_bot("gthread")
    g = api.ok("post", "/api/groups", {"name": "串里提问", "members": ["gthread"]})
    send(api, g["id"], "@gthread 开个话题")
    root = entries(api.wait_group(g["id"]))[0]["id"]
    send(api, g["id"], "@gthread 让我选", root)
    p = api.wait_pending()
    assert p[0]["group_id"] == g["id"] and p[0]["thread"] == root
    api.ok("post", f"/api/pending/{p[0]['id']}", {"answer": "A"})
    api.wait_group(g["id"])


def test_static_assets_and_manifest(api):
    import httpx
    for path, ctype in (("/manifest.webmanifest", "application/manifest+json"), ("/icon.svg", "image/svg+xml"),
                        ("/icon-small.svg", "image/svg+xml"), ("/favicon.ico", "image/"), ("/icon-512.png", "image/png")):
        r = httpx.get(api.base + path)
        assert r.status_code == 200 and r.headers["content-type"].startswith(ctype), (path, r.status_code, r.headers.get("content-type"))
    m = httpx.get(api.base + "/manifest.webmanifest").json()
    assert m["name"] == "SEDRIC Bots" and any(i["sizes"] == "512x512" for i in m["icons"])
    assert "SEDRIC Bots" in httpx.get(api.base + "/").text


def test_cache_headers(api):
    import re

    import httpx
    html = httpx.get(api.base + "/")
    assert "no-store" in html.headers["cache-control"]
    js = re.search(r'src="(/assets/[^"]+\.js)"', html.text).group(1)
    assert "immutable" in httpx.get(api.base + js).headers["cache-control"]
    assert httpx.get(api.base + "/icon.svg").headers["cache-control"] == "no-cache"
    assert httpx.get(api.base + "/assets/..%2F..%2Fbackend%2Fapp%2Fmain.py").status_code in (200, 404)
    assert "FastAPI" not in httpx.get(api.base + "/assets/..%2F..%2Fbackend%2Fapp%2Fmain.py").text
