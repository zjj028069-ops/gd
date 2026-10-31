"""Calls the SEDRIC01 API on behalf of one logged-in MES user.

The base URL comes from the environment only, and callers pass fixed paths
built in code. Credentials live in memory only (never written to disk) and are
refreshed by every gateway request from that user."""
from __future__ import annotations

import os
import re
import secrets
import time
from typing import Any

import httpx

MES_URL = os.environ.get("SBOT_MES_URL", "http://127.0.0.1:3001").rstrip("/")
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
CRED_TTL = 8 * 3600  # same as the MES session lifetime

# owner ("<tenant_id>:<user_id>") -> {"cookie": "name=value", "csrf": str, "at": epoch, "name": str, "role": str}
_creds: dict[str, dict[str, Any]] = {}


class MesError(Exception):
    def __init__(self, message: str, status: int = 0, code: str = ""):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


def set_creds(owner: str, cookie: str, csrf: str, name: str = "", role: str = "") -> None:
    _creds[owner] = {"cookie": cookie, "csrf": csrf, "at": time.time(), "name": name, "role": role}


def user_info(owner: str) -> dict[str, Any]:
    c = _creds.get(owner) or {}
    return {"name": c.get("name") or "", "role": c.get("role") or ""}


def check_id(value: Any, what: str = "ID") -> str:
    v = str(value or "").strip()
    if not UUID_RE.match(v):
        raise MesError(f"{what} 格式不对，应该是系统里查到的 ID（UUID），不要自己编造。")
    return v


def request_key() -> str:
    return "sbot-" + secrets.token_hex(12)


async def call(owner: str, method: str, path: str, *, params: dict[str, Any] | None = None,
               body: dict[str, Any] | None = None) -> Any:
    if not path.startswith("/api/") or ".." in path or "//" in path:
        raise MesError("内部错误：不允许的接口路径")
    c = _creds.get(owner)
    if not c or time.time() - c["at"] > CRED_TTL:
        raise MesError("登录信息已过期，请刷新页面重新登录后再试。", 401, "UNAUTHENTICATED")
    headers = {"Cookie": c["cookie"], "Accept": "application/json"}
    if method != "GET":
        headers["X-CSRF-Token"] = c["csrf"]
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=False, trust_env=False) as client:
            r = await client.request(method, MES_URL + path, params=params, json=body, headers=headers)
    except httpx.HTTPError as e:
        raise MesError(f"连接业务系统失败：{type(e).__name__}") from e
    try:
        data = r.json()
    except ValueError:
        data = None
    if r.status_code >= 400:
        err = (data or {}).get("error") if isinstance(data, dict) else None
        msg = (err or {}).get("message") if isinstance(err, dict) else None
        code = (err or {}).get("code") if isinstance(err, dict) else ""
        if r.status_code == 401:
            msg = "登录已失效，请刷新页面重新登录。"
        elif r.status_code == 403 and not msg:
            msg = "当前账号没有这个操作的权限。"
        raise MesError(msg or f"业务系统返回错误（{r.status_code}）", r.status_code, code or "")
    return data
