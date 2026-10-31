"""File-backed storage helpers: data dir layout, atomic JSON writes, ids, time."""
from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(os.environ.get("HB_DATA", ROOT / "data")).resolve()
BOTS_DIR = DATA / "bots"
GROUPS_DIR = DATA / "groups"
UPLOADS_DIR = DATA / "uploads"

for _d in (DATA, BOTS_DIR, GROUPS_DIR, UPLOADS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id(prefix: str = "") -> str:
    return f"{prefix}{int(time.time() * 1000):x}{secrets.token_hex(3)}"


def read_json(path: Path, default: Any = None) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except (json.JSONDecodeError, OSError):
        # A corrupted file should never crash the app; keep a copy for forensics.
        try:
            shutil.copy(path, str(path) + f".corrupt-{int(time.time())}")
        except OSError:
            pass
        return default


def write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp{secrets.token_hex(2)}")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def read_text(path: Path, default: str = "") -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError):
        return default


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def truncate(text: str, limit: int, mark: str = "… [已截断]") -> str:
    text = text or ""
    if len(text) <= limit:
        return text
    return text[: max(0, limit - len(mark))] + mark
