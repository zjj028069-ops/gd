"""Routines: per-bot scheduled tasks (Hermes cron jobs).

A due job runs its instruction in the job's own hidden session, then posts the
result into the bot's Bot Chat so you see it where you already talk to it."""
from __future__ import annotations

import asyncio
import re
from datetime import datetime
from typing import Any

from croniter import croniter

from . import bots, sessions
from .events import bus
from .storage import new_id, now_ms, read_json, truncate, write_json

TICK_SECONDS = 10
HISTORY_KEEP = 30


class CronError(Exception):
    pass


_runtime = None
_running: set[str] = set()


def set_runtime(rt) -> None:
    global _runtime
    _runtime = rt


# ── schedule parsing ─────────────────────────────────────────────────────────

_DAYS = {"monday": 1, "mon": 1, "tuesday": 2, "tue": 2, "wednesday": 3, "wed": 3, "thursday": 4, "thu": 4,
         "friday": 5, "fri": 5, "saturday": 6, "sat": 6, "sunday": 0, "sun": 0,
         "周一": 1, "周二": 2, "周三": 3, "周四": 4, "周五": 5, "周六": 6, "周日": 0, "周天": 0,
         "星期一": 1, "星期二": 2, "星期三": 3, "星期四": 4, "星期五": 5, "星期六": 6, "星期日": 0, "星期天": 0}
_UNITS = {"m": 1, "min": 1, "mins": 1, "minute": 1, "minutes": 1, "分钟": 1, "分": 1,
          "h": 60, "hr": 60, "hour": 60, "hours": 60, "小时": 60, "时": 60,
          "d": 1440, "day": 1440, "days": 1440, "天": 1440}


def _duration(text: str) -> int | None:
    m = re.fullmatch(r"\s*(\d+)\s*([a-z一-鿿]+)\s*", text)
    if not m or m.group(2) not in _UNITS:
        return None
    return int(m.group(1)) * _UNITS[m.group(2)]


def _time(text: str) -> tuple[int, int] | None:
    m = re.search(r"(上午|下午|晚上|早上|中午)?\s*(\d{1,2})(?::|：|点)?(半|\d{2})?\s*(am|pm)?", text)
    if not m:
        return None
    h = int(m.group(2))
    mi = 30 if m.group(3) == "半" else int(m.group(3) or 0)
    ap = m.group(4) or m.group(1)
    if ap in ("pm", "下午", "晚上") and h < 12:
        h += 12
    if ap in ("am", "上午") and h == 12:
        h = 0
    if h > 23 or mi > 59:
        return None
    return h, mi


def humanize_cron(expr: str) -> str:
    mi, h, dom, mon, dow = expr.split()
    if not (mi.isdigit() and h.isdigit()) or dom != "*" or mon != "*":
        if mi.isdigit() and h == "*" and dom == mon == dow == "*":
            return f"每小时第 {int(mi)} 分"
        return f"cron {expr}"
    hhmm = f"{int(h):02d}:{int(mi):02d}"
    if dow == "*":
        return f"每天 {hhmm}"
    if dow == "1-5":
        return f"工作日 {hhmm}"
    if dow in ("0,6", "6,0"):
        return f"周末 {hhmm}"
    if dow.isdigit() and int(dow) <= 7:
        return f"每周{'日一二三四五六日'[int(dow)]} {hhmm}"
    return f"cron {expr}"


