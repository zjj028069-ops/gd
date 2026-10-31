"""Minimal MCP client (stdio + streamable HTTP), no SDK dependency.

Each bot lists its servers in profile.json → mcp_servers:
    {"name": "fs", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
     "env": {}, "enabled": true}
    {"name": "remote", "url": "https://example.com/mcp", "headers": {}, "enabled": true}
Their tools are exposed to the model as mcp_<server>_<tool>."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from typing import Any

import httpx

PROTOCOL = "2024-11-05"
INIT_TIMEOUT = 30
RETRY_AFTER = 60
CLIENT_INFO = {"name": "sedric-bots", "version": "1.0"}


class MCPError(Exception):
    pass


class StdioClient:
    def __init__(self, cfg: dict[str, Any], cwd: str):
        self.cfg = cfg
        self.cwd = cwd
        self.proc: subprocess.Popen | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.pending: dict[int, asyncio.Future] = {}
        self.next_id = 1
        self.stderr_tail: list[str] = []
        self.lock = threading.Lock()

    async def start(self) -> None:
        self.loop = asyncio.get_running_loop()
        cmd = self.cfg.get("command") or ""
        exe = shutil.which(cmd) or cmd
        argv = [exe, *[str(a) for a in (self.cfg.get("args") or [])]]
        env = {**os.environ, **{k: str(v) for k, v in (self.cfg.get("env") or {}).items()}}
        kw: dict[str, Any] = {}
        if sys.platform == "win32":
            kw["creationflags"] = subprocess.CREATE_NO_WINDOW
        try:
            self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         cwd=self.cwd, env=env, **kw)
        except OSError as e:
            raise MCPError(f"无法启动 MCP 服务器「{cmd}」：{e}") from e
        threading.Thread(target=self._read_out, daemon=True).start()
        threading.Thread(target=self._read_err, daemon=True).start()

    def _read_out(self) -> None:
        assert self.proc and self.proc.stdout
        for raw in iter(self.proc.stdout.readline, b""):
            try:
                msg = json.loads(raw.decode("utf-8", "replace"))
            except json.JSONDecodeError:
                continue
            mid = msg.get("id")
            if mid is not None and mid in self.pending and ("result" in msg or "error" in msg):
                fut = self.pending.pop(mid)
                if self.loop:
                    self.loop.call_soon_threadsafe(lambda f=fut, m=msg: f.done() or f.set_result(m))
        for fut in list(self.pending.values()):
            if self.loop:
                self.loop.call_soon_threadsafe(lambda f=fut: f.done() or f.set_exception(
                    MCPError("MCP 服务器已退出：" + " ".join(self.stderr_tail[-5:]))))
        self.pending.clear()

    def _read_err(self) -> None:
        assert self.proc and self.proc.stderr
        for raw in iter(self.proc.stderr.readline, b""):
            self.stderr_tail = (self.stderr_tail + [raw.decode("utf-8", "replace").strip()])[-20:]

    def _write(self, obj: dict[str, Any]) -> None:
        if not self.proc or self.proc.poll() is not None or not self.proc.stdin:
            raise MCPError("MCP 服务器未运行：" + " ".join(self.stderr_tail[-5:]))
        with self.lock:
            self.proc.stdin.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
            self.proc.stdin.flush()

    async def request(self, method: str, params: dict[str, Any] | None = None, timeout: float = 60) -> Any:
        assert self.loop
        mid = self.next_id
        self.next_id += 1
        fut = self.loop.create_future()
        self.pending[mid] = fut
        self._write({"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}})
        try:
            msg = await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError as e:
            self.pending.pop(mid, None)
            raise MCPError(f"MCP 请求超时：{method}") from e
        if "error" in msg:
            raise MCPError(f"MCP 错误：{msg['error'].get('message')}")
        return msg.get("result")

    async def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self._write({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def alive(self) -> bool:
        return bool(self.proc and self.proc.poll() is None)

    def close(self) -> None:
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.kill()
            except Exception:
                pass


class HttpClient:
    def __init__(self, cfg: dict[str, Any]):
        self.url = cfg["url"]
        self.headers = {k: str(v) for k, v in (cfg.get("headers") or {}).items()}
        self.session_id: str | None = None
        self.next_id = 1

    async def start(self) -> None:
        return None

    async def _post(self, body: dict[str, Any], timeout: float) -> Any:
        h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", **self.headers}
        if self.session_id:
            h["Mcp-Session-Id"] = self.session_id
        async with httpx.AsyncClient(timeout=timeout, trust_env=True) as c:
            r = await c.post(self.url, json=body, headers=h)
        if r.headers.get("mcp-session-id"):
            self.session_id = r.headers["mcp-session-id"]
        if r.status_code >= 400:
            raise MCPError(f"MCP HTTP {r.status_code}: {r.text[:300]}")
        if "id" not in body:
            return None
        if "text/event-stream" in r.headers.get("content-type", ""):
            for line in r.text.splitlines():
                if line.startswith("data:"):
                    try:
                        msg = json.loads(line[5:].strip())
                    except json.JSONDecodeError:
                        continue
                    if msg.get("id") == body["id"]:
                        return msg
            raise MCPError("MCP 服务器没有返回结果")
        return r.json()

    async def request(self, method: str, params: dict[str, Any] | None = None, timeout: float = 60) -> Any:
        mid = self.next_id
        self.next_id += 1
        msg = await self._post({"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}}, timeout)
        if msg.get("error"):
            raise MCPError(f"MCP 错误：{msg['error'].get('message')}")
        return msg.get("result")

    async def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        await self._post({"jsonrpc": "2.0", "method": method, "params": params or {}}, 30)

    def alive(self) -> bool:
        return True

    def close(self) -> None:
        return None


class Server:
    def __init__(self, cfg: dict[str, Any], cwd: str):
        self.cfg = cfg
        self.client = HttpClient(cfg) if cfg.get("url") else StdioClient(cfg, cwd)
        self.tools: list[dict[str, Any]] = []
        self.ready = False
        self.error: str | None = None
        self.failed_at = 0.0
        self.lock = asyncio.Lock()

    async def ensure(self) -> None:
        async with self.lock:
            if self.ready and self.client.alive():
                return
            # A server that just failed is not retried on every turn (each
            # attempt can take up to the init timeout).
            if self.failed_at and time.monotonic() - self.failed_at < RETRY_AFTER:
                raise MCPError(self.error or "MCP 服务器不可用")
            if not self.client.alive():
                self.client = HttpClient(self.cfg) if self.cfg.get("url") else StdioClient(self.client.cfg, self.client.cwd)
            try:
                await self.client.start()
                await self.client.request("initialize", {"protocolVersion": PROTOCOL, "capabilities": {},
                                                         "clientInfo": CLIENT_INFO}, timeout=INIT_TIMEOUT)
                await self.client.notify("notifications/initialized")
                res = await self.client.request("tools/list", {}, timeout=60)
                self.tools = (res or {}).get("tools", [])
                self.ready = True
                self.error = None
                self.failed_at = 0.0
            except Exception as e:  # noqa: BLE001
                self.error = str(e)
                self.ready = False
                self.failed_at = time.monotonic()
                self.client.close()
                raise

    async def call(self, tool: str, args: dict[str, Any]) -> str:
        await self.ensure()
        res = await self.client.request("tools/call", {"name": tool, "arguments": args}, timeout=300) or {}
        parts = []
        for c in res.get("content", []):
            if c.get("type") == "text":
                parts.append(c.get("text", ""))
            elif c.get("type") == "image":
                parts.append(f"[图片 {c.get('mimeType')}，{len(c.get('data', ''))} 字节 base64]")
            elif c.get("type") == "resource":
                r = c.get("resource") or {}
                parts.append(r.get("text") or f"[资源 {r.get('uri')}]")
        text = "\n".join(parts) or json.dumps(res, ensure_ascii=False)[:4000]
        return ("[工具报错] " if res.get("isError") else "") + text


_servers: dict[str, Server] = {}


def _key(bot: str, cfg: dict[str, Any]) -> str:
    return bot + ":" + hashlib.md5(json.dumps(cfg, sort_keys=True).encode()).hexdigest()


def tool_name(server: str, tool: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "_", f"mcp_{server}_{tool}")[:64]


async def server_for(bot: str, cfg: dict[str, Any], cwd: str) -> Server:
    k = _key(bot, cfg)
    if k not in _servers:
        _servers[k] = Server(cfg, cwd)
    return _servers[k]


async def tools_for(bot: str, servers: list[dict[str, Any]], cwd: str) -> list[tuple[dict[str, Any], Server, str]]:
    """[(openai_schema, server, original_tool_name)] for every enabled server that starts."""
    out = []
    for cfg in servers:
        if not cfg.get("enabled", True) or not cfg.get("name"):
            continue
        srv = await server_for(bot, cfg, cwd)
        try:
            await srv.ensure()
        except Exception:  # noqa: BLE001
            continue
        for t in srv.tools:
            out.append(({"type": "function", "function": {
                "name": tool_name(cfg["name"], t["name"]),
                "description": f"[MCP {cfg['name']}] " + (t.get("description") or "")[:900],
                "parameters": t.get("inputSchema") or {"type": "object", "properties": {}}}}, srv, t["name"]))
    return out


async def test_server(bot: str, cfg: dict[str, Any], cwd: str) -> dict[str, Any]:
    srv = Server(cfg, cwd)
    try:
        await srv.ensure()
        return {"ok": True, "tools": [{"name": t["name"], "description": t.get("description", "")} for t in srv.tools]}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
    finally:
        srv.client.close()


def shutdown() -> None:
    for s in _servers.values():
        s.client.close()
    _servers.clear()
