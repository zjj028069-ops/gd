"""Bots / profiles: creation rules, cloning, rename, delete, skills, memory, security."""
from __future__ import annotations

import re

import httpx


def test_default_bot_exists(api):
    st = api.ok("get", "/api/state")
    assert "jie" in [b["name"] for b in st["bots"]]
    assert st["settings"]["providers"][0]["id"] == "mock"
    # keys never leave the server
    assert all("api_key" not in p for p in st["settings"]["providers"])
    assert "ok" not in str([p.get("api_key_masked") for p in st["settings"]["providers"] if p["id"] == "fok"])


def test_create_validation(api):
    for bad in ["", "a b", "../x", "x/y", "-lead", "user", "all", "everyone", "a" * 33, "名字"]:
        r = api.post("/api/bots", {"name": bad, "kickoff": False})
        assert r.status_code == 400, bad
    api.create_bot("val1")
    r = api.post("/api/bots", {"name": "val1", "kickoff": False})
    assert r.status_code == 400 and "占用" in r.json()["error"]
    # Upper case is normalised, not rejected
    b = api.create_bot("UpperCase")
    assert b["name"] == "uppercase"


def test_path_traversal_blocked(api, server):
    secret = server.data / "settings.json"
    assert secret.exists()
    # Encoded dot-segments reach the server verbatim (plain ".." is normalised away by the client).
    assert api.get("/api").status_code == 404
    for path in ["/api/bots/%2E%2E", "/api/bots/..%2F..%2Fsettings", "/api/bots/%2E%2E%2Fhermes",
                 "/api/bots/jie/skills/%2E%2E", "/api/bots/jie/skills/..%2F..%2Fprofile"]:
        r = api.get(path)
        assert r.status_code in (400, 404), path
    for path in ["/api/bots/%2E%2E", "/api/bots/jie/skills/%2E%2E", "/api/bots/jie/skills/%2E%2E%2F%2E%2E"]:
        assert api.delete(path).status_code in (400, 404, 405), path
    r = api.put("/api/bots/jie/skills/..%2F..%2F..%2Fevil", {"name": "x", "body": "y"})
    assert r.status_code in (400, 404, 405)
    # ".." is slugified into a harmless id rather than used as a path
    r = api.put("/api/bots/jie/skills/%2E%2E", {"name": "x", "body": "y"})
    assert r.status_code == 200 and re.match(r"^[a-z0-9][a-z0-9_-]*$", r.json()["id"])
    api.delete(f"/api/bots/jie/skills/{r.json()['id']}")
    for gid in ["%2E%2E", "..%2Fsettings", "g..", "settings"]:
        assert api.get(f"/api/groups/{gid}").status_code in (400, 404)
        api.delete(f"/api/groups/{gid}")
    assert secret.exists()
    assert (server.data / "bots" / "jie" / "profile.json").exists()


def test_host_header_guard(api):
    r = httpx.get(api.base + "/api/state", headers={"Host": "evil.example.com"})
    assert r.status_code == 403
    r = httpx.get(api.base + "/api/state", headers={"Host": "localhost"})
    assert r.status_code == 200


def test_non_json_post_rejected(api):
    # A cross-site "simple" form post must not be able to create bots.
    r = httpx.post(api.base + "/api/bots", content="name=evil", headers={"Content-Type": "text/plain"})
    assert r.status_code in (400, 415, 422)
    assert "evil" not in [b["name"] for b in api.ok("get", "/api/bots")]


def test_patch_and_ignore_unknown(api):
    api.create_bot("patchy")
    b = api.ok("patch", "/api/bots/patchy", {"title": "新标题", "pinned": True, "name": "hacked", "created": 1})
    assert b["title"] == "新标题" and b["pinned"] is True and b["name"] == "patchy"
    b = api.ok("patch", "/api/bots/patchy", {"avatar": {"shape": "cloud"}})
    assert b["avatar"]["shape"] == "cloud" and b["avatar"]["color"]  # merged with defaults
    assert api.patch("/api/bots/nobody", {"title": "x"}).status_code == 400


def test_skills_selection_and_empty(api):
    a = api.create_bot("skillsome", skills=["web-research"])
    d = api.ok("get", "/api/bots/skillsome")
    assert [s["id"] for s in d["skills"]] == ["web-research"]
    api.create_bot("skillnone", empty_skills=True)
    assert api.ok("get", "/api/bots/skillnone")["skills"] == []
    api.create_bot("skillall")
    assert len(api.ok("get", "/api/bots/skillall")["skills"]) >= 4
    assert a["name"] == "skillsome"


