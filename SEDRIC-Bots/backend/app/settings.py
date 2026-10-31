"""Global settings: model providers (OpenAI-compatible), defaults, user name."""
from __future__ import annotations

import os
from typing import Any

from .storage import DATA, new_id, read_json, write_json

SETTINGS_PATH = DATA / "settings.json"

MOCK_PROVIDER = {
    "id": "mock",
    "name": "演示模式（无需 API Key）",
    "base_url": "mock://",
    "api_key": "",
    "api_key_env": "",
    "models": ["mock-agent"],
    "builtin": True,
}

DEFAULTS: dict[str, Any] = {
    "providers": [],
    "default_provider": "mock",
    "default_model": "mock-agent",
    "user_name": "你",
    "approval_mode": "smart",  # smart | always | auto
    "max_iterations": 24,
    "context_chars": 120_000,
    "theme": "light",
}


def load() -> dict[str, Any]:
    data = read_json(SETTINGS_PATH, None) or {}
    merged = {**DEFAULTS, **data}
    merged["providers"] = [p for p in merged.get("providers", []) if p.get("id") != "mock"]
    return merged


def save(data: dict[str, Any]) -> dict[str, Any]:
    current = load()
    providers = data.get("providers")
    if providers is not None:
        old = {p["id"]: p for p in current["providers"]}
        cleaned = []
        for p in providers:
            if p.get("id") == "mock":
                continue
            pid = p.get("id") or new_id("p")
            prev = old.get(pid, {})
            key = p.get("api_key")
            # The UI only ever sees a masked key; "unchanged" keeps the stored one.
            if key is None or key == "__keep__":
                key = prev.get("api_key", "")
            cleaned.append({
                "id": pid,
                "name": p.get("name") or "未命名提供商",
                "base_url": (p.get("base_url") or "").strip().rstrip("/"),
                "api_key": key,
                "api_key_env": (p.get("api_key_env") or "").strip(),
                "models": [m for m in (p.get("models") or []) if m],
                "extra_headers": p.get("extra_headers") or {},
            })
        current["providers"] = cleaned
    for k in ("default_provider", "default_model", "user_name", "approval_mode", "max_iterations", "context_chars", "theme"):
        if k in data and data[k] is not None:
            current[k] = data[k]
    write_json(SETTINGS_PATH, current)
    return current


def all_providers(s: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    s = s or load()
    return [MOCK_PROVIDER, *s["providers"]]


def provider_key(p: dict[str, Any]) -> str:
    if p.get("api_key"):
        return p["api_key"]
    env = p.get("api_key_env")
    return os.environ.get(env, "") if env else ""


def public(s: dict[str, Any] | None = None) -> dict[str, Any]:
    s = s or load()
    out = {k: v for k, v in s.items() if k != "providers"}
    provs = []
    for p in all_providers(s):
        key = p.get("api_key") or ""
        provs.append({
            **{k: v for k, v in p.items() if k != "api_key"},
            "api_key_set": bool(key),
            "api_key_masked": (key[:3] + "…" + key[-4:]) if len(key) > 10 else ("已设置" if key else ""),
            "env_key_found": bool(p.get("api_key_env") and os.environ.get(p["api_key_env"])),
        })
    out["providers"] = provs
    return out


def get_provider(pid: str | None, s: dict[str, Any] | None = None) -> dict[str, Any] | None:
    for p in all_providers(s):
        if p["id"] == pid:
            return p
    return None


def resolve_model(bot_model: dict[str, Any] | None) -> tuple[dict[str, Any] | None, str]:
    """A bot's own pick wins; anything unset inherits the global default."""
    s = load()
    pid = (bot_model or {}).get("provider") or s["default_provider"]
    model = (bot_model or {}).get("model") or ""
    p = get_provider(pid, s)
    if p is None:
        p = get_provider(s["default_provider"], s)
    if not model:
        if p and p["id"] == s["default_provider"]:
            model = s["default_model"]
        elif p and p.get("models"):
            model = p["models"][0]
    return p, model
