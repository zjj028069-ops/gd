"""Group chats: bounded round-robin coordination over a shared room log.

Behaviour (mirrors Hermes Bot Mode):
- A room is ONE ordered log. A user send starts a drive of at most MAX_ROUNDS
  serial rounds — never parallel, no LLM router.
- Who may speak each round is a deterministic @mention parse of the messages
  since the last user message (mentioned members only, otherwise everyone);
  the order rotates each round.
- Each member runs in its OWN hidden per-room (per-thread) session and is fed
  only the room messages that are new since its last turn.
- A member replying exactly "(pass)" (or nothing) stays silent. A round in
  which nobody speaks means the conversation settled — unless a member
  @handed off to someone who hasn't answered: then one bounded continuation
  round runs for exactly those members.
- A member the user addressed explicitly cannot pass: it is nudged once.
- Holds: "stop @x" parks x until it is mentioned again or "@all resume".
"""
from __future__ import annotations

import asyncio
import re
from typing import Any

from . import bots, sessions
from .events import bus
from .storage import GROUPS_DIR, new_id, now_ms, read_json, truncate, write_json

MAX_ROUNDS = 3
MAX_MESSAGES = 10
MAX_CONTINUATIONS = 2
TURN_CAP_SECONDS = 15 * 60
GROUP_TURN_STEPS = 8  # the room waits on each speaker, so keep member turns short
HISTORY_LIMIT = 200
HISTORY_CHARS = 32_000
LINE_CHARS = 8_000
LOG_RETAIN = HISTORY_LIMIT * 2
MAIN = "main"

PASS_RE = re.compile(r"^\s*[\(（]\s*pass\s*[\)）]\s*\.?\s*$", re.I)
MENTION_RE = re.compile(r"(?<![A-Za-z0-9_.@])@([A-Za-z0-9一-鿿][\w一-鿿.-]*)")
STOP_WORDS = ["stop", "halt", "pause", "hold on", "shut up", "停止", "暂停", "停下", "别说了", "闭嘴", "先别", "等一下", "安静", "停"]
RESUME_WORDS = ["resume", "continue", "go on", "继续", "恢复", "开始吧"]
CONTROL_RE = re.compile(r"\[(?=/?OUT-OF-BAND|CONTEXT COMPACTION|CONTEXT SUMMARY\]|System note:|System:|SYSTEM\]|IMPORTANT:)", re.I)

GROUP_DELTA_HEADER = "自你上次发言以来，群里的新消息（从旧到新）："
NUDGE = ("\n你刚才回复了 \"(pass)\"，但用户在这一轮明确点名了你（@你 或 @所有人）。被直接点名时不能 pass。"
         "现在请回复一条消息：你的回答、你的结果，或者明确说明你无法回答以及原因。")

_runtime = None
_drives: dict[tuple[str, str], asyncio.Task] = {}
_rerun: set[tuple[str, str]] = set()
_active_member: dict[tuple[str, str], str] = {}


def set_runtime(rt) -> None:
    global _runtime
    _runtime = rt


class GroupError(Exception):
    pass


# ── storage ──────────────────────────────────────────────────────────────────


GID_RE = re.compile(r"^g[0-9a-f]{6,40}$")


def _path(gid: str):
    if not isinstance(gid, str) or not GID_RE.match(gid):
        raise GroupError("群聊不存在")
    return GROUPS_DIR / f"{gid}.json"


def load(gid: str) -> dict[str, Any] | None:
    room = read_json(_path(gid), None)
    if room:
        room.setdefault("log", [])
        room.setdefault("members", [])
        room.setdefault("holds", {})
        room.setdefault("watermarks", {})
        room.setdefault("sessions", {})
        room.setdefault("activity", [])
        room.setdefault("epoch", 0)
        room.setdefault("hold_detection", True)
        room.setdefault("last_read", 0)
    return room


def save(room: dict[str, Any], entry: dict[str, Any] | None = None) -> None:
    fresh = room.pop("_fresh", [])
    room["log"] = room["log"][-LOG_RETAIN:]
    room["activity"] = room["activity"][-120:]
    room["updated"] = now_ms()
    write_json(_path(room["id"]), room)
    bus.publish("group", id=room["id"], summary=summary(room))
    for e in fresh:
        bus.publish("group_entry", id=room["id"], entry=e)
    if entry is not None:
        bus.publish("group_entry", id=room["id"], entry=entry)


