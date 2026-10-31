"""Bots = profiles. Each bot owns a directory:

    data/bots/<name>/
        profile.json        identity, avatar, model, tools, MCP, roster flags
        SOUL.md             persona (the user's identity text)
        memories/MEMORY.md  agent's own notes   (entries separated by §)
        memories/USER.md    what it knows about the user
        skills/<id>/SKILL.md
        sessions/<id>.json
        cron.json
        workspace/          default cwd for terminal / file tools
"""
from __future__ import annotations

import hashlib
import re
import shutil
from pathlib import Path
from typing import Any

from .storage import BOTS_DIR, DATA, NAME_RE, now_ms, new_id, read_json, read_text, write_json, write_text

BUNDLED_SKILLS = Path(__file__).parent / "bundled_skills"
UI_PATH = DATA / "ui.json"

AVATAR_COLORS = ["#8b5cf6", "#3b82f6", "#06b6d4", "#10b981", "#84cc16", "#f59e0b", "#f97316",
                 "#ef4444", "#ec4899", "#a855f7", "#64748b", "#0f172a", "#7f1d1d", "#d6c7a1"]
AVATAR_SHAPES = ["circle", "blob", "squircle", "pill", "triangle", "hexagon", "cloud", "drop", "pebble"]

ALL_TOOLS = ["terminal", "files", "web", "memory", "skills", "message_agent", "cronjob", "clarify", "mcp"]
TOOL_LABELS = {
    "terminal": "终端命令", "files": "读写文件", "web": "联网搜索/抓取", "memory": "长期记忆",
    "skills": "技能", "message_agent": "给队友发消息", "cronjob": "定时任务", "clarify": "向你提问", "mcp": "MCP 工具",
}

MEMORY_LIMIT = 2200
USER_LIMIT = 1400
ENTRY_SEP = "\n§\n"


SKILL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


class BotError(Exception):
    pass


def bot_dir(name: str) -> Path:
    # Names come straight from URLs; never let one escape the bots directory.
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise BotError("机器人不存在")
    return BOTS_DIR / name


def skill_dir(bot: str, sid: str) -> Path:
    if not isinstance(sid, str) or not SKILL_ID_RE.match(sid):
        raise BotError("技能不存在")
    return bot_dir(bot) / "skills" / sid


def _hash(name: str) -> int:
    return int(hashlib.md5(name.encode()).hexdigest()[:8], 16)