def test_skill_crud_and_chinese_ids(api):
    api.create_bot("sk", empty_skills=True)
    s1 = api.ok("put", "/api/bots/sk/skills/周报", {"name": "周报", "description": "写周报", "body": "步骤1"})
    s2 = api.ok("put", "/api/bots/sk/skills/周报", {"name": "周报", "description": "写周报", "body": "步骤2"})
    assert s1["id"] == s2["id"], "same Chinese name must map to the same skill"
    skills = api.ok("get", "/api/bots/sk")["skills"]
    assert len(skills) == 1 and skills[0]["body"] == "步骤2"
    api.ok("put", "/api/bots/sk/skills/deploy-app", {"name": "deploy-app", "description": "d", "body": "b"})
    assert api.ok("get", "/api/bots/sk/skills/deploy-app")["name"] == "deploy-app"
    api.ok("delete", f"/api/bots/sk/skills/{s1['id']}")
    assert [s["id"] for s in api.ok("get", "/api/bots/sk")["skills"]] == ["deploy-app"]
    # install from catalog and copy from another bot
    api.ok("post", "/api/bots/sk/skills/install", {"ids": ["code-helper"]})
    api.ok("post", "/api/bots/jie/skills/install", {"ids": ["deploy-app"], "from_bot": "sk"})
    assert "deploy-app" in [s["id"] for s in api.ok("get", "/api/bots/jie")["skills"]]
    # disabling a skill marks it
    api.ok("patch", "/api/bots/sk", {"skills_disabled": ["code-helper"]})
    flags = {s["id"]: s["enabled"] for s in api.ok("get", "/api/bots/sk")["skills"]}
    assert flags == {"deploy-app": True, "code-helper": False}


def test_soul_and_memory(api):
    api.create_bot("mem", title="记忆体", description="测试")
    d = api.ok("get", "/api/bots/mem")
    assert "记忆体" in d["soul"]
    api.ok("put", "/api/bots/mem/soul", {"soul": "# 新人格"})
    assert api.ok("get", "/api/bots/mem")["soul"] == "# 新人格"
    api.ok("put", "/api/bots/mem/memory", {"memory": ["a", "b"], "user": ["喜欢茶"]})
    m = api.ok("get", "/api/bots/mem")["memory"]
    assert m["memory"] == ["a", "b"] and m["user"] == ["喜欢茶"]
    api.ok("put", "/api/bots/mem/memory", {"memory": []})
    assert api.ok("get", "/api/bots/mem")["memory"]["memory"] == []


def test_clone_copies_identity_not_history(api):
    api.create_bot("orig", title="原版", description="原描述")
    sid = api.botchat("orig")
    api.say(sid, "你好")
    api.ok("put", "/api/bots/orig/memory", {"memory": ["秘密笔记"]})
    api.ok("put", "/api/bots/orig/soul", {"soul": "# 原版人格"})
    api.create_bot("copy", clone_from="orig", title="副本")
    d = api.ok("get", "/api/bots/copy")
    assert d["soul"] == "# 原版人格"
    assert d["memory"]["memory"] == ["秘密笔记"]
    assert d["sessions"] == [] or all(s["message_count"] == 0 for s in d["sessions"])


def test_duplicate(api):
    api.create_bot("dupme", title="Dup")
    a = api.ok("post", "/api/bots/dupme/duplicate")
    b = api.ok("post", "/api/bots/dupme/duplicate")
    assert a["name"] == "dupme-2" and b["name"] == "dupme-3"
    assert a["avatar"]["shape"] == api.ok("get", "/api/bots/dupme")["avatar"]["shape"]


def test_rename_carries_everything(api):
    api.create_bot("oldname", title="改名者")
    sid = api.botchat("oldname")
    api.say(sid, "记住 我叫小王")
    g = api.ok("post", "/api/groups", {"name": "改名群", "members": ["oldname", "jie"]})
    api.ok("post", "/api/bots/oldname/cron", {"name": "j", "instruction": "x", "schedule": "every 2h"})
    r = api.ok("post", "/api/bots/oldname/rename", {"name": "newname"})
    assert r["name"] == "newname" and "oldname" in r["previous_names"]
    assert api.botchat("newname") == sid, "Bot Chat history must survive the rename"
    s = api.session(sid)
    assert any("我叫小王" in (m.get("content") or "") for m in s["messages"])
    assert api.say(sid, "你好")["bot"] == "newname"
    assert "newname" in api.ok("get", f"/api/groups/{g['id']}")["members"]
    jobs = api.ok("get", "/api/bots/newname/cron")
    assert len(jobs) == 1 and jobs[0]["bot"] == "newname"
    assert api.post("/api/bots/newname/rename", {"name": "jie"}).status_code == 400
    assert api.post("/api/bots/newname/rename", {"name": "Bad Name"}).status_code == 400


def test_delete_cleans_up(api, server):
    api.create_bot("gone")
    sid = api.botchat("gone")
    api.say(sid, "你好")
    g = api.ok("post", "/api/groups", {"name": "删除群", "members": ["gone", "jie"]})
    api.ok("delete", "/api/bots/gone")
    assert not (server.data / "bots" / "gone").exists()
    assert api.get(f"/api/sessions/{sid}").status_code == 404
    room = api.ok("get", f"/api/groups/{g['id']}")
    assert room["members"] == ["jie"]
    assert any("Gone 已被删除" in e["text"] for e in room["log"] if e["from"]["kind"] == "system")
    assert api.post("/api/bots/gone/botchat").status_code == 404


def test_sections_ui_state(api):
    st = api.ok("put", "/api/ui", {"sections": [{"id": "s1", "name": "客户"}], "collapsed": ["groups"], "junk": 1})
    assert st["sections"][0]["name"] == "客户" and "junk" not in st
    api.ok("patch", "/api/bots/jie", {"section": "s1"})
    assert api.ok("get", "/api/bots/jie")["section"] == "s1"
    api.ok("patch", "/api/bots/jie", {"section": None})