def parse_schedule(text: str) -> dict[str, Any]:
    raw = (text or "").strip()
    s = raw.lower().strip()
    if not s:
        raise CronError("schedule 不能为空")
    # one-shot relative: "in 10m" / "10分钟后"
    m = re.fullmatch(r"in\s+(.+)", s) or re.fullmatch(r"(.+?)后", s)
    if m and (mins := _duration(m.group(1))):
        return {"kind": "once", "run_at": now_ms() + mins * 60_000, "display": f"{mins} 分钟后执行一次"}
    # interval: "30m", "every 2h", "每30分钟"
    m = re.fullmatch(r"(?:every|每)?\s*(.+)", s)
    if m and (mins := _duration(m.group(1))):
        return {"kind": "interval", "minutes": mins, "display": f"每 {mins} 分钟" if mins < 60 or mins % 60
                else (f"每 {mins // 60} 小时" if mins % 1440 else f"每 {mins // 1440} 天")}
    # cron expression
    parts = raw.split()
    if len(parts) == 5 and all(re.fullmatch(r"[A-Za-z\d\*\-,/]+", p) for p in parts):
        if not croniter.is_valid(raw):
            raise CronError(f"cron 表达式无效：{raw}")
        return {"kind": "cron", "expr": raw, "display": humanize_cron(raw)}
    # natural phrases → cron
    tm = _time(s)
    if tm:
        h, mi = tm
        hhmm = f"{h:02d}:{mi:02d}"
        if re.search(r"weekday|工作日", s):
            return {"kind": "cron", "expr": f"{mi} {h} * * 1-5", "display": f"工作日 {hhmm}"}
        if re.search(r"weekend|周末", s):
            return {"kind": "cron", "expr": f"{mi} {h} * * 0,6", "display": f"周末 {hhmm}"}
        for k, v in sorted(_DAYS.items(), key=lambda kv: -len(kv[0])):
            if re.search(rf"(?<![a-z]){k}(?![a-z])", s):
                return {"kind": "cron", "expr": f"{mi} {h} * * {v}", "display": f"每周{'日一二三四五六'[v]} {hhmm}"}
        if re.search(r"every\s*day|daily|每天|每日|day", s) or re.fullmatch(
                r"(at\s*)?(上午|下午|晚上|早上|中午)?\s*\d{1,2}([:：点](\d{2}|半)?)?\s*(am|pm)?", s):
            return {"kind": "cron", "expr": f"{mi} {h} * * *", "display": f"每天 {hhmm}"}
    # ISO timestamp
    if re.match(r"^\d{4}-\d{2}-\d{2}", raw):
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            return {"kind": "once", "run_at": int(dt.timestamp() * 1000), "display": f"{dt:%Y-%m-%d %H:%M} 执行一次"}
        except ValueError:
            pass
    raise CronError(f"看不懂这个时间：「{raw}」。可以写 '30m'、'every 2h'、'every day 09:00'、"
                    "'weekdays at 18:30'、'0 9 * * *' 或 '2026-01-01T09:00'。")


def next_run(job: dict[str, Any], after_ms: int | None = None) -> int | None:
    sch = job["schedule"]
    base = after_ms or now_ms()
    if sch["kind"] == "once":
        return sch["run_at"] if job.get("runs", 0) == 0 else None
    if sch["kind"] == "interval":
        anchor = job.get("last_run") or job.get("created") or base
        return anchor + sch["minutes"] * 60_000
    it = croniter(sch["expr"], datetime.fromtimestamp(base / 1000))
    return int(it.get_next(datetime).timestamp() * 1000)


# ── storage ──────────────────────────────────────────────────────────────────


def _path(bot: str):
    return bots.bot_dir(bot) / "cron.json"


def list_jobs(bot: str) -> list[dict[str, Any]]:
    return read_json(_path(bot), []) or []


def _save(bot: str, jobs: list[dict[str, Any]]) -> None:
    write_json(_path(bot), jobs)
    bus.publish("cron", bot=bot)


def brief(job: dict[str, Any]) -> dict[str, Any]:
    return {"job_id": job["id"], "name": job["name"], "schedule": job["schedule"]["display"],
            "enabled": job["enabled"], "runs": job.get("runs", 0), "max_runs": job.get("max_runs"),
            "next_run": datetime.fromtimestamp(job["next_run"] / 1000).strftime("%Y-%m-%d %H:%M")
            if job.get("next_run") else None}


def create_job(bot: str, data: dict[str, Any]) -> dict[str, Any]:
    if not bots.exists(bot):
        raise CronError("机器人不存在")
    instruction = (data.get("instruction") or "").strip()
    if not instruction:
        raise CronError("instruction 不能为空")
    schedule = parse_schedule(data.get("schedule") or "")
    max_runs = data.get("max_runs")
    job = {
        "id": new_id("job"), "bot": bot, "name": (data.get("name") or instruction[:24]).strip(),
        "instruction": instruction, "schedule": schedule, "schedule_text": data.get("schedule"),
        "enabled": True, "max_runs": int(max_runs) if max_runs not in (None, "", 0) else None, "runs": 0,
        "created": now_ms(), "last_run": None, "last_status": None, "history": [], "session_id": None,
    }
    job["next_run"] = next_run(job)
    jobs = list_jobs(bot)
    jobs.append(job)
    _save(bot, jobs)
    return job