def default_avatar(name: str) -> dict[str, Any]:
    h = _hash(name)
    return {"shape": AVATAR_SHAPES[h % len(AVATAR_SHAPES)], "color": AVATAR_COLORS[(h // 7) % len(AVATAR_COLORS)],
            "image": None, "custom": False}


def exists(name: str) -> bool:
    if not isinstance(name, str) or not NAME_RE.match(name):
        return False
    return (bot_dir(name) / "profile.json").exists()


def names() -> list[str]:
    return sorted(p.parent.name for p in BOTS_DIR.glob("*/profile.json") if NAME_RE.match(p.parent.name))


def load(name: str) -> dict[str, Any] | None:
    if not exists(name):
        return None
    prof = read_json(bot_dir(name) / "profile.json", None)
    if prof is None:
        return None
    prof.setdefault("name", name)
    prof.setdefault("title", "")
    prof.setdefault("description", "")
    prof.setdefault("avatar", default_avatar(name))
    prof.setdefault("tools", {t: True for t in ALL_TOOLS})
    for t in ALL_TOOLS:
        prof["tools"].setdefault(t, True)
    prof.setdefault("model", None)
    prof.setdefault("approval", "inherit")
    prof.setdefault("mcp_servers", [])
    prof.setdefault("pinned", False)
    prof.setdefault("hidden", False)
    prof.setdefault("section", None)
    prof.setdefault("previous_names", [])
    prof.setdefault("screen_auto_open", False)
    prof.setdefault("created", now_ms())
    return prof


def save(prof: dict[str, Any]) -> None:
    write_json(bot_dir(prof["name"]) / "profile.json", prof)


def display_name(prof: dict[str, Any]) -> str:
    return prof.get("title") or prof["name"]


def handle(name: str) -> str:
    return name


# ── SOUL ─────────────────────────────────────────────────────────────────────


def compose_soul(name: str, title: str, description: str, help_prompt: str = "") -> str:
    who = title or name
    lines = [f"# {who}", ""]
    lines.append(f"你是 **{who}**（@{name}），一个拥有独立记忆、技能和聊天记录的 AI 队友。")
    if description:
        lines += ["", "## 职责", description.strip()]
    if help_prompt:
        lines += ["", "## 用户希望你帮忙做的事", help_prompt.strip()]
    lines += [
        "",
        "## 风格",
        "- 用用户使用的语言回复（默认中文），直接、具体、有温度。",
        "- 先给结论，再给必要的细节；不确定时说明不确定，或者用 clarify 工具问清楚。",
        "- 动手做事前想清楚，做完后简短汇报结果。",
    ]
    return "\n".join(lines) + "\n"


def get_soul(name: str) -> str:
    return read_text(bot_dir(name) / "SOUL.md")


def set_soul(name: str, text: str) -> None:
    write_text(bot_dir(name) / "SOUL.md", text)


# ── memory ───────────────────────────────────────────────────────────────────


def memory_path(name: str, target: str) -> Path:
    return bot_dir(name) / "memories" / ("USER.md" if target == "user" else "MEMORY.md")


def memory_entries(name: str, target: str) -> list[str]:
    raw = read_text(memory_path(name, target)).strip()
    return [e.strip() for e in raw.split("§") if e.strip()] if raw else []


def set_memory_entries(name: str, target: str, entries: list[str]) -> None:
    write_text(memory_path(name, target), ENTRY_SEP.join(e.strip() for e in entries if e.strip()) + "\n")


def memory_limit(target: str) -> int:
    return USER_LIMIT if target == "user" else MEMORY_LIMIT


# ── skills ───────────────────────────────────────────────────────────────────

_FM = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", re.S)


def parse_skill(text: str, fallback_id: str) -> dict[str, Any]:
    meta: dict[str, str] = {}
    body = text
    m = _FM.match(text or "")
    if m:
        body = m.group(2)
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip().strip('"').strip("'")
    return {"id": fallback_id, "name": meta.get("name") or fallback_id, "description": meta.get("description", ""),
            "body": body.strip(), "raw": text}


def skill_text(name: str, description: str, body: str) -> str:
    return f"---\nname: {name}\ndescription: {description}\n---\n\n{body.strip()}\n"


def list_skills(bot: str) -> list[dict[str, Any]]:
    prof = load(bot) or {}
    disabled = set(prof.get("skills_disabled") or [])
    out = []
    for p in sorted((bot_dir(bot) / "skills").glob("*/SKILL.md")):
        s = parse_skill(read_text(p), p.parent.name)
        s["enabled"] = s["id"] not in disabled
        s.pop("raw", None)
        out.append(s)
    return out


def get_skill(bot: str, sid: str) -> dict[str, Any] | None:
    p = skill_dir(bot, sid) / "SKILL.md"
    if not p.exists():
        return None
    return parse_skill(read_text(p), sid)


def slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:40].strip("-")
    if s and (len(s) >= 3 or text.isascii()):
        return s
    # Non-ASCII names (e.g. Chinese) get a stable id so updates hit the same skill.
    return "skill-" + hashlib.md5((text or "skill").encode()).hexdigest()[:10]


def put_skill(bot: str, sid: str, name: str, description: str, body: str) -> dict[str, Any]:
    sid = slug(sid or name)
    write_text(skill_dir(bot, sid) / "SKILL.md", skill_text(name or sid, description, body))
    return get_skill(bot, sid)  # type: ignore[return-value]


def delete_skill(bot: str, sid: str) -> bool:
    d = skill_dir(bot, sid)
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)
        return True
    return False


def bundled_skills() -> list[dict[str, Any]]:
    out = []
    for p in sorted(BUNDLED_SKILLS.glob("*/SKILL.md")):
        s = parse_skill(read_text(p), p.parent.name)
        s.pop("raw", None)
        out.append(s)
    return out


def install_bundled(bot: str, ids: list[str] | None = None) -> None:
    for p in BUNDLED_SKILLS.glob("*/SKILL.md"):
        if ids is not None and p.parent.name not in ids:
            continue
        dest = skill_dir(bot, p.parent.name) / "SKILL.md"
        if not dest.exists():
            write_text(dest, read_text(p))


# ── lifecycle ────────────────────────────────────────────────────────────────


def validate_name(name: str) -> str:
    name = (name or "").strip().lower()
    if not NAME_RE.match(name):
        raise BotError("名称只能包含小写字母、数字、- 和 _，并以字母或数字开头（最多 32 个字符）。")
    if name in ("user", "everyone", "all", "you"):
        raise BotError(f"「{name}」是保留名称。")
    return name


