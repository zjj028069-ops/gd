"""terminal + process tools: run shell commands in the bot's workspace, with
approval for dangerous commands and optional background processes."""
from __future__ import annotations

import asyncio
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from .. import bots, settings
from ..storage import new_id, truncate
from . import Tool, ToolCtx, err, obj, ok, register

IS_WIN = sys.platform == "win32"

DANGEROUS = [
    (r"\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r|--recursive)\b", "递归删除文件"),
    (r"\b(del|erase)\s+.*(/s|/q)", "批量删除文件"),
    (r"\b(rd|rmdir)\s+.*/s", "删除目录树"),
    (r"remove-item\b.*-recurse", "递归删除文件"),
    (r"\bformat(\.com)?\s+[a-z]:", "格式化磁盘"),
    (r"\bmkfs\b|\bdiskpart\b|\bdd\s+if=", "磁盘级操作"),
    (r"\b(shutdown|reboot|halt|poweroff)\b|stop-computer|restart-computer", "关机/重启"),
    (r"\breg\s+(delete|add)\b|remove-itemproperty|set-itemproperty\s+.*hk(lm|cu)", "修改注册表"),
    (r"git\s+push\s+.*(--force|-f)\b|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f", "不可逆的 Git 操作"),
    (r"chmod\s+-r\s+777|chown\s+-r", "批量修改权限"),
    (r"(curl|wget|iwr|invoke-webrequest)[^|]*\|\s*(sh|bash|iex|invoke-expression|python)", "下载并直接执行脚本"),
    (r"\btaskkill\b.*\/f|stop-process\b.*-force|\bkill\s+-9", "强制结束进程"),
    (r"set-executionpolicy|\bnet\s+user\b|\bcipher\s+/w", "系统安全设置"),
    (r">\s*/dev/sd|:\(\)\s*\{", "危险的 shell 操作"),
]


def dangerous_reason(command: str) -> str | None:
    low = command.lower()
    for pat, why in DANGEROUS:
        if re.search(pat, low):
            return why
    return None


def approval_mode(ctx: ToolCtx) -> str:
    mode = ctx.profile.get("approval") or "inherit"
    if mode == "inherit":
        mode = settings.load().get("approval_mode", "smart")
    return mode


def workspace(ctx: ToolCtx) -> Path:
    d = bots.bot_dir(ctx.bot) / "workspace"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _decode(b: bytes) -> str:
    for enc in ("utf-8", "gbk"):
        try:
            return b.decode(enc)
        except UnicodeDecodeError:
            continue
    return b.decode("utf-8", "replace")


def _argv(command: str) -> list[str]:
    if IS_WIN:
        prefix = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; "
        return ["powershell", "-NoProfile", "-NonInteractive", "-Command", prefix + command]
    return ["bash", "-lc", command]


def _popen(command: str, cwd: Path, stdout, stderr) -> subprocess.Popen:
    kw: dict[str, Any] = {}
    if IS_WIN:
        kw["creationflags"] = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    return subprocess.Popen(_argv(command), cwd=str(cwd), stdout=stdout, stderr=stderr, stdin=subprocess.DEVNULL,
                            env=env, **kw)


def _kill(p: subprocess.Popen) -> None:
    try:
        if IS_WIN:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)], capture_output=True)
        else:
            import signal
            os.killpg(p.pid, signal.SIGKILL)
    except Exception:
        try:
            p.kill()
        except Exception:
            pass


def _run_blocking(command: str, cwd: Path, timeout: int, stop: threading.Event) -> tuple[int | None, str, str]:
    p = _popen(command, cwd, subprocess.PIPE, subprocess.PIPE)
    out: list[bytes] = []
    errs: list[bytes] = []

    def pump(stream, acc):
        for chunk in iter(lambda: stream.read(4096), b""):
            acc.append(chunk)

    ts = [threading.Thread(target=pump, args=(p.stdout, out), daemon=True),
          threading.Thread(target=pump, args=(p.stderr, errs), daemon=True)]
    for t in ts:
        t.start()
    start = time.time()
    status = "ok"
    while p.poll() is None:
        if stop.is_set():
            _kill(p)
            status = "interrupted"
            break
        if time.time() - start > timeout:
            _kill(p)
            status = "timeout"
            break
        time.sleep(0.1)
    for t in ts:
        t.join(timeout=2)
    return p.returncode, _decode(b"".join(out)), _decode(b"".join(errs)) + ("" if status == "ok" else f"\n[{status}]")


