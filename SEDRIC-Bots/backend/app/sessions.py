"""Chat sessions, one JSON file each, cached in memory.

A bot's canonical chat is the session titled exactly "Bot Chat" on that bot —
resolved by title, never by a stored pointer (same rule as Hermes Bot Mode)."""
from __future__ import annotations

import re
from typing import Any

from . import bots
from .storage import new_id, now_ms, read_json, write_json

BOT_CHAT_TITLE = "Bot Chat"

_cache: dict[str, dict[str, Any]] = {}
_index: dict[str, str] = {}  # sid -> bot


def _path(bot: str, sid: str):
    return bots.bot_dir(bot) / "sessions" / f"{sid}.json"


def rebuild_index() -> None:
    """Rescan disk. Cached session objects are kept (a running turn holds a
    reference to them — dropping the cache would fork the session and lose
    writes); only their owning bot is updated, e.g. after a rename."""
    _index.clear()
    for name in bots.names():
        for p in (bots.bot_dir(name) / "sessions").glob("*.json"):
            _index[p.stem] = name
    for sid in list(_cache):
        if sid in _index:
            _cache[sid]["bot"] = _index[sid]
        else:
            _cache.pop(sid)


def bot_of(sid: str) -> str | None:
    return _index.get(sid)


def get(sid: str) -> dict[str, Any] | None:
    if sid in _cache:
        return _cache[sid]
    bot = _index.get(sid)
    if not bot:
        return None
    s = read_json(_path(bot, sid), None)
    if s is None:
        _index.pop(sid, None)
        return None
    s["bot"] = bot
    s.setdefault("messages", [])
    _cache[sid] = s
    return s


def save(s: dict[str, Any]) -> None:
    s["updated"] = now_ms()
    write_json(_path(s["bot"], s["id"]), s)


def create(bot: str, title: str = "新聊天", kind: str = "chat", hidden: bool = False, **extra: Any) -> dict[str, Any]:
    sid = new_id("s")
    s = {"id": sid, "bot": bot, "title": title, "kind": kind, "hidden": hidden, "created": now_ms(),
         "updated": now_ms(), "last_read": now_ms(), "messages": [], **extra}
    _index[sid] = bot
    _cache[sid] = s
    save(s)
    return s


def list_for(bot: str, include_hidden: bool = False) -> list[dict[str, Any]]:
    out = []
    for sid, b in list(_index.items()):
        if b != bot:
            continue
        s = get(sid)
        if s and (include_hidden or not s.get("hidden")):
            out.append(s)
    out.sort(key=lambda s: (s.get("kind") != "botchat", -s.get("updated", 0)))
    return out


def canonical(bot: str, create_missing: bool = True) -> dict[str, Any] | None:
    for s in list_for(bot, include_hidden=True):
        if s.get("title") == BOT_CHAT_TITLE and s.get("kind") == "botchat":
            return s
    if not create_missing:
        return None
    return create(bot, BOT_CHAT_TITLE, kind="botchat")


def delete(sid: str) -> None:
    bot = _index.pop(sid, None)
    _cache.pop(sid, None)
    if bot:
        try:
            _path(bot, sid).unlink()
        except FileNotFoundError:
            pass


def drop_bot(bot: str) -> None:
    for sid, b in list(_index.items()):
        if b == bot:
            _index.pop(sid, None)
            _cache.pop(sid, None)


def append(s: dict[str, Any], msg: dict[str, Any]) -> dict[str, Any]:
    msg.setdefault("id", new_id("m"))
    msg.setdefault("at", now_ms())
    s["messages"].append(msg)
    save(s)
    return msg


def plain(text: str) -> str:
    """Markdown → one plain line for list previews."""
    text = re.sub(r"```.*?```", " [代码] ", text, flags=re.S)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "[图片]", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[*_`#>~|]+", "", text)
    text = re.sub(r"^\s*(?:[-+]|\d+\.)\s+", "", text, flags=re.M)
    return re.sub(r"\s+", " ", text).strip()


def preview(s: dict[str, Any]) -> dict[str, Any]:
    last = None
    for m in reversed(s.get("messages", [])):
        if m.get("role") in ("user", "assistant") and (m.get("content") or "").strip():
            last = m
            break
    unread = bool(last and last.get("role") == "assistant" and last.get("at", 0) > s.get("last_read", 0))
    return {
        "id": s["id"], "bot": s["bot"], "title": s.get("title"), "kind": s.get("kind"), "hidden": s.get("hidden", False),
        "created": s.get("created"), "updated": s.get("updated"),
        "last_active": last.get("at") if last else s.get("updated"),
        "preview": plain(last.get("content") or "")[:140] if last else "",
        "message_count": sum(1 for m in s.get("messages", []) if m.get("role") in ("user", "assistant")),
        "unread": unread,
    }


def public(s: dict[str, Any]) -> dict[str, Any]:
    return {**preview(s), "messages": s.get("messages", []), "summary": s.get("summary"), "group_id": s.get("group_id")}