def all_rooms() -> list[dict[str, Any]]:
    out = []
    for p in GROUPS_DIR.glob("*.json"):
        if not GID_RE.match(p.stem):
            continue
        r = load(p.stem)
        if r:
            out.append(r)
    return out


def running_threads(gid: str) -> list[str]:
    return [t for (g, t), task in _drives.items() if g == gid and not task.done()]


def summary(room: dict[str, Any]) -> dict[str, Any]:
    last = next((e for e in reversed(room["log"]) if e.get("from", {}).get("kind") != "system"), None)
    return {
        "id": room["id"], "name": room["name"], "image": room.get("image"), "members": room["members"],
        "created": room.get("created"), "updated": room.get("updated"), "pinned": room.get("pinned", False),
        "section": room.get("section"), "hold_detection": room.get("hold_detection", True),
        "holds": list(room["holds"].keys()),
        "last_active": last["at"] if last else room.get("created"),
        "preview": (f"{_speaker(last)}: {sessions.plain(last['text'])[:100]}" if last else ""),
        "unread": bool(last and last["at"] > room.get("last_read", 0) and last["from"]["kind"] != "user"),
        "running": running_threads(room["id"]),
        "active": {t: m for (g, t), m in _active_member.items() if g == room["id"]},
    }


def public(room: dict[str, Any]) -> dict[str, Any]:
    return {**summary(room), "log": room["log"], "activity": room["activity"][-60:]}


def _speaker(entry: dict[str, Any] | None) -> str:
    if not entry:
        return ""
    f = entry["from"]
    if f["kind"] == "user":
        return f.get("name") or "你"
    p = bots.load(f["name"]) or {}
    return p.get("title") or f["name"]


def create(name: str, members: list[str], image: str | None = None) -> dict[str, Any]:
    name = (name or "").strip() or "新群聊"
    members = [m for m in dict.fromkeys(members) if bots.exists(m)]
    if not members:
        raise GroupError("至少选择一个机器人")
    room = {"id": new_id("g"), "name": name, "image": image, "members": members, "created": now_ms(),
            "log": [], "holds": {}, "watermarks": {}, "sessions": {}, "activity": [], "epoch": 0,
            "hold_detection": True, "last_read": now_ms()}
    save(room)
    return room


def update(gid: str, patch: dict[str, Any]) -> dict[str, Any]:
    room = load(gid)
    if not room:
        raise GroupError("群聊不存在")
    for k in ("name", "image", "pinned", "section", "hold_detection"):
        if k in patch:
            room[k] = patch[k]
    if "members" in patch:
        new = [m for m in dict.fromkeys(patch["members"]) if bots.exists(m)]
        if not new:
            raise GroupError("群聊至少要有一个成员")
        added = [m for m in new if m not in room["members"]]
        removed = [m for m in room["members"] if m not in new]
        room["members"] = new
        for m in removed:
            room["holds"].pop(m, None)
        names = lambda ms: "、".join((bots.load(m) or {}).get("title") or m for m in ms)  # noqa: E731
        if added:
            _system(room, f"{names(added)} 加入了群聊")
            # Newcomers start reading from now, not from the beginning of time.
            for m in added:
                room["watermarks"].setdefault(m, {})[MAIN] = room["log"][-1]["id"] if room["log"] else None
        if removed:
            _system(room, f"{names(removed)} 离开了群聊")
    save(room)
    return room


def delete(gid: str) -> None:
    room = load(gid)
    if not room:
        return
    for (g, t), task in list(_drives.items()):
        if g == gid:
            task.cancel()
    for member, threads in room["sessions"].items():
        for sid in threads.values():
            if _runtime:
                _runtime.interrupt(sid)
            sessions.delete(sid)
    _path(gid).unlink(missing_ok=True)
    bus.publish("group_deleted", id=gid)


def mark_read(gid: str) -> None:
    room = load(gid)
    if room:
        room["last_read"] = now_ms()
        save(room)