def create(data: dict[str, Any]) -> dict[str, Any]:
    name = validate_name(data.get("name", ""))
    if exists(name):
        raise BotError(f"名称「{name}」已被占用。")
    clone = data.get("clone_from")
    d = bot_dir(name)
    if clone and exists(clone):
        src = bot_dir(clone)
        d.mkdir(parents=True, exist_ok=True)
        for f in ("SOUL.md",):
            if (src / f).exists():
                shutil.copy(src / f, d / f)
        if (src / "memories").exists():
            shutil.copytree(src / "memories", d / "memories", dirs_exist_ok=True)
        if (src / "skills").exists():
            shutil.copytree(src / "skills", d / "skills", dirs_exist_ok=True)
        base = load(clone) or {}
    else:
        base = {}
    title = (data.get("title") or "").strip()
    description = (data.get("description") or "").strip()
    prof = {
        "name": name,
        "title": title,
        "description": description,
        "avatar": data.get("avatar") or default_avatar(name),
        "tools": data.get("tools") or base.get("tools") or {t: True for t in ALL_TOOLS},
        "model": data.get("model") if data.get("model") is not None else base.get("model"),
        "approval": data.get("approval") or base.get("approval") or "inherit",
        "mcp_servers": data.get("mcp_servers") or base.get("mcp_servers") or [],
        "skills_disabled": base.get("skills_disabled", []),
        "pinned": False,
        "hidden": False,
        "section": data.get("section"),
        "created": now_ms(),
        "previous_names": [],
    }
    save(prof)
    soul = (data.get("soul") or "").strip()
    if soul:
        set_soul(name, soul + "\n")
    elif not (d / "SOUL.md").exists():
        set_soul(name, compose_soul(name, title, description, data.get("help_prompt", "")))
    for t in ("memory", "user"):
        if not memory_path(name, t).exists():
            write_text(memory_path(name, t), "")
    if not clone and not data.get("empty_skills"):
        install_bundled(name, data.get("skills"))
    (d / "workspace").mkdir(parents=True, exist_ok=True)
    (d / "sessions").mkdir(parents=True, exist_ok=True)
    return load(name)  # type: ignore[return-value]


PATCHABLE = {"title", "description", "avatar", "tools", "model", "approval", "mcp_servers", "pinned", "hidden",
             "section", "skills_disabled", "screen_auto_open"}


def update(name: str, patch: dict[str, Any]) -> dict[str, Any]:
    prof = load(name)
    if prof is None:
        raise BotError("机器人不存在。")
    for k, v in patch.items():
        if k in PATCHABLE:
            prof[k] = v
    if "avatar" in patch and isinstance(patch["avatar"], dict):
        prof["avatar"] = {**default_avatar(name), **patch["avatar"]}
    save(prof)
    return prof


def rename(old: str, new: str) -> dict[str, Any]:
    new = validate_name(new)
    if not exists(old):
        raise BotError("机器人不存在。")
    if exists(new):
        raise BotError(f"名称「{new}」已被占用。")
    bot_dir(old).rename(bot_dir(new))
    prof = load(new) or {}
    prof["name"] = new
    prof["previous_names"] = sorted({*prof.get("previous_names", []), old})
    save(prof)
    soul = get_soul(new)
    if f"@{old}" in soul:
        set_soul(new, soul.replace(f"@{old}", f"@{new}"))
    return prof


def delete(name: str) -> None:
    d = bot_dir(name)
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)


def duplicate(name: str) -> dict[str, Any]:
    prof = load(name)
    if prof is None:
        raise BotError("机器人不存在。")
    i = 2
    while exists(f"{name}-{i}"):
        i += 1
    new = f"{name}-{i}"[:32]
    created = create({
        "name": new, "title": (prof.get("title") or name) + f" {i}", "description": prof.get("description", ""),
        "clone_from": name, "avatar": {**prof["avatar"]},
    })
    return created


def ensure_default() -> None:
    if not names():
        create({"name": "jie", "title": "Jie", "description": "你的主力助手：什么都能聊，什么都能帮你安排，也负责协调其他队友。",
                "avatar": {"shape": "squircle", "color": "#8b5cf6", "image": None, "custom": True}})


# ── roster UI state (sections) ───────────────────────────────────────────────


def ui_state() -> dict[str, Any]:
    st = read_json(UI_PATH, None) or {}
    st.setdefault("sections", [])
    st.setdefault("collapsed", [])
    return st


def save_ui_state(patch: dict[str, Any]) -> dict[str, Any]:
    st = ui_state()
    for k in ("sections", "collapsed", "bot_order"):
        if k in patch:
            st[k] = patch[k]
    write_json(UI_PATH, st)
    return st