# ── background processes ─────────────────────────────────────────────────────

PROCS: dict[str, dict[str, Any]] = {}


async def terminal(ctx: ToolCtx, args: dict[str, Any]) -> str:
    command = (args.get("command") or "").strip()
    if not command:
        return err("command 不能为空")
    cwd = Path(args.get("cwd") or workspace(ctx))
    if not cwd.is_absolute():
        cwd = workspace(ctx) / cwd
    if not cwd.exists():
        return err(f"工作目录不存在：{cwd}")
    mode = approval_mode(ctx)
    reason = dangerous_reason(command)
    if mode == "always" or (mode == "smart" and reason):
        approved = await ctx.approve("执行命令" + (f"（{reason}）" if reason else ""), command)
        if not approved:
            return err("用户拒绝了这条命令。换一种更安全的做法，或者先向用户说明原因。")
    timeout = max(5, min(int(args.get("timeout") or 120), 1800))
    if args.get("background"):
        pid = new_id("proc")
        log = bots.bot_dir(ctx.bot) / "workspace" / ".hb_proc" / f"{pid}.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        fh = open(log, "wb")
        p = _popen(command, cwd, fh, subprocess.STDOUT)
        PROCS[pid] = {"id": pid, "bot": ctx.bot, "command": command, "proc": p, "log": log, "fh": fh,
                      "started": time.time()}
        return ok({"status": "started", "process_id": pid, "pid": p.pid,
                   "hint": "用 process 工具（action=poll/kill）查看输出或结束它。"})
    stop = threading.Event()

    async def watch():
        await ctx.cancel.wait()
        stop.set()

    w = asyncio.create_task(watch())
    try:
        code, out, errs = await asyncio.to_thread(_run_blocking, command, cwd, timeout, stop)
    finally:
        w.cancel()
    return ok({"exit_code": code, "stdout": truncate(out, 12000), "stderr": truncate(errs, 4000), "cwd": str(cwd)})


async def process(ctx: ToolCtx, args: dict[str, Any]) -> str:
    action = args.get("action") or "list"
    if action == "list":
        return ok([{"process_id": k, "command": v["command"], "running": v["proc"].poll() is None,
                    "exit_code": v["proc"].poll()} for k, v in PROCS.items() if v["bot"] == ctx.bot])
    rec = PROCS.get(args.get("process_id") or "")
    if not rec or rec["bot"] != ctx.bot:
        return err("找不到这个后台进程")
    if action == "kill":
        _kill(rec["proc"])
        return ok({"status": "killed"})
    if action == "wait":
        t0 = time.time()
        while rec["proc"].poll() is None and time.time() - t0 < min(int(args.get("timeout") or 60), 600):
            if ctx.cancel.is_set():
                break
            await asyncio.sleep(0.5)
    rec["fh"].flush()
    data = _decode(rec["log"].read_bytes()) if rec["log"].exists() else ""
    return ok({"running": rec["proc"].poll() is None, "exit_code": rec["proc"].poll(), "output_tail": data[-8000:]})


register(Tool(
    "terminal", "terminal",
    "在你的工作目录里执行一条 shell 命令（Windows 上是 PowerShell，其他系统是 bash），返回 stdout/stderr。"
    "危险命令会先请求用户批准。长时间运行的程序（服务器、监听）用 background=true。",
    obj({
        "command": {"type": "string", "description": "要执行的命令"},
        "cwd": {"type": "string", "description": "工作目录（默认是你的 workspace）"},
        "timeout": {"type": "integer", "description": "超时秒数，默认 120"},
        "background": {"type": "boolean", "description": "后台运行，立即返回 process_id"},
    }, ["command"]),
    terminal,
))

register(Tool(
    "process", "terminal",
    "管理 terminal 启动的后台进程：list 列出、poll 查看输出、wait 等待结束、kill 结束。",
    obj({"action": {"type": "string", "enum": ["list", "poll", "wait", "kill"]},
         "process_id": {"type": "string"}, "timeout": {"type": "integer"}}, ["action"]),
    process,
))