def _system(room: dict[str, Any], text: str) -> dict[str, Any]:
    e = {"id": new_id("e"), "at": now_ms(), "from": {"kind": "system", "name": "system"}, "text": text, "thread": MAIN}
    room["log"].append(e)
    room.setdefault("_fresh", []).append(e)  # published by the next save()
    return e


def _activity(room: dict[str, Any], kind: str, thread: str, member: str | None = None, text: str = "") -> None:
    a = {"at": now_ms(), "kind": kind, "thread": thread, "member": member, "text": text}
    room["activity"].append(a)
    bus.publish("group_activity", id=room["id"], activity=a)


def on_bot_renamed(old: str, new: str) -> None:
    for room in all_rooms():
        if old in room["members"]:
            room["members"] = [new if m == old else m for m in room["members"]]
            for k in ("holds", "watermarks", "sessions"):
                if old in room[k]:
                    room[k][new] = room[k].pop(old)
            save(room)


def on_bot_deleted(name: str) -> None:
    for room in all_rooms():
        if name in room["members"]:
            room["members"].remove(name)
            for k in ("holds", "watermarks", "sessions"):
                room[k].pop(name, None)
            _system(room, f"{(bots.load(name) or {}).get('title') or name} 已被删除，离开了群聊")
            save(room)


# ── mentions & holds ─────────────────────────────────────────────────────────


def _forms(name: str) -> set[str]:
    p = bots.load(name) or {}
    title = (p.get("title") or "").strip().lower()
    forms = {name.lower(), re.sub(r"[\s_-]+", "", name.lower())}
    for prev in p.get("previous_names") or []:
        forms.add(prev.lower())
    if title:
        forms |= {title, re.sub(r"\s+", "", title), *[w for w in title.split() if len(w) >= 2]}
    return {f for f in forms if f}


def parse_mentions(text: str, members: list[str]) -> tuple[set[str], bool, list[tuple[int, int, str]]]:
    table: dict[str, str] = {}
    for m in members:
        for f in _forms(m):
            table.setdefault(f, m)
    mentioned: set[str] = set()
    everyone = False
    spans: list[tuple[int, int, str]] = []
    for mt in MENTION_RE.finditer(text or ""):
        h = mt.group(1).lower().rstrip(".-")
        if h in ("everyone", "all", "所有人", "大家", "全体"):
            everyone = True
            spans.append((mt.start(), mt.end(), "*"))
            continue
        if h == "user":
            continue
        who = table.get(h) or table.get(re.sub(r"[._-]+", "", h))
        if not who:
            # Prefix match handles "@alice你好" style Chinese text with no space.
            # Only when the name runs straight into non-ASCII text ("@伽马你好", "@bob你好");
            # "@alice" must never resolve to a member called "al".
            for f, m in sorted(table.items(), key=lambda kv: -len(kv[0])):
                rest = h[len(f):]
                if h.startswith(f) and rest and not re.match(r"[a-z0-9_.-]", rest):
                    who = m
                    break
        if who:
            mentioned.add(who)
            spans.append((mt.start(), mt.end(), who))
    return mentioned, everyone, spans


def _near(text: str, spans: list[tuple[int, int, str]], words: list[str]) -> bool:
    low = text.lower()
    for s, e, _ in spans:
        window = low[max(0, s - 10): e + 12]
        if any(w in window for w in words):
            return True
    return False


def apply_holds(room: dict[str, Any], text: str) -> list[str]:
    if not room.get("hold_detection", True):
        return []
    mentioned, everyone, spans = parse_mentions(text, room["members"])
    notes = []
    targets = list(room["members"]) if everyone else list(mentioned)
    if not targets:
        return []
    if _near(text, spans, STOP_WORDS) and not _near(text, spans, RESUME_WORDS):
        for m in targets:
            room["holds"][m] = {"at": now_ms()}
        notes.append("已暂停：" + "、".join((bots.load(m) or {}).get("title") or m for m in targets))
    else:
        released = [m for m in targets if m in room["holds"]]
        for m in released:
            room["holds"].pop(m, None)
        if released:
            notes.append("已恢复：" + "、".join((bots.load(m) or {}).get("title") or m for m in released))
    return notes


# ── formatting ───────────────────────────────────────────────────────────────


def thread_of(e: dict[str, Any]) -> str:
    return e.get("thread") or MAIN


