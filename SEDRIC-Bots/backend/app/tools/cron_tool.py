"""cronjob: let a bot create and manage its own Routines (scheduled tasks)."""
from __future__ import annotations

from typing import Any

from .. import cron
from . import Tool, ToolCtx, err, obj, ok, register


async def cronjob(ctx: ToolCtx, args: dict[str, Any]) -> str:
    action = args.get("action") or "list"
    try:
        if action == "list":
            return ok([cron.brief(j) for j in cron.list_jobs(ctx.bot)])
        if action == "create":
            job = cron.create_job(ctx.bot, {
                "name": args.get("name") or "",
                "instruction": args.get("instruction") or "",
                "schedule": args.get("schedule") or "",
                "max_runs": args.get("max_runs"),
            })
            return ok({"status": "created", **cron.brief(job)})
        jid = args.get("job_id") or ""
        if action in ("pause", "resume"):
            job = cron.update_job(ctx.bot, jid, {"enabled": action == "resume"})
            return ok({"status": action + "d", **cron.brief(job)})
        if action == "update":
            patch = {k: args[k] for k in ("name", "instruction", "schedule", "max_runs") if args.get(k) is not None}
            job = cron.update_job(ctx.bot, jid, patch)
            return ok({"status": "updated", **cron.brief(job)})
        if action == "remove":
            cron.delete_job(ctx.bot, jid)
            return ok({"status": "removed"})
        if action == "run":
            cron.trigger(ctx.bot, jid)
            return ok({"status": "triggered"})
    except cron.CronError as e:
        return err(str(e))
    return err("未知 action")


register(Tool(
    "cronjob", "cronjob",
    "管理你的定时任务（Routines）。到点时你会在独立会话里执行 instruction，并把结果发到你的 Bot Chat。"
    "schedule 支持：'30m' / 'every 2h'（间隔）、'every day 09:00'、'every monday 9:00'、'weekdays at 18:30'、"
    "cron 表达式 '0 9 * * *'、一次性 ISO 时间 '2026-01-01T09:00'、或 'in 10m'（10 分钟后执行一次）。"
    "instruction 要写成未来的你能独立执行的完整指令。",
    obj({"action": {"type": "string", "enum": ["list", "create", "update", "pause", "resume", "remove", "run"]},
         "job_id": {"type": "string"}, "name": {"type": "string"}, "schedule": {"type": "string"},
         "instruction": {"type": "string"}, "max_runs": {"type": "integer", "description": "最多执行几次，空=无限"}},
        ["action"]),
    cronjob,
    available=lambda ctx: ctx.kind != "routine",
))