def _find(bot: str, jid: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    jobs = list_jobs(bot)
    for j in jobs:
        if j["id"] == jid:
            return jobs, j
    raise CronError("找不到这个定时任务")


def update_job(bot: str, jid: str, patch: dict[str, Any]) -> dict[str, Any]:
    jobs, job = _find(bot, jid)
    if "schedule" in patch and patch["schedule"]:
        job["schedule"] = parse_schedule(patch["schedule"])
        job["schedule_text"] = patch["schedule"]
        job["runs"] = 0 if job["schedule"]["kind"] == "once" else job.get("runs", 0)
    for k in ("name", "instruction"):
        if patch.get(k):
            job[k] = patch[k].strip()
    if "max_runs" in patch:
        job["max_runs"] = int(patch["max_runs"]) if patch["max_runs"] not in (None, "", 0) else None
    if "enabled" in patch:
        job["enabled"] = bool(patch["enabled"])
    job["next_run"] = next_run(job) if job["enabled"] else None
    _save(bot, jobs)
    return job


def delete_job(bot: str, jid: str) -> None:
    jobs, job = _find(bot, jid)
    jobs.remove(job)
    _save(bot, jobs)


def trigger(bot: str, jid: str) -> None:
    _find(bot, jid)
    asyncio.get_running_loop().create_task(run_job(bot, jid, manual=True))


def rename_bot(old: str, new: str) -> None:
    jobs = list_jobs(new)
    for j in jobs:
        j["bot"] = new
    if jobs:
        _save(new, jobs)


# ── execution ────────────────────────────────────────────────────────────────


async def run_job(bot: str, jid: str, manual: bool = False) -> None:
    key = f"{bot}/{jid}"
    if key in _running or _runtime is None:
        return
    _running.add(key)
    started = now_ms()
    try:
        jobs, job = _find(bot, jid)
        job["last_status"] = "running"
        _save(bot, jobs)
        sess = sessions.get(job.get("session_id") or "") if job.get("session_id") else None
        if sess is None:
            sess = sessions.create(bot, f"Routine: {job['name']}", kind="routine", hidden=True, job_id=jid)
        n = job.get("runs", 0) + 1
        content = (f"[定时任务「{job['name']}」第 {n} 次执行 · {datetime.now():%Y-%m-%d %H:%M}]\n"
                   f"{job['instruction']}\n\n（这是自动执行的任务，用户此刻不在线；直接完成任务并给出简洁的结果汇报。）")
        status, output = "ok", ""
        try:
            output = await _runtime.run(bot, sess["id"], content, {"from": {"kind": "routine", "name": job["name"]}})
        except Exception as e:  # noqa: BLE001
            status, output = "error", f"执行失败：{e}"
        if not output.strip():
            output = "（任务完成，没有输出）"
        chat = sessions.canonical(bot)
        msg = sessions.append(chat, {"role": "assistant", "content": output,
                                     "meta": {"kind": "routine", "job_id": jid, "job_name": job["name"], "status": status}})
        bus.publish("message", sid=chat["id"], bot=bot, message=msg)
        bus.publish("session_meta", bot=bot, session=sessions.preview(chat))
        jobs, job = _find(bot, jid)
        job["runs"] = n
        job["last_run"] = started
        job["last_status"] = status
        job["session_id"] = sess["id"]
        job["history"] = ([{"at": started, "status": status, "output": truncate(output, 2000), "manual": manual,
                            "duration": now_ms() - started}] + job.get("history", []))[:HISTORY_KEEP]
        if job.get("max_runs") and n >= job["max_runs"]:
            job["enabled"] = False
        if job["schedule"]["kind"] == "once" and not manual:
            job["enabled"] = False
        job["next_run"] = next_run(job) if job["enabled"] else None
        _save(bot, jobs)
    except CronError:
        pass
    finally:
        _running.discard(key)


async def scheduler_loop() -> None:
    while True:
        try:
            t = now_ms()
            for bot in bots.names():
                for job in list_jobs(bot):
                    if job.get("enabled") and job.get("next_run") and job["next_run"] <= t:
                        if f"{bot}/{job['id']}" not in _running:
                            asyncio.get_running_loop().create_task(run_job(bot, job["id"]))
        except Exception as e:  # noqa: BLE001
            print("[cron] tick failed:", e)
        await asyncio.sleep(TICK_SECONDS)


def is_running(bot: str, jid: str) -> bool:
    return f"{bot}/{jid}" in _running