def format_line(e: dict[str, Any], viewer: str) -> str:
    att = "".join(f" [附件：{a.get('name')}]" for a in e.get("attachments") or [])
    if e["from"]["kind"] == "user":
        return f"{e['from'].get('name') or '用户'} (user): {e['text']}{att}"
    if e["from"]["kind"] == "system":
        return f"[系统] {e['text']}"
    me = " (you)" if e["from"]["name"] == viewer else ""
    p = bots.load(e["from"]["name"]) or {}
    label = f"{p.get('title')} (@{e['from']['name']})" if p.get("title") else f"@{e['from']['name']}"
    return f"{label}{me}: {CONTROL_RE.sub('[member-quoted ', e['text'])}{att}"


def format_delta(delta: list[dict[str, Any]], viewer: str) -> list[str]:
    lines: list[str] = []
    chars = 0
    for e in reversed(delta):
        if len(lines) >= HISTORY_LIMIT:
            break
        line = format_line({**e, "text": truncate(e["text"], LINE_CHARS)}, viewer)
        if lines and chars + len(line) > HISTORY_CHARS:
            break
        lines.append(line)
        chars += len(line) + 1
    lines.reverse()
    omitted = len(delta) - len(lines)
    if omitted > 0:
        lines.insert(0, f"… 自你上次发言以来还有 {omitted} 条更早的消息被省略")
    return lines


def turn_prompt(room: dict[str, Any], viewer: str, lines: list[str], thread: str) -> str:
    peers = []
    for m in room["members"]:
        if m == viewer:
            continue
        p = bots.load(m) or {}
        peers.append(f"{p.get('title')} (@{m})" if p.get("title") else f"@{m}")
    where = "" if thread == MAIN else "（这是群里的一个讨论串，只讨论这个话题）"
    return "\n".join([
        f"[群聊：「{room['name']}」{where}] 你是 @{viewer}，和 {', '.join(peers) or '（暂无其他成员）'} 以及用户在同一个群聊里。",
        "",
        GROUP_DELTA_HEADER,
        *[f"  {ln}" for ln in lines],
        "",
        "群聊规则：",
        "- 只有在你确实有新东西可说时才回复一条消息：接着刚才的话往下说、认领或转交工作、回答问给你的问题、汇报真实的结果。闲聊保持简短（1-3 句）；但交付结果、回答用户要的东西或实质性工作时，要完整、高质量，不要为了简短而缩水。",
        "- 如果你没有新内容可补充，就只回复 \"(pass)\"。pass 是好事——能让讨论收敛。",
        "- 想拉某个队友进来就 @名字；只有需要用户拍板或用户需要看到结果时才 @user。不要重复别人已经说过的话。",
        "- 不要透露你和用户 1 对 1 私聊的内容。你的回复会原样发到群里——不要加前言或旁白。",
    ])


# ── engine ───────────────────────────────────────────────────────────────────


def _thread_log(room: dict[str, Any], thread: str) -> list[dict[str, Any]]:
    return [e for e in room["log"] if thread_of(e) == thread and e["from"]["kind"] != "system"]


def _since_last_user(log: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for i in range(len(log) - 1, -1, -1):
        if log[i]["from"]["kind"] == "user":
            return log[i:]
    return []


def responders(room: dict[str, Any], thread: str) -> list[str]:
    tail = _since_last_user(_thread_log(room, thread))
    mentioned: set[str] = set()
    everyone = False
    for e in tail:
        if e["from"]["kind"] != "user":
            continue
        m, ev, _ = parse_mentions(e["text"], room["members"])
        mentioned |= m
        everyone |= ev
    if everyone or not mentioned:
        return list(room["members"])
    return [m for m in room["members"] if m in mentioned]


def addressed(room: dict[str, Any], thread: str) -> set[str]:
    out: set[str] = set()
    for e in _since_last_user(_thread_log(room, thread)):
        if e["from"]["kind"] == "user":
            m, ev, _ = parse_mentions(e["text"], room["members"])
            out |= set(room["members"]) if ev else m
    return out


def unanswered_mentions(room: dict[str, Any], thread: str) -> list[str]:
    """Members @mentioned by another member's reply (since the last user
    message) who have not spoken since that mention."""
    tail = _since_last_user(_thread_log(room, thread))
    owed: list[str] = []
    for i, e in enumerate(tail):
        if e["from"]["kind"] != "member":
            continue
        m, ev, _ = parse_mentions(e["text"], room["members"])
        for who in (room["members"] if ev else m):
            if who == e["from"]["name"]:
                continue
            spoke_after = any(x["from"]["kind"] == "member" and x["from"]["name"] == who for x in tail[i + 1:])
            if not spoke_after and who not in owed and who not in room["holds"]:
                owed.append(who)
    return owed


def rotate(members: list[str], rnd: int) -> list[str]:
    if len(members) < 2:
        return members
    k = rnd % len(members)
    return members[k:] + members[:k]


def _member_session(room: dict[str, Any], member: str, thread: str) -> dict[str, Any]:
    sid = room["sessions"].get(member, {}).get(thread)
    s = sessions.get(sid) if sid else None
    if s is None:
        s = sessions.create(member, f"群聊：{room['name']}" + ("" if thread == MAIN else " · 讨论串"),
                            kind="group", hidden=True, group_id=room["id"], thread=thread)
        room["sessions"].setdefault(member, {})[thread] = s["id"]
    return s


def _delta_for(room: dict[str, Any], member: str, thread: str) -> tuple[list[dict[str, Any]], bool]:
    log = [e for e in room["log"] if thread_of(e) == thread]
    mark = room["watermarks"].get(member, {}).get(thread)
    fresh_thread = thread != MAIN and thread not in room["watermarks"].get(member, {})
    start = 0
    if mark:
        for i, e in enumerate(log):
            if e["id"] == mark:
                start = i + 1
                break
    delta = log[start:]
    has_news = any(e["from"].get("name") != member and e["from"]["kind"] != "system" for e in delta)
    if fresh_thread:
        root = next((e for e in room["log"] if e["id"] == thread), None)
        if root:
            delta = [root, *delta]
    return delta, has_news


async def _member_turn(gid: str, member: str, thread: str, epoch: int, must_answer: bool) -> bool | None:
    """True = posted, False = silent, None = drive abandoned (stopped)."""
    room = load(gid)
    if not room or room["epoch"] != epoch or member not in room["members"]:
        return None
    if member in room["holds"]:
        return False
    delta, has_news = _delta_for(room, member, thread)
    if not has_news:
        return False
    lines = format_delta(delta, member)
    content = turn_prompt(room, member, lines, thread)
    images = [a for e in delta if e["from"]["kind"] == "user" for a in e.get("attachments") or []]
    s = _member_session(room, member, thread)
    room["watermarks"].setdefault(member, {})[thread] = delta[-1]["id"]
    _activity(room, "turn", thread, member, "正在思考…")
    save(room)
    _active_member[(gid, thread)] = member
    bus.publish("group", id=gid, summary=summary(room))
    try:
        reply = await _runtime.run(member, s["id"], content, {"from": {"kind": "group", "name": room["name"]},
                                                              "max_iterations": GROUP_TURN_STEPS},
                                   images, timeout=TURN_CAP_SECONDS)
        room = load(gid)
        if room and room["epoch"] == epoch and PASS_RE.match(reply or "") and must_answer:
            reply = await _runtime.run(member, s["id"], NUDGE, {"from": {"kind": "group", "name": room["name"]},
                                                                "max_iterations": GROUP_TURN_STEPS},
                                       timeout=TURN_CAP_SECONDS)
    except asyncio.TimeoutError:
        room = load(gid)
        if room:
            _activity(room, "failed", thread, member, "超时")
            save(room)
        return False
    except Exception as e:  # noqa: BLE001
        room = load(gid)
        if room:
            _activity(room, "failed", thread, member, str(e)[:200])
            save(room)
        return False
    finally:
        _active_member.pop((gid, thread), None)
    room = load(gid)
    if not room or room["epoch"] != epoch:
        return None
    text = (reply or "").strip()
    if not text or PASS_RE.match(text):
        _activity(room, "pass", thread, member, "没有新内容（pass）" if text else "没有回复")
        save(room)
        return False
    entry = {"id": new_id("e"), "at": now_ms(), "from": {"kind": "member", "name": member}, "text": text, "thread": thread}
    room["log"].append(entry)
    room["watermarks"].setdefault(member, {})[thread] = entry["id"]
    _activity(room, "reply", thread, member, text[:80])
    save(room, entry)
    return True


async def _drive(gid: str, thread: str) -> None:
    key = (gid, thread)
    try:
        while True:
            _rerun.discard(key)
            room = load(gid)
            if not room:
                return
            epoch = room["epoch"]
            must = addressed(room, thread)
            posted = 0
            continuations = 0
            outcome = "settled"
            stopped = False
            for rnd in range(MAX_ROUNDS):
                room = load(gid)
                if not room or room["epoch"] != epoch:
                    stopped = True
                    break
                order = [m for m in rotate(responders(room, thread), rnd) if m not in room["holds"]]
                spoke = 0
                for member in order:
                    if posted >= MAX_MESSAGES:
                        outcome = "capped"
                        break
                    r = await _member_turn(gid, member, thread, epoch, member in must and rnd == 0)
                    if r is None:
                        stopped = True
                        break
                    if r:
                        posted += 1
                        spoke += 1
                if stopped or outcome == "capped":
                    break
                if spoke == 0:
                    room = load(gid)
                    owed = unanswered_mentions(room, thread) if room else []
                    while owed and continuations < MAX_CONTINUATIONS and posted < MAX_MESSAGES:
                        continuations += 1
                        got = 0
                        for member in owed:
                            r = await _member_turn(gid, member, thread, epoch, True)
                            if r is None:
                                stopped = True
                                break
                            if r:
                                posted += 1
                                got += 1
                        if stopped or not got:
                            break
                        room = load(gid)
                        owed = unanswered_mentions(room, thread) if room else []
                    break
            else:
                outcome = "capped"
            room = load(gid)
            if room:
                if stopped:
                    _activity(room, "stopped", thread, None, "已停止")
                else:
                    _activity(room, outcome, thread, None,
                              "讨论告一段落" if outcome == "settled" else f"达到本轮上限（{MAX_ROUNDS} 轮 / {MAX_MESSAGES} 条），先停在这里")
                save(room)
            if key not in _rerun or stopped:
                return
    finally:
        _drives.pop(key, None)
        room = load(gid)
        if room:
            bus.publish("group", id=gid, summary=summary(room))


def send(gid: str, text: str, thread: str | None, attachments: list[dict[str, Any]] | None, user_name: str) -> dict[str, Any]:
    room = load(gid)
    if not room:
        raise GroupError("群聊不存在")
    text = (text or "").strip()
    if not text and not attachments:
        raise GroupError("消息不能为空")
    if text.startswith("/"):
        raise GroupError("群聊不支持斜杠命令。请打开单个机器人的聊天来使用它们。")
    thread = thread or MAIN
    if thread != MAIN and not any(e["id"] == thread for e in room["log"]):
        raise GroupError("讨论串不存在")
    entry = {"id": new_id("e"), "at": now_ms(), "from": {"kind": "user", "name": user_name}, "text": text,
             "thread": thread, "attachments": attachments or []}
    room["log"].append(entry)
    room["last_read"] = now_ms()
    notes = apply_holds(room, text)
    for n in notes:
        _activity(room, "hold", thread, None, n)
    save(room, entry)
    key = (gid, thread)
    task = _drives.get(key)
    if task and not task.done():
        _rerun.add(key)
    else:
        _drives[key] = asyncio.get_running_loop().create_task(_drive(gid, thread))
        bus.publish("group", id=gid, summary=summary(room))
    return entry


def stop(gid: str, thread: str | None = None) -> None:
    room = load(gid)
    if not room:
        return
    room["epoch"] += 1
    threads = [thread] if thread else None
    for member, per in room["sessions"].items():
        for t, sid in per.items():
            if threads is None or t in threads:
                _runtime.interrupt(sid)
    for key in list(_rerun):
        if key[0] == gid and (thread is None or key[1] == thread):
            _rerun.discard(key)
    save(room)


async def compress(gid: str) -> dict[str, Any]:
    room = load(gid)
    if not room:
        raise GroupError("群聊不存在")
    n = 0
    for member, per in room["sessions"].items():
        for sid in per.values():
            r = await _runtime.compress(member, sid, keep=2)
            n += 1 if r.get("ok") else 0
    return {"ok": True, "sessions": n}
